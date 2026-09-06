import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  checkReleases,
  expectedAssetName,
} from '../dist/src/installation/updates/release-source.js';
import { boundedFetch } from '../dist/src/installation/updates/bounded-fetch.js';

const TARGET = 'win32-x64';
const REPO = { owner: 'test-owner', name: 'test-repo' };

async function fixtureServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

function releasesHandler(releases, { status = 200 } = {}) {
  return (req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(releases));
  };
}

function release(overrides) {
  return {
    tag_name: 'v1.0.0',
    draft: false,
    prerelease: false,
    published_at: '2026-01-01T00:00:00Z',
    html_url: 'https://example.invalid/releases/v1.0.0',
    body: 'Release notes.',
    assets: [],
    ...overrides,
  };
}

function assetFor(version, target) {
  return {
    name: expectedAssetName(version, target),
    browser_download_url: `https://example.invalid/download/${expectedAssetName(version, target)}`,
    size: 1024,
  };
}

test('an empty release feed is a normal, non-error, non-current outcome', async (t) => {
  const { server, baseUrl } = await fixtureServer(releasesHandler([]));
  t.after(() => server.close());
  const result = await checkReleases('1.0.0', {
    repository: REPO,
    apiBaseUrl: baseUrl,
    target: TARGET,
  });
  assert.equal(result.outcome, 'no-releases');
  assert.equal(result.reason, null);
  assert.equal(result.candidate, null);
});

test('an unreachable release source reports offline and preserves the current installation', async () => {
  // Nothing is listening on this port; the connection is refused.
  const result = await checkReleases('1.0.0', {
    repository: REPO,
    apiBaseUrl: 'http://127.0.0.1:1',
    target: TARGET,
    timeoutMs: 1000,
    maxRetries: 0,
  });
  assert.equal(result.outcome, 'offline');
  assert.match(result.reason, /release source/i);
});

test('a rate-limited response (403) is distinguished from offline and from current', async (t) => {
  const { server, baseUrl } = await fixtureServer((req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end('{"message":"rate limit exceeded"}');
  });
  t.after(() => server.close());
  const result = await checkReleases('1.0.0', {
    repository: REPO,
    apiBaseUrl: baseUrl,
    target: TARGET,
  });
  assert.equal(result.outcome, 'rate-limited');
  assert.match(result.reason, /rate limit/i);
});

test('a 429 response is also reported as rate-limited', async (t) => {
  const { server, baseUrl } = await fixtureServer((req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end('{"message":"too many requests"}');
  });
  t.after(() => server.close());
  const result = await checkReleases('1.0.0', {
    repository: REPO,
    apiBaseUrl: baseUrl,
    target: TARGET,
  });
  assert.equal(result.outcome, 'rate-limited');
});

test('a newer release with no matching platform asset is missing-asset, not update-available', async (t) => {
  const { server, baseUrl } = await fixtureServer(
    releasesHandler([release({ tag_name: 'v1.1.0', assets: [] })]),
  );
  t.after(() => server.close());
  const result = await checkReleases('1.0.0', {
    repository: REPO,
    apiBaseUrl: baseUrl,
    target: TARGET,
  });
  assert.equal(result.outcome, 'missing-asset');
  assert.equal(result.candidate.version, '1.1.0');
  assert.match(result.reason, /No .*asset is published/);
});

test('drafts, prereleases, and downgrades are excluded from selection', async (t) => {
  const { server, baseUrl } = await fixtureServer(
    releasesHandler([
      release({ tag_name: 'v2.0.0', draft: true, assets: [assetFor('2.0.0', TARGET)] }),
      release({ tag_name: 'v1.5.0', prerelease: true, assets: [assetFor('1.5.0', TARGET)] }),
      release({ tag_name: 'v0.9.0', assets: [assetFor('0.9.0', TARGET)] }),
      release({ tag_name: 'v1.0.0', assets: [assetFor('1.0.0', TARGET)] }),
    ]),
  );
  t.after(() => server.close());
  const result = await checkReleases('1.0.0', {
    repository: REPO,
    apiBaseUrl: baseUrl,
    target: TARGET,
  });
  // Nothing eligible is newer than the running 1.0.0, so this is "current",
  // not "no-releases" (releases genuinely exist) and not "update-available".
  assert.equal(result.outcome, 'current');
  assert.equal(result.excludedCount, 4);
});

test('an eligible stable release becomes update-available and binds the matching asset', async (t) => {
  const { server, baseUrl } = await fixtureServer(
    releasesHandler([
      release({
        tag_name: 'v1.5.0-rc.1',
        prerelease: true,
        assets: [assetFor('1.5.0-rc.1', TARGET)],
      }),
      release({ tag_name: 'v1.5.0', assets: [assetFor('1.5.0', TARGET)] }),
      release({ tag_name: 'v1.2.0', assets: [assetFor('1.2.0', TARGET)] }),
    ]),
  );
  t.after(() => server.close());
  const result = await checkReleases('1.0.0', {
    repository: REPO,
    apiBaseUrl: baseUrl,
    target: TARGET,
  });
  assert.equal(result.outcome, 'update-available');
  assert.equal(
    result.candidate.version,
    '1.5.0',
    'the highest eligible stable release is selected',
  );
  assert.equal(result.candidate.asset.name, expectedAssetName('1.5.0', TARGET));
  assert.equal(result.majorUpdate, false);
  assert.equal(result.excludedCount, 1);
});

test('a major-version release is surfaced but flagged for manual review', async (t) => {
  const { server, baseUrl } = await fixtureServer(
    releasesHandler([release({ tag_name: 'v2.0.0', assets: [assetFor('2.0.0', TARGET)] })]),
  );
  t.after(() => server.close());
  const result = await checkReleases('1.4.0', {
    repository: REPO,
    apiBaseUrl: baseUrl,
    target: TARGET,
  });
  assert.equal(result.outcome, 'update-available');
  assert.equal(result.majorUpdate, true);
});

test('a redirect from the release source is followed and bounded', async (t) => {
  const target = await fixtureServer(
    releasesHandler([release({ tag_name: 'v1.1.0', assets: [assetFor('1.1.0', TARGET)] })]),
  );
  const front = await fixtureServer((req, res) => {
    res.writeHead(302, { location: `${target.baseUrl}${req.url}` });
    res.end();
  });
  t.after(() => {
    front.server.close();
    target.server.close();
  });
  const result = await checkReleases('1.0.0', {
    repository: REPO,
    apiBaseUrl: front.baseUrl,
    target: TARGET,
  });
  assert.equal(result.outcome, 'update-available');
});

test('boundedFetch refuses an unbounded redirect chain', async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(302, { location: '/next' });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  await assert.rejects(
    boundedFetch(`http://127.0.0.1:${port}/start`, { maxRedirects: 2, maxRetries: 0 }),
    /Too many redirects/,
  );
});
