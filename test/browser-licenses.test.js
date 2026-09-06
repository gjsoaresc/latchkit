import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectBrowserLicenses } from '../scripts/browser-licenses.js';

test('built browser distribution includes full dependency notices and SBOM metadata', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const records = JSON.parse(await readFile(path.join(root, 'dist/web/licenses/manifest.json')));
  for (const name of ['react', 'react-dom', 'lucide-react', 'tailwindcss', '@radix-ui/react-slot'])
    assert.ok(
      records.some((record) => record.name === name),
      `Missing ${name}`,
    );
  assert.equal(
    new Set(records.map(({ name, version }) => `${name}@${version}`)).size,
    records.length,
  );
  for (const record of records) {
    assert.ok(record.version);
    assert.notEqual(record.license, 'NOASSERTION');
    assert.ok(record.notices.length > 0);
    for (const notice of record.notices)
      assert.ok((await readFile(path.join(root, record.path, notice), 'utf8')).trim().length > 0);
  }
  const fallback = records.find(({ name }) => name === 'react-remove-scroll-bar');
  assert.ok(fallback.notices.includes('SOURCE.md'));
});

test('a repeated license collection reclaims a package directory that no longer contributes bytes', async (t) => {
  const root = path.resolve(import.meta.dirname, '..');
  const destination = await mkdtemp(path.join(os.tmpdir(), 'latchkit-license-reconcile-'));
  t.after(() => rm(destination, { recursive: true, force: true }));
  const metafileWithClsx = {
    outputs: {
      'app.js': {
        inputs: {
          'node_modules/clsx/dist/clsx.mjs': { bytesInOutput: 42 },
        },
      },
    },
  };
  const metafileWithoutClsx = { outputs: { 'app.js': { inputs: {} } } };

  const first = await collectBrowserLicenses(root, destination, metafileWithClsx);
  assert.ok(first.some((record) => record.name === 'clsx'));
  assert.ok((await readdir(destination)).some((name) => name.startsWith('clsx@')));

  const second = await collectBrowserLicenses(root, destination, metafileWithoutClsx);
  assert.ok(!second.some((record) => record.name === 'clsx'));
  const remaining = await readdir(destination);
  assert.ok(
    !remaining.some((name) => name.startsWith('clsx@')),
    'a dropped dependency must not leave its license directory behind',
  );
  assert.ok(remaining.includes('manifest.json'));
  // Tailwind's theme.css is unconditionally treated as a browser input, so
  // its directory is expected to survive both calls.
  assert.ok(remaining.some((name) => name.startsWith('tailwindcss@')));
});
