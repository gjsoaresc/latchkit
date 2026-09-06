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
  syncProject,
} from './core.js';
import { importMarkdownTask, inspectTask, listTasks, resumeTask } from './task-state/service.js';
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

function requiredOption(value: string | undefined, name: string): string {
  if (!value) throw new Error('--' + name + ' is required.');
  return value;
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
  task       Start, inspect, import, resume, or cancel durable workflow state
  workflow   Run, inspect, approve, resume, or cancel a delivery workflow
  self       Inspect, upgrade, roll back, or uninstall this standalone installation
  review     Run bounded independent reviews
  diff       Inspect a revision-bound Git diff or record review feedback
  acceptance Run CLI, HTTP, browser, or manual acceptance checks
  tool       Inspect or explicitly manage an optional local tool
  workspace  Inspect, create, cancel, or clean a task-owned Git worktree
  memory     Inspect, search, add, update, delete, export, import, or recover local project memory
  usage      Enable, inspect, import, export, retain, or delete local usage records
  schedule   Create and operate an explicit foreground local scheduler
  ui         Start the local configuration console (Ctrl+C to stop)

Options:
  --project <path>    Project directory (default: current directory)
  --providers <csv>   init: claude,codex,antigravity,cursor,cursor-cli
  --skills <csv>      init: requirements,spec,build,fix,review,handoff,setup
  --port <number>     ui: local port (default: automatically selected)
  --to <version>      migrate: target schema version (default: current)
  --dry-run           migrate/recover/sync: preview without writing files
  --task <id>         task: stable task identifier
  --expected-revision <n>  task resume/cancel: optimistic revision
  --mutation-id <id>  task mutation: retry-safe event identifier
  --branch <name>     workspace create: explicit new branch name
  --revision <ref>    workspace create: base commit (default: HEAD)
  --mode <name>       workspace inspect/create: isolated or direct
  --authorized        workspace cleanup: direct user authorization
  --provider <id>     task start/resume: provider adapter ID
  --prompt <text>     task start/resume: provider prompt
  --session <id>      task resume: prior Latchkit session ID
  --host-local-authorized  task start/resume: authorize host-local execution
  --export            diagnostics: export a reviewable local support bundle
  --clear             diagnostics: delete local diagnostic records
  --id <id>           memory: stable memory identifier
  --text <text>       memory: concise memory text or search query
  --kind <kind>       memory add: decision, discovery, constraint, resolved-defect
  --file <path>       memory import or acceptance verify: versioned JSON file
  --budget <n>        memory recover: maximum context characters
  --retention-days <n> usage enable/retain: bounded local retention (1-365 days)
  --provider-version <version> usage import: documented provider version for the event
  --provider <id>     memory recover: provider contract to evaluate
  --path <path>       diff annotation: project-relative file path
  --line <number>     diff annotation: one-based line
  --side <side>       diff annotation: left or right
  --body <text>       diff annotation text
  --expected-revision <id>  diff annotate: revision returned by inspect
  --evidence-id <id>  diff resolve: current task evidence ID
  --review-provider <id> workflow: explicit independent reviewer (default: selected provider)
  --plan-digest <sha256> workflow approve: exact plan digest from inspect
  --requirements-digest <sha256> workflow approve: exact requirements digest
  --checks-digest <sha256> workflow approve: exact acceptance-check digest
  --authorization-scope <text> workflow approve: permitted changes
  --authorization-reference <text> workflow approve: direct approval reference
  --resolution <decision> workflow resume: observed, abandon, or retry an interrupted action
  --action-id <id>    workflow resume: interrupted action being resolved
  --file <path>       workflow run: versioned acceptance checks
  --timezone <iana>   schedule create/edit: IANA timezone
  --every-minutes <n> schedule create/edit: recurrence interval
  --scope <text>      schedule create: authorized task scope
  --reference <text>  schedule create: authorization reference
  --install-root <path> self: user-local installation directory
  --to <version>      self upgrade/rollback: exact release version
  --bundle <path>     self install/upgrade: extracted local bundle
  --archive <path>    tool fcc preview/install: pinned local FCC archive
  --tool-root <path>  tool fcc: recorded user-local FCC tool directory
  --python <path>     tool fcc install: explicit Python 3.14+ runtime
  --uv <path>         tool fcc install: explicit uv 0.11.16+ lock installer
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
      authorized: { type: 'boolean' },
      'authorization-scope': { type: 'string' },
      'authorization-reference': { type: 'string' },
      prompt: { type: 'string' },
      session: { type: 'string' },
      'host-local-authorized': { type: 'boolean' },
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
        'workflow',
        'self',
        'workspace',
        'review',
        'memory',
        'usage',
        'acceptance',
        'diff',
        'pack',
        'schedule',
        'tool',
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
      ],
      review: ['project', 'task', 'provider', 'prompt', 'host-local-authorized'],
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
      workspace: ['project', 'task', 'branch', 'revision', 'mode', 'authorized'],
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
        !['inspect', 'preview', 'install', 'start', 'stop', 'remove'].includes(extra[1] ?? '')
      )
        throw new Error(
          'Usage: latchkit tool fcc <inspect|preview|install|start|stop|remove> [--archive <path>] [--python <path>] [--tool-root <path>].',
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
    } else if (command === 'init')
      print(
        await initProject(root, {
          ...(values.providers !== undefined
            ? { providers: values.providers.split(',').filter(Boolean) }
            : {}),
          ...(values.skills !== undefined
            ? { skills: values.skills.split(',').filter(Boolean) }
            : {}),
        }),
      );
    else if (command === 'doctor') print(await doctor(root));
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
        !['run', 'inspect', 'approve', 'resume', 'cancel'].includes(action)
      )
        throw new Error('Usage: latchkit workflow <run|inspect|approve|resume|cancel> [options].');
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
            print({ workflows: await (await import('./workflows/store.js')).listWorkflows(root) });
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
            result = await controller.run({
              ...common,
              taskId: values.task,
              providerId: requiredOption(values.provider, 'provider'),
              reviewProviderId: values['review-provider'],
              prompt: values.prompt,
              executionAuthorized: values['host-local-authorized'] === true,
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
    } else if (command === 'task') {
      if (
        extra.length !== 1 ||
        !['start', 'inspect', 'import', 'resume', 'cancel'].includes(extra[0] ?? '')
      ) {
        throw new Error('Usage: latchkit task <start|inspect|import|resume|cancel> [options].');
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
      if (action === 'inspect')
        print(values.task ? await inspectTask(root, values.task) : await listTasks(root));
      else if (action === 'start') {
        if (!values.provider) throw new Error('task start requires --provider.');
        print(
          await createTaskController({ root }).start({
            taskId: requiredOption(values.task, 'task'),
            providerId: values.provider,
            prompt: values.prompt,
            expectedRevision,
            mutationId: values['mutation-id'],
            executionAuthorized: values['host-local-authorized'] === true,
          }),
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
      else {
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
        print(
          await importMarkdownTask(root, {
            notePath: values.note,
            title: requiredOption(values.title, 'title'),
            ...(values['mutation-id'] ? { mutationId: values['mutation-id'] } : {}),
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
    } else if (command === 'review') {
      if (extra.length !== 1 || !['run'].includes(extra[0] ?? ''))
        throw new Error('Usage: latchkit review run [options].');
      if (!values.task || !values.provider)
        throw new Error('review run requires --task and --provider.');
      print(
        await createReviewOrchestrator({ root }).run({
          taskId: requiredOption(values.task, 'task'),
          reviewers: [{ id: values.provider, providerId: values.provider, prompt: values.prompt }],
          executionAuthorized: values['host-local-authorized'] === true,
        }),
      );
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
        !['inspect', 'create', 'cancel', 'cleanup'].includes(extra[0] ?? '')
      ) {
        throw new Error('Usage: latchkit workspace <inspect|create|cancel|cleanup> [options].');
      }
      const action = extra[0];
      if (action === 'inspect')
        print(await inspectWorkspaceCapability(root, { mode: values.mode }));
      else if (action === 'create')
        print(
          await createTaskWorkspace(root, {
            taskId: requiredOption(values.task, 'task'),
            ...(values.branch ? { branch: values.branch } : {}),
            ...(values.revision ? { revision: values.revision } : {}),
            ...(values.mode ? { mode: values.mode } : {}),
          }),
        );
      else if (action === 'cancel') print(await cancelTaskWorkspace(root, { taskId: values.task }));
      else
        print(
          await cleanupTaskWorkspace(root, {
            taskId: requiredOption(values.task, 'task'),
            authorized: values.authorized,
          }),
        );
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
        await scheduler.start();
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
