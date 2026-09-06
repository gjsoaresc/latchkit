// Publishing a release archive means writing several independent files
// (the archive itself, a checksum sidecar, an SBOM sidecar, and a manifest
// sidecar) that only make sense together. Plain sequential `writeFile`
// calls can be interrupted between any two of them, leaving a directory
// that looks like a release but is missing a piece -- or, worse, silently
// mixes bytes from two different attempts.
import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';

export type ArchiveSidecar = { path: string; bytes: string | Uint8Array };

// Publishes `finalArchive` (already staged at `stagedArchivePath`, typically
// by an external compression tool) plus its sidecar files as close to a
// single atomic set as plain filesystem renames allow. Each file is renamed
// into place from a same-directory "<token>.tmp" name, so every rename is a
// same-device operation even when the system temp root lives on a different
// drive from the destination.
//
// `sidecars` is an ordered array of `{ path, bytes }`. Order matters: put
// the file existing tooling uses to *discover* a published artifact (a
// "*.manifest.json", per verifyReleaseArtifacts/bundle-smoke.js) last, so a
// failure or an unhandleable kill partway through never exposes a set that
// reads as complete -- only inspectable, operation-owned leftovers a later
// cleanup pass can recognize and reclaim.
//
// If any step throws, every file this call itself staged or already
// committed is removed before the error is rethrown, so a previously
// published, distinct artifact elsewhere in the same directory is never
// touched. Returns the list of committed final paths on success.
export async function publishArchiveSet(
  finalArchive: string,
  stagedArchivePath: string,
  sidecars: readonly ArchiveSidecar[],
): Promise<string[]> {
  const token = randomUUID();
  const committed = [];
  try {
    await rename(stagedArchivePath, finalArchive);
    committed.push(finalArchive);
    for (const { path: destination, bytes } of sidecars) {
      const temp = `${destination}.${token}.tmp`;
      await writeFile(temp, bytes);
      await rename(temp, destination);
      committed.push(destination);
    }
    return committed;
  } catch (error) {
    await rm(stagedArchivePath, { force: true });
    await Promise.all(committed.map((entry) => rm(entry, { force: true })));
    throw error;
  }
}
