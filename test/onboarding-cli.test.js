import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const cli = path.resolve('dist/src/cli.js');

async function tempProject(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-onboarding-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

function run(...args) {
  // execFile pipes stdio (no TTY attached), matching a non-interactive shell
  // or a package-manager postinstall context — this is the "no TTY" case the
  // `latchkit onboarding` CLI fallback must handle safely.
  return execute(process.execPath, [cli, ...args], { timeout: 20_000 });
}

test('latchkit onboarding with no subcommand and no TTY prints state and exits (never blocks)', async (t) => {
  const root = await tempProject(t);
  const startedAt = Date.now();
  const { stdout } = await run('onboarding', '--project', root);
  assert.ok(Date.now() - startedAt < 20_000, 'must not hang waiting for input');
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.apiVersion === undefined, true); // CLI JSON, not the HTTP envelope
  assert.equal(parsed.initialized, false);
  assert.equal(parsed.readiness.nextStepId, 'project');
});

test('latchkit onboarding drives the full wizard end to end via explicit actions', async (t) => {
  const root = await tempProject(t);
  await run('onboarding', 'project', '--project', root, '--providers', 'codex', '--skills', 'spec');
  const providers = JSON.parse(
    (await run('onboarding', 'providers', '--project', root, '--providers', 'codex,claude')).stdout,
  );
  assert.deepEqual(providers.providers.sort(), ['claude', 'codex']);

  const workspace = JSON.parse(
    (await run('onboarding', 'workspace', '--project', root, '--execution', 'ask')).stdout,
  );
  assert.equal(workspace.workspace.executionPreference, 'ask');

  const verification = JSON.parse(
    (await run('onboarding', 'verification', '--project', root, '--verification-mode', 'fast'))
      .stdout,
  );
  assert.equal(verification.settings.defaultMode, 'fast');

  const usage = JSON.parse((await run('onboarding', 'usage', 'enable', '--project', root)).stdout);
  assert.equal(usage.settings.enabled, true);

  const preview = JSON.parse((await run('onboarding', 'preview', '--project', root)).stdout);
  assert.equal(preview.conflicts.length, 0);

  const applied = JSON.parse((await run('onboarding', 'apply', '--project', root)).stdout);
  assert.equal(applied.conflicts.length, 0);

  const completed = JSON.parse((await run('onboarding', 'complete', '--project', root)).stdout);
  assert.equal(completed.progress.status, 'completed');

  const inspected = JSON.parse((await run('onboarding', '--project', root)).stdout);
  assert.equal(inspected.progress.status, 'completed');
});

test('latchkit onboarding skip/back/dismiss are exposed as an accessible CLI-only fallback', async (t) => {
  const root = await tempProject(t);
  await run('onboarding', 'project', '--project', root);

  await assert.rejects(run('onboarding', 'skip', 'project', '--project', root), (error) => {
    assert.match(error.stderr, /step cannot be skipped/);
    return true;
  });

  const skipped = JSON.parse(
    (await run('onboarding', 'skip', 'providers', '--project', root)).stdout,
  );
  assert.deepEqual(skipped.progress.skippedStepIds, ['providers']);

  const back = JSON.parse((await run('onboarding', 'back', 'providers', '--project', root)).stdout);
  assert.equal(back.progress.currentStepId, 'project');

  const dismissed = JSON.parse((await run('onboarding', 'dismiss', '--project', root)).stdout);
  assert.equal(dismissed.progress.status, 'dismissed');

  const cancelled = JSON.parse((await run('onboarding', 'cancel', '--project', root)).stdout);
  assert.equal(cancelled.progress.status, 'dismissed'); // cancel is an alias for dismiss
});

test('invalid onboarding actions and missing required options fail loudly with a usage message', async (t) => {
  const root = await tempProject(t);
  await assert.rejects(run('onboarding', 'not-a-real-action', '--project', root), (error) => {
    assert.match(error.stderr, /Usage: latchkit onboarding/);
    return true;
  });
  await assert.rejects(run('onboarding', 'workspace', '--project', root), (error) => {
    assert.match(error.stderr, /--execution and\/or --worktree-root/);
    return true;
  });
  await assert.rejects(run('onboarding', 'verification', '--project', root), (error) => {
    assert.match(error.stderr, /--verification-mode/);
    return true;
  });
  await assert.rejects(run('onboarding', 'usage', 'maybe', '--project', root), (error) => {
    assert.match(error.stderr, /usage <enable\|disable>/);
    return true;
  });
});
