import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { resolveTar, tar } from '../scripts/archive-tool.js';

const run = promisify(execFile);

test('tar helper creates and lists an archive at an absolute path', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'latchkit-archive-tool-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'bundle');
  await mkdir(path.join(source, 'app'), { recursive: true });
  await writeFile(path.join(source, 'app', 'entry.txt'), 'entry');
  const archive = path.join(directory, 'bundle.tar.gz');
  assert.ok(path.isAbsolute(archive));
  await tar(['-czf', archive, '-C', source, '.']);
  const listing = (await tar(['-tf', archive])).stdout
    .split(/\r?\n/)
    .map((entry) => entry.replace(/^\.\//, '').replace(/\/$/, ''))
    .filter(Boolean);
  assert.ok(listing.includes('app/entry.txt'), listing.join(', '));
});

test(
  'tar helper adds --force-local only for GNU tar on Windows',
  { skip: process.platform !== 'win32' },
  async () => {
    const { tool, prefixArgs } = await resolveTar();
    const { stdout } = await run(tool, ['--version'], { windowsHide: true });
    const gnu = /GNU tar/i.test(stdout);
    assert.deepEqual(prefixArgs, gnu ? ['--force-local'] : []);
  },
);
