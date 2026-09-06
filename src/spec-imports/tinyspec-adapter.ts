// TinySpec discovery/preview adapter, pinned to TINYSPEC_UPSTREAM (see
// contracts.ts). Reads only `<root>/.specs/*.md` (ungrouped) and
// `<root>/.specs/<group>/*.md` (one level of grouping, `templates/`
// excluded), each file's `tinySpec: v0` front matter and its `# Background`
// / `# Proposal` / `# Implementation Plan` / `# Test Plan` sections, plus
// explicit local links from the file body. Never executes anything; never
// follows a reference outside `root`, including an `applications:`
// front-matter entry, which names a repository resolved only through the
// user's local `~/.tinyspec/config.yaml` — outside any selected root.
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
  SPEC_IMPORT_MANIFEST_SCHEMA_VERSION,
  TINYSPEC_ADAPTER_ID,
  TINYSPEC_ADAPTER_VERSION,
  TINYSPEC_UPSTREAM,
  type SpecImportArtifact,
  type SpecImportDeclaredLink,
  type SpecImportEntry,
  type SpecImportEntryStatus,
  type SpecImportInferredReference,
  type SpecImportLimits,
  type SpecImportManifest,
  type SpecImportTaskIdentifier,
  type SpecImportWarning,
} from './contracts.js';

// Mirrors upstream `extract_spec_name` (17-char "YYYY-MM-DD-HH-MM-" prefix,
// `.md` suffix) but, unlike upstream, does not assume the remaining name is
// well-formed — kebab-case is checked separately so a customized name still
// yields a clean `slug` for duplicate-detection instead of the whole filename.
const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-(.+)\.md$/;
const KEBAB_CASE = /^[a-z0-9](?:-?[a-z0-9]+)*$/;
const MAX_INFERRED_PER_ENTRY = 50;
const MAX_APPLICATIONS_NOTED = 10;

type TinySpecFrontMatter = {
  tinySpec: string | null;
  title: string | null;
  applications: string[];
};

/**
 * Minimal YAML-subset parser for the pinned front-matter shape (`tinySpec`,
 * `title`, and a single-level `applications` list, inline `[a, b]` or block
 * `- a`). Anything more exotic (nested maps, multi-line scalars, anchors)
 * is out of scope — see the "Known limitations" note in docs/spec-imports.md.
 */
function parseFrontMatter(content: string): TinySpecFrontMatter | null {
  const startMatch = /^---\r?\n/.exec(content);
  if (!startMatch) return null;
  const rest = content.slice(startMatch[0].length);
  const endMatch = /\r?\n---(?:\r?\n|$)/.exec(rest);
  if (!endMatch) return null;
  const yamlBlock = rest.slice(0, endMatch.index);

  let tinySpec: string | null = null;
  let title: string | null = null;
  const applications: string[] = [];
  let inApplications = false;
  const stripQuotes = (value: string) => value.replace(/^['"]|['"]$/g, '').trim();

  for (const rawLine of splitLines(yamlBlock)) {
    const kvMatch = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(rawLine);
    if (kvMatch?.[1] !== undefined) {
      inApplications = false;
      const key = kvMatch[1];
      const value = (kvMatch[2] ?? '').trim();
      if (key === 'tinySpec') tinySpec = value ? stripQuotes(value) : null;
      else if (key === 'title') title = value ? stripQuotes(value) : null;
      else if (key === 'applications') {
        if (value.startsWith('[') && value.endsWith(']')) {
          for (const item of value.slice(1, -1).split(','))
            if (item.trim()) applications.push(stripQuotes(item));
        } else if (value === '' || value === '|' || value === '>') {
          inApplications = true;
        }
      }
      continue;
    }
    if (inApplications) {
      const itemMatch = /^-\s*(.+)$/.exec(rawLine.trim());
      if (itemMatch?.[1]) applications.push(stripQuotes(itemMatch[1]));
      else if (rawLine.trim()) inApplications = false;
    }
  }
  return { tinySpec, title, applications };
}

function hasExactHeading(content: string, heading: string): boolean {
  return splitLines(content).some((line) => line.trim() === heading);
}

const TASK_LINE_CHECKED = /^-\s\[[xX]\]\s(.*)$/;
const TASK_LINE_UNCHECKED = /^-\s\[ \]\s(.*)$/;

/** Mirrors upstream `parse_tasks` in `src/spec/summary.rs`: only the `# Implementation Plan` section, exact heading match, `ID: description`. */
function parseTinySpecTasks(content: string, max: number): SpecImportTaskIdentifier[] {
  const tasks: SpecImportTaskIdentifier[] = [];
  let inPlan = false;
  for (const rawLine of splitLines(content)) {
    const trimmed = rawLine.trim();
    if (trimmed === '# Implementation Plan') {
      inPlan = true;
      continue;
    }
    if (inPlan && trimmed.startsWith('# ')) break;
    if (!inPlan) continue;
    if (tasks.length >= max) break;
    const checkedMatch = TASK_LINE_CHECKED.exec(trimmed);
    const uncheckedMatch = TASK_LINE_UNCHECKED.exec(trimmed);
    const match = checkedMatch ?? uncheckedMatch;
    if (!match?.[1]) continue;
    const colonIndex = match[1].indexOf(':');
    if (colonIndex === -1) continue;
    const id = match[1].slice(0, colonIndex).trim().slice(0, 64);
    const description = match[1].slice(colonIndex + 1).trim();
    if (!id || !description) continue;
    tasks.push({
      id,
      checked: checkedMatch !== null,
      parallel: false,
      userStory: null,
      description: description.slice(0, 300),
    });
  }
  return tasks;
}

function classifyStatus(
  nameMatches: boolean,
  frontMatter: TinySpecFrontMatter | null,
  hasBackground: boolean,
  hasProposal: boolean,
  hasPlan: boolean,
): SpecImportEntryStatus {
  if (!frontMatter || frontMatter.tinySpec === null) return 'malformed';
  if (!nameMatches) return 'ambiguous';
  if (frontMatter.tinySpec !== 'v0') return 'unsupported-version';
  if (!hasBackground || !hasProposal || !hasPlan) return 'partial';
  return 'complete';
}

type Candidate = { relative: string; group: string | null; filename: string };

async function collectCandidates(
  root: string,
  limits: SpecImportLimits,
  topWarnings: SpecImportWarning[],
): Promise<{ candidates: Candidate[]; truncated: boolean }> {
  const candidates: Candidate[] = [];
  let target: string;
  try {
    target = await safePath(root, '.specs', 'directory');
  } catch {
    return { candidates, truncated: false };
  }
  let topEntries: Dirent[];
  try {
    topEntries = await readdir(target, { withFileTypes: true });
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') return { candidates, truncated: false };
    if (code === 'EACCES' || code === 'EPERM') {
      topWarnings.push({
        code: 'specs-directory-inaccessible',
        message: '".specs" could not be read (permission denied).',
        path: '.specs',
      });
      return { candidates, truncated: false };
    }
    if (code === 'ENOTDIR') {
      topWarnings.push({
        code: 'specs-not-a-directory',
        message: '".specs" exists but is not a directory.',
        path: '.specs',
      });
      return { candidates, truncated: false };
    }
    throw error;
  }

  for (const entry of topEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) {
      topWarnings.push({
        code: 'refused-symlink-entry',
        message: `Refused symlinked entry ".specs/${entry.name}".`,
        path: `.specs/${entry.name}`,
      });
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.md')) {
      candidates.push({ relative: `.specs/${entry.name}`, group: null, filename: entry.name });
      continue;
    }
    if (!entry.isDirectory() || entry.name === 'templates') continue;

    const groupRelative = `.specs/${entry.name}`;
    let groupTarget: string;
    try {
      groupTarget = await safePath(root, groupRelative, 'directory');
    } catch {
      continue;
    }
    let groupEntries: Dirent[];
    try {
      groupEntries = await readdir(groupTarget, { withFileTypes: true });
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') continue;
      if (code === 'EACCES' || code === 'EPERM') {
        topWarnings.push({
          code: 'inaccessible-directory',
          message: `"${groupRelative}" could not be read (permission denied).`,
          path: groupRelative,
        });
        continue;
      }
      throw error;
    }
    for (const groupEntry of groupEntries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (groupEntry.isSymbolicLink()) {
        topWarnings.push({
          code: 'refused-symlink-entry',
          message: `Refused symlinked entry "${groupRelative}/${groupEntry.name}".`,
          path: `${groupRelative}/${groupEntry.name}`,
        });
        continue;
      }
      if (groupEntry.isDirectory()) {
        topWarnings.push({
          code: 'nonstandard-tinyspec-nesting',
          message: `"${groupRelative}/${groupEntry.name}" is a second level of grouping; only one level is recognized and it was not scanned.`,
          path: `${groupRelative}/${groupEntry.name}`,
        });
        continue;
      }
      if (groupEntry.isFile() && groupEntry.name.endsWith('.md'))
        candidates.push({
          relative: `${groupRelative}/${groupEntry.name}`,
          group: entry.name,
          filename: groupEntry.name,
        });
    }
  }

  const limited = candidates.slice(0, limits.maxFeatureDirectories);
  return { candidates: limited, truncated: candidates.length > limited.length };
}

async function buildEntry(
  root: string,
  candidate: Candidate,
  limits: SpecImportLimits,
  budget: { files: number; bytes: number },
  topWarnings: SpecImportWarning[],
  state: { truncated: boolean },
): Promise<SpecImportEntry> {
  const { relative, group, filename } = candidate;
  const warnings: SpecImportWarning[] = [];
  const prefixMatch = TIMESTAMP_PREFIX.exec(filename);
  const name = prefixMatch?.[1] ?? filename.replace(/\.md$/, '');
  const groupMatches = group === null || KEBAB_CASE.test(group);
  const nameMatches = prefixMatch !== null && KEBAB_CASE.test(name) && groupMatches;

  const outcome = await readWithinLimits(root, relative, limits, budget);
  let content: string | null = null;
  let status: SpecImportEntryStatus | null = null;
  const artifacts: SpecImportArtifact[] = [];
  if (outcome.kind === 'ok') {
    content = outcome.content.toString('utf8');
    artifacts.push({
      role: 'spec',
      path: relative,
      sha256: outcome.sha256,
      byteLength: outcome.size,
      sectionAnchors: extractHeadings(content),
    });
  } else if (outcome.kind === 'inaccessible') {
    status = 'inaccessible';
    warnings.push({
      code: 'inaccessible-file',
      message: `"${relative}" could not be read (permission denied).`,
      path: relative,
    });
  } else if (outcome.kind === 'too-large') {
    warnings.push({
      code: 'file-exceeds-limit',
      message: `"${relative}" exceeds the ${limits.maxFileBytes}-byte limit.`,
      path: relative,
    });
  } else if (outcome.kind === 'limited') {
    state.truncated = true;
    topWarnings.push({
      code: 'discovery-limit-exceeded',
      message: 'Bounded discovery limit reached; some files were not read.',
      path: relative,
    });
  } else if (outcome.kind === 'refused-symlink') {
    warnings.push({
      code: 'refused-symlink-file',
      message: `Refused symlink or junction at "${relative}".`,
      path: relative,
    });
  } else {
    warnings.push({
      code: 'unsafe-path',
      message: `"${relative}" is not a safe regular file.`,
      path: relative,
    });
  }

  const frontMatter = content ? parseFrontMatter(content) : null;
  const hasBackground = content ? hasExactHeading(content, '# Background') : false;
  const hasProposal = content ? hasExactHeading(content, '# Proposal') : false;
  const hasPlan = content ? hasExactHeading(content, '# Implementation Plan') : false;
  if (status === null)
    status = classifyStatus(nameMatches, frontMatter, hasBackground, hasProposal, hasPlan);
  if (!nameMatches)
    warnings.push({
      code: 'nonstandard-tinyspec-filename',
      message: `"${filename}" does not match the pinned "YYYY-MM-DD-HH-MM-kebab-name.md" TinySpec convention.`,
      path: relative,
    });
  if (content && frontMatter && frontMatter.tinySpec !== null && frontMatter.tinySpec !== 'v0')
    warnings.push({
      code: 'unrecognized-tinyspec-version',
      message: `"${relative}" declares "tinySpec: ${frontMatter.tinySpec}", not the pinned "v0".`,
      path: relative,
    });

  const declaredLinks: SpecImportDeclaredLink[] = [];
  const parsedTasks = content ? parseTinySpecTasks(content, limits.maxTasksPerEntry) : [];
  const inferredReferences: SpecImportInferredReference[] = [];
  if (content && artifacts[0]) {
    const knownArtifactPaths = new Map<string, SpecImportArtifact>([[relative, artifacts[0]]]);
    const entryState = { filesRead: 1, truncated: false };
    const linkResult = await scanExplicitLinks(
      root,
      limits,
      budget,
      entryState,
      topWarnings,
      knownArtifactPaths,
      'spec',
      relative,
      content,
    );
    declaredLinks.push(...linkResult.declaredLinks);
    artifacts.push(...linkResult.newArtifacts);
    warnings.push(...linkResult.warnings);
    if (entryState.truncated) state.truncated = true;

    for (const task of parsedTasks) {
      if (inferredReferences.length >= MAX_INFERRED_PER_ENTRY) break;
      inferredReferences.push(
        ...findInferredReferences(
          'spec',
          relative,
          task.description,
          MAX_INFERRED_PER_ENTRY - inferredReferences.length,
        ),
      );
    }

    if (frontMatter && frontMatter.applications.length > 0) {
      const named = frontMatter.applications.slice(0, MAX_APPLICATIONS_NOTED).join(', ');
      warnings.push({
        code: 'tinyspec-application-pointer-detected',
        message: `"${relative}" declares application repositories (${named}); these are resolved only through the user's local ~/.tinyspec/config.yaml, which this adapter never reads.`,
        path: relative,
      });
    }
  }

  return {
    id: relative,
    slug: name,
    directory: relative,
    status,
    lifecycle: null,
    sourceDeclaredStatus: { value: null, provenance: 'source-declared-claim' },
    artifacts,
    declaredLinks,
    inferredReferences,
    parsedIdentifiers: { tasks: parsedTasks, userStories: [] },
    warnings,
  };
}

function warnDuplicateSlugs(entries: SpecImportEntry[], topWarnings: SpecImportWarning[]): void {
  const bySlug = new Map<string, SpecImportEntry[]>();
  for (const entry of entries) {
    const list = bySlug.get(entry.slug) ?? [];
    list.push(entry);
    bySlug.set(entry.slug, list);
  }
  for (const [slug, group] of bySlug) {
    if (group.length <= 1) continue;
    const paths = group.map((entry) => entry.directory).join(', ');
    topWarnings.push({
      code: 'duplicate-feature-slug',
      message: `${group.length} TinySpec files share the name "${slug}" (TinySpec names must be globally unique): ${paths}.`,
      path: '.specs',
    });
    for (const entry of group)
      entry.warnings.push({
        code: 'duplicate-feature-slug',
        message: `Shares the name "${slug}" with ${group.length - 1} other spec file${
          group.length - 1 === 1 ? '' : 's'
        }.`,
        path: entry.directory,
      });
  }
}

export async function buildTinySpecManifest(
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

  const { candidates, truncated: candidatesTruncated } = await collectCandidates(
    root,
    limits,
    topWarnings,
  );
  if (candidatesTruncated) {
    state.truncated = true;
    topWarnings.push({
      code: 'feature-directory-limit-exceeded',
      message: `Only the first ${limits.maxFeatureDirectories} TinySpec files were scanned.`,
      path: '.specs',
    });
  }

  const entries: SpecImportEntry[] = [];
  for (const candidate of candidates) {
    if (budget.files <= 0 || budget.bytes <= 0) {
      state.truncated = true;
      topWarnings.push({
        code: 'discovery-limit-exceeded',
        message: 'Bounded discovery limit reached before every file could be processed.',
        path: '.specs',
      });
      break;
    }
    entries.push(await buildEntry(root, candidate, limits, budget, topWarnings, state));
  }

  warnDuplicateSlugs(entries, topWarnings);

  return {
    schemaVersion: SPEC_IMPORT_MANIFEST_SCHEMA_VERSION as 1,
    adapter: {
      id: TINYSPEC_ADAPTER_ID,
      version: TINYSPEC_ADAPTER_VERSION,
      upstream: TINYSPEC_UPSTREAM,
    },
    discoveredAt: clock().toISOString(),
    sourceRoot: { path: root },
    limits,
    truncated: state.truncated,
    entries,
    warnings: topWarnings,
  };
}
