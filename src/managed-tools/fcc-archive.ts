import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

export const FCC = Object.freeze({
  id: 'fcc',
  commit: 'c9b75088b09cbd3251d1e828b710cfdcd1ff3c5a',
  version: '5.22.8',
  archiveSha256: '7de379974935a29a59419b96665464205ea847f010cbb5684d098edf139686df',
});
export const digest = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
export type ArchiveMember = { name: string; bytes: Buffer };
const MAX_ARCHIVE = 64 * 1024 * 1024;
const MAX_MEMBER = 32 * 1024 * 1024;
const MAX_TOTAL = 512 * 1024 * 1024;

function safeName(name: string): boolean {
  return (
    !!name &&
    name.length < 230 &&
    !/[\\:]/.test(name) &&
    !Array.from(name).some((character) => character.charCodeAt(0) < 32) &&
    name
      .split('/')
      .every(
        (part) =>
          !!part &&
          part !== '.' &&
          part !== '..' &&
          !/[. ]$/.test(part) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  );
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function parseFccArchive(
  bytes: Buffer,
  expectedSha256 = FCC.archiveSha256,
): ArchiveMember[] {
  if (bytes.length > MAX_ARCHIVE) throw new Error('FCC archive exceeds its size limit.');
  if (digest(bytes) !== expectedSha256)
    throw new Error('FCC archive SHA-256 does not match the pinned source.');
  let end = -1;
  for (let cursor = bytes.length - 22; cursor >= Math.max(0, bytes.length - 65557); cursor -= 1)
    if (
      bytes.readUInt32LE(cursor) === 0x06054b50 &&
      cursor + 22 + bytes.readUInt16LE(cursor + 20) === bytes.length
    ) {
      end = cursor;
      break;
    }
  if (end < 0) throw new Error('FCC archive has no valid ZIP directory.');
  const count = bytes.readUInt16LE(end + 10);
  const central = bytes.readUInt32LE(end + 16);
  if (
    !count ||
    count > 10_000 ||
    bytes.readUInt16LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 6) !== 0 ||
    count !== bytes.readUInt16LE(end + 8) ||
    central + bytes.readUInt32LE(end + 12) !== end
  )
    throw new Error('FCC archive directory is unsupported or malformed.');
  const output: ArchiveMember[] = [];
  const names = new Set<string>();
  const kinds = new Map<string, boolean>();
  const spans: [number, number][] = [];
  let root: string | undefined;
  let cursor = central;
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error('FCC archive member header is malformed.');
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16);
    const compressed = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const offset = bytes.readUInt32LE(cursor + 42);
    const unixType = (bytes.readUInt32LE(cursor + 38) >>> 16) & 0xf000;
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (
      next > end ||
      bytes.readUInt16LE(cursor + 34) !== 0 ||
      flags & ~0x808 ||
      ![0, 8].includes(method)
    )
      throw new Error('FCC archive encryption, disk or compression is unsupported.');
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const directory = rawName.endsWith('/');
    const name = rawName.replace(/\/$/, '');
    if (!safeName(name)) throw new Error('FCC archive contains an unsafe member.');
    if (unixType && unixType !== (directory ? 0x4000 : 0x8000))
      throw new Error('FCC archive links and special files are not allowed.');
    const canonical = name.toLowerCase();
    if (names.has(canonical)) throw new Error('FCC archive contains duplicate members.');
    names.add(canonical);
    kinds.set(canonical, directory);
    const parts = name.split('/');
    if (!root) root = parts[0];
    if (parts[0] !== root || (!directory && parts.length < 2))
      throw new Error('FCC archive must have one source root.');
    if (size > MAX_MEMBER || (total += size) > MAX_TOTAL || (directory && size !== 0))
      throw new Error('FCC archive member exceeds its size limit.');
    if (
      offset + 30 > central ||
      bytes.readUInt32LE(offset) !== 0x04034b50 ||
      bytes.readUInt16LE(offset + 6) !== flags ||
      bytes.readUInt16LE(offset + 8) !== method
    )
      throw new Error('FCC archive local header is malformed.');
    const localLength = bytes.readUInt16LE(offset + 26);
    const start = offset + 30 + localLength + bytes.readUInt16LE(offset + 28);
    if (
      bytes.subarray(offset + 30, offset + 30 + localLength).toString('utf8') !== rawName ||
      start + compressed > central
    )
      throw new Error('FCC archive local member is inconsistent.');
    spans.push([offset, start + compressed]);
    const raw = bytes.subarray(start, start + compressed);
    const content = method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: MAX_MEMBER });
    if (content.length !== size || crc32(content) !== crc)
      throw new Error('FCC archive member checksum or size mismatch.');
    if (!directory) output.push({ name: parts.slice(1).join('/'), bytes: content });
    cursor = next;
  }
  if (cursor !== end) throw new Error('FCC archive directory length is inconsistent.');
  spans.sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < spans.length; index += 1)
    if (spans[index]![0] < spans[index - 1]![1]) throw new Error('FCC archive members overlap.');
  for (const name of names) {
    const parts = name.split('/');
    for (let count = 1; count < parts.length; count += 1)
      if (kinds.get(parts.slice(0, count).join('/')) === false)
        throw new Error('FCC archive file collides with a directory.');
  }
  return output;
}

export function validateFccArchive(
  bytes: Buffer,
  expectedSha256 = FCC.archiveSha256,
): { members: string[] } {
  return { members: parseFccArchive(bytes, expectedSha256).map((entry) => entry.name) };
}
