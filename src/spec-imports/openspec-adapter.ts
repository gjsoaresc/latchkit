// OpenSpec discovery/preview adapter, pinned to OPENSPEC_UPSTREAM (see
// contracts.ts). Reads only `<root>/openspec/specs/**/spec.md` (current,
// deployed capability specs), `<root>/openspec/changes/<name>/` (active
// changes), and `<root>/openspec/changes/archive/<dated-name>/` (archived
// changes) — each change's `{proposal,design,tasks}.md`, its
// `specs/**/spec.md` delta specs, and explicit local links from those
// files. Never executes anything; never follows a reference outside `root`,
// including a detected OpenSpec store pointer (`openspec/config.yaml`'s
// `store:` key) or `.openspec-store/` identity file — see
// docs/spec-imports.md and https://openspec.dev/docs/stores.
import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { errorCode } from '../types.js';
import { safePath } from '../storage.js';
import {
  extractHeadings,
  findInferredReferences,
  readWithinLimits,
  scanExplicitLinks,
  splitLines,
} from './discovery-helpers.js';
import {
  DEFAULT_SPEC_IMPORT_LIMITS,
  OPENSPEC_ADAPTER_ID,
  OPENSPEC_ADAPTER_VERSION,
  OPENSPEC_UPSTREAM,
  SPEC_IMPORT_MANIFEST_SCHEMA_VERSION,
  type SpecImportArtifact,
  type SpecImportArtifactRole,
  type SpecImportDeclaredLink,
  type SpecImportEntry,
  type SpecImportEntryStatus,
  type SpecImportInferredReference,
  type SpecImportLimits,
  type SpecImportManifest,
  type SpecImportTaskIdentifier,
  type SpecImportWarning,
} from './contracts.js';

const DOMAIN_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ACTIVE_CHANGE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ARCHIVED_CHANGE_NAME = /^(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const TASK_LINE = /^-\s\[([ xX])\]\s+(\d+(?:\.\d+)?)\s+(.+)$/;
const GROUP_HEADING = /^##\s+\d+\.\s/m;
const MAX_INFERRED_PER_ENTRY = 50;

// Marker lines drawn from the pinned `schemas/spec-driven/templates/*.md`
// scaffold at OPENSPEC_UPSTREAM.commit — structural headings the built-in
// schema always emits, not the prose that fills them in.
const PROPOSAL_MARKERS = [/^##\s*Why\s*$/m, /^##\s*What Changes\s*$/m, /^##\s*Capabilities\s*$/m];
const DESIGN_MARKERS = [/^##\s*Context\s*$/m, /^##\s*Decisions\s*$/m];
const TASKS_MARKERS = [GROUP_HEADING, /^-\s\[[ xX]\]\s*\d+\.\d+\s/m];
const CURRENT_SPEC_MARKERS = [/^##\s*Requirements\s*$/m, /^###\s*Requirement:/m];
const DELTA_SPEC_MARKERS = [
  /^##\s*(ADDED|MODIFIED|REMOVED)\s+Requirements\s*$/m,
  /^##\s*Purpose\s*$/m,
];

function looksLikeMarked(markers: RegExp[], content: string): boolean {
  return markers.some((marker) => marker.test(content));
}

function parseOpenSpecTasks(content: string, max: number): SpecImportTaskIdentifier[] {
  const tasks: SpecImportTaskIdentifier[] = [];
  for (const line of splitLines(content)) {
    if (tasks.length >= max) break;
    const match = TASK_LINE.exec(line);
    if (!match) continue;
    const [, checkedMark, id, description] = match;
    if (!checkedMark || !id || description === undefined) continue;
    tasks.push({
      id,
      checked: checkedMark.toLowerCase() === 'x',
      parallel: false,
      userStory: null,
      description: description.trim().slice(0, 300),
    });
  }
  return tasks;
}

/** Detects `openspec/config.yaml`'s `store:` pointer without ever reading the store it names. */
async function detectStorePointer(
  root: string,
  limits: SpecImportLimits,
  budget: { files: number; bytes: number },
  topWarnings: SpecImportWarning[],
): Promise<void> {
  const outcome = await readWithinLimits(root, 'openspec/config.yaml', limits, budget);
  if (outcome.kind !== 'ok') return;
  const text = outcome.content.toString('utf8');
  for (const line of splitLines(text)) {
    const match = /^store:\s*(\S.*)$/.exec(line);
    if (match?.[1]) {
      topWarnings.push({
        code: 'openspec-store-pointer-detected',
        message: `"openspec/config.yaml" declares store "${match[1].trim()}"; a detected store pointer is never followed — this adapter only reads the selected root.`,
        path: 'openspec/config.yaml',
      });
      return;
    }
  }
}

type CandidateKind = 'current' | 'active' | 'archived';

/** A missing directory yields zero entries, silently — mirrors the Spec Kit adapter's "no specs/ directory" behavior. */
async function listDirectoryEntries(
  root: string,
  relative: string,
  topWarnings: SpecImportWarning[],
  notDirCode: string,
  inaccessibleCode: string,
): Promise<Dirent[]> {
  let target: string;
  try {
    target = await safePath(root, relative, 'directory');
  } catch {
    return [];
  }
  try {
    return await readdir(target, { withFileTypes: true });
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') return [];
    if (code === 'EACCES' || code === 'EPERM') {
      topWarnings.push({
        code: inaccessibleCode,
        message: `"${relative}" could not be read (permission denied).`,
        path: relative,
      });
      return [];
    }
    if (code === 'ENOTDIR') {
      topWarnings.push({
        code: notDirCode,
        message: `"${relative}" exists but is not a directory.`,
        path: relative,
      });
      return [];
    }
    throw error;
  }
}

/** Recursively finds directories directly containing `spec.md` under `baseDir`, bounded by depth and count. */
async function findSpecDirectories(
  root: string,
  baseDir: string,
  maxDepth: number,
  maxCount: number,
  warnings: SpecImportWarning[],
): Promise<{ directories: string[]; truncated: boolean }> {
  const found: string[] = [];
  let truncated = false;

  async function walk(relDir: string, depth: number): Promise<void> {
    if (found.length >= maxCount) {
      truncated = true;
      return;
    }
    if (depth > maxDepth) {
      warnings.push({
        code: 'exceeds-depth-limit',
        message: `"${relDir}" exceeds the depth limit and was not scanned.`,
        path: relDir,
      });
      return;
    }
    let target: string;
    try {
      target = await safePath(root, relDir, 'directory');
    } catch (error) {
      const code = errorCode(error);
      if (code === 'EACCES' || code === 'EPERM') {
        warnings.push({
          code: 'inaccessible-directory',
          message: `"${relDir}" could not be read (permission denied).`,
          path: relDir,
        });
        return;
      }
      const message = error instanceof Error ? error.message : '';
      warnings.push({
        code: /symlink or junction/i.test(message)
          ? 'refused-symlink-entry'
          : 'refused-unsafe-entry',
        message: `Refused "${relDir}": ${message}`,
        path: relDir,
      });
      return;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(target, { withFileTypes: true });
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') return;
      if (code === 'EACCES' || code === 'EPERM') {
        warnings.push({
          code: 'inaccessible-directory',
          message: `"${relDir}" could not be read (permission denied).`,
          path: relDir,
        });
        return;
      }
      throw error;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === 'spec.md')) {
      found.push(relDir);
      if (found.length >= maxCount) {
        truncated = true;
        return;
      }
    }
    const subdirs = entries
      .filter((entry) => entry.name !== 'spec.md')
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of subdirs) {
      if (found.length >= maxCount) {
        truncated = true;
        break;
      }
      if (entry.isSymbolicLink()) {
        warnings.push({
          code: 'refused-symlink-entry',
          message: `Refused symlinked directory "${relDir}/${entry.name}".`,
          path: `${relDir}/${entry.name}`,
        });
        continue;
      }
      if (entry.isDirectory()) await walk(`${relDir}/${entry.name}`, depth + 1);
    }
  }

  await walk(baseDir, 0);
  return { directories: found, truncated };
}

async function readCoreFile(
  root: string,
  relative: string,
  role: SpecImportArtifactRole,
  markers: RegExp[],
  limits: SpecImportLimits,
  budget: { files: number; bytes: number },
  warnings: SpecImportWarning[],
  topWarnings: SpecImportWarning[],
  state: { truncated: boolean },
): Promise<{ text: string; artifact: SpecImportArtifact; templateMismatch: boolean } | null> {
  const outcome = await readWithinLimits(root, relative, limits, budget);
  if (outcome.kind === 'missing') return null;
  if (outcome.kind === 'too-large') {
    warnings.push({
      code: 'file-exceeds-limit',
      message: `"${relative}" exceeds the ${limits.maxFileBytes}-byte limit.`,
      path: relative,
    });
    return null;
  }
  if (outcome.kind === 'refused-symlink') {
    warnings.push({
      code: 'refused-symlink-file',
      message: `Refused symlink or junction at "${relative}".`,
      path: relative,
    });
    return null;
  }
  if (outcome.kind === 'refused-unsafe-path') {
    warnings.push({
      code: 'unsafe-path',
      message: `"${relative}" is not a safe regular file.`,
      path: relative,
    });
    return null;
  }
  if (outcome.kind === 'inaccessible') {
    warnings.push({
      code: 'inaccessible-file',
      message: `"${relative}" could not be read (permission denied).`,
      path: relative,
    });
    return null;
  }
  if (outcome.kind === 'limited') {
    state.truncated = true;
    topWarnings.push({
      code: 'discovery-limit-exceeded',
      message: 'Bounded discovery limit reached; some files were not read.',
      path: relative,
    });
    return null;
  }
  const text = outcome.content.toString('utf8');
  const templateMismatch = !looksLikeMarked(markers, text);
  if (templateMismatch)
    warnings.push({
      code: `unrecognized-${role}-format`,
      message: `"${relative}" does not match the pinned OpenSpec ${OPENSPEC_UPSTREAM.ref} ${role} template markers.`,
      path: relative,
    });
  return {
    text,
    artifact: {
      role,
      path: relative,
      sha256: outcome.sha256,
      byteLength: outcome.size,
      sectionAnchors: extractHeadings(text),
    },
    templateMismatch,
  };
}

function classifyChangeStatus(
  nameMatches: boolean,
  presentCount: number,
  templateMismatch: boolean,
): SpecImportEntryStatus {
  if (presentCount === 0) return 'malformed';
  if (!nameMatches) return 'ambiguous';
  if (presentCount < 3) return 'partial';
  if (templateMismatch) return 'unsupported-version';
  return 'complete';
}

async function buildChangeEntry(
  root: string,
  name: string,
  kind: 'active' | 'archived',
  limits: SpecImportLimits,
  budget: { files: number; bytes: number },
  topWarnings: SpecImportWarning[],
  state: { truncated: boolean },
): Promise<SpecImportEntry> {
  const directory =
    kind === 'active' ? `openspec/changes/${name}` : `openspec/changes/archive/${name}`;
  const nameMatches =
    kind === 'active' ? ACTIVE_CHANGE_NAME.test(name) : ARCHIVED_CHANGE_NAME.test(name);
  const slug = kind === 'archived' ? (ARCHIVED_CHANGE_NAME.exec(name)?.[2] ?? name) : name;

  const warnings: SpecImportWarning[] = [];
  const artifacts: SpecImportArtifact[] = [];
  const declaredLinks: SpecImportDeclaredLink[] = [];
  const inferredReferences: SpecImportInferredReference[] = [];
  const knownArtifactPaths = new Map<string, SpecImportArtifact>();
  const entryState = { filesRead: 0, truncated: false };
  let templateMismatch = false;

  const coreFiles: { role: SpecImportArtifactRole; file: string; markers: RegExp[] }[] = [
    { role: 'spec', file: 'proposal.md', markers: PROPOSAL_MARKERS },
    { role: 'plan', file: 'design.md', markers: DESIGN_MARKERS },
    { role: 'tasks', file: 'tasks.md', markers: TASKS_MARKERS },
  ];

  let tasksText: string | null = null;
  let presentCount = 0;
  for (const { role, file, markers } of coreFiles) {
    if (entryState.filesRead >= limits.maxFilesPerEntry) {
      warnings.push({
        code: 'entry-file-limit-exceeded',
        message: 'Per-entry file limit reached before every file could be read.',
        path: directory,
      });
      break;
    }
    const relative = `${directory}/${file}`;
    const result = await readCoreFile(
      root,
      relative,
      role,
      markers,
      limits,
      budget,
      warnings,
      topWarnings,
      state,
    );
    if (!result) continue;
    entryState.filesRead += 1;
    presentCount += 1;
    if (result.templateMismatch) templateMismatch = true;
    artifacts.push(result.artifact);
    knownArtifactPaths.set(relative, result.artifact);
    if (role === 'tasks') tasksText = result.text;

    const linkResult = await scanExplicitLinks(
      root,
      limits,
      budget,
      entryState,
      topWarnings,
      knownArtifactPaths,
      role,
      relative,
      result.text,
    );
    declaredLinks.push(...linkResult.declaredLinks);
    artifacts.push(...linkResult.newArtifacts);
    warnings.push(...linkResult.warnings);
  }

  const parsedTasks = tasksText ? parseOpenSpecTasks(tasksText, limits.maxTasksPerEntry) : [];
  for (const task of parsedTasks) {
    if (inferredReferences.length >= MAX_INFERRED_PER_ENTRY) break;
    inferredReferences.push(
      ...findInferredReferences(
        'tasks',
        `${directory}/tasks.md`,
        task.description,
        MAX_INFERRED_PER_ENTRY - inferredReferences.length,
      ),
    );
  }

  // Delta specs: `<change>/specs/**/spec.md`. Structurally discovered (not
  // linked), same as Spec Kit's own core files — bounded by the per-entry
  // file limit, not counted toward core-file completeness.
  if (entryState.filesRead < limits.maxFilesPerEntry) {
    const { directories: deltaDirs } = await findSpecDirectories(
      root,
      `${directory}/specs`,
      limits.maxDepth,
      limits.maxFilesPerEntry - entryState.filesRead,
      warnings,
    );
    for (const deltaDir of deltaDirs) {
      if (entryState.filesRead >= limits.maxFilesPerEntry) {
        warnings.push({
          code: 'entry-file-limit-exceeded',
          message: 'Per-entry file limit reached before every delta spec could be read.',
          path: directory,
        });
        break;
      }
      const relative = `${deltaDir}/spec.md`;
      const result = await readCoreFile(
        root,
        relative,
        'supporting',
        DELTA_SPEC_MARKERS,
        limits,
        budget,
        warnings,
        topWarnings,
        state,
      );
      if (!result) continue;
      entryState.filesRead += 1;
      artifacts.push(result.artifact);
      knownArtifactPaths.set(relative, result.artifact);
      if (result.templateMismatch)
        warnings.push({
          code: 'unrecognized-delta-spec-format',
          message: `"${relative}" does not match the pinned OpenSpec ${OPENSPEC_UPSTREAM.ref} delta-spec markers.`,
          path: relative,
        });
    }
  }

  if (entryState.truncated) state.truncated = true;
  if (!nameMatches)
    warnings.push({
      code: 'nonstandard-change-directory-name',
      message:
        kind === 'active'
          ? `"${name}" does not match the pinned OpenSpec kebab-case change-name convention.`
          : `"${name}" does not match the pinned OpenSpec "YYYY-MM-DD-slug" archived-change convention.`,
      path: directory,
    });

  return {
    id: directory,
    slug,
    directory,
    status: classifyChangeStatus(nameMatches, presentCount, templateMismatch),
    lifecycle: kind,
    sourceDeclaredStatus: { value: null, provenance: 'source-declared-claim' },
    artifacts,
    declaredLinks,
    inferredReferences,
    parsedIdentifiers: { tasks: parsedTasks, userStories: [] },
    warnings,
  };
}

function classifyCurrentSpecStatus(
  nameMatches: boolean,
  present: boolean,
  hasRequirementsHeading: boolean,
  hasRequirementEntry: boolean,
): SpecImportEntryStatus {
  if (!present) return 'malformed';
  if (!nameMatches) return 'ambiguous';
  if (!hasRequirementsHeading) return 'unsupported-version';
  if (!hasRequirementEntry) return 'partial';
  return 'complete';
}

async function buildCurrentSpecEntry(
  root: string,
  domainPath: string,
  limits: SpecImportLimits,
  budget: { files: number; bytes: number },
  topWarnings: SpecImportWarning[],
  state: { truncated: boolean },
): Promise<SpecImportEntry> {
  const directory = `openspec/specs/${domainPath}`;
  const relative = `${directory}/spec.md`;
  const warnings: SpecImportWarning[] = [];
  const nameMatches = domainPath.split('/').every((segment) => DOMAIN_SEGMENT.test(segment));

  const result = await readCoreFile(
    root,
    relative,
    'spec',
    CURRENT_SPEC_MARKERS,
    limits,
    budget,
    warnings,
    topWarnings,
    state,
  );
  const artifacts: SpecImportArtifact[] = [];
  const declaredLinks: SpecImportDeclaredLink[] = [];
  let hasRequirementsHeading = false;
  let hasRequirementEntry = false;
  if (result) {
    artifacts.push(result.artifact);
    hasRequirementsHeading = /^##\s*Requirements\s*$/m.test(result.text);
    hasRequirementEntry = /^###\s*Requirement:/m.test(result.text);
    const entryState = { filesRead: 1, truncated: false };
    const knownArtifactPaths = new Map<string, SpecImportArtifact>([[relative, result.artifact]]);
    const linkResult = await scanExplicitLinks(
      root,
      limits,
      budget,
      entryState,
      topWarnings,
      knownArtifactPaths,
      'spec',
      relative,
      result.text,
    );
    declaredLinks.push(...linkResult.declaredLinks);
    artifacts.push(...linkResult.newArtifacts);
    warnings.push(...linkResult.warnings);
    if (entryState.truncated) state.truncated = true;
  }

  if (!nameMatches)
    warnings.push({
      code: 'nonstandard-capability-path',
      message: `"${domainPath}" does not match the pinned OpenSpec kebab-case capability-path convention.`,
      path: directory,
    });

  return {
    id: directory,
    slug: domainPath,
    directory,
    status: classifyCurrentSpecStatus(
      nameMatches,
      result !== null,
      hasRequirementsHeading,
      hasRequirementEntry,
    ),
    lifecycle: 'current',
    sourceDeclaredStatus: { value: null, provenance: 'source-declared-claim' },
    artifacts,
    declaredLinks,
    inferredReferences: [],
    parsedIdentifiers: { tasks: [], userStories: [] },
    warnings,
  };
}

function warnDuplicateSlugs(
  entries: SpecImportEntry[],
  kind: CandidateKind,
  topWarnings: SpecImportWarning[],
): void {
  const bySlug = new Map<string, SpecImportEntry[]>();
  for (const entry of entries) {
    if (entry.lifecycle !== kind) continue;
    const list = bySlug.get(entry.slug) ?? [];
    list.push(entry);
    bySlug.set(entry.slug, list);
  }
  for (const [slug, group] of bySlug) {
    if (group.length <= 1) continue;
    const directories = group.map((entry) => entry.directory).join(', ');
    topWarnings.push({
      code: 'duplicate-feature-slug',
      message: `${group.length} ${kind} OpenSpec entries share the slug "${slug}": ${directories}.`,
      path: kind === 'current' ? 'openspec/specs' : 'openspec/changes',
    });
    for (const entry of group)
      entry.warnings.push({
        code: 'duplicate-feature-slug',
        message: `Shares slug "${slug}" with ${group.length - 1} other ${kind} entr${
          group.length - 1 === 1 ? 'y' : 'ies'
        }.`,
        path: entry.directory,
      });
  }
}

export async function buildOpenSpecManifest(
  root: string,
  {
    limits = DEFAULT_SPEC_IMPORT_LIMITS,
    clock = () => new Date(),
  }: {
    limits?: SpecImportLimits;
    clock?: () => Date;
  } = {},
): Promise<SpecImportManifest> {
  const topWarnings: SpecImportWarning[] = [];
  const budget = { files: limits.maxTotalFiles, bytes: limits.maxTotalBytes };
  const state = { truncated: false };

  await detectStorePointer(root, limits, budget, topWarnings);

  // Enumerated fully (bounded only by depth), then capped below alongside
  // active/archived changes — mirrors the Spec Kit adapter's "readdir every
  // candidate, then slice to the limit" convention so the combined,
  // current-first cap and its warning are computed in one place.
  const { directories: specDirs } = await findSpecDirectories(
    root,
    'openspec/specs',
    limits.maxDepth,
    Number.MAX_SAFE_INTEGER,
    topWarnings,
  );

  const changesEntries = await listDirectoryEntries(
    root,
    'openspec/changes',
    topWarnings,
    'changes-not-a-directory',
    'changes-directory-inaccessible',
  );
  const activeNames: string[] = [];
  let archiveDirEntry: Dirent | null = null;
  for (const entry of changesEntries) {
    if (entry.isSymbolicLink()) {
      topWarnings.push({
        code: 'refused-symlink-entry',
        message: `Refused symlinked entry "openspec/changes/${entry.name}".`,
        path: `openspec/changes/${entry.name}`,
      });
      continue;
    }
    if (!entry.isDirectory()) continue;
    if (entry.name === 'archive') {
      archiveDirEntry = entry;
      continue;
    }
    activeNames.push(entry.name);
  }
  activeNames.sort();

  let archivedNames: string[] = [];
  if (archiveDirEntry) {
    const archiveEntries = await listDirectoryEntries(
      root,
      'openspec/changes/archive',
      topWarnings,
      'archive-not-a-directory',
      'archive-directory-inaccessible',
    );
    archivedNames = archiveEntries
      .filter((entry) => {
        if (entry.isSymbolicLink()) {
          topWarnings.push({
            code: 'refused-symlink-entry',
            message: `Refused symlinked entry "openspec/changes/archive/${entry.name}".`,
            path: `openspec/changes/archive/${entry.name}`,
          });
          return false;
        }
        return entry.isDirectory();
      })
      .map((entry) => entry.name)
      .sort();
  }

  const totalCandidates = specDirs.length + activeNames.length + archivedNames.length;
  const cap = limits.maxFeatureDirectories;
  const limitedSpecDirs = specDirs.slice(0, cap);
  const remainingAfterSpecs = Math.max(0, cap - limitedSpecDirs.length);
  const limitedActive = activeNames.slice(0, remainingAfterSpecs);
  const remainingAfterActive = Math.max(0, remainingAfterSpecs - limitedActive.length);
  const limitedArchived = archivedNames.slice(0, remainingAfterActive);
  if (totalCandidates > limitedSpecDirs.length + limitedActive.length + limitedArchived.length) {
    state.truncated = true;
    topWarnings.push({
      code: 'feature-directory-limit-exceeded',
      message: `Only the first ${cap} OpenSpec entries (current specs, then active changes, then archived changes) were scanned.`,
      path: 'openspec',
    });
  }

  const entries: SpecImportEntry[] = [];
  for (const domainPath of limitedSpecDirs) {
    if (budget.files <= 0 || budget.bytes <= 0) {
      state.truncated = true;
      topWarnings.push({
        code: 'discovery-limit-exceeded',
        message: 'Bounded discovery limit reached before every entry could be processed.',
        path: 'openspec',
      });
      break;
    }
    const domain = domainPath.slice('openspec/specs/'.length);
    entries.push(await buildCurrentSpecEntry(root, domain, limits, budget, topWarnings, state));
  }
  for (const name of limitedActive) {
    if (budget.files <= 0 || budget.bytes <= 0) {
      state.truncated = true;
      topWarnings.push({
        code: 'discovery-limit-exceeded',
        message: 'Bounded discovery limit reached before every entry could be processed.',
        path: 'openspec',
      });
      break;
    }
    entries.push(await buildChangeEntry(root, name, 'active', limits, budget, topWarnings, state));
  }
  for (const name of limitedArchived) {
    if (budget.files <= 0 || budget.bytes <= 0) {
      state.truncated = true;
      topWarnings.push({
        code: 'discovery-limit-exceeded',
        message: 'Bounded discovery limit reached before every entry could be processed.',
        path: 'openspec',
      });
      break;
    }
    entries.push(
      await buildChangeEntry(root, name, 'archived', limits, budget, topWarnings, state),
    );
  }

  warnDuplicateSlugs(entries, 'current', topWarnings);
  warnDuplicateSlugs(entries, 'active', topWarnings);
  warnDuplicateSlugs(entries, 'archived', topWarnings);

  return {
    schemaVersion: SPEC_IMPORT_MANIFEST_SCHEMA_VERSION as 1,
    adapter: {
      id: OPENSPEC_ADAPTER_ID,
      version: OPENSPEC_ADAPTER_VERSION,
      upstream: OPENSPEC_UPSTREAM,
    },
    discoveredAt: clock().toISOString(),
    sourceRoot: { path: root },
    limits,
    truncated: state.truncated,
    entries,
    warnings: topWarnings,
  };
}
