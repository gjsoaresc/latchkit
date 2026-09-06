import { copyFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: { artifacts: { type: 'string' }, evidence: { type: 'string' } },
});
if (!values.artifacts || !values.evidence)
  throw new Error('--artifacts and --evidence are required.');
const artifacts = path.resolve(values.artifacts);
const manifests = await Promise.all(
  (await readdir(artifacts))
    .filter((name) => name.endsWith('.manifest.json'))
    .map(async (name) => JSON.parse(await readFile(path.join(artifacts, name), 'utf8'))),
);
const evidence = path.resolve(values.evidence);
let copied = 0;
for (const entry of await readdir(evidence, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.evidence.json')) continue;
  const file = path.join(entry.parentPath, entry.name);
  const record = JSON.parse(await readFile(file, 'utf8'));
  const digest = record.sha256 ?? record.candidate?.archiveSha256;
  if (!manifests.some((manifest) => manifest.sha256 === digest)) continue;
  const destination = path.join(artifacts, entry.name);
  try {
    if (!(await readFile(destination)).equals(await readFile(file)))
      throw new Error(`Conflicting evidence filename: ${entry.name}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await copyFile(file, destination);
    copied += 1;
  }
}
console.log(`Collected ${copied} matching external qualification records.`);
