#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { VERSION } from './version.js';
import {
  doctor,
  initProject,
  inspectRecovery,
  materializePackSource,
  migrateConfig,
  planConfigMigration,
  planSync,
  readConfig,
  recoverProject,
  removeProjectSkills,
  saveConfig,
  syncProject,
} from './core.js';
import { DEFAULT_WORKSPACE_SETTINGS } from './config/contracts.js';
import {
  applyTaskReconciliation,
  importMarkdownTask,
  inspectTask,
  inspectTaskRecord,
  listTaskRecords,
  listTasks,
  migrateLegacyPlan,
  migrateTaskState,
  previewTaskReconciliation,
  recordTaskRecord,
  registerEnhancedWorkflow,
  resolveCollisionSafePlanPath,
  resumeTask,
  reviseTaskRecord,
  setVerificationMode,
  transitionTaskRecord,
  verifyTask,
} from './task-state/service.js';
import type {
  ReconciliationPatchInput,
  RecordKind,
  RecordLinkInput,
  RecordProvenanceKind,
} from './task-state/service.js';
import {
  addSpecDecisionNotes,
  approveSpecDecision,
  inspectSpecDecision,
  markSpecBuildStarted,
  pauseSpecDecision,
  presentSpecDecision,
} from './workflows/spec-decision-service.js';
import { configureVerification, inspectVerificationSettings } from './verification/service.js';
import {
  addResultDecisionNotes,
  approveResultDecision,
  deferResultDecision,
  inspectResultDecision,
  presentResultDecision,
} from './workflows/result-decision-service.js';
import { exportSupportBundle, previewSupportBundle } from './diagnostics/bundle.js';
import { appendEvent } from './diagnostics/logger.js';
import { operationalError } from './diagnostics/errors.js';
import {
  cancelTaskWorkspace,
  cleanupTaskWorkspace,
  createTaskWorkspace,
  inspectWorkspaceCapability,
} from './workspaces/git.js';
import { createTaskController } from './runtime/task-controller.js';
import { createReviewOrchestrator } from './reviews/orchestrator.js';
import {
  createDiffAnnotation,
  inspectDiff,
  listDiffAnnotations,
  updateDiffAnnotation,
} from './reviews/diff-annotations.js';
import {
  formatDecisionComparisonText,
  inspectDecisionComparison,
} from './reviews/decision-comparison.js';
import { createAcceptanceVerifier } from './acceptance/service.js';
import {
  addProjectMemory,
  deleteProjectMemory,
  exportProjectMemory,
  importProjectMemory,
  inspectProjectMemory,
  listProjectMemory,
  recoverProjectContext,
  searchProjectMemory,
  updateProjectMemory,
} from './project-memory/service.js';
import { readFile } from 'node:fs/promises';
import { providerById } from './providers/registry.js';
import {
  configureUsage,
  deleteUsage,
  enforceUsageRetention,
  exportUsage,
  inspectUsage,
  recordProviderUsage,
} from './usage/service.js';
import {
  cancelScheduleRun,
  createForegroundScheduler,
  createSchedule,
  editSchedule,
  exportSchedules,
  inspectSchedule,
  listSchedules,
  pauseSchedule,
  removeSchedule,
  resumeSchedule,
} from './scheduler/service.js';
import {
  applyOnboardingSetup,
  backStep as backOnboardingStep,
  completeOnboarding,
  dismissOnboarding,
  inspectOnboarding,
  previewOnboardingSetup,
  selectProject as selectOnboardingProject,
  skipStep as skipOnboardingStep,
  startOnboarding,
  updateProjectSelection as updateOnboardingProjectSelection,
  updateUsagePreference as updateOnboardingUsagePreference,
  updateVerificationPreference as updateOnboardingVerificationPreference,
  updateWorkspacePreference as updateOnboardingWorkspacePreference,
} from './onboarding/service.js';
import { listProjects, registerProject, removeProject } from './projects/service.js';
import { defaultProjectsRegistryRoot } from './projects/store.js';
import { discoverSpecImport, previewSpecImport } from './spec-imports/service.js';
import {
  detachSpecImportRegistration,
  registerSpecImport,
  reinspectSpecImportRegistrations,
} from './spec-imports/registration-service.js';
import { buildContextBrief } from './context-brief/service.js';
import type { ContextBrief } from './context-brief/contracts.js';
import {
  exploreCodegraph,
  inspectCodegraph,
  readCodegraphSettings,
  saveCodegraphSettings,
  syncCodegraph,
} from './integrations/codegraph/service.js';

function requiredOption(value: string | undefined, name: string): string {
  if (!value) throw new Error('--' + name + ' is required.');
  return value;
}

/** Reads an optional `--file` JSON object with a `links` array, shared by `task record-add` and
 * `task record-revise`. Returns `undefined` when no file was given so callers can omit the field
 * entirely rather than sending an explicit empty list. */
async function readLinksFile(filePath: string | undefined): Promise<unknown> {
  if (!filePath) return undefined;
  const bytes = await readFile(path.resolve(filePath));
  if (bytes.byteLength > 32 * 1024) throw new Error('Record link file exceeds 32 KiB.');
  let document: unknown;
  try {
    document = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Record link file must be valid JSON.');
  }
  if (!document || typeof document !== 'object' || Array.isArray(document))
    throw new Error('Record link file must be an object with a links array.');
  return (document as { links?: unknown }).links;
}

/** Reads the required `--file` JSON reconciliation patch document shared by `task
 * reconcile-preview` and `task reconcile-apply`; see schemas/reconciliation-patch-v1.schema.json. */
async function readReconciliationPatchFile(
  filePath: string | undefined,
): Promise<ReconciliationPatchInput> {
  if (!filePath) throw new Error('--file is required (a reconciliation patch document).');
  const bytes = await readFile(path.resolve(filePath));
  if (bytes.byteLength > 128 * 1024) throw new Error('Reconciliation patch file exceeds 128 KiB.');
  let document: unknown;
  try {
    document = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Reconciliation patch file must be valid JSON.');
  }
  if (!document || typeof document !== 'object' || Array.isArray(document))
    throw new Error('Reconciliation patch file must be an object.');
  return document as ReconciliationPatchInput;
}

/** Shared `--format` handling for `task context-preview`/`workflow context` (issue #112): `json`
 * prints the full brief exactly like every other command; `text` (the default) renders a concise
 * human-readable summary with source links, never a substitute for inspecting the JSON directly. */
function requireContextBriefFormat(value: string | undefined): 'text' | 'json' {
  const format = value ?? 'text';
  if (format !== 'text' && format !== 'json') throw new Error('--format must be text or json.');
  return format;
}

function parseByteBudgetOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error('--byte-budget must be a positive integer.');
  return parsed;
}

function formatContextBriefText(brief: ContextBrief): string {
  const lines: string[] = [];
  lines.push(
    `Context brief for ${brief.taskId} (task revision ${brief.taskRevision}, state ${brief.taskState})`,
  );
  lines.push(`  digest: ${brief.digest}`);
  lines.push(`  intentDigest: ${brief.intentDigest}  criteriaDigest: ${brief.criteriaDigest}`);
  lines.push(
    brief.workflow.exists
      ? `  workflow: ${brief.workflow.workflowId} (phase ${brief.workflow.phase}, status ${brief.workflow.status})`
      : '  workflow: none (ordinary task)',
  );
  lines.push(`  next action: ${brief.nextAction.kind} — ${brief.nextAction.description}`);
  const section = (title: string, items: { id: string; status: string; text: string }[]) => {
    lines.push(`${title} (${items.length}):`);
    for (const item of items) lines.push(`  - [${item.status}] ${item.id}: ${item.text}`);
  };
  section('Accepted decisions', brief.acceptedDecisions);
  section('Confirmed assumptions', brief.confirmedAssumptions);
  section('Pending decisions', brief.pendingDecisions);
  section('Open assumptions', brief.openAssumptions);
  section('Open questions', brief.openQuestions);
  lines.push(`Criteria (${brief.criteria.length}):`);
  for (const criterion of brief.criteria)
    lines.push(
      `  - ${criterion.id}${criterion.required ? ' [required]' : ''}: ${criterion.description}`,
    );
  const change = brief.changeSinceLastRun;
  lines.push(
    `Change since last run: ${change.available ? 'available' : `unavailable (${change.reason})`}`,
  );
  if (change.available) {
    lines.push(
      `  reconciliations since: ${change.reconciliationsSince.length}${change.reconciliationsSinceTruncated ? ' (truncated)' : ''}`,
    );
    if (change.unreconciledChange)
      lines.push(
        `  unreconciled change: criteria=${change.unreconciledChange.criteriaDigestChanged} intent=${change.unreconciledChange.intentDigestChanged}${change.unreconciledChange.note ? ` — ${change.unreconciledChange.note}` : ''}`,
      );
    lines.push(`  work needing attention (${change.workNeedingAttention.length}):`);
    for (const item of change.workNeedingAttention)
      lines.push(`    - ${item.kind}:${item.id} (${item.outcome}, ${item.reasonCode})`);
    lines.push(`  completed work remaining (${change.completedWorkRemaining.length}):`);
    for (const item of change.completedWorkRemaining)
      lines.push(`    - ${item.criterionId}: ${item.description} (evidence ${item.evidenceId})`);
    lines.push(`  missing dependency links (${change.missingDependencyLinks.length}):`);
    for (const item of change.missingDependencyLinks)
      lines.push(`    - ${item.recordId} -> ${item.linkType}:${item.targetId} (${item.status})`);
  }
  lines.push(`Plan references (${brief.planReferences.length}):`);
  for (const reference of brief.planReferences)
    lines.push(`  - ${reference.kind}: ${reference.sourceRef} (${reference.digest.slice(0, 12)}…)`);
  lines.push(
    `Reconciliation outcomes (${brief.reconciliationOutcomes.length}${brief.reconciliationOutcomesTruncated ? ', truncated' : ''})`,
  );
  lines.push(
    `Omitted (${brief.omitted.length}): ${brief.omitted.map((item) => `${item.section}:${item.sourceRef}`).join(', ') || 'none'}`,
  );
  lines.push(
    `Budget: used ${brief.budget.usedBytes}/${brief.budget.effectiveBytes} bytes (~${brief.budget.estimatedTokens} est. tokens; ${brief.budget.estimateDisclaimer})`,
  );
  lines.push(brief.deliveryNote);
  lines.push(brief.resumeGuidance);
  return lines.join('\n');
}

async function printContextBrief(options: {
  taskId: string;
  byteBudget?: number;
  sinceDigest?: string;
  format: 'text' | 'json';
  root: string;
  /** `workflow context` only: fail before rendering when this task has no delivery workflow,
   * mirroring `workflow inspect`'s own WORKFLOW_NOT_FOUND rather than silently falling back to
   * `task context-preview`'s ordinary-task behavior. */
  requireWorkflow?: boolean;
}): Promise<void> {
  const brief = await buildContextBrief(options.root, {
    taskId: options.taskId,
    ...(options.byteBudget !== undefined ? { byteBudget: options.byteBudget } : {}),
    ...(options.sinceDigest !== undefined ? { sinceDigest: options.sinceDigest } : {}),
  });
  if (options.requireWorkflow && !brief.workflow.exists) {
    const error = new Error('Workflow was not found.') as Error & { code: string };
    error.code = 'WORKFLOW_NOT_FOUND';
    throw error;
  }
  if (options.format === 'json') console.log(JSON.stringify(brief, null, 2));
  else console.log(formatContextBriefText(brief));
}

let cliValues: { project?: string } = {};

const usage = `Latchkit — Your agents. One workflow.

Usage: latchkit <command> [options]

  init       Create project configuration without replacing existing settings
  doctor     Detect host runtime and provider executables on PATH
  config     Print saved project configuration
  migrate    Upgrade configuration; use --dry-run to preview
  recover    Inspect or recover an interrupted mutation
  sync       Install selected skills; use --dry-run to preview
  pack fetch Materialize selected immutable Git pack sources locally
  remove     Remove unmodified Latchkit skills; keep configuration and notes
  diagnostics Preview/export or clear local redacted diagnostics
  task       Start, inspect, import, resume, or cancel durable workflow state,
             or present/approve/note/defer/inspect the end-of-execution result
             decision (approve the result, request changes, or review later),
             or record/revise/transition/list/inspect a decision/assumption/
             observation/question knowledge record with explicit provenance,
             or reconcile-preview/reconcile-apply a structured patch to accepted
             intent records and/or criteria (deterministic impact report, then
             an explicit digest-bound apply), or context-preview a bounded,
             deterministic resumable context brief (current intent, change
             since the last dispatch, and the next allowed action; read-only)
  spec       Register/inspect/migrate/verify an enhanced spec, preview a plan-path or
             migrate-plan a durable plan, or present/approve/note/pause/build the
             end-of-spec decision (approve and build, add notes, or keep for later)
  workflow   Run, inspect, approve, resume, cancel, or context (a read-only
             resumable context brief) a delivery workflow
  self       Inspect, upgrade, roll back, or uninstall this standalone installation
  update     Narrow inspect/recovery fallback for the console updater: status, check,
             preview, stage, or roll back a compatible release (never activates on
             stage; console/API/restart handoff and automation are later slices)
  review     Run bounded independent reviews
  review     Run bounded independent reviews, or compare recorded decisions/consequences/
             evidence/approval-coverage against a comparison baseline (read-only; see issue #113)
  diff       Inspect a revision-bound Git diff or record review feedback
  acceptance Run CLI, HTTP, browser, or manual acceptance checks
  tool       Inspect or explicitly manage an optional local tool
  workspace  Inspect, create, cancel, or clean a task-owned Git worktree; view or set the workspace preference
  memory     Inspect, search, add, update, delete, export, import, or recover local project memory
  usage      Enable, inspect, import, export, retain, or delete local usage records
  verification Inspect or configure the project's default fast/standard verification mode
  schedule   Create and operate an explicit foreground local scheduler
  mcp        Preview, apply, remove, inspect, recover, or health-check optional MCP configuration
  onboarding Inspect, drive, or resume the project/provider/workflow setup wizard (CLI fallback
             for the browser console's onboarding page); prints state and exits, no prompts
  projects   List, add, or remove a project in the user-local multi-project overview registry
  spec-import Explicitly discover or preview foreign spec artifacts (Spec Kit, OpenSpec, and
             TinySpec; see issue #114) under a selected local root; discover/preview are
             read-only and create nothing. register/reinspect/detach bind a selected,
             previewed entry into existing task state (an ordinary task plus one imported
             observation record), reinspect its registered snapshot, or remove only
             Latchkit's association — never the source file
  codegraph Inspect, enable/disable, or run a bounded advisory CodeGraph exploration
  ui         Start the local configuration console (Ctrl+C to stop)

Options:
  --project <path>    Project directory (default: current directory)
  --providers <csv>   init: claude,codex,antigravity,cursor,cursor-cli; also onboarding project/providers
  --skills <csv>      init: requirements,spec,build,fix,review,handoff,setup; also onboarding project/providers
  --port <number>     ui: local port (default: automatically selected)
  --to <version>      migrate: target schema version (default: current)
  --dry-run           migrate/recover/sync: preview without writing files
  --task <id>         task: stable task identifier
  --verification-mode <mode> task/workflow: fast or standard; verification/onboarding: project default
  --expected-revision <n>  task resume/cancel/result-approve/-notes/-defer: optimistic revision;
                       also spec-import detach: optimistic registration revision
  --mutation-id <id>  task mutation: retry-safe event identifier
  --branch <name>     workspace create: explicit new branch name
  --revision <ref>    workspace create: base commit (default: HEAD)
  --mode <name>       workspace inspect/create: isolated or direct
  --worktree-root <path>  workspace inspect/create/preference/onboarding workspace: worktree root
  --execution <name>  workspace preference/onboarding workspace: ask, always-worktree, or direct
  --authorized        workspace cleanup: direct user authorization
  --provider <id>     task start/resume: provider adapter ID
  --prompt <text>     task start/resume: provider prompt
  --session <id>      task resume: prior Latchkit session ID
  --workspace-choice <name>  task start: explicit worktree or direct choice for this task
  --host-local-authorized  task start/resume: authorize host-local execution
  --export            diagnostics: export a reviewable local support bundle
  --clear             diagnostics: delete local diagnostic records
  --id <id>           memory: stable memory identifier; also projects remove: registered
                       project ID; also spec-import reinspect/detach: registration ID
                       (reinspect: all when omitted)
  --text <text>       memory: concise memory text or search query; also spec decision-notes
                       and task result-approve/-notes: notes or acceptance text
  --kind <kind>       memory add: decision, discovery, constraint, resolved-defect;
                       also task record-add/-list: decision, assumption, observation, question
  --file <path>       memory import or acceptance verify: versioned JSON file; also task
                       result-present: optional {artifactRefs, completedCriteria} JSON; also
                       task record-add/-revise: optional {links: [...]} JSON; also task
                       reconcile-preview/-apply: required reconciliation patch JSON (see
                       schemas/reconciliation-patch-v1.schema.json)
  --record <id>       task record-revise/-transition/-inspect: stable record identifier
  --record-revision <n> task record-revise/-transition: optimistic record revision
  --provenance <kind> task record-add: direct-user, agent-inferred, imported, execution-observed
  --reference <text>  task record-add: provenance reference; also schedule create: authorization
                       reference
  --status <status>   task record-transition: target kind-appropriate status; also task
                       record-list: optional status filter
  --supersedes <id>   task record-add: prior same-kind record this one explicitly supersedes
  --authorization-id <id> task record-add/-transition: existing task authorization to reference
  --limit <n>         task record-list: page size (default 50, max 200)
  --cursor <id>       task record-list: resume listing after this record ID
  --preview-digest <sha256> task reconcile-apply: exact digest from a prior reconcile-preview
  --since-digest <sha256> task context-preview/workflow context: prior brief digest to diff
                       "change since last run" against (default: the workflow's own last
                       dispatched digest, if any)
  --byte-budget <n>    task context-preview/workflow context: explicit byte budget (default
                       16384, max 262144); mandatory content that cannot fit refuses rather than
                       silently omitting a governing constraint
  --format <name>      task context-preview/workflow context: text (default, concise) or json
                       (the full brief)
  --summary <text>    spec decision-present and task result-present: concise summary
  --budget <n>        memory recover: maximum context characters
  --retention-days <n> usage enable/retain: bounded local retention (1-365 days)
  --provider-version <version> usage import: documented provider version for the event
  --authorized        mcp apply: explicitly authorize the exact enabled definitions in --file
  --provider <id>     memory recover: provider contract to evaluate
  --path <path>       diff annotation: project-relative file path
  --line <number>     diff annotation: one-based line
  --side <side>       diff annotation: left or right
  --body <text>       diff annotation text
  --expected-revision <id>  diff annotate: revision returned by inspect
  --evidence-id <id>  diff resolve: current task evidence ID; also task record-transition:
                       current passing evidence required to mark an observation verified
  --reason <text>     task cancel: cancellation reason; also task record-revise (optional)
                       and task record-transition (required): reason for the change
  --review-provider <id> workflow: explicit independent reviewer (default: selected provider)
  --result-ref <text>  task result-present: link/path to the reviewable diff or result
  --result-digest <sha256> task result-present/-approve/-notes: exact reviewed-snapshot digest
  --verification-results <text> task result-present: actual verification results shown to the user
  --remaining-gaps <text> task result-present: known remaining gaps (omit for none)
  --change-scope <kind> task result-notes: in-scope (default) or new-scope feedback
  --plan-digest <sha256> workflow approve: exact plan digest from inspect
  --requirements-digest <sha256> workflow approve: exact requirements digest
  --checks-digest <sha256> workflow approve: exact acceptance-check digest
  --authorization-scope <text> workflow approve: permitted changes; also task record-add/
                       -transition: grant a new authorization instead of --authorization-id
  --authorization-reference <text> workflow approve: direct approval reference; also task
                       record-add/-transition: reference for a newly granted authorization
  --resolution <decision> workflow resume: observed, abandon, or retry an interrupted action
  --action-id <id>    workflow resume: interrupted action being resolved
  --file <path>       workflow run: versioned acceptance checks
  --title <text>      spec plan-path: desired plan title used to derive the filename; also
                      projects add: optional display name (default: the folder name)
  --from <path>       spec migrate-plan: legacy .latchkit/notes/ source to migrate
  --to <path>         spec migrate-plan: explicit docs/plans/ destination (default: derived)
  --timezone <iana>   schedule create/edit: IANA timezone
  --every-minutes <n> schedule create/edit: recurrence interval
  --scope <text>      schedule create: authorized task scope
  --reference <text>  schedule create: authorization reference
  --install-root <path> self/update: user-local installation directory
  --to <version>      self upgrade/rollback and update rollback: exact release version
  --bundle <path>     self install/upgrade: extracted local bundle
  --archive <path>    tool fcc preview/install: pinned local FCC archive
  --tool-root <path>  tool fcc: recorded user-local FCC tool directory
  --python <path>     tool fcc install: explicit Python 3.14+ runtime
  --uv <path>         tool fcc install: explicit uv 0.11.16+ lock installer
  --root <path>       spec-import: local root to scan (contains a "specs" directory); for
                       register, must be the Latchkit project or a subdirectory of it
  --adapter <id>      spec-import: adapter ID ("spec-kit", "openspec", or "tinyspec")
  --entry <id>        spec-import register: the entry ID selected from a prior preview
  --manifest-digest <sha256> spec-import register: exact manifestDigest from that preview
  --source-sha256 <sha256> spec-import register: exact wouldCreate[].importSource.sha256
                       for --entry from that same preview
  --expected-task-revision <n> spec-import register: required when updating an
                       already-registered entry (see spec-import reinspect)
  --review-id <id>    review inspect/cancel: review ID
  --format <kind>     review compare: json (default) or text
  --baseline-revision <n> review compare: an explicitly selected retained task revision to
                      compare against, in place of the derived previously reviewed snapshot
  --help             Show this help
  --version          Show version

Providers handle their own login, subscription, and permissions.
Delivery workflows require plan approval, verified changes, independent review, and handoff.
`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: 'string' },
      providers: { type: 'string' },
      skills: { type: 'string' },
      port: { type: 'string' },
      to: { type: 'string' },
      from: { type: 'string' },
      'dry-run': { type: 'boolean' },
      task: { type: 'string' },
      'expected-revision': { type: 'string' },
      'mutation-id': { type: 'string' },
      owner: { type: 'string' },
      reason: { type: 'string' },
      note: { type: 'string' },
      title: { type: 'string' },
      branch: { type: 'string' },
      revision: { type: 'string' },
      mode: { type: 'string' },
      'verification-mode': { type: 'string' },
      'worktree-root': { type: 'string' },
      'workspace-choice': { type: 'string' },
      execution: { type: 'string' },
      authorized: { type: 'boolean' },
      'authorization-scope': { type: 'string' },
      'authorization-reference': { type: 'string' },
      prompt: { type: 'string' },
      session: { type: 'string' },
      'host-local-authorized': { type: 'boolean' },
      query: { type: 'string' },
      help: { type: 'boolean' },
      version: { type: 'boolean' },
      export: { type: 'boolean' },
      clear: { type: 'boolean' },
      id: { type: 'string' },
      text: { type: 'string' },
      kind: { type: 'string' },
      file: { type: 'string' },
      budget: { type: 'string' },
      provider: { type: 'string' },
      path: { type: 'string' },
      line: { type: 'string' },
      side: { type: 'string' },
      body: { type: 'string' },
      annotation: { type: 'string' },
      'expected-store-revision': { type: 'string' },
      'evidence-revision': { type: 'string' },
      'evidence-id': { type: 'string' },
      base: { type: 'string' },
      'review-provider': { type: 'string' },
      'plan-digest': { type: 'string' },
      'plan-ref': { type: 'string' },
      summary: { type: 'string' },
      'result-ref': { type: 'string' },
      'result-digest': { type: 'string' },
      'verification-results': { type: 'string' },
      'remaining-gaps': { type: 'string' },
      'change-scope': { type: 'string' },
      'requirements-digest': { type: 'string' },
      'checks-digest': { type: 'string' },
      resolution: { type: 'string' },
      'action-id': { type: 'string' },
      'install-root': { type: 'string' },
      bundle: { type: 'string' },
      'retention-days': { type: 'string' },
      'provider-version': { type: 'string' },
      timezone: { type: 'string' },
      'every-minutes': { type: 'string' },
      scope: { type: 'string' },
      reference: { type: 'string' },
      'timeout-ms': { type: 'string' },
      'output-limit-bytes': { type: 'string' },
      'max-runs': { type: 'string' },
      archive: { type: 'string' },
      'tool-root': { type: 'string' },
      python: { type: 'string' },
      uv: { type: 'string' },
      record: { type: 'string' },
      'record-revision': { type: 'string' },
      provenance: { type: 'string' },
      status: { type: 'string' },
      supersedes: { type: 'string' },
      'authorization-id': { type: 'string' },
      limit: { type: 'string' },
      cursor: { type: 'string' },
      root: { type: 'string' },
      adapter: { type: 'string' },
      'preview-digest': { type: 'string' },
      entry: { type: 'string' },
      'manifest-digest': { type: 'string' },
      'source-sha256': { type: 'string' },
      'expected-task-revision': { type: 'string' },
      format: { type: 'string' },
      'baseline-revision': { type: 'string' },
      'review-id': { type: 'string' },
      'since-digest': { type: 'string' },
      'byte-budget': { type: 'string' },
    },
  });
  cliValues = values;
  if (values.version) console.log(VERSION);
  else if (values.help || positionals.length === 0) console.log(usage);
  else {
    const [command, ...extra] = positionals;
    if (!command) throw new Error('A command is required.');
    if (
      ![
        'task',
        'spec',
        'workflow',
        'self',
        'workspace',
        'review',
        'memory',
        'usage',
        'verification',
        'mcp',
        'acceptance',
        'diff',
        'pack',
        'schedule',
        'tool',
        'onboarding',
        'projects',
        'spec-import',
        'update',
      ].includes(command) &&
      extra.length
    )
      throw new Error('Only one command is supported at a time.');
    const allowedByCommand: Record<string, string[]> = {
      init: ['project', 'providers', 'skills'],
      doctor: ['project'],
      config: ['project'],
      migrate: ['project', 'to', 'dry-run'],
      recover: ['project', 'dry-run'],
      sync: ['project', 'dry-run'],
      remove: ['project'],
      ui: ['project', 'port'],
      diagnostics: ['project', 'export', 'clear'],
      self: ['install-root', 'to', 'bundle'],
      update: ['install-root', 'to'],
      tool: ['archive', 'tool-root', 'python', 'uv'],
      workflow: [
        'project',
        'task',
        'provider',
        'review-provider',
        'prompt',
        'host-local-authorized',
        'expected-revision',
        'mutation-id',
        'plan-digest',
        'requirements-digest',
        'checks-digest',
        'authorization-scope',
        'authorization-reference',
        'resolution',
        'action-id',
        'evidence-id',
        'file',
        'verification-mode',
        'since-digest',
        'byte-budget',
        'format',
      ],
      task: [
        'project',
        'task',
        'expected-revision',
        'mutation-id',
        'owner',
        'reason',
        'note',
        'title',
        'authorization-scope',
        'authorization-reference',
        'provider',
        'prompt',
        'session',
        'host-local-authorized',
        'verification-mode',
        'workspace-choice',
        'worktree-root',
        'result-ref',
        'result-digest',
        'summary',
        'file',
        'verification-results',
        'remaining-gaps',
        'change-scope',
        'text',
        'kind',
        'record',
        'record-revision',
        'provenance',
        'reference',
        'status',
        'supersedes',
        'authorization-id',
        'evidence-id',
        'limit',
        'cursor',
        'preview-digest',
        'since-digest',
        'byte-budget',
        'format',
      ],
      spec: [
        'project',
        'task',
        'expected-revision',
        'mutation-id',
        'file',
        'dry-run',
        'plan-digest',
        'plan-ref',
        'summary',
        'text',
        'scope',
        'reference',
        'from',
        'to',
        'title',
      ],
      review: [
        'project',
        'task',
        'provider',
        'prompt',
        'host-local-authorized',
        'format',
        'baseline-revision',
        'review-id',
      ],
      diff: [
        'project',
        'task',
        'path',
        'line',
        'side',
        'body',
        'annotation',
        'expected-revision',
        'expected-store-revision',
        'evidence-revision',
        'evidence-id',
        'base',
      ],
      acceptance: ['project', 'task', 'file', 'host-local-authorized'],
      workspace: [
        'project',
        'task',
        'branch',
        'revision',
        'mode',
        'authorized',
        'worktree-root',
        'execution',
      ],
      memory: [
        'project',
        'id',
        'text',
        'kind',
        'title',
        'file',
        'budget',
        'provider',
        'expected-revision',
      ],
      usage: [
        'project',
        'provider',
        'provider-version',
        'file',
        'task',
        'session',
        'retention-days',
      ],
      verification: ['project', 'verification-mode'],
      pack: ['project', 'id'],
      schedule: [
        'project',
        'id',
        'provider',
        'prompt',
        'timezone',
        'every-minutes',
        'scope',
        'reference',
        'host-local-authorized',
        'timeout-ms',
        'output-limit-bytes',
        'max-runs',
        'expected-revision',
      ],
      mcp: ['project', 'file', 'authorized', 'dry-run', 'id'],
      onboarding: [
        'project',
        'providers',
        'skills',
        'execution',
        'worktree-root',
        'verification-mode',
      ],
      projects: ['project', 'id', 'title'],
      'spec-import': [
        'project',
        'root',
        'adapter',
        'entry',
        'manifest-digest',
        'source-sha256',
        'expected-task-revision',
        'id',
        'expected-revision',
      ],
      codegraph: ['project', 'query'],
    };
    const allowed = allowedByCommand[command];
    if (!allowed) throw new Error(`Unknown command: ${command}. Run latchkit --help.`);
    for (const option of Object.keys(values))
      if (!allowed.includes(option)) throw new Error(`--${option} is not valid for ${command}.`);
    const root = path.resolve(values.project ?? process.cwd());
    const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
    if (command === 'tool') {
      if (
        extra.length !== 2 ||
        extra[0] !== 'fcc' ||
        !['inspect', 'preview', 'install', 'start', 'stop', 'remove', 'recover'].includes(
          extra[1] ?? '',
        )
      )
        throw new Error(
          'Usage: latchkit tool fcc <inspect|preview|install|start|stop|remove|recover> [--archive <path>] [--python <path>] [--uv <path>] [--tool-root <path>].',
        );
      const fcc = await import('./managed-tools/fcc.js');
      const options = {
        ...(values.archive ? { archive: path.resolve(values.archive) } : {}),
        ...(values.python ? { python: path.resolve(values.python) } : {}),
        ...(values.uv ? { uv: path.resolve(values.uv) } : {}),
        ...(values['tool-root'] ? { root: path.resolve(values['tool-root']) } : {}),
      };
      const action = extra[1];
      print(
        action === 'inspect'
          ? await fcc.inspectFcc(options)
          : action === 'preview'
            ? await fcc.previewFccInstall(options)
            : action === 'install'
              ? await fcc.installFcc(options)
              : action === 'start'
                ? await fcc.startFcc(options)
                : action === 'stop'
                  ? await fcc.stopFcc(options)
                  : action === 'recover'
                    ? await fcc.recoverFcc(options)
                    : await fcc.removeFcc(options),
      );
    } else if (command === 'self') {
      const action = extra[0];
      if (
        extra.length !== 1 ||
        !action ||
        !['inspect', 'install', 'upgrade', 'rollback', 'uninstall'].includes(action)
      )
        throw new Error(
          'Usage: latchkit self <inspect|install|upgrade|rollback|uninstall> [options].',
        );
      const { runInstallationManager } = await import('./installation/manager.js');
      print(
        await runInstallationManager({
          command: action as 'inspect' | 'install' | 'upgrade' | 'rollback' | 'uninstall',
          root:
            values['install-root'] ??
            requiredOption(process.env.LATCHKIT_INSTALL_ROOT, 'install-root'),
          version: values.to,
          bundle: values.bundle,
        }),
      );
      // Narrow inspect/recovery CLI fallback for the update service (issue
      // #139 slice 1). The authenticated local API and console are later
      // slices; this exists so an operator (or a script) can inspect update
      // settings/status, check the official release source, preview and
      // stage a compatible update, or roll back without either surface.
    } else if (command === 'update') {
      const action = extra[0];
      if (
        extra.length !== 1 ||
        !action ||
        !['status', 'check', 'preview', 'stage', 'rollback'].includes(action)
      )
        throw new Error('Usage: latchkit update <status|check|preview|stage|rollback> [options].');
      const installRoot =
        values['install-root'] ?? requiredOption(process.env.LATCHKIT_INSTALL_ROOT, 'install-root');
      const updates = await import('./installation/updates/service.js');
      if (action === 'status') print(await updates.inspectUpdateStatus(installRoot));
      else if (action === 'check') print(await updates.checkForUpdates(installRoot));
      else if (action === 'preview') print(await updates.previewUpdate(installRoot));
      else if (action === 'stage') {
        // A narrow CLI convenience: perform a fresh check, bind a preview,
        // and stage it in one step. The service module's `previewUpdate`/
        // `stageUpdate` split still exists for a future console/API that
        // shows the preview before an operator confirms staging.
        const preview = await updates.previewUpdate(installRoot);
        print(await updates.stageUpdate(installRoot, preview));
      } else {
        print(await updates.rollbackUpdate(installRoot, requiredOption(values.to, 'to')));
      }
    } else if (command === 'init') {
      const initialized = await initProject(root, {
        ...(values.providers !== undefined
          ? { providers: values.providers.split(',').filter(Boolean) }
          : {}),
        ...(values.skills !== undefined
          ? { skills: values.skills.split(',').filter(Boolean) }
          : {}),
      });
      print(initialized);
      // Multi-project overview (issue #94): capture every project a user initializes. A
      // registry write failure never fails `init` itself; see docs/projects.md.
      await registerProject(defaultProjectsRegistryRoot(), { root, source: 'init' }).catch(
        () => {},
      );
    } else if (command === 'doctor') print(await doctor(root));
    else if (command === 'config') print(await readConfig(root));
    else if (command === 'migrate') {
      const options = values.to === undefined ? {} : { toVersion: values.to };
      print(
        await (values['dry-run']
          ? planConfigMigration(root, options)
          : migrateConfig(root, options)),
      );
    } else if (command === 'recover')
      print(await (values['dry-run'] ? inspectRecovery(root) : recoverProject(root)));
    else if (command === 'sync') {
      const result = await (values['dry-run'] ? planSync(root) : syncProject(root));
      print(result);
      if (result.conflicts.length) process.exitCode = 1;
    } else if (command === 'pack') {
      if (extra.length !== 1 || extra[0] !== 'fetch')
        throw new Error('Usage: latchkit pack fetch [--project <path>] [--id <pack-id>].');
      print(await materializePackSource(root, { ...(values.id ? { id: values.id } : {}) }));
    } else if (command === 'remove') print(await removeProjectSkills(root));
    else if (command === 'diagnostics') {
      if (values.clear) {
        const { clearDiagnostics } = await import('./diagnostics/logger.js');
        print(await clearDiagnostics(root));
      } else if (values.export) print(await exportSupportBundle(root));
      else print(await previewSupportBundle(root));
    } else if (command === 'workflow') {
      const action = extra[0];
      if (
        extra.length !== 1 ||
        !action ||
        !['run', 'inspect', 'approve', 'resume', 'cancel', 'context'].includes(action)
      )
        throw new Error(
          'Usage: latchkit workflow <run|inspect|approve|resume|cancel|context> [options].',
        );
      if (action === 'context') {
        // Read-only (issue #112): never creates a controller, never starts a provider.
        await printContextBrief({
          root,
          taskId: requiredOption(values.task, 'task'),
          byteBudget: parseByteBudgetOption(values['byte-budget']),
          ...(values['since-digest'] !== undefined ? { sinceDigest: values['since-digest'] } : {}),
          format: requireContextBriefFormat(values.format),
          requireWorkflow: true,
        });
      } else {
        const { createWorkflowController } = await import('./workflows/service.js');
        const controller = createWorkflowController({ root });
        const shutdown = () => {
          void controller.shutdown();
        };
        for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, shutdown);
        try {
          if (action === 'inspect') {
            if (values.task) print(await controller.inspect(values.task));
            else
              print({
                workflows: await (await import('./workflows/store.js')).listWorkflows(root),
              });
          } else {
            const expectedRevision =
              values['expected-revision'] === undefined
                ? undefined
                : Number(values['expected-revision']);
            if (
              (action !== 'run' || values.task) &&
              (!Number.isInteger(expectedRevision) || (expectedRevision ?? 0) < 1)
            )
              throw new Error('Send --expected-revision with the current workflow revision.');
            const common = { expectedRevision, mutationId: values['mutation-id'] };
            let result;
            if (action === 'run') {
              if (
                values['verification-mode'] !== undefined &&
                !['fast', 'standard'].includes(values['verification-mode'])
              )
                throw new Error('--verification-mode must be fast or standard.');
              result = await controller.run({
                ...common,
                taskId: values.task,
                providerId: requiredOption(values.provider, 'provider'),
                reviewProviderId: values['review-provider'],
                prompt: values.prompt,
                executionAuthorized: values['host-local-authorized'] === true,
                ...(values['verification-mode']
                  ? { verificationMode: values['verification-mode'] as 'fast' | 'standard' }
                  : {}),
                ...(values.file
                  ? {
                      checksDocument: JSON.parse(
                        await readFile(path.resolve(requiredOption(values.file, 'file')), 'utf8'),
                      ) as unknown,
                    }
                  : {}),
              });
            } else if (action === 'approve') {
              result = await controller.approve({
                ...common,
                expectedRevision: expectedRevision!,
                taskId: requiredOption(values.task, 'task'),
                planDigest: requiredOption(values['plan-digest'], 'plan-digest'),
                requirementsDigest: requiredOption(
                  values['requirements-digest'],
                  'requirements-digest',
                ),
                checksDigest: requiredOption(values['checks-digest'], 'checks-digest'),
                scope: requiredOption(values['authorization-scope'], 'authorization-scope'),
                reference: requiredOption(
                  values['authorization-reference'],
                  'authorization-reference',
                ),
              });
            } else if (action === 'resume') {
              const decision = values.resolution;
              if (decision && !['observed', 'abandon', 'retry'].includes(decision))
                throw new Error('--resolution must be observed, abandon, or retry.');
              result = await controller.resume({
                ...common,
                expectedRevision: expectedRevision!,
                taskId: requiredOption(values.task, 'task'),
                prompt: values.prompt,
                executionAuthorized: values['host-local-authorized'] === true,
                ...(decision
                  ? {
                      resolution: {
                        actionId: requiredOption(values['action-id'], 'action-id'),
                        decision: decision as 'observed' | 'abandon' | 'retry',
                        ...(decision === 'observed'
                          ? { evidenceId: requiredOption(values['evidence-id'], 'evidence-id') }
                          : {}),
                      },
                    }
                  : {}),
              });
            } else
              result = await controller.cancel({
                ...common,
                expectedRevision: expectedRevision!,
                taskId: requiredOption(values.task, 'task'),
              });
            print(result);
            if (action === 'run')
              await registerProject(defaultProjectsRegistryRoot(), {
                root,
                source: 'task-run',
              }).catch(() => {});
            if (action !== 'cancel') {
              const final = await controller.wait(result.taskId);
              if (final.revision !== result.revision) print(final);
              if (['blocked', 'interrupted'].includes(final.status)) process.exitCode = 1;
            }
          }
        } finally {
          for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, shutdown);
          await controller.shutdown();
        }
      }
    } else if (command === 'task') {
      const taskActions = [
        'start',
        'inspect',
        'import',
        'resume',
        'cancel',
        'mode',
        'result-present',
        'result-approve',
        'result-notes',
        'result-defer',
        'result-inspect',
        'record-add',
        'record-revise',
        'record-transition',
        'record-list',
        'record-inspect',
        'reconcile-preview',
        'reconcile-apply',
        'context-preview',
      ];
      if (extra.length !== 1 || !taskActions.includes(extra[0] ?? '')) {
        throw new Error(`Usage: latchkit task <${taskActions.join('|')}> [options].`);
      }
      const action = extra[0];
      const expectedRevision =
        values['expected-revision'] === undefined ? undefined : Number(values['expected-revision']);
      if (
        expectedRevision !== undefined &&
        (!Number.isInteger(expectedRevision) || expectedRevision < 1)
      ) {
        throw new Error('--expected-revision must be a positive integer.');
      }
      if (action === 'mode') {
        const requestedMode = requiredOption(values['verification-mode'], 'verification-mode');
        if (!['fast', 'standard'].includes(requestedMode))
          throw new Error('--verification-mode must be fast or standard.');
        if (expectedRevision === undefined)
          throw new Error('task mode requires --expected-revision.');
        print(
          await setVerificationMode(root, {
            taskId: requiredOption(values.task, 'task'),
            expectedRevision,
            verificationMode: requestedMode as 'fast' | 'standard',
            ...(values['mutation-id'] ? { mutationId: values['mutation-id'] } : {}),
          }),
        );
      } else if (action === 'inspect')
        print(values.task ? await inspectTask(root, values.task) : await listTasks(root));
      else if (action === 'start') {
        if (!values.provider) throw new Error('task start requires --provider.');
        if (
          values['workspace-choice'] !== undefined &&
          !['worktree', 'direct'].includes(values['workspace-choice'])
        )
          throw new Error('--workspace-choice must be worktree or direct.');
        print(
          await createTaskController({ root }).start({
            taskId: requiredOption(values.task, 'task'),
            providerId: values.provider,
            prompt: values.prompt,
            expectedRevision,
            mutationId: values['mutation-id'],
            executionAuthorized: values['host-local-authorized'] === true,
            ...(values['workspace-choice']
              ? { workspaceChoice: values['workspace-choice'] as 'worktree' | 'direct' }
              : {}),
            ...(values['worktree-root'] ? { worktreeRoot: values['worktree-root'] } : {}),
          }),
        );
        await registerProject(defaultProjectsRegistryRoot(), { root, source: 'task-run' }).catch(
          () => {},
        );
      } else if (action === 'resume' && (values.provider || values.session)) {
        if (!values.session) throw new Error('Provider session resume requires --session.');
        print(
          await createTaskController({ root }).resume({
            taskId: requiredOption(values.task, 'task'),
            sessionId: values.session,
            prompt: values.prompt,
            expectedRevision,
            mutationId: values['mutation-id'],
            executionAuthorized: values['host-local-authorized'] === true,
          }),
        );
      } else if (action === 'resume') {
        if (!values.task || expectedRevision === undefined)
          throw new Error('task resume requires --task and --expected-revision.');
        print(
          await resumeTask(root, {
            taskId: requiredOption(values.task, 'task'),
            expectedRevision,
            ...(values['mutation-id'] ? { mutationId: values['mutation-id'] } : {}),
            ...(values.owner ? { ownerId: values.owner } : {}),
          }),
        );
      } else if (action === 'cancel')
        print(
          (
            await createTaskController({ root }).cancel({
              taskId: requiredOption(values.task, 'task'),
              expectedRevision,
              ...(values['mutation-id'] ? { mutationId: values['mutation-id'] } : {}),
              ...(values.reason ? { reason: values.reason } : {}),
            })
          ).task,
        );
      else if (action === 'result-inspect')
        print(await inspectResultDecision(root, requiredOption(values.task, 'task')));
      else if (action === 'result-present') {
        let artifactRefs: unknown;
        let completedCriteria: unknown;
        if (values.file) {
          const bytes = await readFile(path.resolve(values.file));
          if (bytes.byteLength > 64 * 1024)
            throw new Error('Result decision input exceeds 64 KiB.');
          let document: unknown;
          try {
            document = JSON.parse(bytes.toString('utf8'));
          } catch {
            throw new Error('Result decision input must be valid JSON.');
          }
          if (!document || typeof document !== 'object' || Array.isArray(document))
            throw new Error('Result decision input must be an object.');
          artifactRefs = (document as { artifactRefs?: unknown }).artifactRefs;
          completedCriteria = (document as { completedCriteria?: unknown }).completedCriteria;
        }
        print(
          await presentResultDecision(root, {
            taskId: requiredOption(values.task, 'task'),
            resultRef: requiredOption(values['result-ref'], 'result-ref'),
            resultDigest: requiredOption(values['result-digest'], 'result-digest'),
            summary: requiredOption(values.summary, 'summary'),
            verificationResults: requiredOption(
              values['verification-results'],
              'verification-results',
            ),
            ...(values['remaining-gaps'] !== undefined
              ? { remainingGaps: values['remaining-gaps'] }
              : {}),
            ...(artifactRefs !== undefined ? { artifactRefs: artifactRefs as string[] } : {}),
            ...(completedCriteria !== undefined
              ? { completedCriteria: completedCriteria as string[] }
              : {}),
            ...(values['mutation-id'] ? { mutationId: values['mutation-id'] } : {}),
          }),
        );
      } else if (['result-approve', 'result-notes', 'result-defer'].includes(action ?? '')) {
        if (expectedRevision === undefined)
          throw new Error('task result-approve/-notes/-defer requires --expected-revision.');
        const common = {
          taskId: requiredOption(values.task, 'task'),
          expectedRevision,
          ...(values['mutation-id'] ? { mutationId: values['mutation-id'] } : {}),
        };
        if (action === 'result-approve')
          print(
            await approveResultDecision(root, {
              ...common,
              resultDigest: requiredOption(values['result-digest'], 'result-digest'),
              ...(values.text !== undefined ? { note: values.text } : {}),
            }),
          );
        else if (action === 'result-notes') {
          const changeScope = values['change-scope'] ?? 'in-scope';
          if (!['in-scope', 'new-scope'].includes(changeScope))
            throw new Error('--change-scope must be in-scope or new-scope.');
          print(
            await addResultDecisionNotes(root, {
              ...common,
              notes: requiredOption(values.text, 'text'),
              resultDigest: requiredOption(values['result-digest'], 'result-digest'),
              changeScope: changeScope as 'in-scope' | 'new-scope',
              ...(changeScope === 'new-scope'
                ? {
                    scopeAuthorization: {
                      scope: requiredOption(values['authorization-scope'], 'authorization-scope'),
                      reference: requiredOption(
                        values['authorization-reference'],
                        'authorization-reference',
                      ),
                    },
                  }
                : {}),
            }),
          );
        } else print(await deferResultDecision(root, common));
      } else if (action === 'record-add') {
        if (expectedRevision === undefined)
          throw new Error('task record-add requires --expected-revision.');
        const links = await readLinksFile(values.file);
        const hasNewAuthorization =
          values['authorization-scope'] !== undefined ||
          values['authorization-reference'] !== undefined;
        print(
          await recordTaskRecord(root, {
            taskId: requiredOption(values.task, 'task'),
            expectedRevision,
            kind: requiredOption(values.kind, 'kind') as RecordKind,
            text: requiredOption(values.text, 'text'),
            provenance: {
              kind: requiredOption(values.provenance, 'provenance') as RecordProvenanceKind,
              reference: requiredOption(values.reference, 'reference'),
            },
            ...(links !== undefined ? { links: links as RecordLinkInput[] } : {}),
            ...(values.supersedes ? { supersedes: values.supersedes } : {}),
            ...(values['authorization-id'] ? { authorizationId: values['authorization-id'] } : {}),
            ...(hasNewAuthorization
              ? {
                  authorization: {
                    source: 'user',
                    scope: requiredOption(values['authorization-scope'], 'authorization-scope'),
                    reference: requiredOption(
                      values['authorization-reference'],
                      'authorization-reference',
                    ),
                    provenanceKind: 'explicit-cli' as const,
                  },
                }
              : {}),
            ...(values['mutation-id'] ? { mutationId: values['mutation-id'] } : {}),
          }),
        );
      } else if (action === 'record-revise') {
        if (expectedRevision === undefined)
          throw new Error('task record-revise requires --expected-revision.');
        const recordRevision = Number(requiredOption(values['record-revision'], 'record-revision'));
        if (!Number.isInteger(recordRevision) || recordRevision < 1)
          throw new Error('--record-revision must be a positive integer.');
        const links = await readLinksFile(values.file);
        print(
          await reviseTaskRecord(root, {
            taskId: requiredOption(values.task, 'task'),
            expectedRevision,
            recordId: requiredOption(values.record, 'record'),
            recordRevision,
            ...(values.text !== undefined ? { text: values.text } : {}),
            ...(links !== undefined ? { links: links as RecordLinkInput[] } : {}),
            ...(values.reason !== undefined ? { reason: values.reason } : {}),
            ...(values['mutation-id'] ? { mutationId: values['mutation-id'] } : {}),
          }),
        );
      } else if (action === 'record-transition') {
        if (expectedRevision === undefined)
          throw new Error('task record-transition requires --expected-revision.');
        const recordRevision = Number(requiredOption(values['record-revision'], 'record-revision'));
        if (!Number.isInteger(recordRevision) || recordRevision < 1)
          throw new Error('--record-revision must be a positive integer.');
        const hasNewAuthorization =
          values['authorization-scope'] !== undefined ||
          values['authorization-reference'] !== undefined;
        print(
          await transitionTaskRecord(root, {
            taskId: requiredOption(values.task, 'task'),
            expectedRevision,
            recordId: requiredOption(values.record, 'record'),
            recordRevision,
            status: requiredOption(values.status, 'status'),
            reason: requiredOption(values.reason, 'reason'),
            ...(values['authorization-id'] ? { authorizationId: values['authorization-id'] } : {}),
            ...(hasNewAuthorization
              ? {
                  authorization: {
                    source: 'user',
                    scope: requiredOption(values['authorization-scope'], 'authorization-scope'),
                    reference: requiredOption(
                      values['authorization-reference'],
                      'authorization-reference',
                    ),
                    provenanceKind: 'explicit-cli' as const,
                  },
                }
              : {}),
            ...(values['evidence-id'] ? { evidenceId: values['evidence-id'] } : {}),
            ...(values['mutation-id'] ? { mutationId: values['mutation-id'] } : {}),
          }),
        );
      } else if (action === 'record-list') {
        const limit = values.limit === undefined ? undefined : Number(values.limit);
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
          throw new Error('--limit must be a positive integer.');
        print(
          await listTaskRecords(root, {
            taskId: requiredOption(values.task, 'task'),
            ...(values.kind ? { kind: values.kind as RecordKind } : {}),
            ...(values.status ? { status: values.status } : {}),
            ...(limit !== undefined ? { limit } : {}),
            ...(values.cursor ? { cursor: values.cursor } : {}),
          }),
        );
      } else if (action === 'record-inspect') {
        print(
          await inspectTaskRecord(root, {
            taskId: requiredOption(values.task, 'task'),
            recordId: requiredOption(values.record, 'record'),
          }),
        );
      } else if (action === 'reconcile-preview') {
        const patch = await readReconciliationPatchFile(values.file);
        print(
          await previewTaskReconciliation(root, {
            taskId: requiredOption(values.task, 'task'),
            patch,
          }),
        );
      } else if (action === 'reconcile-apply') {
        if (expectedRevision === undefined)
          throw new Error('task reconcile-apply requires --expected-revision.');
        const patch = await readReconciliationPatchFile(values.file);
        print(
          await applyTaskReconciliation(root, {
            taskId: requiredOption(values.task, 'task'),
            expectedRevision,
            patch,
            previewDigest: requiredOption(values['preview-digest'], 'preview-digest'),
            ...(values['mutation-id'] ? { mutationId: values['mutation-id'] } : {}),
          }),
        );
      } else if (action === 'context-preview') {
        await printContextBrief({
          root,
          taskId: requiredOption(values.task, 'task'),
          byteBudget: parseByteBudgetOption(values['byte-budget']),
          ...(values['since-digest'] !== undefined ? { sinceDigest: values['since-digest'] } : {}),
          format: requireContextBriefFormat(values.format),
        });
      } else {
        const hasAuthorization =
          values['authorization-scope'] !== undefined ||
          values['authorization-reference'] !== undefined;
        if (
          hasAuthorization &&
          (!values['authorization-scope'] || !values['authorization-reference'])
        ) {
          throw new Error(
            'Import authorization requires both --authorization-scope and --authorization-reference.',
          );
        }
        if (
          values['verification-mode'] !== undefined &&
          !['fast', 'standard'].includes(values['verification-mode'])
        )
          throw new Error('--verification-mode must be fast or standard.');
        print(
          await importMarkdownTask(root, {
            notePath: values.note,
            title: requiredOption(values.title, 'title'),
            ...(values['mutation-id'] ? { mutationId: values['mutation-id'] } : {}),
            ...(values['verification-mode']
              ? { verificationMode: values['verification-mode'] as 'fast' | 'standard' }
              : {}),
            ...(hasAuthorization
              ? {
                  authorization: {
                    source: 'user',
                    scope: requiredOption(values['authorization-scope'], 'authorization-scope'),
                    reference: requiredOption(
                      values['authorization-reference'],
                      'authorization-reference',
                    ),
                    provenanceKind: 'explicit-cli',
                  },
                }
              : {}),
          }),
        );
      }
    } else if (command === 'spec') {
      const specActions = [
        'register',
        'update',
        'inspect',
        'migrate',
        'verify',
        'decision-present',
        'decision-approve',
        'decision-notes',
        'decision-pause',
        'decision-build',
        'decision-inspect',
        'plan-path',
        'migrate-plan',
      ];
      if (extra.length !== 1 || !specActions.includes(extra[0] ?? ''))
        throw new Error(`Usage: latchkit spec <${specActions.join('|')}> [options].`);
      const action = extra[0];
      if (action === 'migrate') print(await migrateTaskState(root, { dryRun: values['dry-run'] }));
      else if (action === 'plan-path')
        print({
          path: await resolveCollisionSafePlanPath(root, requiredOption(values.title, 'title')),
        });
      else if (action === 'migrate-plan')
        print(
          await migrateLegacyPlan(root, {
            from: requiredOption(values.from, 'from'),
            ...(values.to ? { to: values.to } : {}),
            dryRun: values['dry-run'] === true,
          }),
        );
      else if (action === 'inspect')
        print((await inspectTask(root, requiredOption(values.task, 'task'))).task.enhancedWorkflow);
      else if (action === 'decision-inspect')
        print(await inspectSpecDecision(root, requiredOption(values.task, 'task')));
      else if (action === 'decision-present')
        print(
          await presentSpecDecision(root, {
            taskId: requiredOption(values.task, 'task'),
            planRef: requiredOption(values['plan-ref'], 'plan-ref'),
            planDigest: requiredOption(values['plan-digest'], 'plan-digest'),
            summary: requiredOption(values.summary, 'summary'),
            ...(values['mutation-id'] ? { mutationId: values['mutation-id'] } : {}),
          }),
        );
      else if (
        ['decision-approve', 'decision-notes', 'decision-pause', 'decision-build'].includes(
          action ?? '',
        )
      ) {
        const expectedRevision = Number(
          requiredOption(values['expected-revision'], 'expected-revision'),
        );
        if (!Number.isInteger(expectedRevision) || expectedRevision < 1)
          throw new Error('--expected-revision must be a positive integer.');
        const common = {
          taskId: requiredOption(values.task, 'task'),
          expectedRevision,
          ...(values['mutation-id'] ? { mutationId: values['mutation-id'] } : {}),
        };
        if (action === 'decision-approve')
          print(
            await approveSpecDecision(root, {
              ...common,
              planDigest: requiredOption(values['plan-digest'], 'plan-digest'),
              scope: requiredOption(values.scope, 'scope'),
              reference: requiredOption(values.reference, 'reference'),
            }),
          );
        else if (action === 'decision-notes')
          print(
            await addSpecDecisionNotes(root, {
              ...common,
              notes: requiredOption(values.text, 'text'),
              planDigest: requiredOption(values['plan-digest'], 'plan-digest'),
              ...(values['plan-ref'] ? { planRef: values['plan-ref'] } : {}),
            }),
          );
        else if (action === 'decision-pause') print(await pauseSpecDecision(root, common));
        else print(await markSpecBuildStarted(root, common));
      } else {
        const expectedRevision = Number(
          requiredOption(values['expected-revision'], 'expected-revision'),
        );
        if (!Number.isInteger(expectedRevision) || expectedRevision < 1)
          throw new Error('--expected-revision must be a positive integer.');
        if (action === 'verify')
          print(
            await verifyTask(root, {
              taskId: requiredOption(values.task, 'task'),
              expectedRevision,
              ...(values['mutation-id'] ? { mutationId: values['mutation-id'] } : {}),
            }),
          );
        else {
          const bytes = await readFile(path.resolve(requiredOption(values.file, 'file')));
          if (bytes.byteLength > 64 * 1024)
            throw new Error('Enhanced specification input exceeds 64 KiB.');
          let document: unknown;
          try {
            document = JSON.parse(bytes.toString('utf8'));
          } catch {
            throw new Error('Enhanced specification input must be valid JSON.');
          }
          if (!document || typeof document !== 'object' || Array.isArray(document))
            throw new Error('Enhanced specification input must be an object.');
          print(
            await registerEnhancedWorkflow(root, {
              ...(document as Omit<
                Parameters<typeof registerEnhancedWorkflow>[1],
                'taskId' | 'expectedRevision' | 'mutationId'
              >),
              taskId: requiredOption(values.task, 'task'),
              expectedRevision,
              ...(values['mutation-id'] ? { mutationId: values['mutation-id'] } : {}),
            }),
          );
        }
      }
    } else if (command === 'review') {
      if (extra.length !== 1 || !['run', 'compare', 'inspect', 'cancel'].includes(extra[0] ?? ''))
        throw new Error('Usage: latchkit review <run|compare|inspect|cancel> [options].');
      if (extra[0] === 'compare') {
        // Issue #113: a read-only, non-mutating comparison of changed decisions and their
        // consequences for one task. Never launches a provider, never refreshes evidence.
        if (values.format !== undefined && !['json', 'text'].includes(values.format))
          throw new Error('--format must be json or text.');
        const baselineRevision =
          values['baseline-revision'] === undefined
            ? undefined
            : Number(values['baseline-revision']);
        if (
          baselineRevision !== undefined &&
          (!Number.isInteger(baselineRevision) || baselineRevision < 1)
        )
          throw new Error('--baseline-revision must be a positive integer task revision.');
        const report = await inspectDecisionComparison(root, {
          taskId: requiredOption(values.task, 'task'),
          baselineRevision,
        });
        if (values.format === 'text') console.log(formatDecisionComparisonText(report));
        else print(report);
      } else if (extra[0] === 'inspect') {
        print(await createReviewOrchestrator({ root }).inspect());
      } else if (extra[0] === 'cancel') {
        print(
          await createReviewOrchestrator({ root }).cancel({
            reviewId: requiredOption(values['review-id'], 'review-id'),
          }),
        );
      } else {
        if (!values.task || !values.provider)
          throw new Error('review run requires --task and --provider.');
        print(
          await createReviewOrchestrator({ root }).run({
            taskId: requiredOption(values.task, 'task'),
            reviewers: [
              { id: values.provider, providerId: values.provider, prompt: values.prompt },
            ],
            executionAuthorized: values['host-local-authorized'] === true,
            sandbox: 'read-only',
          }),
        );
      }
    } else if (command === 'diff') {
      if (
        !['inspect', 'annotations', 'annotate', 'resolve', 'reopen'].includes(extra[0] ?? '') ||
        extra.length !== 1
      )
        throw new Error(
          'Usage: latchkit diff <inspect|annotations|annotate|resolve|reopen> --task <id> [options].',
        );
      if (!values.task) throw new Error('diff requires --task.');
      const action = extra[0];
      if (action === 'inspect')
        print(
          await inspectDiff(root, {
            taskId: requiredOption(values.task, 'task'),
            base: values.base,
          }),
        );
      else if (action === 'annotations')
        print(await listDiffAnnotations(root, { taskId: values.task }));
      else if (action === 'annotate') {
        const line = Number(values.line);
        const storeRevision = Number(values['expected-store-revision']);
        print(
          await createDiffAnnotation(root, {
            taskId: requiredOption(values.task, 'task'),
            path: values.path,
            line,
            side: values.side,
            body: values.body,
            expectedRevision: values['expected-revision'],
            expectedStoreRevision: storeRevision,
          }),
        );
      } else {
        const storeRevision = Number(values['expected-store-revision']);
        print(
          await updateDiffAnnotation(root, {
            taskId: requiredOption(values.task, 'task'),
            annotationId: values.annotation,
            action,
            expectedStoreRevision: storeRevision,
            evidenceRevision: values['evidence-revision'],
            evidenceId: values['evidence-id'],
          }),
        );
      }
    } else if (command === 'acceptance') {
      if (extra.length !== 1 || extra[0] !== 'verify')
        throw new Error('Usage: latchkit acceptance verify [options].');
      if (!values.task) throw new Error('acceptance requires --task.');
      const verifier = createAcceptanceVerifier({ root });
      if (!values.file) throw new Error('acceptance verify requires --file.');
      const abort = new AbortController();
      const cancel = () => abort.abort();
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, cancel);
      try {
        const result = await verifier.verify({
          taskId: requiredOption(values.task, 'task'),
          document: JSON.parse(
            await readFile(path.resolve(requiredOption(values.file, 'file')), 'utf8'),
          ),
          executionAuthorized: values['host-local-authorized'] === true,
          signal: abort.signal,
        });
        print(result);
        if (result.status !== 'passed') process.exitCode = 1;
      } finally {
        for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, cancel);
      }
    } else if (command === 'workspace') {
      if (
        extra.length !== 1 ||
        !['inspect', 'create', 'cancel', 'cleanup', 'preference'].includes(extra[0] ?? '')
      ) {
        throw new Error(
          'Usage: latchkit workspace <inspect|create|cancel|cleanup|preference> [options].',
        );
      }
      const action = extra[0];
      if (action === 'inspect')
        print(
          await inspectWorkspaceCapability(root, {
            mode: values.mode,
            ...(values['worktree-root'] ? { worktreeRoot: values['worktree-root'] } : {}),
          }),
        );
      else if (action === 'create')
        print(
          await createTaskWorkspace(root, {
            taskId: requiredOption(values.task, 'task'),
            ...(values.branch ? { branch: values.branch } : {}),
            ...(values.revision ? { revision: values.revision } : {}),
            ...(values.mode ? { mode: values.mode } : {}),
            ...(values['worktree-root'] ? { worktreeRoot: values['worktree-root'] } : {}),
          }),
        );
      else if (action === 'cancel') print(await cancelTaskWorkspace(root, { taskId: values.task }));
      else if (action === 'cleanup')
        print(
          await cleanupTaskWorkspace(root, {
            taskId: requiredOption(values.task, 'task'),
            authorized: values.authorized,
          }),
        );
      else if (values.execution === undefined && values['worktree-root'] === undefined) {
        // Read-only: report the effective, defaulted project preference.
        let workspace: unknown;
        try {
          workspace = (await readConfig(root)).workspace;
        } catch {
          workspace = undefined;
        }
        print(workspace ?? DEFAULT_WORKSPACE_SETTINGS);
      } else {
        if (
          values.execution !== undefined &&
          !['ask', 'always-worktree', 'direct'].includes(values.execution)
        )
          throw new Error('--execution must be ask, always-worktree, or direct.');
        const existing = await readConfig(root);
        const current = existing.workspace ?? DEFAULT_WORKSPACE_SETTINGS;
        print(
          await saveConfig(root, {
            ...existing,
            workspace: {
              executionPreference: values.execution ?? current.executionPreference,
              worktreeRoot: values['worktree-root'] ?? current.worktreeRoot,
            },
          }),
        );
      }
    } else if (command === 'memory') {
      if (
        !['inspect', 'search', 'add', 'update', 'delete', 'export', 'import', 'recover'].includes(
          extra[0] ?? '',
        ) ||
        extra.length !== 1
      )
        throw new Error(
          'Usage: latchkit memory <inspect|search|add|update|delete|export|import|recover> [options].',
        );
      const action = extra[0];
      const revision =
        values['expected-revision'] === undefined ? undefined : Number(values['expected-revision']);
      if (revision !== undefined && (!Number.isInteger(revision) || revision < 1))
        throw new Error('--expected-revision must be a positive integer.');
      if (action === 'inspect')
        print(
          values.id ? await inspectProjectMemory(root, values.id) : await listProjectMemory(root),
        );
      else if (action === 'search')
        print(await searchProjectMemory(root, requiredOption(values.text, 'text')));
      else if (action === 'add')
        print(
          await addProjectMemory(root, {
            title: requiredOption(values.title, 'title'),
            text: requiredOption(values.text, 'text'),
            kind: values.kind,
          }),
        );
      else if (action === 'update')
        print(
          await updateProjectMemory(root, requiredOption(values.id, 'id'), {
            title: values.title,
            text: values.text,
            expectedRevision: revision,
          }),
        );
      else if (action === 'delete')
        print(
          await deleteProjectMemory(root, requiredOption(values.id, 'id'), {
            expectedRevision: revision,
          }),
        );
      else if (action === 'export') print(await exportProjectMemory(root));
      else if (action === 'import')
        print(
          await importProjectMemory(
            root,
            JSON.parse(await readFile(path.resolve(requiredOption(values.file, 'file')), 'utf8')),
          ),
        );
      else {
        const provider = values.provider ? providerById(values.provider) : undefined;
        const budget = values.budget === undefined ? undefined : Number(values.budget);
        print(await recoverProjectContext(root, { query: values.text, budget, provider }));
      }
    } else if (command === 'usage') {
      if (
        !['enable', 'disable', 'inspect', 'import', 'export', 'retain', 'delete'].includes(
          extra[0] ?? '',
        ) ||
        extra.length !== 1
      )
        throw new Error(
          'Usage: latchkit usage <enable|disable|inspect|import|export|retain|delete> [options].',
        );
      const action = extra[0];
      const retentionDays =
        values['retention-days'] === undefined ? undefined : Number(values['retention-days']);
      if (
        retentionDays !== undefined &&
        (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365)
      )
        throw new Error('--retention-days must be an integer between 1 and 365.');
      if (action === 'enable')
        print(
          await configureUsage(root, {
            enabled: true,
            ...(retentionDays === undefined ? {} : { retentionDays }),
          }),
        );
      else if (action === 'disable') print(await configureUsage(root, { enabled: false }));
      else if (action === 'inspect') print(await inspectUsage(root));
      else if (action === 'export') print(await exportUsage(root));
      else if (action === 'delete') print(await deleteUsage(root));
      else if (action === 'retain')
        print(
          await (retentionDays === undefined
            ? enforceUsageRetention(root)
            : configureUsage(root, { retentionDays })),
        );
      else {
        if (!values.provider || !values.file)
          throw new Error('usage import requires --provider and --file.');
        const input = await readFile(path.resolve(values.file), 'utf8');
        if (Buffer.byteLength(input, 'utf8') > 1024 * 1024)
          throw new Error('Usage input exceeds the 1 MiB limit.');
        let output: unknown = input;
        try {
          output = JSON.parse(input);
        } catch {
          /* Documented JSONL is parsed by the usage service. */
        }
        print(
          await recordProviderUsage(root, {
            provider: values.provider,
            providerVersion: values['provider-version'],
            taskId: values.task,
            sessionId: values.session,
            output,
          }),
        );
      }
    } else if (command === 'verification') {
      if (extra.length)
        throw new Error('Usage: latchkit verification [--verification-mode <fast|standard>].');
      if (values['verification-mode'] === undefined) print(await inspectVerificationSettings(root));
      else {
        if (!['fast', 'standard'].includes(values['verification-mode']))
          throw new Error('--verification-mode must be fast or standard.');
        print(
          await configureVerification(root, {
            defaultMode: values['verification-mode'] as 'fast' | 'standard',
          }),
        );
      }
    } else if (command === 'schedule') {
      if (
        ![
          'create',
          'list',
          'inspect',
          'edit',
          'pause',
          'resume',
          'remove',
          'cancel',
          'export',
          'start',
        ].includes(extra[0] ?? '') ||
        extra.length !== 1
      )
        throw new Error(
          'Usage: latchkit schedule <create|list|inspect|edit|pause|resume|remove|cancel|export|start> [options].',
        );
      const action = extra[0];
      const number = (name: 'every-minutes' | 'timeout-ms' | 'output-limit-bytes' | 'max-runs') =>
        values[name] === undefined ? undefined : Number(values[name]);
      const limits = {
        ...(number('timeout-ms') === undefined ? {} : { timeoutMs: number('timeout-ms')! }),
        ...(number('output-limit-bytes') === undefined
          ? {}
          : { outputLimitBytes: number('output-limit-bytes')! }),
        ...(number('max-runs') === undefined ? {} : { maxRuns: number('max-runs')! }),
      };
      if (action === 'list') print(await listSchedules(root));
      else if (action === 'export') print(await exportSchedules(root));
      else if (action === 'inspect')
        print(await inspectSchedule(root, requiredOption(values.id, 'id')));
      else if (action === 'create')
        print(
          await createSchedule(root, {
            timezone: values.timezone,
            everyMinutes: number('every-minutes')!,
            providerId: requiredOption(values.provider, 'provider'),
            instructions: requiredOption(values.prompt, 'prompt'),
            authorization: {
              scope: requiredOption(values.scope, 'scope'),
              reference: requiredOption(values.reference, 'reference'),
              executionAuthorized: values['host-local-authorized'] === true,
            },
            limits,
          }),
        );
      else if (action === 'edit')
        print(
          await editSchedule(root, requiredOption(values.id, 'id'), {
            ...(values.timezone === undefined ? {} : { timezone: values.timezone }),
            ...(number('every-minutes') === undefined
              ? {}
              : { everyMinutes: number('every-minutes')! }),
            ...(values.provider === undefined ? {} : { providerId: values.provider }),
            ...(values.prompt === undefined ? {} : { instructions: values.prompt }),
            ...(values.scope === undefined &&
            values.reference === undefined &&
            values['host-local-authorized'] !== true
              ? {}
              : {
                  authorization: {
                    scope: requiredOption(values.scope, 'scope'),
                    reference: requiredOption(values.reference, 'reference'),
                    executionAuthorized: values['host-local-authorized'] === true,
                  },
                }),
            ...(Object.keys(limits).length ? { limits } : {}),
            ...(values['expected-revision'] === undefined
              ? {}
              : { expectedRevision: Number(values['expected-revision']) }),
          }),
        );
      else if (action === 'pause')
        print(await pauseSchedule(root, requiredOption(values.id, 'id')));
      else if (action === 'resume')
        print(await resumeSchedule(root, requiredOption(values.id, 'id')));
      else if (action === 'remove')
        print(await removeSchedule(root, requiredOption(values.id, 'id')));
      else if (action === 'cancel')
        print(await cancelScheduleRun(root, requiredOption(values.id, 'id')));
      else {
        const scheduler = createForegroundScheduler({ root });
        // The CLI is an explicit foreground process; poll promptly so a
        // near-term schedule does not appear idle for the 30-second service
        // default while still keeping the service API's conservative default.
        await scheduler.start(1_000);
        console.log('Foreground scheduler running. Ctrl+C to stop.');
        const stop = () => {
          void scheduler.stop().catch(() => {});
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        try {
          const result = await scheduler.closed;
          if (result.error) throw result.error;
        } finally {
          process.off('SIGINT', stop);
          process.off('SIGTERM', stop);
        }
      }
    } else if (command === 'mcp') {
      const action = extra[0];
      if (
        extra.length !== 1 ||
        !action ||
        !['preview', 'apply', 'remove', 'inspect', 'recover', 'health'].includes(action)
      )
        throw new Error(
          'Usage: latchkit mcp <preview|apply|remove|inspect|recover|health> [options].',
        );
      const actionOptions: Record<string, string[]> = {
        preview: ['file'],
        apply: ['file', 'authorized', 'dry-run'],
        remove: ['dry-run'],
        inspect: [],
        recover: ['dry-run'],
        health: ['id'],
      };
      for (const option of Object.keys(values))
        if (option !== 'project' && !actionOptions[action]!.includes(option))
          throw new Error(`--${option} is not valid for mcp ${action}.`);
      const managed = await import('./integrations/mcp/managed.js');
      if (action === 'inspect') print(await managed.inspectManagedMcp(root));
      else if (action === 'recover')
        print(
          await (values['dry-run']
            ? managed.inspectManagedMcpRecovery(root)
            : managed.recoverManagedMcp(root)),
        );
      else if (action === 'health') {
        const { checkManagedMcpHealth } = await import('./integrations/mcp/health.js');
        const controller = new AbortController();
        const abort = () => controller.abort();
        process.once('SIGINT', abort);
        process.once('SIGTERM', abort);
        try {
          print(
            await checkManagedMcpHealth(root, requiredOption(values.id, 'id'), {
              signal: controller.signal,
            }),
          );
        } finally {
          process.removeListener('SIGINT', abort);
          process.removeListener('SIGTERM', abort);
        }
      } else {
        let definitions: unknown[] = [];
        if (action !== 'remove') {
          const bytes = await readFile(path.resolve(requiredOption(values.file, 'file')));
          if (bytes.byteLength > 64 * 1024) throw new Error('MCP definition input exceeds 64 KiB.');
          let input: unknown;
          try {
            input = JSON.parse(bytes.toString('utf8'));
          } catch {
            throw new Error('MCP input must be valid JSON.');
          }
          definitions = Array.isArray(input) ? input : [input];
          if (definitions.length > 64) throw new Error('MCP input exceeds 64 definitions.');
        }
        const grants = managed.authorizeManagedMcp(
          definitions,
          action === 'apply' && values.authorized === true,
        );
        const result =
          action === 'preview' || values['dry-run']
            ? await managed.planManagedMcp(root, definitions, grants)
            : await managed.applyManagedMcp(root, definitions, grants);
        print(result);
        if (result.diagnostics.length) process.exitCode = 1;
      }
      // --- Onboarding (#100): CLI fallback for the browser console's
      // onboarding page. Every action prints its result and exits; there is
      // no interactive prompt anywhere in this CLI, so this is inherently
      // "non-interactive-safe" — it never blocks on a TTY.
    } else if (command === 'onboarding') {
      const action = extra[0] ?? 'inspect';
      const stepActions = new Set(['skip', 'back']);
      const validActions = [
        'inspect',
        'start',
        'project',
        'providers',
        'workspace',
        'verification',
        'usage',
        'preview',
        'apply',
        'skip',
        'back',
        'complete',
        'dismiss',
        'cancel',
      ];
      if (
        !validActions.includes(action) ||
        (stepActions.has(action) || action === 'usage' ? extra.length !== 2 : extra.length > 1)
      )
        throw new Error(
          'Usage: latchkit onboarding [inspect|start|project|providers|workspace|verification|' +
            'usage <enable|disable>|preview|apply|skip <step>|back <step>|complete|dismiss|cancel] [options].',
        );
      const providerList = () =>
        values.providers === undefined ? undefined : values.providers.split(',').filter(Boolean);
      const skillList = () =>
        values.skills === undefined ? undefined : values.skills.split(',').filter(Boolean);
      if (action === 'inspect') print(await inspectOnboarding(root));
      else if (action === 'start') print(await startOnboarding(root));
      else if (action === 'project')
        print(
          await selectOnboardingProject(root, {
            ...(providerList() !== undefined ? { providers: providerList() } : {}),
            ...(skillList() !== undefined ? { skills: skillList() } : {}),
          }),
        );
      else if (action === 'providers')
        print(
          await updateOnboardingProjectSelection(root, {
            ...(providerList() !== undefined ? { providers: providerList() } : {}),
            ...(skillList() !== undefined ? { skills: skillList() } : {}),
          }),
        );
      else if (action === 'workspace') {
        if (values.execution === undefined && values['worktree-root'] === undefined)
          throw new Error('onboarding workspace requires --execution and/or --worktree-root.');
        if (
          values.execution !== undefined &&
          !['ask', 'always-worktree', 'direct'].includes(values.execution)
        )
          throw new Error('--execution must be ask, always-worktree, or direct.');
        print(
          await updateOnboardingWorkspacePreference(root, {
            ...(values.execution !== undefined
              ? { executionPreference: values.execution as 'ask' | 'always-worktree' | 'direct' }
              : {}),
            ...(values['worktree-root'] !== undefined
              ? { worktreeRoot: values['worktree-root'] }
              : {}),
          }),
        );
      } else if (action === 'verification') {
        if (
          values['verification-mode'] === undefined ||
          !['fast', 'standard'].includes(values['verification-mode'])
        )
          throw new Error('onboarding verification requires --verification-mode fast|standard.');
        print(
          await updateOnboardingVerificationPreference(
            root,
            values['verification-mode'] as 'fast' | 'standard',
          ),
        );
      } else if (action === 'usage') {
        if (!['enable', 'disable'].includes(extra[1] ?? ''))
          throw new Error('Usage: latchkit onboarding usage <enable|disable>.');
        print(await updateOnboardingUsagePreference(root, extra[1] === 'enable'));
      } else if (action === 'preview') print(await previewOnboardingSetup(root));
      else if (action === 'apply') print(await applyOnboardingSetup(root));
      else if (action === 'skip' || action === 'back') {
        const stepId = requiredOption(extra[1], 'step');
        print(await (action === 'skip' ? skipOnboardingStep : backOnboardingStep)(root, stepId));
      } else if (action === 'complete') print(await completeOnboarding(root));
      else print(await dismissOnboarding(root)); // 'dismiss' | 'cancel'
    } else if (command === 'projects') {
      const action = extra[0];
      if (extra.length !== 1 || !action || !['list', 'add', 'remove'].includes(action))
        throw new Error('Usage: latchkit projects <list|add|remove> [options].');
      const registryRoot = defaultProjectsRegistryRoot();
      if (action === 'list') print(await listProjects(registryRoot));
      else if (action === 'add')
        print(
          await registerProject(registryRoot, {
            root,
            ...(values.title !== undefined ? { displayName: values.title } : {}),
            source: 'manual',
          }),
        );
      else print(await removeProject(registryRoot, requiredOption(values.id, 'id')));
    } else if (command === 'codegraph') {
      const action = extra[0];
      if (
        extra.length !== 1 ||
        !action ||
        !['inspect', 'enable', 'disable', 'sync', 'explore'].includes(action)
      )
        throw new Error(
          'Usage: latchkit codegraph <inspect|enable|disable|sync|explore> [--query <text>].',
        );
      if (action === 'inspect') print(await inspectCodegraph(root));
      else if (action === 'sync') print(await syncCodegraph(root));
      else if (action === 'explore')
        print(await exploreCodegraph(root, requiredOption(values.query, 'query')));
      else {
        const settings = await readCodegraphSettings(root);
        print(await saveCodegraphSettings(root, { ...settings, enabled: action === 'enable' }));
      }
    } else if (command === 'spec-import') {
      const specImportActions = ['discover', 'preview', 'register', 'reinspect', 'detach'];
      const action = extra[0];
      if (extra.length !== 1 || !action || !specImportActions.includes(action))
        throw new Error(`Usage: latchkit spec-import <${specImportActions.join('|')}> [options].`);
      if (action === 'discover' || action === 'preview') {
        const options = {
          adapter: values.adapter,
          root: path.resolve(requiredOption(values.root, 'root')),
        };
        print(
          action === 'discover'
            ? await discoverSpecImport(options.root, { adapter: options.adapter })
            : await previewSpecImport(options.root, { adapter: options.adapter }),
        );
      } else if (action === 'register') {
        const expectedTaskRevision =
          values['expected-task-revision'] === undefined
            ? undefined
            : Number(values['expected-task-revision']);
        if (
          expectedTaskRevision !== undefined &&
          (!Number.isInteger(expectedTaskRevision) || expectedTaskRevision < 1)
        )
          throw new Error('--expected-task-revision must be a positive integer.');
        print(
          await registerSpecImport(root, {
            sourceRoot: path.resolve(requiredOption(values.root, 'root')),
            adapter: values.adapter,
            entryId: requiredOption(values.entry, 'entry'),
            manifestDigest: requiredOption(values['manifest-digest'], 'manifest-digest'),
            sourceSha256: requiredOption(values['source-sha256'], 'source-sha256'),
            ...(expectedTaskRevision !== undefined ? { expectedTaskRevision } : {}),
          }),
        );
      } else if (action === 'reinspect') {
        print(
          await reinspectSpecImportRegistrations(root, {
            ...(values.id ? { id: values.id } : {}),
          }),
        );
      } else {
        const expectedRevision =
          values['expected-revision'] === undefined
            ? undefined
            : Number(values['expected-revision']);
        if (
          expectedRevision === undefined ||
          !Number.isInteger(expectedRevision) ||
          expectedRevision < 1
        )
          throw new Error('spec-import detach requires --expected-revision.');
        print(
          await detachSpecImportRegistration(root, {
            id: requiredOption(values.id, 'id'),
            expectedRevision,
          }),
        );
      }
    } else if (command === 'ui') {
      const port = values.port === undefined ? 0 : Number(values.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error('Port must be an integer between 0 and 65535.');
      await initProject(root);
      const { startServer } = await import('./server.js');
      const { server, url } = await startServer(root, { port });
      console.log(
        `Latchkit console for ${root}\n${url}\nOpen this link in your browser. Keep its session token private. Ctrl+C to stop.`,
      );
      // Onboarding (#100): clearly offer onboarding on a first launch — best
      // effort only, never blocks starting the console.
      try {
        const { readOnboardingHandoffState, shouldOfferOnboarding } =
          await import('./installation/onboarding-state.js');
        if (shouldOfferOnboarding(await readOnboardingHandoffState()))
          console.log(
            'First time here? Open the Onboarding section in the console (or run `latchkit onboarding`) to finish setup.',
          );
      } catch {
        /* Best-effort hint only; never blocks starting the console. */
      }
      for (const signal of ['SIGINT', 'SIGTERM'])
        process.once(signal, () => {
          server.close();
          server.closeAllConnections();
        });
    }
  }
} catch (error) {
  const diagnostic = operationalError(error, { operation: 'cli', stage: 'dispatch' });
  console.error(`Latchkit [${diagnostic.code}]: ${diagnostic.message}`);
  const project = typeof cliValues.project === 'string' ? path.resolve(cliValues.project) : null;
  if (project) await appendEvent(project, diagnostic).catch(() => {});
  process.exitCode = 1;
}
