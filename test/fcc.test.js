import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  FCC,
  FCC_START_ENVIRONMENT,
  inspectFcc,
  previewFccInstall,
  removeFcc,
  validateFccArchive,
} from '../dist/src/managed-tools/fcc.js';

function zip(names) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const name of names) {
    const encoded = Buffer.from(name);
    const local = Buffer.alloc(30 + encoded.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(encoded.length, 26);
    encoded.copy(local, 30);
    locals.push(local);
    const record = Buffer.alloc(46 + encoded.length);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0, 10);
    record.writeUInt16LE(encoded.length, 28);
    record.writeUInt32LE(offset, 42);
    encoded.copy(record, 46);
    central.push(record);
    offset += local.length;
  }
  const middle = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(middle.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, middle, end]);
}

test('FCC archive validation rejects hash mismatches before any extraction', () => {
  assert.throws(() => validateFccArchive(zip(['fcc/README.md'])), /SHA-256/);
});

test('FCC archive validation refuses traversal members after a matching test hash', () => {
  const archive = zip(['fcc/../../escape']);
  const digest = createHash('sha256').update(archive).digest('hex');
  assert.throws(() => validateFccArchive(archive, digest), /unsafe member/);
});

test('existing FCC state is attachable and preview never adopts it', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'latchkit-fcc-'));
  const root = path.join(home, 'tool');
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, '.fcc'), { recursive: true });
  const inspected = await inspectFcc({ home, root });
  assert.equal(inspected.state, 'attachable');
  const preview = await previewFccInstall({ home, root });
  assert.equal(preview.action, 'blocked');
  assert.match(preview.reason, /archive/i);
});

test('removal preserves pre-existing FCC data and the default start boundary remains loopback', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'latchkit-fcc-'));
  const root = path.join(home, 'tool');
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, '.fcc'), { recursive: true });
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, 'fcc-state.json'),
    JSON.stringify({
      schemaVersion: 1,
      tool: 'fcc',
      version: FCC.version,
      commit: FCC.commit,
      installedAt: new Date().toISOString(),
      installId: '7f6cdfc4-3062-4cf8-83f2-c170654fc3d6',
      sourceArchiveSha256: FCC.archiveSha256,
      python: 'C:/Python314/python.exe',
      runtimeDirectory: `runtime-${FCC.commit}`,
      ownsFccHome: false,
    }),
  );
  const removed = await removeFcc({ home, root });
  assert.equal(removed.preservedFccHome, true);
  assert.equal((await inspectFcc({ home, root })).existingFccHome, true);
  assert.deepEqual(FCC_START_ENVIRONMENT, {
    HOST: '127.0.0.1',
    MESSAGING_PLATFORM: 'none',
    PROXY_AUTH_ENABLED: 'true',
    FCC_DISABLE_PAID_FALLBACK: '1',
    MODEL_FALLBACKS: '',
  });
});

test('an interrupted FCC transaction blocks mutation until ordinary recovery is run', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'latchkit-fcc-'));
  const root = path.join(home, 'tool');
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(root, '.latchkit'), { recursive: true });
  await writeFile(
    path.join(root, 'fcc-state.json'),
    JSON.stringify({
      schemaVersion: 1,
      tool: 'fcc',
      version: FCC.version,
      commit: FCC.commit,
      installedAt: new Date().toISOString(),
      installId: '7f6cdfc4-3062-4cf8-83f2-c170654fc3d6',
      sourceArchiveSha256: FCC.archiveSha256,
      python: 'C:/Python314/python.exe',
      runtimeDirectory: `runtime-${FCC.commit}`,
      ownsFccHome: false,
    }),
  );
  await writeFile(path.join(root, 'active.json'), JSON.stringify({ pid: 999999 }));
  await writeFile(path.join(root, '.latchkit', 'transaction.json'), '{}');
  await assert.rejects(() => removeFcc({ home, root }), /interrupted transaction/);
});
