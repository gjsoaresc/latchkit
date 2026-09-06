import { access, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveRepositoryRoot(scriptDirectory: string): string {
  const adjacentRoot = path.resolve(scriptDirectory, '..');
  return existsSync(path.join(adjacentRoot, 'tsconfig.json'))
    ? adjacentRoot
    : path.resolve(adjacentRoot, '..');
}

const repositoryRoot = resolveRepositoryRoot(path.dirname(fileURLToPath(import.meta.url)));

function parseFrontMatter(content: string, relativePath: string): Map<string, string> {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== '---')
    throw new Error(`${relativePath}: missing YAML front matter opening delimiter`);
  const end = lines.indexOf('---', 1);
  if (end === -1) throw new Error(`${relativePath}: missing YAML front matter closing delimiter`);
  const metadata = new Map();
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][\w-]*):\s*(.+)$/.exec(line);
    if (!match) throw new Error(`${relativePath}: invalid metadata line: ${line}`);
    const key = match[1];
    const value = match[2];
    if (!key || !value) throw new Error(`${relativePath}: invalid metadata line: ${line}`);
    metadata.set(key, value.trim());
  }
  return metadata;
}

export async function findSkillFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile() && entry.name === 'SKILL.md') found.push(entryPath);
    }
  }
  await visit(root);
  return found.sort();
}

export async function validateSkillTree(root: string): Promise<string[]> {
  const files = await findSkillFiles(root);
  if (!files.length) throw new Error(`No SKILL.md files found under ${root}`);
  const names = new Set();
  for (const file of files) {
    const relativePath = path.relative(repositoryRoot, file).replaceAll(path.sep, '/');
    const content = await readFile(file, 'utf8');
    const metadata = parseFrontMatter(content, relativePath);
    const expectedName = path.basename(path.dirname(file));
    if (metadata.get('name') !== expectedName)
      throw new Error(`${relativePath}: metadata name must be ${expectedName}`);
    if (!metadata.get('description'))
      throw new Error(`${relativePath}: metadata description is required`);
    if (names.has(expectedName))
      throw new Error(`${relativePath}: duplicate skill name ${expectedName}`);
    names.add(expectedName);
    for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const reference = match[1]?.split(/[?#]/, 1)[0];
      if (!reference || /^[a-z][a-z+.-]*:/i.test(reference) || reference.startsWith('#')) continue;
      try {
        await access(path.resolve(path.dirname(file), reference));
      } catch {
        throw new Error(`${relativePath}: referenced local resource does not exist: ${reference}`);
      }
    }
  }
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await validateSkillTree(path.join(repositoryRoot, 'skills'));
  console.log('Bundled skill metadata and local references are valid.');
}
