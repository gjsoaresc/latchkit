import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, readFile, rm } from 'node:fs/promises';
import { runAntigravityNativeEvidence } from '../dist/scripts/antigravity-native-evidence.js';

const id = '055a398f-db14-4c5f-abbb-1bf03f8120a7';
const result = (marker, conversationId = id) =>
  JSON.stringify({ conversation_id: conversationId, status: 'SUCCESS', response: marker });
const targetFrom = (prompt) => /read (.+?), then reply/.exec(prompt)?.[1];

function fakeProvider({
  version = '1.1.27',
  firstExit = 0,
  firstStatus = 'exited',
  staleReceipt = false,
  noReceipt = false,
} = {}) {
  let turn = 0;
  return async ({ plan }) => {
    const args = plan.args;
    if (args.includes('--version')) return { status: 'exited', exitCode: 0, stdout: version };
    turn += 1;
    if (turn === 1 && firstStatus !== 'exited') return { status: firstStatus, stdout: '' };
    if (turn === 1 && firstExit !== 0) return { status: 'exited', exitCode: firstExit, stdout: '' };
    const prompt = args[args.indexOf('-p') + 1];
    const target = targetFrom(prompt);
    const marker = await readFile(target, 'utf8');
    if (!noReceipt && !(staleReceipt && turn === 2)) {
      const receipt = plan.environment.LATCHKIT_ANTIGRAVITY_HOOK_RECEIPT;
      const nonce = plan.environment.LATCHKIT_ANTIGRAVITY_HOOK_NONCE;
      const operationDigest = createHash('sha256')
        .update(JSON.stringify({ tool: 'view_file', target }))
        .digest('hex');
      await appendFile(
        receipt,
        `${JSON.stringify({ event: 'PostToolUse', nonce, operationDigest })}\n`,
      );
    }
    return { status: 'exited', exitCode: 0, stdout: result(marker.trim()) };
  };
}

test('native evidence requires fresh turn-specific receipt and acceptance observations', async (t) => {
  const outcome = await runAntigravityNativeEvidence({
    executable: 'fake-agy.exe',
    model: 'fake-fast',
    launch: fakeProvider(),
  });
  t.after(() => rm(outcome.fixture, { recursive: true, force: true }));
  assert.equal(outcome.record.result.status, 'pass');
  assert.equal(outcome.record.observations.resumeReceipt, true);
  assert.equal(outcome.record.observations.resumeAccepted, true);
});

test('native evidence refuses stale receipts, nonzero exits, timeouts, and wrong versions', async (t) => {
  for (const [options, code] of [
    [{ staleReceipt: true }, 'RESUME_RECEIPT_FAILED'],
    [{ firstExit: 3 }, 'INITIAL_PROCESS_FAILED'],
    [{ firstStatus: 'timed-out' }, 'INITIAL_PROCESS_FAILED'],
    [{ version: '1.1.28' }, 'VERSION_MISMATCH'],
  ]) {
    const outcome = await runAntigravityNativeEvidence({
      executable: 'fake-agy.exe',
      model: 'fake-fast',
      launch: fakeProvider(options),
    });
    t.after(() => rm(outcome.fixture, { recursive: true, force: true }));
    assert.equal(outcome.record.result.status, 'fail');
    assert.equal(outcome.record.result.code, code);
  }
});
