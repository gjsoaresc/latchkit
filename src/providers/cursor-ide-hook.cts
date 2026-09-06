'use strict';
/* global Buffer, process, setTimeout */

// Packaged project hook. Default execution validates a bounded JSON object and
// returns an advisory no-op without persistence. An explicitly exported
// qualification mode records only event names, classifications, and sequence.
import fs = require('node:fs');
import path = require('node:path');
import crypto = require('node:crypto');
const { randomUUID } = crypto;

const INPUT_LIMIT = 64 * 1024;
const EVIDENCE_LIMIT = 64 * 1024;
const RECORD_LIMIT = 256;
const EVIDENCE_SCHEMA_VERSION = 1;
const AGENT_EVENTS = new Set([
  'sessionStart',
  'sessionEnd',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'preCompact',
  'stop',
]);

type RecordValue = Record<string, unknown>;
type EvidenceRecord = {
  schemaVersion: number;
  sequence: number;
  event: string;
  classification: string;
};
type EvidenceDocument = { schemaVersion: number; records: EvidenceRecord[] };
const isRecord = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const codeOf = (error: unknown): string | undefined =>
  isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function evidenceArgument(argv: string[]): string | null {
  if (!argv.length) return null;
  if (argv.length !== 2 || argv[0] !== '--evidence')
    throw new Error('Unsupported Cursor hook arguments.');
  const value = argv[1];
  if (
    typeof value !== 'string' ||
    value.length > 240 ||
    !/^\.latchkit\/providers\/cursor-ide\/evidence\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.json$/.test(
      value,
    )
  )
    throw new Error('Unsafe Cursor hook evidence path.');
  return value;
}

async function boundedInput() {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > INPUT_LIMIT) throw new Error('Cursor hook input exceeds 64 KB.');
    chunks.push(chunk);
  }
  let input;
  try {
    const decoded = Buffer.concat(chunks).toString('utf8');
    // Cursor's native Windows hook runner reads its UTF-8 temporary payload
    // through PowerShell. That pipeline can prepend one UTF-8 BOM before
    // forwarding the JSON to stdin. Accept that encoding marker only at the
    // start; JSON.parse continues to reject every other malformed framing.
    input = JSON.parse(decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded);
  } catch {
    throw new Error('Invalid Cursor hook JSON input.');
  }
  if (!isRecord(input)) throw new Error('Expected a Cursor hook object.');
  return input;
}

async function evidenceTarget(relative: string): Promise<string> {
  const root = await fs.promises.realpath(process.cwd());
  const segments = relative.split('/');
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fs.promises.lstat(current);
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error;
      try {
        await fs.promises.mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (codeOf(mkdirError) !== 'EEXIST') throw mkdirError;
      }
      stat = await fs.promises.lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error('Cursor hook evidence path crosses a link or non-directory.');
  }
  const targetFromRoot = path.join(root, ...segments);
  const realDirectory = await fs.promises.realpath(path.dirname(targetFromRoot));
  const relativeDirectory = path.relative(root, realDirectory);
  if (relativeDirectory.startsWith('..') || path.isAbsolute(relativeDirectory))
    throw new Error('Cursor hook evidence path escapes the project.');
  const filename = segments.at(-1);
  if (!filename) throw new Error('Cursor hook evidence filename is required.');
  const target = path.join(realDirectory, filename);
  try {
    const stat = await fs.promises.lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error('Cursor hook evidence target is not a regular file.');
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') throw error;
  }
  return target;
}

function validateEvidence(document: unknown): EvidenceDocument {
  if (!isRecord(document)) throw new Error('Cursor hook evidence must be an object.');
  if (Object.keys(document).sort().join(',') !== 'records,schemaVersion')
    throw new Error('Cursor hook evidence contains unsupported fields.');
  if (document.schemaVersion !== EVIDENCE_SCHEMA_VERSION || !Array.isArray(document.records))
    throw new Error('Unsupported Cursor hook evidence schema.');
  if (document.records.length > RECORD_LIMIT)
    throw new Error('Cursor hook evidence exceeds the record limit.');
  let sequence = 0;
  for (const record of document.records) {
    if (!isRecord(record)) throw new Error('Cursor hook evidence record must be an object.');
    if (Object.keys(record).sort().join(',') !== 'classification,event,schemaVersion,sequence')
      throw new Error('Cursor hook evidence record contains unsupported fields.');
    if (
      record.schemaVersion !== EVIDENCE_SCHEMA_VERSION ||
      record.sequence !== sequence + 1 ||
      typeof record.event !== 'string' ||
      !AGENT_EVENTS.has(record.event) ||
      typeof record.classification !== 'string' ||
      !['success', 'failure', 'refusal'].includes(record.classification)
    )
      throw new Error('Invalid Cursor hook evidence record.');
    sequence = record.sequence;
  }
  return document as unknown as EvidenceDocument;
}

async function readEvidence(target: string): Promise<EvidenceDocument> {
  let bytes;
  try {
    bytes = await fs.promises.readFile(target);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return { schemaVersion: EVIDENCE_SCHEMA_VERSION, records: [] };
    throw error;
  }
  if (bytes.length > EVIDENCE_LIMIT) throw new Error('Cursor hook evidence exceeds 64 KB.');
  try {
    return validateEvidence(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error('Invalid Cursor hook evidence JSON.', { cause: error });
    throw error;
  }
}

async function removeOptional(filename: string): Promise<void> {
  try {
    await fs.promises.unlink(filename);
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: import('node:fs/promises').FileHandle | undefined;
  try {
    const opened = await fs.promises.open(directory, 'r');
    handle = opened;
    await opened.sync();
  } catch (error) {
    if (!['EINVAL', 'EISDIR', 'EPERM', 'EACCES', 'ENOTSUP'].includes(codeOf(error) ?? ''))
      throw error;
  } finally {
    await handle?.close();
  }
}

async function writeAtomic(target: string, content: string): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.promises.open(temporary, 'wx', 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporary, target);
    try {
      await fs.promises.chmod(target, 0o600);
    } catch (error) {
      if (!['ENOSYS', 'ENOTSUP', 'EPERM', 'EACCES'].includes(codeOf(error) ?? '')) throw error;
    }
    await syncDirectory(path.dirname(target));
  } catch (error) {
    await handle?.close().catch(() => {});
    await removeOptional(temporary).catch(() => {});
    throw error;
  }
  await removeOptional(temporary);
}

async function acquireLock(target: string) {
  const lock = `${target}.lock`;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const handle = await fs.promises.open(lock, 'wx', 0o600);
      await handle.writeFile('{"schemaVersion":1}\n');
      await handle.sync();
      return { handle, lock };
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') throw error;
      let stat;
      try {
        stat = await fs.promises.lstat(lock);
      } catch (statError) {
        // The prior owner can release the lock between the failed exclusive
        // open and this inspection. That is normal contention, so retry the
        // exclusive create instead of failing the hook invocation.
        if (codeOf(statError) === 'ENOENT') continue;
        throw statError;
      }
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error('Cursor hook evidence lock is not a regular file.', { cause: error });
      if (Date.now() - stat.mtimeMs > 30_000) {
        await removeOptional(lock);
        continue;
      }
      await delay(10);
    }
  }
  throw new Error('Cursor hook evidence is busy.');
}

async function recordEvidence(relative: string, event: string): Promise<void> {
  if (!AGENT_EVENTS.has(event)) throw new Error('Unsupported Cursor hook event.');
  const target = await evidenceTarget(relative);
  const owner = await acquireLock(target);
  try {
    const document = await readEvidence(target);
    if (document.records.length >= RECORD_LIMIT)
      throw new Error('Cursor hook evidence exceeds the record limit.');
    document.records.push({
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      sequence: document.records.length + 1,
      event,
      classification: event === 'postToolUseFailure' ? 'failure' : 'success',
    });
    const content = `${JSON.stringify(document, null, 2)}\n`;
    if (Buffer.byteLength(content) > EVIDENCE_LIMIT)
      throw new Error('Cursor hook evidence exceeds 64 KB.');
    await writeAtomic(target, content);
  } catch (error) {
    await owner.handle.close().catch(() => {});
    await removeOptional(owner.lock).catch(() => {});
    throw error;
  }
  await owner.handle.close();
  await removeOptional(owner.lock);
}

async function main() {
  const evidence = evidenceArgument(process.argv.slice(2));
  const input = await boundedInput();
  if (evidence) {
    if (typeof input.hook_event_name !== 'string') throw new Error('Cursor hook event is missing.');
    await recordEvidence(evidence, input.hook_event_name);
  }
  process.stdout.write('{}\n');
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
