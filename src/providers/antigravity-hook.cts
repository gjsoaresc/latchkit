'use strict';
/* Packaged Antigravity CLI hook: validate bounded JSON then emit the documented
 * PostToolUse empty advisory response. Other documented events are deliberately
 * absent because their responses can control execution or lack an evidenced
 * permission-preserving advisory response. */
const INPUT_LIMIT = 64 * 1024;
const events = new Set(['PostToolUse']);

async function main() {
  const [flag, event] = process.argv.slice(2);
  if (flag !== '--event' || !event || process.argv.length !== 4 || !events.has(event))
    throw new Error('Unsupported Antigravity hook event.');
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > INPUT_LIMIT) throw new Error('Antigravity hook input exceeds 64 KB.');
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Invalid Antigravity hook JSON input.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an Antigravity hook object.');
  process.stdout.write('{}\n');
}
main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Antigravity hook failed.'}\n`);
  process.exitCode = 1;
});
