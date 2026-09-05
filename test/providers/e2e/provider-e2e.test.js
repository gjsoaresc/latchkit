import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runVerification, writeEvidence } from '../../../scripts/provider-e2e.js';
import { initProject, removeProjectSkills, syncProject } from '../../../src/core.js';

test('offline evidence validates every adapter without credentials or provider execution', async () => {
  for (const providerId of ['claude', 'codex', 'antigravity', 'cursor', 'cursor-cli']) {
    const record = await runVerification({ providerId });
    assert.equal(record.mode, 'fixture');
    assert.equal(record.artifacts.transcriptStored, false);
    assert.equal(record.usage.state, 'unknown');
    assert.match(record.configurationHash, /^sha256:/);
  }
  assert.equal((await runVerification({ providerId: 'cursor' })).result.status, 'unsupported');
});

test('live verification requires authorization, bounds retries, redacts output, and classifies failure paths', async () => {
  await assert.rejects(
    () => runVerification({ providerId: 'codex', mode: 'live' }),
    /requires --authorized/,
  );
  await assert.rejects(() => runVerification({ providerId: 'codex', maxRetries: 3 }), /maxRetries/);
  const blocked = await runVerification({
    providerId: 'codex',
    mode: 'live',
    authorized: true,
    fakeResult: { status: 'exited', exitCode: 1, stderr: 'login token=secret-value' },
  });
  assert.equal(blocked.result.status, 'blocked');
  assert.doesNotMatch(JSON.stringify(blocked), /secret-value/);
  const cancelled = await runVerification({
    providerId: 'codex',
    mode: 'live',
    authorized: true,
    fakeResult: { status: 'cancelled' },
  });
  assert.equal(cancelled.result.status, 'blocked');
  const hung = await runVerification({
    providerId: 'codex',
    mode: 'live',
    authorized: true,
    fakeResult: { status: 'timed-out', stdout: 'partial malformed output {' },
  });
  assert.equal(hung.result.status, 'blocked');
  const denied = await runVerification({
    providerId: 'codex',
    mode: 'live',
    authorized: true,
    fakeResult: { status: 'exited', exitCode: 1, stderr: 'permission denied' },
  });
  assert.equal(denied.result.status, 'blocked');
  const failed = await runVerification({
    providerId: 'codex',
    mode: 'live',
    authorized: true,
    fakeResult: { status: 'exited', exitCode: 2 },
  });
  assert.equal(failed.result.status, 'fail');
});

test('disposable fixture installs discovery artifacts and removal preserves unrelated user files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-provider-e2e-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root, { providers: ['codex'], skills: ['build'] });
  await syncProject(root);
  await assert.doesNotReject(readFile(path.join(root, '.agents/skills/latchkit-build/SKILL.md')));
  await (await import('node:fs/promises')).writeFile(path.join(root, 'human.txt'), 'keep');
  await removeProjectSkills(root);
  assert.equal(await readFile(path.join(root, 'human.txt'), 'utf8'), 'keep');
  const evidence = await runVerification({ providerId: 'codex' });
  const destination = await writeEvidence(evidence, path.join(root, '.latchkit/evidence.json'));
  assert.equal(JSON.parse(await readFile(destination, 'utf8')).result.status, 'pass');
});
