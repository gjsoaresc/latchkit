import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareSemver,
  isDowngradeOrSame,
  isMajorUpdate,
  isPrereleaseVersion,
  parseSemver,
} from '../dist/src/installation/updates/semver.js';

test('parseSemver accepts exact versions and rejects malformed input', () => {
  assert.deepEqual(parseSemver('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] });
  assert.deepEqual(parseSemver('1.2.3-rc.1'), {
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: ['rc', '1'],
  });
  assert.deepEqual(parseSemver('1.2.3+build.5'), { major: 1, minor: 2, patch: 3, prerelease: [] });
  assert.equal(parseSemver('1.2'), null);
  assert.equal(parseSemver('v1.2.3'), null);
  assert.equal(parseSemver('1.2.3.4'), null);
  assert.equal(parseSemver(''), null);
});

test('compareSemver orders major, minor, patch, and prerelease precedence correctly', () => {
  const cmp = (a, b) => compareSemver(parseSemver(a), parseSemver(b));
  assert.equal(cmp('1.0.0', '1.0.0'), 0);
  assert.ok(cmp('2.0.0', '1.9.9') > 0);
  assert.ok(cmp('1.9.9', '2.0.0') < 0);
  assert.ok(cmp('1.2.0', '1.1.9') > 0);
  assert.ok(cmp('1.1.0', '1.1.1') < 0);
  // A release is always greater than a prerelease of the same core version.
  assert.ok(cmp('1.0.0', '1.0.0-rc.1') > 0);
  assert.ok(cmp('1.0.0-rc.1', '1.0.0') < 0);
  // Numeric prerelease identifiers compare numerically and sort below alphanumeric ones.
  assert.ok(cmp('1.0.0-rc.2', '1.0.0-rc.10') < 0);
  assert.ok(cmp('1.0.0-alpha', '1.0.0-alpha.1') < 0);
  assert.ok(cmp('1.0.0-alpha.1', '1.0.0-alpha.beta') < 0);
});

test('isPrereleaseVersion, isMajorUpdate, and isDowngradeOrSame classify releases correctly', () => {
  assert.equal(isPrereleaseVersion(parseSemver('1.0.0-rc.1')), true);
  assert.equal(isPrereleaseVersion(parseSemver('1.0.0')), false);

  const current = parseSemver('1.4.2');
  assert.equal(isMajorUpdate(current, parseSemver('2.0.0')), true);
  assert.equal(isMajorUpdate(current, parseSemver('1.5.0')), false);

  assert.equal(isDowngradeOrSame(current, parseSemver('1.4.2')), true);
  assert.equal(isDowngradeOrSame(current, parseSemver('1.4.1')), true);
  assert.equal(isDowngradeOrSame(current, parseSemver('1.4.3')), false);
});
