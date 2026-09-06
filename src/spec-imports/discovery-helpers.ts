// Generic, framework-agnostic filesystem/text helpers shared by the OpenSpec
// and TinySpec adapters (issue #114, second and third increments). These
// mirror the read-only, bounded conventions the Spec Kit adapter established
// in `spec-kit-adapter.ts` (PR #135): never execute anything, never follow a
// reference outside the caller-selected root, and never follow a
// symlink/junction anywhere along a scanned path. See docs/spec-imports.md.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { errorCode } from '../types.js';
import { safePath, statIfExists } from '../storage.js';
import type {
  SpecImportArtifact,
  SpecImportArtifactRole,
  SpecImportDeclaredLink,
  SpecImportInferredReference,
  SpecImportLimits,
  SpecImportWarning,
} from './contracts.js';

export function splitLines(content: string): string[] {
  return content.split(/\r\n|\r|\n/);
}

const HEADING_LINE = /^#{1,6}\s+(.+?)\s*$/;

/** Markdown ATX heading text found in the file, in document order, bounded. */
export function extractHeadings(content: string, max = 40): string[] {
  const headings: string[] = [];
  for (const line of splitLines(content)) {
    if (headings.length >= max) break;
    const match = HEADING_LINE.exec(line);
    if (match?.[1]) headings.push(match[1].slice(0, 200));
  }
  return headings;
}

export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

const PATH_TOKEN = /\b[\w][\w.-]*(?:\/[\w.-]+)+\.[A-Za-z0-9]{1,8}\b/;
const MAX_INFERRED_PER_CALL = 5;

/**
 * Plain-text, path-looking tokens inside prose (never resolved, hashed, or
 * existence-checked; structural co-location or wording cannot establish a
 * relationship). Mirrors the Spec Kit adapter's `findInferredReferences`.
 */
export function findInferredReferences(
  role: SpecImportArtifactRole,
  fromPath: string,
  text: string,
  budgetRemaining: number,
): SpecImportInferredReference[] {
  const found: SpecImportInferredReference[] = [];
  const source = new RegExp(PATH_TOKEN.source, 'g');
  let match: RegExpExecArray | null;
  let perCall = 0;
  while (
    (match = source.exec(text)) &&
    found.length < budgetRemaining &&
    perCall < MAX_INFERRED_PER_CALL
  ) {
    const token = match[0];
    perCall += 1;
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

export type HrefResolution =
  | { kind: 'external' }
  | { kind: 'anchor-only' }
  | { kind: 'escaped'; code: string }
  | { kind: 'local'; relative: string };

/** Resolves a Markdown link href relative to the file that declared it. */
export function resolveHref(fromDirectory: string, href: string): HrefResolution {
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

export type ReadOutcome =
  | { kind: 'ok'; absolute: string; content: Buffer; size: number; sha256: string }
  | { kind: 'missing' }
  | { kind: 'too-large'; size: number }
  | { kind: 'refused-symlink' }
  | { kind: 'refused-unsafe-path' }
  | { kind: 'inaccessible' }
  | { kind: 'limited'; size: number };

/** Reads a root-relative file, refusing traversal/symlink escapes and bounding size against the shared budget. */
export async function readWithinLimits(
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
    sha256: sha256Hex(content),
  };
}

/**
 * Finds standard Markdown `[text](href)` links in `content`, resolves each
 * relative to `fromPath`'s directory, and reads any not-yet-known target
 * within limits. Mutates `knownArtifactPaths` and `entryState.filesRead` as
 * it goes so a link to an already-read file (core or previously-linked
 * supporting file) is recorded without re-reading or duplicating it.
 * Mirrors the Spec Kit adapter's inline link-scanning loop, generalized
 * across the declaring artifact's role.
 */
export async function scanExplicitLinks(
  root: string,
  limits: SpecImportLimits,
  budget: { files: number; bytes: number },
  entryState: { filesRead: number; truncated: boolean },
  topWarnings: SpecImportWarning[],
  knownArtifactPaths: Map<string, SpecImportArtifact>,
  fromRole: SpecImportArtifactRole,
  fromPath: string,
  content: string,
): Promise<{
  declaredLinks: SpecImportDeclaredLink[];
  newArtifacts: SpecImportArtifact[];
  warnings: SpecImportWarning[];
}> {
  const declaredLinks: SpecImportDeclaredLink[] = [];
  const newArtifacts: SpecImportArtifact[] = [];
  const warnings: SpecImportWarning[] = [];
  let linkCount = 0;
  for (const match of content.matchAll(/\[([^\]\n]{0,200})\]\(([^)\s]+)\)/g)) {
    if (linkCount >= limits.maxLinksPerArtifact) break;
    linkCount += 1;
    const linkText = match[1] ?? '';
    const href = match[2] ?? '';
    const resolution = resolveHref(path.posix.dirname(fromPath), href);
    if (resolution.kind === 'external' || resolution.kind === 'anchor-only') continue;
    if (resolution.kind === 'escaped') {
      warnings.push({
        code: resolution.code,
        message: `Refused local link "${href}" from "${fromPath}".`,
        path: fromPath,
      });
      continue;
    }
    const depth = resolution.relative.split('/').length;
    if (depth > limits.maxDepth) {
      warnings.push({
        code: 'declared-link-exceeds-depth',
        message: `Local link "${href}" from "${fromPath}" exceeds the depth limit.`,
        path: resolution.relative,
      });
      continue;
    }
    const already = knownArtifactPaths.get(resolution.relative);
    if (already) {
      declaredLinks.push({
        fromRole,
        fromPath,
        linkText,
        targetPath: resolution.relative,
        targetExists: true,
        provenance: 'explicit-link',
      });
      continue;
    }
    if (entryState.filesRead >= limits.maxFilesPerEntry) {
      warnings.push({
        code: 'entry-file-limit-exceeded',
        message: 'Per-entry file limit reached before every supporting link could be resolved.',
        path: path.posix.dirname(fromPath),
      });
      break;
    }
    const outcome = await readWithinLimits(root, resolution.relative, limits, budget);
    if (outcome.kind === 'missing') {
      declaredLinks.push({
        fromRole,
        fromPath,
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
        fromRole,
        fromPath,
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
      entryState.truncated = true;
      topWarnings.push({
        code: 'discovery-limit-exceeded',
        message: 'Bounded discovery limit reached; some referenced files were not read.',
        path: resolution.relative,
      });
      declaredLinks.push({
        fromRole,
        fromPath,
        linkText,
        targetPath: resolution.relative,
        targetExists: true,
        provenance: 'explicit-link',
      });
      continue;
    }
    entryState.filesRead += 1;
    const supportingArtifact: SpecImportArtifact = {
      role: 'supporting',
      path: resolution.relative,
      sha256: outcome.sha256,
      byteLength: outcome.size,
      sectionAnchors: extractHeadings(outcome.content.toString('utf8')),
    };
    newArtifacts.push(supportingArtifact);
    knownArtifactPaths.set(resolution.relative, supportingArtifact);
    declaredLinks.push({
      fromRole,
      fromPath,
      linkText,
      targetPath: resolution.relative,
      targetExists: true,
      provenance: 'explicit-link',
    });
  }
  return { declaredLinks, newArtifacts, warnings };
}
