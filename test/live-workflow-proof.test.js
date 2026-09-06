import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  fixtureGitScopeProof,
  workflowFailureEvidence,
} from '../scripts/workflow-evidence-proof.js';

test('fixture Git proof allows only the implementation and internal state, including committed-change detection', () => {
  const clean = {
    beforeHead: 'a'.repeat(40),
    afterHead: 'a'.repeat(40),
    changedPaths: ['src/calculator.js'],
    untrackedPaths: ['.latchkit/tasks/state.json'],
  };
  assert.deepEqual(fixtureGitScopeProof(clean), {
    headUnchanged: true,
    changedPaths: ['src/calculator.js'],
    unexpectedPathCount: 0,
  });
  for (const changed of [
    'package.json',
    '.gitignore',
    'REQUIREMENTS.md',
    'test/calculator.test.js',
  ])
    assert.throws(
      () => fixtureGitScopeProof({ ...clean, changedPaths: [...clean.changedPaths, changed] }),
      { code: 'WORKFLOW_FIXTURE_SCOPE_CHANGED' },
    );
  assert.throws(() => fixtureGitScopeProof({ ...clean, untrackedPaths: ['hidden-output.log'] }), {
    code: 'WORKFLOW_FIXTURE_SCOPE_CHANGED',
  });
  assert.throws(
    () => fixtureGitScopeProof({ ...clean, afterHead: 'b'.repeat(40), changedPaths: [] }),
    { code: 'WORKFLOW_FIXTURE_SCOPE_CHANGED' },
  );
});

test('failed qualification evidence contains only bounded phase metadata and no raw outcomes or error text', () => {
  const secret = 'test-only-sensitive-value';
  const evidence = workflowFailureEvidence({
    attemptId: 'fixture-attempt',
    startedAt: '2026-09-06T14:00:00.000Z',
    finishedAt: '2026-09-06T14:01:00.000Z',
    stage: 'implementation-verification',
    candidate: {
      archiveSha256: 'a'.repeat(64),
      commit: 'b'.repeat(40),
      version: '1.0.0-dogfood.20260906.1',
      target: 'win32-x64',
      secret,
    },
    provider: { model: 'gpt-5.6-luna', 'reasoning-effort': 'medium', credentials: secret },
    workflow: {
      phase: 'implementation',
      status: 'blocked',
      repairAttempts: 1,
      prompt: secret,
      lastOutcome: { summary: secret },
      completedActions: [
        { phase: 'plan', status: 'passed', result: secret },
        { phase: secret, status: secret },
      ],
    },
    error: new Error(secret),
    providerProcessStarts: 3,
  });
  assert.equal(evidence.kind, 'live-workflow-qualification-failure');
  assert.equal(evidence.status, 'failed');
  assert.equal(evidence.workflow.status, 'blocked');
  assert.equal(evidence.provider.reasoningEffortOverride, 'medium');
  assert.equal(evidence.bounds.providerProcessStarts, 3);
  assert.equal(JSON.stringify(evidence).includes(secret), false);
});

test('artifact failure replaces stale success evidence without launching a provider or retaining raw error paths', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit workflow proof é-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = path.join(root, 'invalid.zip');
  const output = path.join(root, 'qualification.evidence.json');
  await writeFile(archive, 'fixture invalid archive bytes');
  await writeFile(
    output,
    JSON.stringify({ kind: 'live-workflow-qualification', status: 'verified' }),
  );
  const run = promisify(execFile);
  await assert.rejects(
    run(
      process.execPath,
      [
        path.resolve('scripts/live-workflow-evidence.js'),
        '--authorized',
        '--provider',
        'codex',
        '--model',
        'gpt-5.6-luna',
        '--reasoning-effort',
        'medium',
        '--artifact',
        archive,
        '--artifact-sha256',
        '0'.repeat(64),
        '--output',
        output,
      ],
      { windowsHide: true, timeout: 10000 },
    ),
    (error) => error.code === 1 && !error.stderr.includes(root),
  );
  const evidence = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(evidence.kind, 'live-workflow-qualification-failure');
  assert.equal(evidence.failure.stage, 'archive-validation');
  assert.equal(evidence.bounds.providerProcessStarts, 0);
  assert.equal(evidence.provider.modelOverride, 'gpt-5.6-luna');
  assert.equal(evidence.status, 'failed');
});
