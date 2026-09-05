#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { VERSION } from './version.js';
import {
  doctor,
  initProject,
  inspectRecovery,
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

let cliValues = {};

const usage = `Latchkit — Your agents. One workflow.

Usage: latchkit <command> [options]

  init       Create project configuration without replacing existing settings
  doctor     Detect host runtime and provider executables on PATH
  config     Print saved project configuration
  migrate    Upgrade configuration; use --dry-run to preview
  recover    Inspect or recover an interrupted mutation
  sync       Install selected skills; use --dry-run to preview
  remove     Remove unmodified Latchkit skills; keep configuration and notes
  diagnostics Preview/export or clear local redacted diagnostics
  task       Start, inspect, import, resume, or cancel durable workflow state
  review     Run bounded independent reviews
  diff       Inspect a revision-bound Git diff or record review feedback
  acceptance Run CLI, HTTP, browser, or manual acceptance checks
  workspace  Inspect, create, cancel, or clean a task-owned Git worktree
  memory     Inspect, search, add, update, delete, export, import, or recover local project memory
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
  --provider <id>     memory recover: provider contract to evaluate
  --path <path>       diff annotation: project-relative file path
  --line <number>     diff annotation: one-based line
  --side <side>       diff annotation: left or right
  --body <text>       diff annotation text
  --expected-revision <id>  diff annotate: revision returned by inspect
  --evidence-id <id>  diff resolve: current task evidence ID
  --help             Show this help
  --version          Show version

Providers handle their own login, subscription, and permissions.
Skills guide agent behavior; this alpha does not enforce workflow hooks.
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
    },
  });
  cliValues = values;
  if (values.version) console.log(VERSION);
  else if (values.help || positionals.length === 0) console.log(usage);
  else {
    const [command, ...extra] = positionals;
    if (
      !['task', 'workspace', 'review', 'memory', 'acceptance', 'diff'].includes(command) &&
      extra.length
    )
      throw new Error('Only one command is supported at a time.');
    const allowed = {
      init: ['project', 'providers', 'skills'],
      doctor: ['project'],
      config: ['project'],
      migrate: ['project', 'to', 'dry-run'],
      recover: ['project', 'dry-run'],
      sync: ['project', 'dry-run'],
      remove: ['project'],
      ui: ['project', 'port'],
      diagnostics: ['project', 'export', 'clear'],
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
    }[command];
    if (!allowed) throw new Error(`Unknown command: ${command}. Run latchkit --help.`);
    for (const option of Object.keys(values))
      if (!allowed.includes(option)) throw new Error(`--${option} is not valid for ${command}.`);
    const root = path.resolve(values.project ?? process.cwd());
    const print = (value) => console.log(JSON.stringify(value, null, 2));
    if (command === 'init')
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
    } else if (command === 'remove') print(await removeProjectSkills(root));
    else if (command === 'diagnostics') {
      if (values.clear) {
        const { clearDiagnostics } = await import('./diagnostics/logger.js');
        print(await clearDiagnostics(root));
      } else if (values.export) print(await exportSupportBundle(root));
      else print(await previewSupportBundle(root));
    } else if (command === 'task') {
      if (
        extra.length !== 1 ||
        !['start', 'inspect', 'import', 'resume', 'cancel'].includes(extra[0])
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
            taskId: values.task,
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
            taskId: values.task,
            sessionId: values.session,
            prompt: values.prompt,
            expectedRevision,
            mutationId: values['mutation-id'],
            executionAuthorized: values['host-local-authorized'] === true,
          }),
        );
      } else if (action === 'resume')
        print(
          await resumeTask(root, {
            taskId: values.task,
            expectedRevision,
            ...(values['mutation-id'] ? { mutationId: values['mutation-id'] } : {}),
            ...(values.owner ? { ownerId: values.owner } : {}),
          }),
        );
      else if (action === 'cancel')
        print(
          (
            await createTaskController({ root }).cancel({
              taskId: values.task,
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
            title: values.title,
            ...(values['mutation-id'] ? { mutationId: values['mutation-id'] } : {}),
            ...(hasAuthorization
              ? {
                  authorization: {
                    source: 'user',
                    scope: values['authorization-scope'],
                    reference: values['authorization-reference'],
                    provenanceKind: 'explicit-cli',
                  },
                }
              : {}),
          }),
        );
      }
    } else if (command === 'review') {
      if (extra.length !== 1 || !['run'].includes(extra[0]))
        throw new Error('Usage: latchkit review run [options].');
      if (!values.task || !values.provider)
        throw new Error('review run requires --task and --provider.');
      print(
        await createReviewOrchestrator({ root }).run({
          taskId: values.task,
          reviewers: [{ id: values.provider, providerId: values.provider, prompt: values.prompt }],
          executionAuthorized: values['host-local-authorized'] === true,
        }),
      );
    } else if (command === 'diff') {
      if (
        !['inspect', 'annotations', 'annotate', 'resolve', 'reopen'].includes(extra[0]) ||
        extra.length !== 1
      )
        throw new Error(
          'Usage: latchkit diff <inspect|annotations|annotate|resolve|reopen> --task <id> [options].',
        );
      if (!values.task) throw new Error('diff requires --task.');
      const action = extra[0];
      if (action === 'inspect')
        print(await inspectDiff(root, { taskId: values.task, base: values.base }));
      else if (action === 'annotations')
        print(await listDiffAnnotations(root, { taskId: values.task }));
      else if (action === 'annotate') {
        const line = Number(values.line);
        const storeRevision = Number(values['expected-store-revision']);
        print(
          await createDiffAnnotation(root, {
            taskId: values.task,
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
            taskId: values.task,
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
          taskId: values.task,
          document: JSON.parse(await readFile(path.resolve(values.file), 'utf8')),
          executionAuthorized: values['host-local-authorized'] === true,
          signal: abort.signal,
        });
        print(result);
        if (result.status !== 'passed') process.exitCode = 1;
      } finally {
        for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, cancel);
      }
    } else if (command === 'workspace') {
      if (extra.length !== 1 || !['inspect', 'create', 'cancel', 'cleanup'].includes(extra[0])) {
        throw new Error('Usage: latchkit workspace <inspect|create|cancel|cleanup> [options].');
      }
      const action = extra[0];
      if (action === 'inspect')
        print(await inspectWorkspaceCapability(root, { mode: values.mode }));
      else if (action === 'create')
        print(
          await createTaskWorkspace(root, {
            taskId: values.task,
            ...(values.branch ? { branch: values.branch } : {}),
            ...(values.revision ? { revision: values.revision } : {}),
            ...(values.mode ? { mode: values.mode } : {}),
          }),
        );
      else if (action === 'cancel') print(await cancelTaskWorkspace(root, { taskId: values.task }));
      else
        print(
          await cleanupTaskWorkspace(root, { taskId: values.task, authorized: values.authorized }),
        );
    } else if (command === 'memory') {
      if (
        !['inspect', 'search', 'add', 'update', 'delete', 'export', 'import', 'recover'].includes(
          extra[0],
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
      else if (action === 'search') print(await searchProjectMemory(root, values.text));
      else if (action === 'add')
        print(
          await addProjectMemory(root, {
            title: values.title,
            text: values.text,
            kind: values.kind,
          }),
        );
      else if (action === 'update')
        print(
          await updateProjectMemory(root, values.id, {
            title: values.title,
            text: values.text,
            expectedRevision: revision,
          }),
        );
      else if (action === 'delete')
        print(await deleteProjectMemory(root, values.id, { expectedRevision: revision }));
      else if (action === 'export') print(await exportProjectMemory(root));
      else if (action === 'import')
        print(
          await importProjectMemory(
            root,
            JSON.parse(await readFile(path.resolve(values.file), 'utf8')),
          ),
        );
      else {
        const provider = values.provider ? providerById(values.provider) : undefined;
        const budget = values.budget === undefined ? undefined : Number(values.budget);
        print(await recoverProjectContext(root, { query: values.text, budget, provider }));
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
