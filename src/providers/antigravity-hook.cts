'use strict';
/* Packaged Antigravity CLI hook: validate bounded JSON then emit the documented
 * PostToolUse empty advisory response. Other documented events are deliberately
 * absent because their responses can control execution or lack an evidenced
 * permission-preserving advisory response. */
const INPUT_LIMIT = 64 * 1024;
const events = new Set(['PostToolUse']);

async function writeEvidenceReceipt(
  event: string,
  stepIdx: number,
  toolCall: { name?: unknown; args?: unknown },
) {
  const destination = process.env.LATCHKIT_ANTIGRAVITY_HOOK_RECEIPT;
  const nonce = process.env.LATCHKIT_ANTIGRAVITY_HOOK_NONCE;
  if (!destination || !nonce) return;
  if (destination.length > 1024 || /[\r\n\0]/.test(destination))
    throw new Error('Invalid Antigravity hook receipt destination.');
  if (nonce.length > 128 || /[\r\n\0]/.test(nonce))
    throw new Error('Invalid Antigravity hook receipt nonce.');
  if (
    toolCall.name !== 'view_file' ||
    toolCall.args === null ||
    typeof toolCall.args !== 'object' ||
    Array.isArray(toolCall.args) ||
    typeof (toolCall.args as { AbsolutePath?: unknown }).AbsolutePath !== 'string'
  )
    return;
  const target = (toolCall.args as { AbsolutePath: string }).AbsolutePath;
  const [{ appendFile }, { createHash }] = await Promise.all([
    import('node:fs/promises'),
    import('node:crypto'),
  ]);
  // The receipt is an opaque operation digest; it excludes the path, payload,
  // provider text, and tool arguments from the retained evidence.
  const operationDigest = createHash('sha256')
    .update(JSON.stringify({ tool: 'view_file', target }))
    .digest('hex');
  await appendFile(destination, `${JSON.stringify({ event, stepIdx, nonce, operationDigest })}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

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
  const payload = value as { toolCall?: unknown; stepIdx?: unknown };
  if (
    payload.toolCall === null ||
    typeof payload.toolCall !== 'object' ||
    Array.isArray(payload.toolCall) ||
    !Number.isInteger(payload.stepIdx) ||
    (payload.stepIdx as number) < 0
  )
    throw new Error('PostToolUse requires a toolCall object and non-negative stepIdx.');
  await writeEvidenceReceipt(
    event,
    payload.stepIdx as number,
    payload.toolCall as { name?: unknown; args?: unknown },
  );
  process.stdout.write('{}\n');
}
main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Antigravity hook failed.'}\n`);
  process.exitCode = 1;
});
