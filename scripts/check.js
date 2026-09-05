import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { SKILLS } from '../src/core.js';

for (const directory of ['src', 'web', 'scripts', 'test']) {
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.js')) continue;
    const result = spawnSync(process.execPath, ['--check', path.join(directory, file)], { stdio: 'inherit', shell: false });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
for (const skill of SKILLS) {
  const content = await readFile(`skills/latchkit-${skill.id}/SKILL.md`, 'utf8');
  if (!content.startsWith(`---\nname: latchkit-${skill.id}\n`) || !/^description: .+/m.test(content)) throw new Error(`Invalid skill metadata: ${skill.id}`);
}
console.log('JavaScript syntax and bundled skill metadata are valid.');
