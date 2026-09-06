/**
 * Official release discovery (issue #139 slice 1, acceptance criterion 2).
 *
 * Resolves candidate releases exclusively from the configured official
 * Latchkit GitHub repository over HTTPS, matching the exact archive naming
 * `install.ps1`/`install.sh` already expect
 * (`latchkit-<version>-<target>.zip`/`.tar.gz`). Drafts, prereleases, and
 * downgrades are excluded from automatic selection; a major-version bump is
 * still surfaced (so it can be shown) but flagged `majorUpdate` for manual
 * review. Offline, rate-limited, and missing-asset outcomes are distinct
 * from `current` so a degraded check can never be reported as "up to date",
 * and an empty release feed is `no-releases` — a normal, supported,
 * non-error outcome — never `current` and never a failure.
 */
import { errorMessage } from '../../types.js';
import { boundedFetch } from './bounded-fetch.js';
import type { FetchLike } from './bounded-fetch.js';
import {
  compareSemver,
  isDowngradeOrSame,
  isMajorUpdate,
  isPrereleaseVersion,
  parseSemver,
} from './semver.js';
import type { ReleaseAsset, ReleaseCandidate, ReleaseCheckResult } from './contracts.js';

export interface OfficialRepository {
  owner: string;
  name: string;
}

/** The single configured official release source. Never accept a repository
 * from caller/request input — a future authenticated API must keep this
 * constant, not a value threaded through from the browser or CLI. */
export const OFFICIAL_REPOSITORY: OfficialRepository = Object.freeze({
  owner: 'willahealm',
  name: 'latchkit',
});

export function expectedAssetName(version: string, target: string): string {
  return target.startsWith('win32-')
    ? `latchkit-${version}-${target}.zip`
    : `latchkit-${version}-${target}.tar.gz`;
}

export interface CheckReleasesOptions {
  repository?: OfficialRepository;
  /** Overridable only for local fixture servers in tests; production callers
   * must leave this at the default `https://api.github.com`. */
  apiBaseUrl?: string;
  target?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  userAgent?: string;
}

interface RawAsset {
  name?: unknown;
  browser_download_url?: unknown;
  size?: unknown;
}
interface RawRelease {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  html_url?: unknown;
  body?: unknown;
  assets?: unknown;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseRelease(raw: unknown, target: string): ReleaseCandidate | null {
  if (raw === null || typeof raw !== 'object') return null;
  const release = raw as RawRelease;
  if (typeof release.tag_name !== 'string' || !release.tag_name) return null;
  const version = release.tag_name.replace(/^v/, '');
  if (!parseSemver(version)) return null;
  const expected = expectedAssetName(version, target);
  const assets = asArray(release.assets).filter(
    (item): item is RawAsset => item !== null && typeof item === 'object',
  );
  const match = assets.find((item) => item.name === expected);
  const asset: ReleaseAsset | null =
    match && typeof match.browser_download_url === 'string'
      ? {
          name: expected,
          url: match.browser_download_url,
          size: typeof match.size === 'number' ? match.size : null,
        }
      : null;
  return {
    version,
    tag: release.tag_name,
    draft: release.draft === true,
    prerelease: release.prerelease === true,
    publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
    notesUrl: typeof release.html_url === 'string' ? release.html_url : null,
    notes: typeof release.body === 'string' ? release.body : '',
    asset,
  };
}

export async function checkReleases(
  currentVersion: string,
  options: CheckReleasesOptions = {},
): Promise<ReleaseCheckResult> {
  const repository = options.repository ?? OFFICIAL_REPOSITORY;
  const apiBaseUrl = options.apiBaseUrl ?? 'https://api.github.com';
  const target = options.target ?? `${process.platform}-${process.arch}`;
  const checkedAt = new Date().toISOString();
  const current = parseSemver(currentVersion);
  if (!current) throw new Error(`Invalid current version: ${currentVersion}`);
  const base = {
    schemaVersion: 1 as const,
    checkedAt,
    source: { owner: repository.owner, name: repository.name, target },
    currentVersion,
    candidate: null,
    majorUpdate: false,
    excludedCount: 0,
  };
  const url = `${apiBaseUrl.replace(/\/$/, '')}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/releases?per_page=30`;
  let response: Response;
  try {
    response = await boundedFetch(url, {
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': options.userAgent ?? 'latchkit-updater',
      },
    });
  } catch (error) {
    return {
      ...base,
      outcome: 'offline',
      reason: `Could not reach the release source (${errorMessage(error)}). The current installation is unchanged.`,
    };
  }
  if (response.status === 403 || response.status === 429) {
    return {
      ...base,
      outcome: 'rate-limited',
      reason:
        'The release source rate limit was reached; try again later. The current installation is unchanged.',
    };
  }
  if (response.status === 404) return { ...base, outcome: 'no-releases', reason: null };
  if (!response.ok) {
    return {
      ...base,
      outcome: 'offline',
      reason: `The release source returned an unexpected status (${response.status}). The current installation is unchanged.`,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await response.text());
  } catch {
    return {
      ...base,
      outcome: 'offline',
      reason:
        'The release source returned an invalid response. The current installation is unchanged.',
    };
  }
  const releases = asArray(raw);
  if (releases.length === 0) return { ...base, outcome: 'no-releases', reason: null };
  let excludedCount = 0;
  const eligible: ReleaseCandidate[] = [];
  for (const item of releases) {
    const parsed = parseRelease(item, target);
    if (!parsed) {
      excludedCount += 1;
      continue;
    }
    const parsedVersion = parseSemver(parsed.version);
    if (!parsedVersion) {
      excludedCount += 1;
      continue;
    }
    if (parsed.draft || parsed.prerelease || isPrereleaseVersion(parsedVersion)) {
      excludedCount += 1;
      continue;
    }
    if (isDowngradeOrSame(current, parsedVersion)) {
      excludedCount += 1;
      continue;
    }
    eligible.push(parsed);
  }
  if (eligible.length === 0) return { ...base, outcome: 'current', excludedCount, reason: null };
  eligible.sort((left, right) => {
    const leftVersion = parseSemver(left.version);
    const rightVersion = parseSemver(right.version);
    // Both are guaranteed parseable — anything else was already excluded.
    return compareSemver(rightVersion!, leftVersion!);
  });
  const best = eligible[0]!;
  const bestVersion = parseSemver(best.version)!;
  const majorUpdate = isMajorUpdate(current, bestVersion);
  if (!best.asset) {
    return {
      ...base,
      outcome: 'missing-asset',
      candidate: best,
      majorUpdate,
      excludedCount,
      reason: `No ${expectedAssetName(best.version, target)} asset is published for this release yet. The current installation is unchanged.`,
    };
  }
  return {
    ...base,
    outcome: 'update-available',
    candidate: best,
    majorUpdate,
    excludedCount,
    reason: null,
  };
}
