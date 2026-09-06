// GitHub Spec Kit discovery/preview adapter, pinned to SPEC_KIT_UPSTREAM
// (see contracts.ts). Reads only `<root>/specs/<feature>/{spec,plan,tasks}.md`
// and their explicit local links. Never executes anything; never follows a
// reference outside `root`.
import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { errorCode } from '../types.js';
import { safePath, statIfExists } from '../storage.js';
import {
  DEFAULT_SPEC_IMPORT_LIMITS,
  SPEC_IMPORT_MANIFEST_SCHEMA_VERSION,
  SPEC_KIT_ADAPTER_ID,
  SPEC_KIT_ADAPTER_VERSION,
  SPEC_KIT_UPSTREAM,
  type SpecImportArtifact,
  type SpecImportArtifactRole,
  type SpecImportDeclaredLink,
  type SpecImportEntry,
  type SpecImportEntryStatus,
  type SpecImportInferredReference,
  type SpecImportLimits,
  type SpecImportManifest,
  type SpecImportTaskIdentifier,
  type SpecImportUserStory,
  type SpecImportWarning,
} from './contracts.js';

const FEATURE_DIRECTORY_NAME = /^[0-9]{3}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEADING_LINE = /^#{1,6}\s+(.+?)\s*$/;
const STATUS_LINE = /^\*\*Status\*\*:\s*(.+?)\s*$/;
const TASK_LINE = /^-\s\[([ xX])\]\s+(T\d{3,})((?:\s+\[P\])?)((?:\s+\[US\d+\])?)\s+(.+)$/;
const USER_STORY_LINE = /^###\s+User Story\s+(\d+)\s*-\s*(.+?)\s*\(Priority:\s*(P\d+)\)\s*$/;
const MAX_HEADINGS = 40;
const MAX_INFERRED_PER_TASK = 5;
const MAX_INFERRED_PER_ENTRY = 50;

const SPEC_TEMPLATE_MARKERS = [
  /^#\s*Feature Specification:/m,
  /\*\*Status\*\*:/m,
  /##\s*User (Scenarios|Stories)/im,
];
const PLAN_TEMPLATE_MARKERS = [/^#\s*Implementation Plan:/m, /##\s*Technical Context/m];
const TASKS_TEMPLATE_MARKERS = [/^#\s*Tasks:/m, /^-\s\[[ xX]\]\s*T\d{3,}/m];

function looksLikePinnedTemplate(role: 'spec' | 'plan' | 'tasks', content: string): boolean {
  const markers =
    role === 'spec'
      ? SPEC_TEMPLATE_MARKERS
      : role === 'plan'
        ? PLAN_TEMPLATE_MARKERS
        : TASKS_TEMPLATE_MARKERS;
  return markers.some((marker) => marker.test(content));
}

function splitLines(content: string): string[] {
  return content.split(/\r\n|\r|\n/);
}

function extractHeadings(content: string): string[] {
  const headings: string[] = [];
  for (const line of splitLines(content)) {
    if (headings.length >= MAX_HEADINGS) break;
    const match = HEADING_LINE.exec(line);
    if (match?.[1]) headings.push(match[1].slice(0, 200));
  }
  return headings;
}

function parseSourceDeclaredStatus(content: string): string | null {
  for (const line of splitLines(content)) {
    const match = STATUS_LINE.exec(line);
    if (match?.[1]) return match[1].slice(0, 200);
  }
  return null;
}

function parseUserStories(content: string, max: number): SpecImportUserStory[] {
  const stories: SpecImportUserStory[] = [];
  for (const line of splitLines(content)) {
    if (stories.length >= max) break;
    const match = USER_STORY_LINE.exec(line);
    if (!match) continue;
    const [, number, title, priority] = match;
    if (!number || !title) continue;
    stories.push({
      number: Number(number),
      title: title.slice(0, 200),
      priority: priority ?? null,
    });
  }
  return stories;
}

function parseTasks(content: string, max: number): SpecImportTaskIdentifier[] {
  const tasks: SpecImportTaskIdentifier[] = [];
  for (const line of splitLines(content)) {
    if (tasks.length >= max) break;
    const match = TASK_LINE.exec(line);
    if (!match) continue;
    const [, checkedMark, id, parallelMark, storyMark, description] = match;
    if (!checkedMark || !id || description === undefined) continue;
    const story = storyMark?.trim().replace(/^\[|\]$/g, '') ?? '';
    tasks.push({
      id,
      checked: checkedMark.toLowerCase() === 'x',
      parallel: parallelMark?.trim() === '[P]',
      userStory: story || null,
      description: description.trim().slice(0, 300),
    });
  }
  return tasks;
}

const PATH_TOKEN = /\b[\w][\w.-]*(?:\/[\w.-]+)+\.[A-Za-z0-9]{1,8}\b/;

function findInferredReferences(
  role: SpecImportArtifactRole,
  fromPath: string,
  text: string,
  budgetRemaining: number,
): SpecImportInferredReference[] {
  const found: SpecImportInferredReference[] = [];
  const source = new RegExp(PATH_TOKEN.source, 'g');
  let match: RegExpExecArray | null;
  let perTask = 0;
  while (
    (match = source.exec(text)) &&
    found.length < budgetRemaining &&
    perTask < MAX_INFERRED_PER_TASK
  ) {
    const token = match[0];
    perTask += 1;
    found.push({
      fromRole: role,
      fromPath,
      text: text.slice(0, 160),
      candidatePath: token,
      provenance: 'inferred',
      established: false,
    });
  }
  return found;
}

type HrefResolution =
  | { kind: 'external' }
  | { kind: 'anchor-only' }
  | { kind: 'escaped'; code: string }
  | { kind: 'local'; relative: string };

function resolveHref(fromDirectory: string, href: string): HrefResolution {
  const trimmed = href.trim();
  if (!trimmed) return { kind: 'anchor-only' };
  const hashIndex = trimmed.indexOf('#');
  const withoutAnchor = hashIndex === -1 ? trimmed : trimmed.slice(0, hashIndex);
  if (!withoutAnchor) return { kind: 'anchor-only' };
  if (withoutAnchor.includes('\\')) return { kind: 'escaped', code: 'declared-link-invalid' };
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(withoutAnchor);
  if (schemeMatch?.[1]) {
    if (schemeMatch[1].length === 1)
      return { kind: 'escaped', code: 'declared-link-absolute-path' };
    return { kind: 'external' };
  }
  if (withoutAnchor.startsWith('/'))
    return { kind: 'escaped', code: 'declared-link-absolute-path' };
  const joined = path.posix.normalize(path.posix.join(fromDirectory, withoutAnchor));
  if (joined === '..' || joined.startsWith('../') || path.posix.isAbsolute(joined))
    return { kind: 'escaped', code: 'declared-link-escapes-root' };
  return { kind: 'local', relative: joined };
}

type ReadOutcome =
  | { kind: 'ok'; absolute: string; content: Buffer; size: number; sha256: string }
  | { kind: 'missing' }
  | { kind: 'too-large'; size: number }
  | { kind: 'refused-symlink' }
  | { kind: 'refused-unsafe-path' }
  | { kind: 'inaccessible' }
  | { kind: 'limited'; size: number };

async function readWithinLimits(
  root: string,
  relative: string,
  limits: SpecImportLimits,
  budget: { files: number; bytes: number },
): Promise<ReadOutcome> {
  let target: string;
  try {
    target = await safePath(root, relative);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'EACCES' || code === 'EPERM') return { kind: 'inaccessible' };
    const message = error instanceof Error ? error.message : '';
    return {
      kind: /symlink or junction/i.test(message) ? 'refused-symlink' : 'refused-unsafe-path',
    };
  }
  let stat;
  try {
    stat = await statIfExists(target);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'EACCES' || code === 'EPERM') return { kind: 'inaccessible' };
    throw error;
  }
  if (!stat) return { kind: 'missing' };
  if (!stat.isFile()) return { kind: 'refused-unsafe-path' };
  if (stat.size > limits.maxFileBytes) return { kind: 'too-large', size: stat.size };
  if (stat.size > budget.bytes || budget.files <= 0) return { kind: 'limited', size: stat.size };
  let content: Buffer;
  try {
    content = await readFile(target);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') return { kind: 'missing' };
    if (code === 'EACCES' || code === 'EPERM') return { kind: 'inaccessible' };
    throw error;
  }
  budget.files -= 1;
  budget.bytes -= content.byteLength;
  return {
    kind: 'ok',
    absolute: target,
    content,
    size: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

function classifyStatus(
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

function inaccessibleEntry(dirName: string, directory: string): SpecImportEntry {
  return {
    id: dirName,
    slug: dirName.replace(/^[0-9]{3}-/, ''),
    directory,
    status: 'inaccessible',
    lifecycle: null,
    sourceDeclaredStatus: { value: null, provenance: 'source-declared-claim' },
    artifacts: [],
    declaredLinks: [],
    inferredReferences: [],
    parsedIdentifiers: { tasks: [], userStories: [] },
    warnings: [
      {
        code: 'inaccessible-directory',
        message: `"${directory}" could not be read (permission denied).`,
        path: directory,
      },
    ],
  };
}

type CoreContent = { relative: string; text: string };

async function buildEntry(
  root: string,
  dirName: string,
  limits: SpecImportLimits,
  budget: { files: number; bytes: number },
  topWarnings: SpecImportWarning[],
  state: { truncated: boolean },
): Promise<SpecImportEntry | null> {
  const directory = `specs/${dirName}`;
  let directoryTarget: string;
  try {
    directoryTarget = await safePath(root, directory, 'directory');
  } catch (error) {
    const code = errorCode(error);
    if (code === 'EACCES' || code === 'EPERM') return inaccessibleEntry(dirName, directory);
    const message = error instanceof Error ? error.message : '';
    topWarnings.push({
      code: /symlink or junction/i.test(message) ? 'refused-symlink-entry' : 'refused-unsafe-entry',
      message: `Refused feature directory "${directory}": ${message}`,
      path: directory,
    });
    return null;
  }
  let directoryStat;
  try {
    directoryStat = await statIfExists(directoryTarget);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'EACCES' || code === 'EPERM') return inaccessibleEntry(dirName, directory);
    throw error;
  }
  if (!directoryStat || !directoryStat.isDirectory()) return null;

  const warnings: SpecImportWarning[] = [];
  const artifacts: SpecImportArtifact[] = [];
  const declaredLinks: SpecImportDeclaredLink[] = [];
  const inferredReferences: SpecImportInferredReference[] = [];
  const coreContents = new Map<'spec' | 'plan' | 'tasks', CoreContent>();
  // Tracks every artifact already read this entry (core or supporting), keyed
  // by its root-relative path, so a link that happens to point at a core file
  // (e.g. plan.md linking to tasks.md) is recorded as a declared link without
  // re-reading the file or duplicating its artifact entry.
  const knownArtifactPaths = new Map<string, SpecImportArtifact>();
  let filesRead = 0;
  let templateMismatch = false;

  const coreFiles: { role: 'spec' | 'plan' | 'tasks'; file: string }[] = [
    { role: 'spec', file: 'spec.md' },
    { role: 'plan', file: 'plan.md' },
    { role: 'tasks', file: 'tasks.md' },
  ];

  for (const { role, file } of coreFiles) {
    if (filesRead >= limits.maxFilesPerEntry) {
      warnings.push({
        code: 'entry-file-limit-exceeded',
        message: 'Per-entry file limit reached before every file could be read.',
        path: directory,
      });
      break;
    }
    const relative = `${directory}/${file}`;
    const outcome = await readWithinLimits(root, relative, limits, budget);
    if (outcome.kind === 'missing') continue;
    if (outcome.kind === 'too-large') {
      warnings.push({
        code: 'file-exceeds-limit',
        message: `"${relative}" exceeds the ${limits.maxFileBytes}-byte limit.`,
        path: relative,
      });
      continue;
    }
    if (outcome.kind === 'refused-symlink') {
      warnings.push({
        code: 'refused-symlink-file',
        message: `Refused symlink or junction at "${relative}".`,
        path: relative,
      });
      continue;
    }
    if (outcome.kind === 'refused-unsafe-path') {
      warnings.push({
        code: 'unsafe-path',
        message: `"${relative}" is not a safe regular file.`,
        path: relative,
      });
      continue;
    }
    if (outcome.kind === 'inaccessible') {
      warnings.push({
        code: 'inaccessible-file',
        message: `"${relative}" could not be read (permission denied).`,
        path: relative,
      });
      continue;
    }
    if (outcome.kind === 'limited') {
      state.truncated = true;
      topWarnings.push({
        code: 'discovery-limit-exceeded',
        message: 'Bounded discovery limit reached; some files were not read.',
        path: relative,
      });
      continue;
    }
    filesRead += 1;
    const text = outcome.content.toString('utf8');
    coreContents.set(role, { relative, text });
    const artifact: SpecImportArtifact = {
      role,
      path: relative,
      sha256: outcome.sha256,
      byteLength: outcome.size,
      sectionAnchors: extractHeadings(text),
    };
    artifacts.push(artifact);
    knownArtifactPaths.set(relative, artifact);
    if (!looksLikePinnedTemplate(role, text)) {
      templateMismatch = true;
      warnings.push({
        code: `unrecognized-${role}-format`,
        message: `"${relative}" does not match the pinned Spec Kit ${SPEC_KIT_UPSTREAM.ref} ${role} template markers.`,
        path: relative,
      });
    }
  }

  const spec = coreContents.get('spec');
  const tasks = coreContents.get('tasks');
  const sourceDeclaredStatus = {
    value: spec ? parseSourceDeclaredStatus(spec.text) : null,
    provenance: 'source-declared-claim' as const,
  };
  const userStories = spec ? parseUserStories(spec.text, limits.maxUserStoriesPerEntry) : [];
  const parsedTasks = tasks ? parseTasks(tasks.text, limits.maxTasksPerEntry) : [];

  for (const task of parsedTasks) {
    if (inferredReferences.length >= MAX_INFERRED_PER_ENTRY) break;
    const relative = tasks?.relative ?? `${directory}/tasks.md`;
    inferredReferences.push(
      ...findInferredReferences(
        'tasks',
        relative,
        task.description,
        MAX_INFERRED_PER_ENTRY - inferredReferences.length,
      ),
    );
  }

  for (const [role, content] of coreContents) {
    if (filesRead >= limits.maxFilesPerEntry) break;
    let linkCount = 0;
    for (const match of content.text.matchAll(/\[([^\]\n]{0,200})\]\(([^)\s]+)\)/g)) {
      if (linkCount >= limits.maxLinksPerArtifact) break;
      linkCount += 1;
      const linkText = match[1] ?? '';
      const href = match[2] ?? '';
      const resolution = resolveHref(path.posix.dirname(content.relative), href);
      if (resolution.kind === 'external' || resolution.kind === 'anchor-only') continue;
      if (resolution.kind === 'escaped') {
        warnings.push({
          code: resolution.code,
          message: `Refused local link "${href}" from "${content.relative}".`,
          path: content.relative,
        });
        continue;
      }
      const depth = resolution.relative.split('/').length;
      if (depth > limits.maxDepth) {
        warnings.push({
          code: 'declared-link-exceeds-depth',
          message: `Local link "${href}" from "${content.relative}" exceeds the depth limit.`,
          path: resolution.relative,
        });
        continue;
      }
      const already = knownArtifactPaths.get(resolution.relative);
      if (already) {
        declaredLinks.push({
          fromRole: role,
          fromPath: content.relative,
          linkText,
          targetPath: resolution.relative,
          targetExists: true,
          provenance: 'explicit-link',
        });
        continue;
      }
      if (filesRead >= limits.maxFilesPerEntry) {
        warnings.push({
          code: 'entry-file-limit-exceeded',
          message: 'Per-entry file limit reached before every supporting link could be resolved.',
          path: directory,
        });
        break;
      }
      const outcome = await readWithinLimits(root, resolution.relative, limits, budget);
      if (outcome.kind === 'missing') {
        declaredLinks.push({
          fromRole: role,
          fromPath: content.relative,
          linkText,
          targetPath: resolution.relative,
          targetExists: false,
          provenance: 'explicit-link',
        });
        warnings.push({
          code: 'missing-referenced-file',
          message: `Referenced file "${resolution.relative}" does not exist.`,
          path: resolution.relative,
        });
        continue;
      }
      if (outcome.kind === 'refused-symlink') {
        warnings.push({
          code: 'declared-link-symlink-escape',
          message: `Referenced file "${resolution.relative}" is a symlink or junction and was refused.`,
          path: resolution.relative,
        });
        continue;
      }
      if (outcome.kind === 'refused-unsafe-path') {
        warnings.push({
          code: 'declared-link-invalid',
          message: `Referenced path "${resolution.relative}" is not a safe regular file.`,
          path: resolution.relative,
        });
        continue;
      }
      if (outcome.kind === 'inaccessible') {
        warnings.push({
          code: 'declared-link-inaccessible',
          message: `Referenced file "${resolution.relative}" could not be read (permission denied).`,
          path: resolution.relative,
        });
        continue;
      }
      if (outcome.kind === 'too-large') {
        declaredLinks.push({
          fromRole: role,
          fromPath: content.relative,
          linkText,
          targetPath: resolution.relative,
          targetExists: true,
          provenance: 'explicit-link',
        });
        warnings.push({
          code: 'file-exceeds-limit',
          message: `"${resolution.relative}" exceeds the ${limits.maxFileBytes}-byte limit.`,
          path: resolution.relative,
        });
        continue;
      }
      if (outcome.kind === 'limited') {
        state.truncated = true;
        topWarnings.push({
          code: 'discovery-limit-exceeded',
          message: 'Bounded discovery limit reached; some referenced files were not read.',
          path: resolution.relative,
        });
        declaredLinks.push({
          fromRole: role,
          fromPath: content.relative,
          linkText,
          targetPath: resolution.relative,
          targetExists: true,
          provenance: 'explicit-link',
        });
        continue;
      }
      filesRead += 1;
      const supportingArtifact: SpecImportArtifact = {
        role: 'supporting',
        path: resolution.relative,
        sha256: outcome.sha256,
        byteLength: outcome.size,
        sectionAnchors: extractHeadings(outcome.content.toString('utf8')),
      };
      artifacts.push(supportingArtifact);
      knownArtifactPaths.set(resolution.relative, supportingArtifact);
      declaredLinks.push({
        fromRole: role,
        fromPath: content.relative,
        linkText,
        targetPath: resolution.relative,
        targetExists: true,
        provenance: 'explicit-link',
      });
    }
  }

  const nameMatches = FEATURE_DIRECTORY_NAME.test(dirName);
  if (!nameMatches)
    warnings.push({
      code: 'nonstandard-feature-directory-name',
      message: `"${dirName}" does not match the pinned Spec Kit "NNN-slug" naming convention.`,
      path: directory,
    });
  const presentCount = ['spec', 'plan', 'tasks'].filter((role) =>
    coreContents.has(role as never),
  ).length;
  const status = classifyStatus(nameMatches, presentCount, templateMismatch);

  return {
    id: dirName,
    slug: dirName.replace(/^[0-9]{3}-/, ''),
    directory,
    status,
    lifecycle: null,
    sourceDeclaredStatus,
    artifacts,
    declaredLinks,
    inferredReferences,
    parsedIdentifiers: { tasks: parsedTasks, userStories },
    warnings,
  };
}

export async function buildSpecKitManifest(
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

  let specsEntries: Dirent[] = [];
  try {
    specsEntries = await readdir(path.join(root, 'specs'), { withFileTypes: true });
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') {
      specsEntries = [];
    } else if (code === 'EACCES' || code === 'EPERM') {
      topWarnings.push({
        code: 'specs-directory-inaccessible',
        message: '"specs" could not be read (permission denied).',
        path: 'specs',
      });
    } else if (code === 'ENOTDIR') {
      topWarnings.push({
        code: 'specs-not-a-directory',
        message: '"specs" exists but is not a directory.',
        path: 'specs',
      });
    } else {
      throw error;
    }
  }

  const candidateNames = specsEntries
    .filter((entry) => {
      if (entry.isSymbolicLink()) {
        topWarnings.push({
          code: 'refused-symlink-entry',
          message: `Refused symlinked feature directory "specs/${entry.name}".`,
          path: `specs/${entry.name}`,
        });
        return false;
      }
      return entry.isDirectory();
    })
    .map((entry) => entry.name)
    .sort();

  const limitedNames = candidateNames.slice(0, limits.maxFeatureDirectories);
  if (candidateNames.length > limitedNames.length) {
    state.truncated = true;
    topWarnings.push({
      code: 'feature-directory-limit-exceeded',
      message: `Only the first ${limits.maxFeatureDirectories} feature directories were scanned.`,
      path: 'specs',
    });
  }

  const entries: SpecImportEntry[] = [];
  for (const name of limitedNames) {
    if (budget.files <= 0 || budget.bytes <= 0) {
      state.truncated = true;
      topWarnings.push({
        code: 'discovery-limit-exceeded',
        message:
          'Bounded discovery limit reached before every feature directory could be processed.',
        path: 'specs',
      });
      break;
    }
    const entry = await buildEntry(root, name, limits, budget, topWarnings, state);
    if (entry) entries.push(entry);
  }

  const bySlug = new Map<string, SpecImportEntry[]>();
  for (const entry of entries) {
    const list = bySlug.get(entry.slug) ?? [];
    list.push(entry);
    bySlug.set(entry.slug, list);
  }
  for (const [slug, group] of bySlug) {
    if (group.length <= 1) continue;
    const directories = group.map((entry) => entry.directory).join(', ');
    topWarnings.push({
      code: 'duplicate-feature-slug',
      message: `${group.length} feature directories share the slug "${slug}": ${directories}.`,
      path: 'specs',
    });
    for (const entry of group)
      entry.warnings.push({
        code: 'duplicate-feature-slug',
        message: `Shares slug "${slug}" with ${group.length - 1} other feature director${
          group.length - 1 === 1 ? 'y' : 'ies'
        }.`,
        path: entry.directory,
      });
  }

  return {
    schemaVersion: SPEC_IMPORT_MANIFEST_SCHEMA_VERSION as 1,
    adapter: {
      id: SPEC_KIT_ADAPTER_ID,
      version: SPEC_KIT_ADAPTER_VERSION,
      upstream: SPEC_KIT_UPSTREAM,
    },
    discoveredAt: clock().toISOString(),
    sourceRoot: { path: root },
    limits,
    truncated: state.truncated,
    entries,
    warnings: topWarnings,
  };
}
