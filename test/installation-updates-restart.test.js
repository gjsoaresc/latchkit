import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { installBundle, stageBundle } from '../dist/src/installation/manager.js';
import { performActivationHandoff } from '../dist/src/installation/updates/handoff.js';
import { killReplacement } from '../dist/src/installation/updates/restart.js';
import {
  readInstallationLease,
  readUpdateHandoffRecord,
} from '../dist/src/installation/updates/store.js';
import { assessInstallationQuiescence } from '../dist/src/installation/updates/workload.js';
import { writeHeartbeat } from '../dist/src/installation/updates/activity.js';
import { defaultProjectsRegistryRoot } from '../dist/src/projects/store.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = `${process.platform}-${process.arch}`;

async function inventory(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await inventory(filename, relative)));
    else if (entry.isFile()) {
      const bytes = await readFile(filename);
      files.push({
        path: relative,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  }
  return files;
}

/**
 * Build a real, immutable, already-staged version directory: an actual copy of this
 * repository's own built `dist/`, running on the real Node binary, exactly like
 * test/installation-updates-stage.test.js's fixtures. `performActivationHandoff` then spawns
 * this directly (no zip/download/network involved — that path is already covered by slice 1's
 * `stageUpdate` tests) so these tests exercise the restart-handoff mechanics with a real child
 * process, a real listening HTTP server, and a real authenticated status check.
 */
async function buildStagedFixture(
  scratch,
  installRoot,
  { version, policyVersion, activate = false } = {},
) {
  const bundle = path.join(scratch, `bundle-${version}`);
  await cp(path.join(repository, 'dist'), path.join(bundle, 'app', 'dist'), { recursive: true });
  await cp(
    process.execPath,
    path.join(bundle, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
  );
  const packageFile = path.join(bundle, 'app', 'dist', 'package.json');
  const packageJson = JSON.parse(await readFile(packageFile, 'utf8'));
  packageJson.version = version;
  await writeFile(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`);
  if (policyVersion) {
    const policyFile = path.join(bundle, 'app', 'dist', 'src', 'workflows', 'policy.js');
    const original = await readFile(policyFile, 'utf8');
    const replaced = original.replace(
      /POLICY_VERSION = '[^']*'/,
      `POLICY_VERSION = '${policyVersion}'`,
    );
    assert.notEqual(replaced, original, 'fixture must actually replace the policy version');
    await writeFile(policyFile, replaced);
  }
  await writeFile(
    path.join(bundle, 'bundle-manifest.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      package: 'latchkit',
      version,
      target: TARGET,
      nodeVersion: process.version,
      files: await inventory(bundle),
    })}\n`,
  );
  if (policyVersion) {
    // `manager.ts`'s own `stageBundle` smoke-checks every candidate against the one policy
    // version this repository's real installer currently ships
    // (`latchkit-workflow-v1`) and refuses to stage anything else — exactly the safety net
    // that would, in a real release, keep an incompatible candidate off the machine in the
    // first place. To exercise `checkPendingWorkCompatibility`'s *own* mismatch detection in
    // isolation, place this fixture directly into `versions/<key>` without going through that
    // gate, mirroring exactly what `stageBundle` would have produced on disk.
    const key = `${version}-${TARGET}`;
    const destination = path.join(installRoot, 'versions', key);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(bundle, destination, { recursive: true });
    return { directory: destination, version, target: TARGET, key };
  }
  if (activate) return installBundle({ root: installRoot, bundle, version, target: TARGET });
  const staged = await stageBundle({ root: installRoot, bundle, version, target: TARGET });
  return staged;
}

async function tempInstallRoot(t, prefix) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return root;
}

function baseHandoffContext(overrides) {
  return {
    projectsRegistryRoot: defaultProjectsRegistryRoot(),
    ownServerId: 'test-server',
    ownMutating: 0,
    ownDirty: false,
    readyTimeoutMs: 20_000,
    ...overrides,
  };
}

test(
  'a successful activation handoff spawns a verified replacement, activates, and records evidence',
  { timeout: 60_000 },
  async (t) => {
    const scratch = await tempInstallRoot(t, 'latchkit-restart-ok-scratch-');
    const installRoot = await tempInstallRoot(t, 'latchkit-restart-ok-root-');
    const projectRoot = await tempInstallRoot(t, 'latchkit-restart-ok-project-');
    const fromVersion = '1.0.0-restart-base';
    const toVersion = '2.0.0-restart-target';

    await buildStagedFixture(scratch, installRoot, { version: fromVersion, activate: true });
    const staged = await buildStagedFixture(scratch, installRoot, { version: toVersion });

    let child;
    try {
      const result = await performActivationHandoff(
        baseHandoffContext({
          installRoot,
          projectRoot,
          fromVersion,
          toVersion,
          target: TARGET,
          stagedDirectory: staged.directory,
          activate: () =>
            import('../dist/src/installation/manager.js').then((manager) =>
              manager.rollbackInstallation(installRoot, toVersion, TARGET),
            ),
        }),
      );
      assert.equal(result.outcome, 'succeeded');
      assert.equal(result.inspection.active, `${toVersion}-${TARGET}`);
      child = result.replacement.child;
      assert.ok(Number.isInteger(child.pid));
      assert.match(result.replacement.url, /^http:\/\/127\.0\.0\.1:\d+\/#[a-f0-9]{64}$/);

      const record = await readUpdateHandoffRecord(installRoot);
      assert.equal(record.outcome, 'succeeded');
      assert.equal(record.toVersion, toVersion);
      assert.equal(record.replacementPid, child.pid);

      const lease = await readInstallationLease(installRoot);
      assert.equal(lease, null, 'a succeeded handoff must clear the lease');
    } finally {
      if (child) killReplacement({ child });
    }
  },
);

test(
  'a replacement that fails to spawn never touches current and records a failed handoff with a recovery command',
  { timeout: 30_000 },
  async (t) => {
    const scratch = await tempInstallRoot(t, 'latchkit-restart-spawnfail-scratch-');
    const installRoot = await tempInstallRoot(t, 'latchkit-restart-spawnfail-root-');
    const projectRoot = await tempInstallRoot(t, 'latchkit-restart-spawnfail-project-');
    const fromVersion = '1.0.0-spawnfail-base';
    const toVersion = '2.0.0-spawnfail-target';

    await buildStagedFixture(scratch, installRoot, { version: fromVersion, activate: true });
    const staged = await buildStagedFixture(scratch, installRoot, { version: toVersion });
    // Remove the staged runtime binary so spawning it fails immediately (ENOENT), simulating a
    // corrupted/incomplete staged directory without ever needing a real crash.
    await rm(
      path.join(staged.directory, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
      { force: true },
    );

    let activated = false;
    const result = await performActivationHandoff(
      baseHandoffContext({
        installRoot,
        projectRoot,
        fromVersion,
        toVersion,
        target: TARGET,
        stagedDirectory: staged.directory,
        activate: () => {
          activated = true;
          throw new Error('must never be called');
        },
      }),
    );
    assert.equal(result.outcome, 'failed');
    assert.equal(result.stage, 'spawn');
    assert.equal(
      activated,
      false,
      'current must never be touched when the replacement fails to start',
    );

    const { inspectInstallation } = await import('../dist/src/installation/manager.js');
    const inspection = await inspectInstallation(installRoot);
    assert.equal(
      inspection.active,
      `${fromVersion}-${TARGET}`,
      'the previous version stays active',
    );

    const record = await readUpdateHandoffRecord(installRoot);
    assert.equal(record.outcome, 'failed');
    assert.equal(record.stage, 'spawn');
    assert.match(record.recoveryCommand, /latchkit update rollback --to 1\.0\.0-spawnfail-base/);

    const lease = await readInstallationLease(installRoot);
    assert.equal(
      lease,
      null,
      'a failed handoff releases the lease rather than waiting out its TTL',
    );
  },
);

test(
  'a replacement reporting the wrong version is killed and never activated',
  { timeout: 30_000 },
  async (t) => {
    const scratch = await tempInstallRoot(t, 'latchkit-restart-mismatch-scratch-');
    const installRoot = await tempInstallRoot(t, 'latchkit-restart-mismatch-root-');
    const projectRoot = await tempInstallRoot(t, 'latchkit-restart-mismatch-project-');
    const fromVersion = '1.0.0-mismatch-base';
    const stagedVersion = '2.0.0-mismatch-staged';

    await buildStagedFixture(scratch, installRoot, { version: fromVersion, activate: true });
    const staged = await buildStagedFixture(scratch, installRoot, { version: stagedVersion });

    let activated = false;
    const result = await performActivationHandoff(
      baseHandoffContext({
        installRoot,
        projectRoot,
        fromVersion,
        // Deliberately expect a version the staged fixture does not actually report.
        toVersion: '9.9.9-does-not-match',
        target: TARGET,
        stagedDirectory: staged.directory,
        activate: () => {
          activated = true;
          throw new Error('must never be called');
        },
      }),
    );
    assert.equal(result.outcome, 'failed');
    assert.equal(result.stage, 'version-verify');
    assert.equal(activated, false);

    const { inspectInstallation } = await import('../dist/src/installation/manager.js');
    const inspection = await inspectInstallation(installRoot);
    assert.equal(inspection.active, `${fromVersion}-${TARGET}`);
  },
);

test('activation is blocked, without ever spawning a replacement, while a workflow is running', async (t) => {
  const installRoot = await tempInstallRoot(t, 'latchkit-restart-busy-root-');
  const projectRoot = await tempInstallRoot(t, 'latchkit-restart-busy-project-');
  const { initProject } = await import('../dist/src/core.js');
  await initProject(projectRoot, { providers: ['codex'], skills: ['spec'] });
  await mkdir(path.join(projectRoot, '.latchkit', 'workflows'), { recursive: true });
  const digest64 = (seed) => createHash('sha256').update(seed).digest('hex');
  const now = new Date().toISOString();
  const runningWorkflow = {
    schemaVersion: 1,
    workflowId: `workflow_${randomUUID()}`,
    taskId: `task_${randomUUID()}`,
    taskOwnerId: `owner_${randomUUID()}`,
    revision: 1,
    status: 'running',
    phase: 'implementation',
    providerId: 'codex',
    reviewProviderId: 'codex',
    executionAuthorized: true,
    policyVersion: 'latchkit-workflow-v1',
    policyDigest: digest64('policy'),
    promptDigest: digest64('Fixture running workflow for the quiescence test.'),
    initialPrompt: 'Fixture running workflow for the quiescence test.',
    inputs: [],
    proposedChecks: null,
    requirements: null,
    plan: null,
    approval: null,
    repairAttempts: 0,
    retryOfActionId: null,
    artifacts: [],
    pendingAction: null,
    completedActions: [],
    mutations: [],
    lastOutcome: { status: 'none', summary: '' },
    source: { revision: null, dirtyFingerprint: null },
    createdAt: now,
    updatedAt: now,
  };
  await writeFile(
    path.join(projectRoot, '.latchkit', 'workflows', 'state-v1.json'),
    `${JSON.stringify({ schemaVersion: 1, workflows: [runningWorkflow] }, null, 2)}\n`,
  );

  const quiescence = await assessInstallationQuiescence({
    installRoot,
    projectsRegistryRoot: defaultProjectsRegistryRoot(),
    currentRoot: projectRoot,
    ownServerId: 'test-server',
    ownMutating: 0,
    ownDirty: false,
  });
  assert.equal(quiescence.busy, true);
  assert.ok(quiescence.reasons.some((reason) => reason.includes('workflow(s) currently running')));
});

test('two consoles racing to activate: the second observes the first-written lease and is blocked', async (t) => {
  const scratch = await tempInstallRoot(t, 'latchkit-restart-race-scratch-');
  const installRoot = await tempInstallRoot(t, 'latchkit-restart-race-root-');
  const projectRoot = await tempInstallRoot(t, 'latchkit-restart-race-project-');
  const fromVersion = '1.0.0-race-base';
  const toVersion = '2.0.0-race-target';
  await buildStagedFixture(scratch, installRoot, { version: fromVersion, activate: true });
  const staged = await buildStagedFixture(scratch, installRoot, { version: toVersion });

  const { acquireRestartLease } = await import('../dist/src/installation/updates/workload.js');
  const first = await acquireRestartLease({
    installRoot,
    projectsRegistryRoot: defaultProjectsRegistryRoot(),
    currentRoot: projectRoot,
    ownServerId: 'console-a',
    ownMutating: 0,
    ownDirty: false,
    reason: 'first',
    fromVersion,
    toVersion,
  });
  assert.equal(first.ok, true);

  const second = await performActivationHandoff(
    baseHandoffContext({
      installRoot,
      projectRoot,
      fromVersion,
      toVersion,
      target: TARGET,
      ownServerId: 'console-b',
      stagedDirectory: staged.directory,
      activate: () => {
        throw new Error('must never be called');
      },
    }),
  );
  assert.equal(second.outcome, 'blocked-quiescence');
  assert.ok(second.reasons.some((reason) => reason.includes('already restarting')));
});

test('an unsaved edit reported by another console sharing this installation blocks activation', async (t) => {
  const installRoot = await tempInstallRoot(t, 'latchkit-restart-dirty-root-');
  const projectRoot = await tempInstallRoot(t, 'latchkit-restart-dirty-project-');
  await writeHeartbeat(installRoot, {
    schemaVersion: 1,
    serverId: 'other-console',
    root: projectRoot,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    dirty: true,
    mutating: 0,
  });

  const quiescence = await assessInstallationQuiescence({
    installRoot,
    projectsRegistryRoot: defaultProjectsRegistryRoot(),
    currentRoot: projectRoot,
    ownServerId: 'this-console',
    ownMutating: 0,
    ownDirty: false,
  });
  assert.equal(quiescence.busy, true);
  assert.ok(quiescence.reasons.some((reason) => reason.includes('unsaved edit')));
});

test('pending work under a different workflow policy version blocks activation before any lease is acquired', async (t) => {
  const scratch = await tempInstallRoot(t, 'latchkit-restart-preflight-scratch-');
  const installRoot = await tempInstallRoot(t, 'latchkit-restart-preflight-root-');
  const projectRoot = await tempInstallRoot(t, 'latchkit-restart-preflight-project-');
  const fromVersion = '1.0.0-preflight-base';
  const toVersion = '2.0.0-preflight-target';
  await buildStagedFixture(scratch, installRoot, { version: fromVersion, activate: true });
  const staged = await buildStagedFixture(scratch, installRoot, {
    version: toVersion,
    policyVersion: 'latchkit-workflow-v2-fixture',
  });

  const { initProject } = await import('../dist/src/core.js');
  await initProject(projectRoot, { providers: ['codex'], skills: ['spec'] });
  await mkdir(path.join(projectRoot, '.latchkit', 'workflows'), { recursive: true });
  const digest64 = (seed) => createHash('sha256').update(seed).digest('hex');
  const now = new Date().toISOString();
  // A minimal but fully valid WorkflowRecord (see assertWorkflowRecord in
  // src/workflows/contracts.ts) in a pending, non-running status with no active process —
  // exactly the "interrupted/approved pending task with no active process" case acceptance
  // criterion 4 describes.
  const pendingWorkflow = {
    schemaVersion: 1,
    workflowId: `workflow_${randomUUID()}`,
    taskId: `task_${randomUUID()}`,
    taskOwnerId: `owner_${randomUUID()}`,
    revision: 1,
    // "interrupted" (rather than "awaiting-approval") avoids that status's extra
    // requirements/plan cross-validation in assertWorkflowRecord while still being one of the
    // "pending, no active process" statuses acceptance criterion 4 describes.
    status: 'interrupted',
    phase: 'plan',
    providerId: 'codex',
    reviewProviderId: 'codex',
    executionAuthorized: false,
    policyVersion: 'latchkit-workflow-v1',
    policyDigest: digest64('policy'),
    promptDigest: digest64('Fixture pending workflow for the compatibility preflight test.'),
    initialPrompt: 'Fixture pending workflow for the compatibility preflight test.',
    inputs: [],
    proposedChecks: null,
    requirements: null,
    plan: null,
    approval: null,
    repairAttempts: 0,
    retryOfActionId: null,
    artifacts: [],
    pendingAction: null,
    completedActions: [],
    mutations: [],
    lastOutcome: { status: 'none', summary: '' },
    source: { revision: null, dirtyFingerprint: null },
    createdAt: now,
    updatedAt: now,
  };
  await writeFile(
    path.join(projectRoot, '.latchkit', 'workflows', 'state-v1.json'),
    `${JSON.stringify({ schemaVersion: 1, workflows: [pendingWorkflow] }, null, 2)}\n`,
  );

  const result = await performActivationHandoff(
    baseHandoffContext({
      installRoot,
      projectRoot,
      fromVersion,
      toVersion,
      target: TARGET,
      stagedDirectory: staged.directory,
      activate: () => {
        throw new Error('must never be called');
      },
    }),
  );
  assert.equal(result.outcome, 'blocked-preflight');
  assert.ok(result.blockers.some((blocker) => blocker.includes('pending workflow')));

  const lease = await readInstallationLease(installRoot);
  assert.equal(lease, null, 'a preflight block must never acquire the restart lease');
});
