import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { applyCleanup, DEFAULT_SCOPES, planCleanup } from '../scripts/clean.js';

const run = promisify(execFile);
const repository = path.resolve(import.meta.dirname, '..');

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-clean-fixture-'));
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'latchkit-clean-tmproot-'));
  t.after(() =>
    Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(tmpRoot, { recursive: true, force: true }),
    ]),
  );
  return { root, tmpRoot };
}

test('planCleanup reports dist, test-results, coverage, typecheck log, and tgz output without deleting anything', async (t) => {
  const { root, tmpRoot } = await fixture(t);
  await mkdir(path.join(root, 'dist', 'src'), { recursive: true });
  await writeFile(path.join(root, 'dist', 'src', 'cli.js'), 'compiled');
  await mkdir(path.join(root, 'test-results', 'acceptance-chromium-x'), { recursive: true });
  await writeFile(path.join(root, 'test-results', 'acceptance-chromium-x', 'evidence.json'), '{}');
  await mkdir(path.join(root, 'coverage'), { recursive: true });
  await writeFile(path.join(root, 'coverage', 'lcov.info'), 'coverage');
  await writeFile(path.join(root, '.latchkit-typecheck.log'), 'tsc output');
  await writeFile(path.join(root, 'latchkit-1.0.0.tgz'), 'packed');
  // Source files and project state must never appear in the plan at all.
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'cli.ts'), 'source');
  await mkdir(path.join(root, '.latchkit'), { recursive: true });
  await writeFile(path.join(root, '.latchkit', 'manifest.json'), '{}');

  const plan = await planCleanup({ root, tmpRoot, scopes: DEFAULT_SCOPES });

  const byId = Object.fromEntries(plan.items.map((item) => [item.id, item]));
  assert.equal(byId.dist.status, 'would-remove');
  assert.equal(byId['test-results'].status, 'would-remove');
  assert.equal(byId.coverage.status, 'would-remove');
  assert.equal(byId['typecheck-log'].status, 'would-remove');
  assert.equal(byId['tgz:latchkit-1.0.0.tgz'].status, 'would-remove');
  assert.ok(plan.totals.bytesReclaimable > 0);
  assert.equal(plan.totals.itemsToRemove, 5);

  // Nothing was actually touched by planning.
  assert.equal(await readFile(path.join(root, 'src', 'cli.ts'), 'utf8'), 'source');
  assert.equal(
    await readFile(path.join(root, 'dist', 'src', 'cli.js'), 'utf8').catch(() => 'missing'),
    'compiled',
  );
  assert.ok(!plan.items.some((item) => item.path.includes(path.join(root, 'src'))));
  assert.ok(!plan.items.some((item) => item.path === path.join(root, '.latchkit')));
  assert.equal(
    await readFile(path.join(root, '.latchkit', 'manifest.json'), 'utf8'),
    '{}',
    'project state under .latchkit/ must be untouched',
  );
});

test('applyCleanup removes exactly the planned items and reports bytes reclaimed', async (t) => {
  const { root, tmpRoot } = await fixture(t);
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await writeFile(path.join(root, 'dist', 'output.js'), 'built');
  await writeFile(path.join(root, '.latchkit-typecheck.log'), 'log contents');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'keep.ts'), 'keep me');

  const plan = await planCleanup({ root, tmpRoot, scopes: ['dist', 'typecheck-log'] });
  const result = await applyCleanup(plan, { root, tmpRoot });

  assert.equal(result.totals.itemsRemoved, 2);
  assert.ok(result.totals.bytesReclaimed > 0);
  await assert.rejects(readFile(path.join(root, 'dist', 'output.js')), /ENOENT/);
  await assert.rejects(readFile(path.join(root, '.latchkit-typecheck.log')), /ENOENT/);
  assert.equal(await readFile(path.join(root, 'src', 'keep.ts'), 'utf8'), 'keep me');
});

test('cleanup is idempotent: a second apply against an already-clean tree removes nothing further', async (t) => {
  const { root, tmpRoot } = await fixture(t);
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await writeFile(path.join(root, 'dist', 'output.js'), 'built');

  const first = await applyCleanup(await planCleanup({ root, tmpRoot, scopes: ['dist'] }), {
    root,
    tmpRoot,
  });
  assert.equal(first.totals.itemsRemoved, 1);

  const second = await applyCleanup(await planCleanup({ root, tmpRoot, scopes: ['dist'] }), {
    root,
    tmpRoot,
  });
  assert.equal(second.totals.itemsRemoved, 0);
  assert.equal(second.items.find((item) => item.id === 'dist').status, 'not-found');
});

test('release-artifacts is excluded from the default scope and only removed when explicitly requested', async (t) => {
  const { root, tmpRoot } = await fixture(t);
  await mkdir(path.join(root, 'release-artifacts', 'previous'), { recursive: true });
  await writeFile(path.join(root, 'release-artifacts', 'latchkit-1.0.0-win32-x64.zip'), 'archive');
  await mkdir(path.join(root, 'release-artifacts-staging'), { recursive: true });
  await writeFile(path.join(root, 'release-artifacts-staging', 'partial.zip'), 'partial');

  const defaultPlan = await planCleanup({ root, tmpRoot, scopes: DEFAULT_SCOPES });
  assert.ok(!defaultPlan.items.some((item) => item.scope === 'release-artifacts'));
  const defaultApply = await applyCleanup(defaultPlan, { root, tmpRoot });
  assert.equal(defaultApply.totals.itemsRemoved, 0);
  assert.ok(
    await readFile(
      path.join(root, 'release-artifacts', 'latchkit-1.0.0-win32-x64.zip'),
      'utf8',
    ).then(
      () => true,
      () => false,
    ),
  );

  const explicitPlan = await planCleanup({ root, tmpRoot, scopes: ['release-artifacts'] });
  const byId = Object.fromEntries(explicitPlan.items.map((item) => [item.id, item]));
  assert.equal(byId['release-artifacts:release-artifacts'].status, 'would-remove');
  assert.equal(byId['release-artifacts:release-artifacts-staging'].status, 'would-remove');
  const explicitApply = await applyCleanup(explicitPlan, { root, tmpRoot });
  assert.equal(explicitApply.totals.itemsRemoved, 2);
  await assert.rejects(readdir(path.join(root, 'release-artifacts')), /ENOENT/);
});

test('a tmp scratch directory younger than the retention window is retained, not removed', async (t) => {
  const { root, tmpRoot } = await fixture(t);
  const scratch = path.join(tmpRoot, 'latchkit-bundle-fresh01');
  await mkdir(scratch, { recursive: true });
  await writeFile(path.join(scratch, 'partial.txt'), 'in progress');

  const plan = await planCleanup({
    root,
    tmpRoot,
    scopes: ['tmp'],
    olderThanMs: 24 * 60 * 60 * 1000,
  });
  const item = plan.items.find((entry) => entry.id.includes('latchkit-bundle-fresh01'));
  assert.equal(item.status, 'retained');

  const result = await applyCleanup(plan, { root, tmpRoot });
  assert.equal(result.totals.itemsRemoved, 0);
  assert.ok(
    await readFile(path.join(scratch, 'partial.txt'), 'utf8').then(
      () => true,
      () => false,
    ),
  );
});

test('a tmp scratch directory older than the retention window is reclaimed once eligible', async (t) => {
  const { root, tmpRoot } = await fixture(t);
  const scratch = path.join(tmpRoot, 'latchkit-native-smoke-old0123');
  await mkdir(scratch, { recursive: true });
  await writeFile(path.join(scratch, 'leftover.txt'), 'orphaned');
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await utimes(scratch, old, old);

  const plan = await planCleanup({
    root,
    tmpRoot,
    scopes: ['tmp'],
    olderThanMs: 24 * 60 * 60 * 1000,
  });
  const item = plan.items.find((entry) => entry.id.includes('latchkit-native-smoke-old0123'));
  assert.equal(item.status, 'would-remove');

  const result = await applyCleanup(plan, { root, tmpRoot });
  assert.equal(result.totals.itemsRemoved, 1);
  await assert.rejects(readdir(scratch), /ENOENT/);
});

test('a temp directory not matching a known script prefix is never discovered', async (t) => {
  const { root, tmpRoot } = await fixture(t);
  const unrelated = path.join(tmpRoot, 'latchkit-issue36-something-unrelated');
  await mkdir(unrelated, { recursive: true });
  const old = new Date(Date.now() - 72 * 60 * 60 * 1000);
  await utimes(unrelated, old, old);

  const plan = await planCleanup({ root, tmpRoot, scopes: ['tmp'] });
  assert.ok(!plan.items.some((item) => item.path === unrelated));
  await applyCleanup(plan, { root, tmpRoot });
  assert.ok(
    await readdir(unrelated).then(
      () => true,
      () => false,
    ),
  );
});

test('a symbolic link in place of an owned path is retained, not followed or removed', async (t) => {
  const { root, tmpRoot } = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'latchkit-clean-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'important.txt'), 'do not delete');
  try {
    await symlink(
      outside,
      path.join(root, 'dist'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('links unavailable');
    throw error;
  }

  const plan = await planCleanup({ root, tmpRoot, scopes: ['dist'] });
  assert.equal(plan.items.find((item) => item.id === 'dist').status, 'retained');
  const result = await applyCleanup(plan, { root, tmpRoot });
  assert.equal(result.totals.itemsRemoved, 0);
  assert.ok(
    await readFile(path.join(outside, 'important.txt'), 'utf8').then(
      () => true,
      () => false,
    ),
  );
});

test('applyCleanup refuses a plan item whose resolved path escapes the managed roots', async (t) => {
  const { root, tmpRoot } = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'latchkit-clean-escape-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'sensitive.txt'), 'must survive');

  const plan = {
    scopes: ['dist'],
    items: [
      {
        id: 'dist',
        scope: 'dist',
        kind: 'directory',
        path: outside,
        status: 'would-remove',
        bytes: 10,
      },
    ],
    totals: {},
  };
  const result = await applyCleanup(plan, { root, tmpRoot });
  assert.equal(result.items[0].status, 'retained');
  assert.match(result.items[0].retainedReason, /escaped the managed cleanup roots/);
  assert.ok(
    await readFile(path.join(outside, 'sensitive.txt'), 'utf8').then(
      () => true,
      () => false,
    ),
  );
});

test('unknown scopes are rejected up front', async (t) => {
  const { root, tmpRoot } = await fixture(t);
  await assert.rejects(
    planCleanup({ root, tmpRoot, scopes: ['not-a-real-scope'] }),
    /Unknown cleanup scope/,
  );
});

test('CLI dry run makes no filesystem changes and reports what apply would do; --apply then removes it', async (t) => {
  const { root: workspace, tmpRoot } = await fixture(t);
  await mkdir(path.join(workspace, 'dist'), { recursive: true });
  await writeFile(path.join(workspace, 'dist', 'cli.js'), 'built');
  const cleanScript = path.join(repository, 'scripts', 'clean.js');

  const dryRun = JSON.parse(
    (
      await run(process.execPath, [
        cleanScript,
        '--root',
        workspace,
        '--tmp-root',
        tmpRoot,
        '--scope',
        'dist',
        '--json',
      ])
    ).stdout,
  );
  assert.equal(dryRun.mode, 'dry-run');
  assert.equal(dryRun.totals.itemsToRemove, 1);
  assert.equal(await readFile(path.join(workspace, 'dist', 'cli.js'), 'utf8'), 'built');

  const applied = JSON.parse(
    (
      await run(process.execPath, [
        cleanScript,
        '--root',
        workspace,
        '--tmp-root',
        tmpRoot,
        '--scope',
        'dist',
        '--apply',
        '--json',
      ])
    ).stdout,
  );
  assert.equal(applied.mode, 'apply');
  assert.equal(applied.totals.itemsRemoved, 1);
  await assert.rejects(readFile(path.join(workspace, 'dist', 'cli.js')), /ENOENT/);
});
