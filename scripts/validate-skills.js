import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseFrontMatter(content, relativePath) {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== '---')
    throw new Error(`${relativePath}: missing YAML front matter opening delimiter`);
  const end = lines.indexOf('---', 1);
  if (end === -1) throw new Error(`${relativePath}: missing YAML front matter closing delimiter`);
  const metadata = new Map();
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][\w-]*):\s*(.+)$/.exec(line);
    if (!match) throw new Error(`${relativePath}: invalid metadata line: ${line}`);
    metadata.set(match[1], match[2].trim());
  }
  return metadata;
}

export async function findSkillFiles(root) {
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile() && entry.name === 'SKILL.md') found.push(entryPath);
    }
  }
  await visit(root);
  return found.sort();
}

export async function validateSkillTree(root) {
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
      const reference = match[1].split(/[?#]/, 1)[0];
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
