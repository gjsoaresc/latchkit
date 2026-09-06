import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

// esbuild records the modules that actually contribute bytes to the browser
// output. Preserve their package notices even when npm classifies them as
// development dependencies because no node_modules tree ships at runtime.
export async function collectBrowserLicenses(root, destination, metafile) {
  const inputs = new Set();
  for (const output of Object.values(metafile.outputs))
    for (const [input, contribution] of Object.entries(output.inputs))
      if (contribution.bytesInOutput > 0 && input.replaceAll('\\', '/').includes('node_modules/'))
        inputs.add(path.resolve(root, input));
  // The generated stylesheet incorporates Tailwind's theme and utilities.
  inputs.add(path.join(root, 'node_modules', 'tailwindcss', 'theme.css'));
  const packages = new Map();
  for (const input of inputs) {
    let directory = path.dirname(input);
    while (directory !== root && directory !== path.dirname(directory)) {
      try {
        const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
        if (metadata.name && metadata.version) {
          packages.set(`${metadata.name}@${metadata.version}`, { directory, metadata });
          break;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      directory = path.dirname(directory);
    }
  }
  const records = [];
  for (const [id, { directory, metadata }] of [...packages].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const relative = id.replaceAll('/', '__');
    const target = path.join(destination, relative);
    await mkdir(target, { recursive: true });
    const notices = [];
    for (const name of (await readdir(directory)).sort()) {
      if (!/^(licen[cs]e|notice|copying)([.-]|$)/i.test(name)) continue;
      if (!(await stat(path.join(directory, name))).isFile()) continue;
      await cp(path.join(directory, name), path.join(target, name));
      notices.push(name);
    }
    if (!notices.length && id === 'react-remove-scroll-bar@2.3.8') {
      const reviewed = path.join(root, 'scripts/licenses/react-remove-scroll-bar-2.3.8');
      for (const name of ['LICENSE', 'SOURCE.md']) {
        await cp(path.join(reviewed, name), path.join(target, name));
        notices.push(name);
      }
    }
    if (!notices.length) throw new Error(`Bundled browser dependency has no license file: ${id}`);
    records.push({
      name: metadata.name,
      version: metadata.version,
      license: typeof metadata.license === 'string' ? metadata.license : 'NOASSERTION',
      path: `dist/web/licenses/${relative}`,
      notices,
    });
  }
  await writeFile(path.join(destination, 'manifest.json'), `${JSON.stringify(records, null, 2)}\n`);
  return records;
}
