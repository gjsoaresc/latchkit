import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  addProjectMemory,
  deleteProjectMemory,
  exportProjectMemory,
  importProjectMemory,
  listProjectMemory,
  recoverProjectContext,
  searchProjectMemory,
  updateProjectMemory,
} from '../dist/src/project-memory/service.js';
import { PROJECT_MEMORY_PATH } from '../dist/src/project-memory/store.js';

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-memory-'));
  const root = path.join(base, 'project with spaces é');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'source.txt'), 'observed source\n');
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return root;
}

test('project memories persist, search Unicode, supersede, and redact credential-like capture', async (t) => {
  const root = await fixture(t);
  const first = await addProjectMemory(root, {
    kind: 'decision',
    title: 'Use JSON snapshots',
    text: 'Decisión: retain inspectable local snapshots.',
    tags: ['évidence'],
    sources: [{ path: 'source.txt' }],
  });
  const second = await addProjectMemory(root, {
    kind: 'resolved-defect',
    title: 'Snapshot race',
    text: 'Serialize writers with an exclusive local lock.',
    supersedes: first.id,
  });
  assert.equal((await searchProjectMemory(root, 'decisión évidence'))[0].memory.id, first.id);
  assert.equal((await listProjectMemory(root)).memories.length, 2);
  await assert.rejects(
    addProjectMemory(root, { title: 'secret', text: 'api_key=abcdefghijklmnopqrstuvwxyz' }),
    { code: 'PROJECT_MEMORY_REDACTED' },
  );
  await assert.rejects(
    addProjectMemory(root, { title: 'secret source', text: 'never', sources: [{ path: '.env' }] }),
    { code: 'PROJECT_MEMORY_EXCLUDED_SOURCE' },
  );
  await updateProjectMemory(root, second.id, {
    text: 'Lock writers before the atomic snapshot.',
    expectedRevision: 1,
  });
  await assert.rejects(
    updateProjectMemory(root, second.id, { title: 'stale', expectedRevision: 1 }),
    { code: 'PROJECT_MEMORY_REVISION_CONFLICT' },
  );
});

test('export/import handles duplicate IDs and deletion removes managed searchable content', async (t) => {
  const root = await fixture(t);
  const memory = await addProjectMemory(root, {
    title: 'Portable export',
    text: 'Export only active memories.',
  });
  const exported = await exportProjectMemory(root);
  assert.equal((await importProjectMemory(root, exported)).skippedDuplicate[0], memory.id);
  const conflicting = structuredClone(exported);
  conflicting.memories[0].text = 'Imported record with same id but different content.';
  assert.equal((await importProjectMemory(root, conflicting)).imported.length, 1);
  await deleteProjectMemory(root, memory.id, { expectedRevision: 1 });
  assert.equal((await searchProjectMemory(root, 'active memories')).length, 0);
  const persisted = await fs.readFile(path.join(root, PROJECT_MEMORY_PATH), 'utf8');
  assert.doesNotMatch(persisted, /Export only active memories/);
  assert.equal(
    (await exportProjectMemory(root)).memories.some((item) => item.id === memory.id),
    false,
  );
});

test('bounded recovery marks stale sources and returns manual mode without a supported capability', async (t) => {
  const root = await fixture(t);
  await addProjectMemory(root, {
    title: 'Context',
    text: 'Relevant historical evidence.',
    sources: [{ path: 'source.txt' }],
  });
  await fs.unlink(path.join(root, 'source.txt'));
  const provider = { capabilities: { compaction: { state: 'supported', reason: 'fixture' } } };
  const recovered = await recoverProjectContext(root, { budget: 300, provider });
  assert.equal(recovered.mode, 'on-demand');
  assert.deepEqual(recovered.records[0].sourceStatus, ['missing']);
  assert.match(recovered.context, /untrusted context/);
  const unavailable = await recoverProjectContext(root, { budget: 300 });
  assert.equal(unavailable.mode, 'manual');
  assert.equal(unavailable.records.length, 0);
  await assert.rejects(recoverProjectContext(root, { budget: 0, provider }), {
    code: 'PROJECT_MEMORY_INVALID',
  });
});
