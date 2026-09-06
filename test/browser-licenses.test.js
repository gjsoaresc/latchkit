import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

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
