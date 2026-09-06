/**
 * Minimal semantic-version parsing and comparison (SemVer 2.0.0 precedence
 * rules) for release selection. Deliberately standalone: no dependency on
 * any registry file or the running package version, so it is trivially unit
 * tested and reusable by both release discovery and the bundle manager's own
 * `VERSION` regular expression family.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(value: string): ParsedVersion | null {
  const match = SEMVER.exec(value);
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ? prerelease.split('.') : [],
  };
}

function compareIdentifier(a: string, b: string): number {
  const numericA = /^\d+$/.test(a);
  const numericB = /^\d+$/.test(b);
  if (numericA && numericB) return Number(a) - Number(b);
  if (numericA) return -1; // Numeric identifiers sort lower than alphanumeric ones.
  if (numericB) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Standard SemVer precedence: negative when `a` < `b`, positive when `a` >
 * `b`, zero when equal. A version without a prerelease is always greater
 * than one with a prerelease that otherwise shares the same major.minor.patch. */
export function compareSemver(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const compared = compareIdentifier(left, right);
    if (compared !== 0) return compared;
  }
  return 0;
}

export function isPrereleaseVersion(version: ParsedVersion): boolean {
  return version.prerelease.length > 0;
}

/** True when `candidate` is a strictly higher major version than `current`
 * and therefore requires manual review before automatic selection. */
export function isMajorUpdate(current: ParsedVersion, candidate: ParsedVersion): boolean {
  return candidate.major > current.major;
}

/** True when `candidate` is not newer than `current` (a downgrade or an
 * exact match), which must be excluded from automatic selection. */
export function isDowngradeOrSame(current: ParsedVersion, candidate: ParsedVersion): boolean {
  return compareSemver(candidate, current) <= 0;
}
