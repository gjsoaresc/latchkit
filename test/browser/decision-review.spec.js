import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { initProject } from '../../dist/src/core.js';
import { startServer } from '../../dist/src/server.js';
import {
  createTask,
  recordEvidence,
  recordTaskRecord,
  resumeTask,
  transitionTaskRecord,
} from '../../dist/src/task-state/service.js';
import {
  addResultDecisionNotes,
  approveResultDecision,
  presentResultDecision,
} from '../../dist/src/workflows/result-decision-service.js';

// Issue #113: browser coverage for the directly addressable decision-comparison review at
// /specs/review?task=<id>. Real task/decision/evidence/result-decision fixtures are built through
// the same durable services the CLI and console already use (matching workbench.spec.js's
// convention) rather than mocked HTTP, so the page renders genuinely persisted state.

const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');
const authorization = (scope, reference = 'current direct test request') => ({
  source: 'user',
  scope,
  reference,
});

async function acceptedDecision(root, taskId, expectedRevision, text, links = []) {
  let updated = await recordTaskRecord(root, {
    taskId,
    expectedRevision,
    kind: 'decision',
    text,
    provenance: { kind: 'direct-user', reference: 'user message' },
    links,
  });
  const decision = updated.records.at(-1);
  updated = await transitionTaskRecord(root, {
    taskId,
    expectedRevision: updated.revision,
    recordId: decision.id,
    recordRevision: decision.revision,
    status: 'accepted',
    reason: 'confirmed with the user',
    authorization: authorization('accept decision', 'user confirmed in chat'),
  });
  return { task: updated, decision: updated.records.find((item) => item.id === decision.id) };
}

async function setUp() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-decision-review-'));
  await initProject(root, { providers: ['codex'], skills: ['spec'] });
  await writeFile(path.join(root, 'orders.sql'), 'select * from orders;\n');
  const { server, url } = await startServer(root);
  return {
    root,
    url,
    async cleanup() {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

test('an initial review reaches the original decision source and a failing check, and flags an uncovered required criterion', async ({
  page,
}) => {
  const { root, url, cleanup } = await setUp();
  try {
    const task = await createTask(root, {
      title: 'Export orders',
      authorization: authorization('implement task'),
      criteria: [
        { description: 'Export is scoped to the current user' },
        { description: 'Export renders every column' },
      ],
    });
    const [scopedCriterion, unlinkedCriterion] = task.criteria;
    const { task: withDecision, decision } = await acceptedDecision(
      root,
      task.id,
      task.revision,
      'Export includes only orders visible to the current user',
      [
        {
          type: 'criterion',
          criterionId: scopedCriterion.id,
          criterionRevision: scopedCriterion.revision,
        },
        { type: 'source', path: 'orders.sql' },
      ],
    );
    const resumed = await resumeTask(root, {
      taskId: task.id,
      expectedRevision: withDecision.revision,
    });
    // A readable artifact location (matching src/server.ts's readKnownArtifact contract) lets the
    // review page's "View recorded evidence" button reach the actual recorded check output, not
    // just its outcome label.
    const artifactLocation = `.latchkit/tasks/acceptance-evidence/${task.id}/check/result.json`;
    await mkdir(path.dirname(path.join(root, artifactLocation)), { recursive: true });
    await writeFile(
      path.join(root, artifactLocation),
      JSON.stringify({ command: 'npm test -- export.spec', outcome: 'failed' }, null, 2),
    );
    await recordEvidence(root, {
      taskId: task.id,
      expectedRevision: resumed.revision,
      runId: resumed.owner.runId,
      criterionId: scopedCriterion.id,
      criterionRevision: scopedCriterion.revision,
      kind: 'check',
      outcome: 'failed',
      command: 'npm test -- export.spec',
      artifact: JSON.stringify({ location: artifactLocation }),
    });

    await page.goto(url);
    await page.goto(`${new URL(url).origin}/specs/review?task=${task.id}`);

    await expect(page.getByRole('heading', { level: 1, name: 'Export orders' })).toBeVisible();
    await expect(page.getByText('Initial review — no prior reviewed snapshot.')).toBeVisible();

    // The changed decision itself, with its exact recorded text and the original decision source.
    // (The decision's own ID also appears inside the declared-consequences "via" path chain
    // further down the page, so scope this to the decision card specifically.)
    const decisionCard = page.locator('.decision-card', { hasText: decision.id });
    await expect(decisionCard).toBeVisible();
    await expect(decisionCard).toContainText(
      'Export includes only orders visible to the current user',
    );
    await expect(decisionCard).toContainText('orders.sql');

    // The failing check is reachable, with a non-color text label distinguishing it from a pass.
    const evidenceRow = page.locator('.evidence-row', {
      hasText: 'Export is scoped to the current user',
    });
    await expect(evidenceRow.getByText('current-fail', { exact: true })).toBeVisible();
    await evidenceRow.getByRole('button', { name: 'View recorded evidence' }).click();
    await expect(evidenceRow.locator('pre')).toContainText('npm test -- export.spec');

    // A required criterion no decision ever declared a link to is an explicit uncertainty. (Its ID
    // also legitimately appears in the separate verification-failures summary further up the page
    // — it has no recorded evidence either — so scope this assertion to the uncovered-criteria
    // paragraph specifically.)
    const uncoveredNote = page.getByText('Required criteria with no declared decision link', {
      exact: false,
    });
    await expect(uncoveredNote).toBeVisible();
    await expect(uncoveredNote).toContainText(unlinkedCriterion.id);

    // No end-of-spec/end-of-execution decision exists yet, so no action form is offered.
    await expect(
      page.getByText('No end-of-spec or end-of-execution decision is pending review'),
    ).toBeVisible();
  } finally {
    await cleanup();
  }
});

test('an unchanged, already-approved result needs no action, and a stale resubmission is refused and refreshed', async ({
  page,
}) => {
  const { root, url, cleanup } = await setUp();
  try {
    const task = await createTask(root, {
      title: 'Export orders',
      authorization: authorization('implement task'),
      criteria: [],
    });
    await acceptedDecision(root, task.id, task.revision, 'Export includes all orders');
    const resultDigest = sha256Hex('diff-v1');
    const presented = await presentResultDecision(root, {
      taskId: task.id,
      resultRef: 'https://example.invalid/diff/1',
      resultDigest,
      summary: 'Adds the export endpoint.',
      verificationResults: 'npm test: 5/5 passed.',
    });
    await approveResultDecision(root, {
      taskId: task.id,
      expectedRevision: presented.revision,
      resultDigest,
    });

    await page.goto(url);
    await page.goto(`${new URL(url).origin}/specs/review?task=${task.id}`);
    await expect(page.getByText(/previously reviewed snapshot/)).toBeVisible();
    await expect(
      page.getByText('No decisions changed since the comparison baseline.'),
    ).toBeVisible();
    await expect(
      page.getByText(
        'The current snapshot is already approved. Opening or refreshing this view causes no prompt or execution.',
      ),
    ).toBeVisible();
    // No action form (its "Submit" button) is offered once the reviewed snapshot is approved.
    await expect(page.getByRole('button', { name: 'Submit' })).toHaveCount(0);
  } finally {
    await cleanup();
  }
});

test('requested changes survive a page reload, and a stale approval attempt is rejected and refreshes the view', async ({
  page,
}) => {
  const { root, url, cleanup } = await setUp();
  try {
    const task = await createTask(root, {
      title: 'Export orders',
      authorization: authorization('implement task'),
      criteria: [],
    });
    await acceptedDecision(root, task.id, task.revision, 'Export includes all orders');
    const resultDigest = sha256Hex('diff-v1');
    await presentResultDecision(root, {
      taskId: task.id,
      resultRef: 'https://example.invalid/diff/1',
      resultDigest,
      summary: 'Adds the export endpoint.',
      verificationResults: 'npm test: 5/5 passed.',
    });

    await page.goto(url);
    await page.goto(`${new URL(url).origin}/specs/review?task=${task.id}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Export orders' })).toBeVisible();

    // A stale approval: the loaded page still holds the pre-note expectedRevision, but the
    // decision is advanced behind its back (a second reviewer, or another tab) before submitting.
    await addResultDecisionNotes(root, {
      taskId: task.id,
      expectedRevision: 1,
      notes: 'Please also filter archived orders.',
      resultDigest,
    });
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByRole('alert')).toContainText(
      'This task changed since the comparison was loaded.',
    );
    // The refreshed view now shows the real, current unresolved feedback rather than a duplicate.
    await expect(page.getByText('Please also filter archived orders.')).toBeVisible();
    await expect(
      page.getByText('Unresolved feedback (carried forward on later revisions)'),
    ).toBeVisible();

    // A browser refresh keeps the same unresolved feedback visible — dismissal/refresh never
    // accepts the result or starts a correction run on its own.
    await page.reload();
    await expect(page.getByText('Please also filter archived orders.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Submit' })).toBeVisible();
  } finally {
    await cleanup();
  }
});

test('keyboard access, non-color freshness labels, and both themes pass an axe scan with color-contrast enabled', async ({
  page,
}) => {
  const { root, url, cleanup } = await setUp();
  try {
    const task = await createTask(root, {
      title: 'Export orders',
      authorization: authorization('implement task'),
      criteria: [{ description: 'Export is scoped to the current user' }],
    });
    const criterion = task.criteria[0];
    const { task: withDecision } = await acceptedDecision(
      root,
      task.id,
      task.revision,
      'Export includes only orders visible to the current user',
      [{ type: 'criterion', criterionId: criterion.id, criterionRevision: criterion.revision }],
    );
    const resumed = await resumeTask(root, {
      taskId: task.id,
      expectedRevision: withDecision.revision,
    });
    await recordEvidence(root, {
      taskId: task.id,
      expectedRevision: resumed.revision,
      runId: resumed.owner.runId,
      criterionId: criterion.id,
      criterionRevision: criterion.revision,
      kind: 'check',
      outcome: 'passed',
    });

    await page.goto(url);
    await page.goto(`${new URL(url).origin}/specs/review?task=${task.id}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Export orders' })).toBeVisible();

    // Every freshness/status label carries its own visible text, never color alone.
    await expect(page.getByText('current-pass', { exact: true })).toBeVisible();
    await expect(page.getByText('Added', { exact: true })).toBeVisible();

    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toBeVisible();

    const light = await new AxeBuilder({ page }).analyze();
    expect(light.violations).toEqual([]);

    await page.getByRole('button', { name: 'Theme: system' }).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    const dark = await new AxeBuilder({ page }).analyze();
    expect(dark.violations).toEqual([]);
  } finally {
    await cleanup();
  }
});

test('a direct load and a refresh resolve the review page without visiting Specs & Tasks first', async ({
  page,
}) => {
  const { root, url, cleanup } = await setUp();
  try {
    const task = await createTask(root, {
      title: 'Export orders',
      authorization: authorization('implement task'),
      criteria: [],
    });
    await acceptedDecision(root, task.id, task.revision, 'Export includes all orders');

    // Establish the session at the root URL Latchkit prints, then load the review page directly
    // by URL — matching the routing contract exercised in navigation.spec.js for every other page.
    await page.goto(url);
    await page.goto(`${new URL(url).origin}/specs/review?task=${task.id}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Export orders' })).toBeVisible();
    await expect(page.locator('.nav-item.active')).toHaveText(/Specs & Tasks/);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Export orders' })).toBeVisible();

    // A missing ?task= is a clear message, never a blank or invented page.
    await page.goto(`${new URL(url).origin}/specs/review`);
    await expect(page.getByText('A task is required.')).toBeVisible();

    // The Specs & Tasks task list links directly to this page.
    await page.goto(`${new URL(url).origin}/specs`);
    await expect(page.getByText('Export orders')).toBeVisible();
    await page.getByText('Export orders').click();
    await page.getByRole('link', { name: 'Review decisions' }).click();
    await expect(page).toHaveURL(new RegExp(`/specs/review\\?task=${task.id}$`));
  } finally {
    await cleanup();
  }
});
