import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('operator documentation links resolve to repository files', async () => {
  const files = ['README.md', 'docs/getting-started.md', 'docs/support.md', 'docs/migration.md'];
  const markdown = await Promise.all(
    files.map(async (file) => [file, await readFile(path.join(root, file), 'utf8')]),
  );
  for (const [file, text] of markdown) {
    const links = [...text.matchAll(/\]\(([^)#]+)(?:#[^)]+)?\)/g)].map((match) => match[1]);
    const localLinks = links.filter((link) => !/^[a-z]+:\/\//i.test(link) && !link.startsWith('#'));
    for (const link of localLinks) await access(path.resolve(root, path.dirname(file), link));
  }
});

test('operator documentation keeps executable CLI examples on the supported surface', async () => {
  const text = await readFile(path.join(root, 'docs/getting-started.md'), 'utf8');
  for (const command of ['init', 'doctor', 'config', 'sync', 'ui', 'remove']) {
    assert.match(text, new RegExp(`latchkit ${command}\\b`));
  }
  assert.match(text, /npm install --global latchkit/);
  assert.match(text, /Node\.js 22/);
});
