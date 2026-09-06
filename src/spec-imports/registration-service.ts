// Explicit registration of selected, previewed spec-import artifacts into
// existing Latchkit task state (issue #114, registration increment). See
// docs/spec-imports.md.
//
// This module creates no execution authorization, approved plan, verified
// task, passing evidence, or enhanced-workflow enrollment: a registered
// entry becomes an ordinary task (awaiting-decision, same as
// `importMarkdownTask`) carrying one `observation` task record with
// `provenance.kind: 'imported'` (see src/task-state/records.ts and issue
// #110). Observation is the only record kind with no authoritative status —
// moving it to `verified` requires linked, current, passing evidence, never
// import text alone — so an imported claim can never become accepted intent
// by itself. Required criteria, checks, and evidence still go through the
// existing, separate `registerEnhancedWorkflow` contract; nothing here calls
// it.
//
// Registration never copies, moves, reformats, or takes ownership of the
// source file: the task record's `source` link stores a project-relative
// path and the SHA-256 observed at registration time, exactly like every
// other declared source link. This is why registration requires the
// adapter's source root to be the Latchkit project root or a subdirectory of
// it (unlike discovery/preview, which accept any local root) — a `source`
// link can only ever name a path relative to the project.
//
// Persistence uses two independent, already-existing safety boundaries in a
// fixed order: the task-state mutation (`createTask`/`recordTaskRecord`,
// lock + expected revision + idempotency, src/task-state/lock.ts) commits
// first and is the sole authoritative record of what was imported; the
// Latchkit-owned association store (registration-store.ts, guarded by
// `withProjectLock`, atomically written) is a secondary index kept
// consistent with it, mirroring how `applyTaskReconciliation` treats its
// workflow acknowledgment as secondary to the task-state commit (see
// docs/task-state.md, "Atomicity across the two stores"). If the process is
// interrupted between the two, the association write is missing but no
// state is corrupted (writeAtomic never leaves a partial file); a retried
// `registerSpecImport` call for the same (adapter, sourceRoot, entryId)
// detects the already-committed task record by its deterministic provenance
// reference and completes only the missing association, rather than
// creating a duplicate task.
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { withProjectLock } from '../installer/lock.js';
import { errorCode } from '../types.js';
import { resolveProjectRoot, safePath } from '../storage.js';
import {
  createTask,
  inspectTask,
  listTasks,
  recordTaskRecord,
  type RecordLinkInput,
} from '../task-state/service.js';
import type { Task } from '../task-state/contracts.js';
import { MAX_RECORD_REFERENCE_BYTES, MAX_RECORD_TEXT_BYTES } from '../task-state/records.js';
import { previewSpecImport } from './service.js';
import type { SpecImportWouldCreate } from './service.js';
import {
  MAX_SPEC_IMPORT_REGISTRATIONS,
  SPEC_KIT_ADAPTER_ID,
  SpecImportError,
  type SpecImportAdapterId,
  type SpecImportEntry,
  type SpecImportLimits,
  type SpecImportRegistration,
  type SpecImportRegistrationAction,
  type SpecImportRegistrationStore,
} from './contracts.js';
import {
  readSpecImportRegistrationStore,
  writeSpecImportRegistrationStore,
  type SpecImportRegistrationWriteOptions,
} from './registration-store.js';

const iso = (clock: () => Date) => clock().toISOString();

function boundBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes - 1) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** Stable across revisions of the same entry (no digest/hash inside) so it can be used both
 * to bind a task record to "this exact registration slot" and to recover an orphaned record
 * after an interrupted registration. Never treated as a secret or as authorization. */
function importProvenanceReference(
  adapter: string,
  sourceRootRelative: string,
  entryId: string,
): string {
  return boundBytes(
    `spec-import:${adapter}:${sourceRootRelative || '.'}:${entryId}`,
    MAX_RECORD_REFERENCE_BYTES,
  );
}

function importObservationText(
  adapter: string,
  entry: SpecImportEntry,
  described: NonNullable<SpecImportWouldCreate['wouldCreate']>,
): string {
  const declared = entry.sourceDeclaredStatus.value;
  const tasks = entry.parsedIdentifiers.tasks;
  const lines = [
    `Imported via the "${adapter}" spec-import adapter (issue #114); reuse #110 provenance.`,
    `Source entry "${entry.slug}" at ${entry.directory} (adapter status: ${entry.status}).`,
    declared !== null
      ? `Source-declared status: ${declared} (an imported claim only, never verification evidence).`
      : null,
    tasks.length
      ? `Source-declared tasks: ${tasks.length} total, ${tasks.filter((task) => task.checked).length} checked (imported claims only).`
      : null,
    `Primary artifact: ${described.importSource.path} (sha256:${described.importSource.sha256}).`,
  ].filter((line): line is string => line !== null);
  return boundBytes(lines.join('\n'), MAX_RECORD_TEXT_BYTES);
}

function relativeToProject(project: string, sourceRoot: string): string {
  // path.relative(a, a) === '' — the project root itself is the common case, not an error.
  const relative = path.relative(project, sourceRoot).split(path.sep).join('/');
  if (relative === '') return '';
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new SpecImportError(
      'Registration requires the selected source root to be the Latchkit project or a ' +
        'subdirectory of it, so the imported artifact can be recorded as a project-relative ' +
        'source link.',
      'SPEC_IMPORT_REGISTRATION_ROOT_OUTSIDE_PROJECT',
      '$.sourceRoot',
    );
  return relative;
}

function joinProjectRelative(sourceRootRelative: string, artifactPath: string): string {
  return sourceRootRelative ? `${sourceRootRelative}/${artifactPath}` : artifactPath;
}

function pushHistory(
  registration: SpecImportRegistration,
  action: SpecImportRegistrationAction,
  at: string,
) {
  registration.history.push({
    revision: registration.revision,
    action,
    manifestDigest: registration.manifestDigest,
    entryDirectory: registration.entryDirectory,
    primaryArtifact: { ...registration.primaryArtifact },
    taskId: registration.taskId,
    recordId: registration.recordId,
    at,
  });
  const MAX_HISTORY = 40;
  if (registration.history.length > MAX_HISTORY) registration.history.shift();
}

function sameScope(item: SpecImportRegistration, adapter: string, sourceRootRelative: string) {
  return item.adapter === adapter && item.sourceRoot === sourceRootRelative;
}

/** Recovery/dedup fallback: locate a still-live (non-superseded) imported observation record
 * carrying this exact registration slot's deterministic reference, regardless of what the
 * association store currently holds. Used both to heal an interrupted registration (task
 * record committed, association write did not) and as defense in depth against ever creating
 * a duplicate task for the same slot. */
async function findLiveImportRecord(
  project: string,
  reference: string,
): Promise<{ task: Task; recordId: string } | null> {
  let listed;
  try {
    listed = await listTasks(project);
  } catch (error) {
    if (errorCode(error) === 'TASK_STATE_NOT_FOUND') return null;
    throw error;
  }
  for (const task of listed.tasks) {
    const record = (task.records ?? []).find(
      (item) =>
        item.provenance.kind === 'imported' &&
        item.provenance.reference === reference &&
        item.supersededBy === null,
    );
    if (record) return { task, recordId: record.id };
  }
  return null;
}

export type SpecImportAmbiguity = {
  entryId: string;
  entryDirectory: string;
  matchesRegistrationId: string;
  matchesPreviousDirectory: string;
  reason: string;
};

export type RegisterSpecImportInput = {
  /** Local directory the adapter scans; must be the Latchkit project root or a subdirectory
   * of it (unlike discovery/preview, which accept any local root). */
  sourceRoot: string;
  adapter?: string;
  limits?: Partial<SpecImportLimits>;
  entryId: string;
  /** The exact `manifestDigest` returned by the `preview` the caller reviewed. */
  manifestDigest: string;
  /** The exact `wouldCreate[].wouldCreate.importSource.sha256` for `entryId` from that same
   * preview; rechecked in addition to `manifestDigest` for defense in depth. */
  sourceSha256: string;
  /** Required when this call updates an already-registered entry (see
   * `docs/spec-imports.md`); the caller's last-observed revision of the associated task,
   * checked with the same `TASK_REVISION_CONFLICT` semantics as every other task mutation.
   * Not used and not required when this call creates a brand-new registration. */
  expectedTaskRevision?: number;
  clock?: () => Date;
};

export type RegisterSpecImportResult = {
  action: 'registered' | 'revised' | 'unchanged';
  registration: SpecImportRegistration;
  task: Task;
  ambiguities: SpecImportAmbiguity[];
};

function requireHash(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw new SpecImportError(
      `A reviewed ${field} is required.`,
      'SPEC_IMPORT_INVALID',
      `$.${field}`,
    );
  return value;
}

/**
 * Register one selected, previously previewed entry into task state. Bound to the exact
 * reviewed `manifestDigest` and `sourceSha256`: both are rechecked against a freshly rebuilt
 * manifest before any write, so a source change between preview and register produces
 * `SPEC_IMPORT_STALE_PREVIEW` rather than importing stale content. Repeating the same call
 * (same adapter/sourceRoot/entryId, unchanged content) is idempotent (`action: 'unchanged'`);
 * an updated artifact supersedes the prior task record with a new one on the same task/
 * association (`action: 'revised'`) rather than creating a duplicate task. A moved/renamed
 * source is never silently matched to a missing registration — see `ambiguities`.
 */
export async function registerSpecImport(
  root: string,
  input: RegisterSpecImportInput,
  options: SpecImportRegistrationWriteOptions = {},
): Promise<RegisterSpecImportResult> {
  const clock = input.clock ?? (() => new Date());
  const adapter = input.adapter ?? SPEC_KIT_ADAPTER_ID;
  if (typeof input.entryId !== 'string' || !input.entryId)
    throw new SpecImportError('An entry ID is required.', 'SPEC_IMPORT_INVALID', '$.entryId');
  const manifestDigest = requireHash(input.manifestDigest, 'manifestDigest');
  const sourceSha256 = requireHash(input.sourceSha256, 'sourceSha256');
  const project = await resolveProjectRoot(root);

  return withProjectLock(project, async () => {
    const resolvedSourceRoot = await resolveProjectRoot(input.sourceRoot);
    const sourceRootRelative = relativeToProject(project, resolvedSourceRoot);
    const preview = await previewSpecImport(resolvedSourceRoot, {
      adapter,
      limits: input.limits,
      clock,
    });
    if (preview.manifestDigest !== manifestDigest)
      throw new SpecImportError(
        'The reviewed manifest is stale: source files changed since preview. Run preview ' +
          'again and register from the new result.',
        'SPEC_IMPORT_STALE_PREVIEW',
        '$.manifestDigest',
      );
    const described = preview.wouldCreate.find((item) => item.entryId === input.entryId);
    if (!described)
      throw new SpecImportError(
        `Entry "${input.entryId}" was not found in this discovery.`,
        'SPEC_IMPORT_ENTRY_NOT_FOUND',
        '$.entryId',
      );
    if (!described.registrable || !described.wouldCreate)
      throw new SpecImportError(
        `Entry "${input.entryId}" is not registrable from this discovery (status ` +
          `"${described.status}").`,
        'SPEC_IMPORT_ENTRY_NOT_REGISTRABLE',
        '$.entryId',
      );
    if (described.wouldCreate.importSource.sha256 !== sourceSha256)
      throw new SpecImportError(
        'The selected source hash is stale: the artifact changed since preview. Run preview ' +
          'again and register from the new result.',
        'SPEC_IMPORT_STALE_PREVIEW',
        '$.sourceSha256',
      );
    const manifestEntry = preview.manifest.entries.find((item) => item.id === input.entryId);
    if (!manifestEntry)
      throw new SpecImportError(
        `Entry "${input.entryId}" was not found in this discovery.`,
        'SPEC_IMPORT_ENTRY_NOT_FOUND',
        '$.entryId',
      );
    const projectRelativeArtifactPath = joinProjectRelative(
      sourceRootRelative,
      described.wouldCreate.importSource.path,
    );

    const store = await readSpecImportRegistrationStore(project);
    const active = store.registrations.find(
      (item) =>
        sameScope(item, adapter, sourceRootRelative) &&
        item.status === 'registered' &&
        item.entryId === input.entryId,
    );
    const presentEntryIds = new Set(preview.manifest.entries.map((entry) => entry.id));
    const ambiguities: SpecImportAmbiguity[] = [];
    const at = iso(clock);

    if (active) {
      // "Unchanged" is about this entry's own content and location, not the whole
      // discovery's digest: an unrelated entry changing elsewhere in the same source root
      // must not force a spurious revision here. The overall manifestDigest was already
      // rechecked against the caller's reviewed value above (SPEC_IMPORT_STALE_PREVIEW).
      if (
        active.primaryArtifact.sha256 === sourceSha256 &&
        active.entryDirectory === manifestEntry.directory
      ) {
        const task = await inspectTask(project, active.taskId);
        return {
          action: 'unchanged',
          registration: structuredClone(active),
          task: task.task,
          ambiguities,
        };
      }
      if (input.expectedTaskRevision === undefined)
        throw new SpecImportError(
          'Updating an already-registered entry requires expectedTaskRevision — run ' +
            'spec-import reinspect to read the current value first.',
          'SPEC_IMPORT_TASK_REVISION_REQUIRED',
          '$.expectedTaskRevision',
        );
      const updated = await recordTaskRecord(
        project,
        {
          taskId: active.taskId,
          expectedRevision: input.expectedTaskRevision,
          kind: 'observation',
          text: importObservationText(adapter, manifestEntry, described.wouldCreate),
          provenance: {
            kind: 'imported',
            reference: importProvenanceReference(adapter, sourceRootRelative, input.entryId),
          },
          links: [{ type: 'source', path: projectRelativeArtifactPath } as RecordLinkInput],
          supersedes: active.recordId,
        },
        { clock },
      );
      const newRecord = (updated.records ?? []).find((item) => item.supersedes === active.recordId);
      if (!newRecord)
        throw new Error('Registration revision did not produce a superseding record.');
      active.revision += 1;
      active.manifestDigest = manifestDigest;
      active.entryDirectory = manifestEntry.directory;
      active.primaryArtifact = { path: projectRelativeArtifactPath, sha256: sourceSha256 };
      active.recordId = newRecord.id;
      active.updatedAt = at;
      pushHistory(active, 'revised', at);
      await writeSpecImportRegistrationStore(project, store, options);
      return {
        action: 'revised',
        registration: structuredClone(active),
        task: updated,
        ambiguities,
      };
    }

    const missing = store.registrations.filter(
      (item) =>
        sameScope(item, adapter, sourceRootRelative) &&
        item.status === 'registered' &&
        !presentEntryIds.has(item.entryId),
    );
    const renameCandidate = missing.find((item) => item.primaryArtifact.sha256 === sourceSha256);
    if (renameCandidate)
      ambiguities.push({
        entryId: input.entryId,
        entryDirectory: manifestEntry.directory,
        matchesRegistrationId: renameCandidate.id,
        matchesPreviousDirectory: renameCandidate.entryDirectory,
        reason:
          'A previously registered entry with byte-identical primary content is now missing ' +
          'from discovery. This may be the same source moved or renamed; it was registered as ' +
          'a new, independent association rather than silently matched to the missing one. ' +
          'Detach the prior registration explicitly if this is in fact the same artifact.',
      });

    const reference = importProvenanceReference(adapter, sourceRootRelative, input.entryId);
    const orphan = await findLiveImportRecord(project, reference);
    if (orphan) {
      if (store.registrations.length >= MAX_SPEC_IMPORT_REGISTRATIONS)
        throw new SpecImportError(
          'This project has reached its spec-import registration limit.',
          'SPEC_IMPORT_REGISTRATION_LIMIT_EXCEEDED',
          '$',
        );
      const registration: SpecImportRegistration = {
        id: `specimport_${randomUUID()}`,
        revision: 1,
        status: 'registered',
        adapter: adapter as SpecImportAdapterId,
        sourceRoot: sourceRootRelative,
        entryId: input.entryId,
        entryDirectory: manifestEntry.directory,
        manifestDigest,
        primaryArtifact: { path: projectRelativeArtifactPath, sha256: sourceSha256 },
        taskId: orphan.task.id,
        recordId: orphan.recordId,
        registeredAt: at,
        updatedAt: at,
        detachedAt: null,
        history: [],
      };
      pushHistory(registration, 'registered', at);
      store.registrations.push(registration);
      await writeSpecImportRegistrationStore(project, store, options);
      return {
        action: 'registered',
        registration: structuredClone(registration),
        task: orphan.task,
        ambiguities,
      };
    }

    if (store.registrations.length >= MAX_SPEC_IMPORT_REGISTRATIONS)
      throw new SpecImportError(
        'This project has reached its spec-import registration limit.',
        'SPEC_IMPORT_REGISTRATION_LIMIT_EXCEEDED',
        '$',
      );
    const created = await createTask(project, { title: described.wouldCreate.title }, { clock });
    const withRecord = await recordTaskRecord(
      project,
      {
        taskId: created.id,
        expectedRevision: created.revision,
        kind: 'observation',
        text: importObservationText(adapter, manifestEntry, described.wouldCreate),
        provenance: { kind: 'imported', reference },
        links: [{ type: 'source', path: projectRelativeArtifactPath } as RecordLinkInput],
      },
      { clock },
    );
    const newRecord = (withRecord.records ?? []).find(
      (item) => item.provenance.reference === reference,
    );
    if (!newRecord) throw new Error('Import record was not created.');
    const registration: SpecImportRegistration = {
      id: `specimport_${randomUUID()}`,
      revision: 1,
      status: 'registered',
      adapter: adapter as SpecImportAdapterId,
      sourceRoot: sourceRootRelative,
      entryId: input.entryId,
      entryDirectory: manifestEntry.directory,
      manifestDigest,
      primaryArtifact: { path: projectRelativeArtifactPath, sha256: sourceSha256 },
      taskId: withRecord.id,
      recordId: newRecord.id,
      registeredAt: at,
      updatedAt: at,
      detachedAt: null,
      history: [],
    };
    pushHistory(registration, 'registered', at);
    store.registrations.push(registration);
    await writeSpecImportRegistrationStore(project, store, options);
    return {
      action: 'registered',
      registration: structuredClone(registration),
      task: withRecord,
      ambiguities,
    };
  });
}

export type SpecImportReinspectionState = 'current' | 'changed' | 'missing' | 'unreadable';

export type SpecImportReinspection = {
  registration: SpecImportRegistration;
  state: SpecImportReinspectionState;
  currentSha256: string | null;
  /** The associated task's current revision, when it could still be read. */
  taskRevision: number | null;
  checkedAt: string;
};

/**
 * Read-only: compares each registered artifact's currently-observed bytes against its
 * registered snapshot, preserving the historical hash. Never rewrites the persisted
 * registration or the associated task record — a changed, missing, or unreadable source is
 * exposed here, not silently repaired.
 */
export async function reinspectSpecImportRegistrations(
  root: string,
  input: { id?: string; clock?: () => Date } = {},
): Promise<SpecImportReinspection[]> {
  const project = await resolveProjectRoot(root);
  const clock = input.clock ?? (() => new Date());
  const store = await readSpecImportRegistrationStore(project);
  const targets = input.id
    ? store.registrations.filter((item) => item.id === input.id)
    : store.registrations;
  if (input.id && targets.length === 0)
    throw new SpecImportError(
      `Registration "${input.id}" was not found.`,
      'SPEC_IMPORT_REGISTRATION_NOT_FOUND',
      '$.id',
    );
  const results: SpecImportReinspection[] = [];
  for (const registration of targets) {
    const checkedAt = iso(clock);
    let state: SpecImportReinspectionState;
    let currentSha256: string | null = null;
    try {
      const bytes = await readFile(await safePath(project, registration.primaryArtifact.path));
      currentSha256 = createHash('sha256').update(bytes).digest('hex');
      state = currentSha256 === registration.primaryArtifact.sha256 ? 'current' : 'changed';
    } catch (error) {
      state = errorCode(error) === 'ENOENT' ? 'missing' : 'unreadable';
    }
    let taskRevision: number | null = null;
    try {
      taskRevision = (await inspectTask(project, registration.taskId)).task.revision;
    } catch {
      /* The task may have been removed independently; the artifact state above still stands. */
    }
    results.push({
      registration: structuredClone(registration),
      state,
      currentSha256,
      taskRevision,
      checkedAt,
    });
  }
  return results;
}

/**
 * Detach removes only Latchkit's association: the source file and the task/task record it
 * points at are left exactly as they are. Idempotent when the target is already detached.
 * Requires the association's current revision, checked with the same optimistic-concurrency
 * semantics as every other Latchkit mutation.
 */
export async function detachSpecImportRegistration(
  root: string,
  input: { id: string; expectedRevision: number; clock?: () => Date },
  options: SpecImportRegistrationWriteOptions = {},
): Promise<SpecImportRegistration> {
  if (typeof input.id !== 'string' || !input.id)
    throw new SpecImportError('A registration ID is required.', 'SPEC_IMPORT_INVALID', '$.id');
  const clock = input.clock ?? (() => new Date());
  const project = await resolveProjectRoot(root);
  return withProjectLock(project, async () => {
    const store = await readSpecImportRegistrationStore(project);
    const registration = store.registrations.find((item) => item.id === input.id);
    if (!registration)
      throw new SpecImportError(
        `Registration "${input.id}" was not found.`,
        'SPEC_IMPORT_REGISTRATION_NOT_FOUND',
        '$.id',
      );
    if (registration.status === 'detached') return structuredClone(registration);
    if (
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision < 1 ||
      registration.revision !== input.expectedRevision
    )
      throw new SpecImportError(
        `Expected registration revision ${String(input.expectedRevision)}, found ` +
          `${registration.revision}.`,
        'SPEC_IMPORT_REGISTRATION_REVISION_CONFLICT',
        '$.expectedRevision',
      );
    const at = iso(clock);
    registration.status = 'detached';
    registration.detachedAt = at;
    registration.updatedAt = at;
    registration.revision += 1;
    pushHistory(registration, 'detached', at);
    await writeSpecImportRegistrationStore(project, store, options);
    return structuredClone(registration);
  });
}

/** Read-only listing of every registration this project has recorded, active or detached. */
export async function listSpecImportRegistrations(
  root: string,
): Promise<SpecImportRegistrationStore> {
  const project = await resolveProjectRoot(root);
  return readSpecImportRegistrationStore(project);
}
