import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { validateSkillTree } from './validate-skills.js';

for (const directory of ['src', 'web', 'scripts', 'test']) {
  for (const file of await readdir(directory, { recursive: true })) {
    if (!file.endsWith('.js')) continue;
    const result = spawnSync(process.execPath, ['--check', path.join(directory, file)], {
      stdio: 'inherit',
      shell: false,
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
await validateSkillTree('skills');
for (const schema of await readdir('schemas')) {
  if (!schema.endsWith('.json')) continue;
  const parsed = JSON.parse(await readFile(path.join('schemas', schema), 'utf8'));
  if (parsed.$schema !== 'https://json-schema.org/draft/2020-12/schema')
    throw new Error(`Invalid schema metadata: ${schema}`);
}
console.log('JavaScript syntax, bundled skill metadata, and published schemas are valid.');
