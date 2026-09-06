// Shared entry point for explicitly invoked spec-import discovery and
// preview (issue #114, first increment). Every operation here is read-only:
// nothing is written to `.latchkit/`, nothing is executed, and no Latchkit
// record is created. Registration into task state is a later, separate
// increment — see docs/spec-imports.md.
import { createHash } from 'node:crypto';
import { resolveProjectRoot } from '../storage.js';
import { errorCode } from '../types.js';
import { buildOpenSpecManifest } from './openspec-adapter.js';
import { buildSpecKitManifest } from './spec-kit-adapter.js';
import { buildTinySpecManifest } from './tinyspec-adapter.js';
import {
  DEFAULT_SPEC_IMPORT_LIMITS,
  OPENSPEC_ADAPTER_ID,
  SPEC_KIT_ADAPTER_ID,
  TINYSPEC_ADAPTER_ID,
  SpecImportError,
  type SpecImportArtifact,
  type SpecImportEntry,
  type SpecImportEntryStatus,
  type SpecImportLimits,
  type SpecImportManifest,
  type SpecImportWarning,
} from './contracts.js';

type AdapterBuilder = (
  root: string,
  options: { limits?: SpecImportLimits; clock?: () => Date },
) => Promise<SpecImportManifest>;

const SUPPORTED_ADAPTERS = new Map<string, AdapterBuilder>([
  [SPEC_KIT_ADAPTER_ID, buildSpecKitManifest],
  [OPENSPEC_ADAPTER_ID, buildOpenSpecManifest],
  [TINYSPEC_ADAPTER_ID, buildTinySpecManifest],
]);
// Reserved for a future adapter named in issue #114 but not yet
// implemented; gives a caller a clear "not yet" instead of an opaque
// unknown-adapter error. Empty now that Spec Kit, OpenSpec, and TinySpec
// are all implemented.
const PLANNED_ADAPTERS = new Set<string>();

function resolveAdapter(adapter: string): AdapterBuilder {
  const builder = SUPPORTED_ADAPTERS.get(adapter);
  if (builder) return builder;
  if (PLANNED_ADAPTERS.has(adapter))
    throw new SpecImportError(
      `Adapter "${adapter}" is planned but not implemented yet; issue #114 delivers adapters incrementally.`,
      'SPEC_IMPORT_ADAPTER_NOT_YET_SUPPORTED',
      '$.adapter',
    );
  throw new SpecImportError(
    `Unknown adapter "${adapter}". Supported: ${[...SUPPORTED_ADAPTERS.keys()].join(', ')}.`,
    'SPEC_IMPORT_UNKNOWN_ADAPTER',
    '$.adapter',
  );
}

async function resolveRoot(root: string): Promise<string> {
  if (typeof root !== 'string' || !root.trim())
    throw new SpecImportError(
      'A source root path is required.',
      'SPEC_IMPORT_ROOT_INVALID',
      '$.root',
    );
  try {
    return await resolveProjectRoot(root);
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR')
      throw new SpecImportError(
        `Source root "${root}" does not exist.`,
        'SPEC_IMPORT_ROOT_INVALID',
        '$.root',
      );
    throw error;
  }
}

function mergeLimits(overrides?: Partial<SpecImportLimits>): SpecImportLimits {
  if (!overrides) return DEFAULT_SPEC_IMPORT_LIMITS;
  const merged = { ...DEFAULT_SPEC_IMPORT_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    const ceiling = DEFAULT_SPEC_IMPORT_LIMITS[key as keyof SpecImportLimits] * 20;
    if (!Number.isInteger(value) || value < 1 || value > ceiling)
      throw new SpecImportError(
        `Limit "${key}" must be a positive integer no greater than ${ceiling}.`,
        'SPEC_IMPORT_INVALID',
        `$.limits.${key}`,
      );
    (merged as Record<string, number>)[key] = value;
  }
  return merged;
}

export type SpecImportOptions = {
  adapter?: string;
  limits?: Partial<SpecImportLimits>;
  clock?: () => Date;
};

export type SpecImportDiscoveryEntry = {
  id: string;
  slug: string;
  directory: string;
  status: SpecImportEntryStatus;
  artifacts: { role: string; path: string; byteLength: number }[];
  warnings: SpecImportWarning[];
};

export type SpecImportDiscoverySummary = {
  adapter: SpecImportManifest['adapter'];
  discoveredAt: string;
  sourceRoot: { path: string };
  limits: SpecImportLimits;
  truncated: boolean;
  entries: SpecImportDiscoveryEntry[];
  warnings: SpecImportWarning[];
};

function summarize(manifest: SpecImportManifest): SpecImportDiscoverySummary {
  return {
    adapter: manifest.adapter,
    discoveredAt: manifest.discoveredAt,
    sourceRoot: manifest.sourceRoot,
    limits: manifest.limits,
    truncated: manifest.truncated,
    entries: manifest.entries.map((entry) => ({
      id: entry.id,
      slug: entry.slug,
      directory: entry.directory,
      status: entry.status,
      artifacts: entry.artifacts.map((artifact) => ({
        role: artifact.role,
        path: artifact.path,
        byteLength: artifact.byteLength,
      })),
      warnings: entry.warnings,
    })),
    warnings: manifest.warnings,
  };
}

/**
 * Lightweight, explicitly invoked enumeration: which feature directories
 * exist under the selected root and what state each is in. No Latchkit
 * record is created or referenced by this call.
 */
export async function discoverSpecImport(
  root: string,
  { adapter = SPEC_KIT_ADAPTER_ID, limits, clock }: SpecImportOptions = {},
): Promise<SpecImportDiscoverySummary> {
  const build = resolveAdapter(adapter);
  const resolvedRoot = await resolveRoot(root);
  const manifest = await build(resolvedRoot, { limits: mergeLimits(limits), clock });
  return summarize(manifest);
}

/** Computed over the manifest exactly as returned; stable for identical source bytes and limits. */
export function computeManifestDigest(manifest: SpecImportManifest): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

function titleFromSlug(slug: string): string {
  const words = slug.split('-').filter(Boolean);
  if (!words.length) return slug || 'Untitled feature';
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function primaryArtifact(entry: SpecImportEntry): SpecImportArtifact | null {
  return (
    entry.artifacts.find((artifact) => artifact.role === 'plan') ??
    entry.artifacts.find((artifact) => artifact.role === 'spec') ??
    entry.artifacts.find((artifact) => artifact.role === 'tasks') ??
    null
  );
}

export type SpecImportWouldCreate = {
  entryId: string;
  directory: string;
  status: SpecImportEntryStatus;
  registrable: boolean;
  wouldCreate: {
    recordKind: 'task-import';
    title: string;
    importSource: { path: string; sha256: string };
    criteriaPreview: never[];
  } | null;
  note: string;
};

function describeWouldCreate(manifest: SpecImportManifest): SpecImportWouldCreate[] {
  return manifest.entries.map((entry) => {
    const registrable = entry.status === 'complete' || entry.status === 'partial';
    const primary = registrable ? primaryArtifact(entry) : null;
    return {
      entryId: entry.id,
      directory: entry.directory,
      status: entry.status,
      registrable: registrable && primary !== null,
      wouldCreate:
        primary !== null
          ? {
              recordKind: 'task-import',
              title: titleFromSlug(entry.slug),
              importSource: { path: primary.path, sha256: primary.sha256 },
              criteriaPreview: [],
            }
          : null,
      note:
        registrable && primary
          ? 'Preview only; no Latchkit record is created. A later explicit registration action binds to the returned manifestDigest and this exact source hash.'
          : `Not registrable from this discovery: status is "${entry.status}".`,
    };
  });
}

export type SpecImportPreview = {
  manifest: SpecImportManifest;
  manifestDigest: string;
  wouldCreate: SpecImportWouldCreate[];
};

/**
 * Full, explicitly invoked manifest build plus a precise description of what
 * a later explicit registration action would create. Creates nothing.
 */
export async function previewSpecImport(
  root: string,
  { adapter = SPEC_KIT_ADAPTER_ID, limits, clock }: SpecImportOptions = {},
): Promise<SpecImportPreview> {
  const build = resolveAdapter(adapter);
  const resolvedRoot = await resolveRoot(root);
  const manifest = await build(resolvedRoot, { limits: mergeLimits(limits), clock });
  const manifestDigest = computeManifestDigest(manifest);
  return { manifest, manifestDigest, wouldCreate: describeWouldCreate(manifest) };
}
