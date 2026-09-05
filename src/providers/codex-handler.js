import { stdin, stdout } from 'node:process';
import { translateCodexEvent } from './codex.js';

const MAX_INPUT_BYTES = 64 * 1024;

export function handleCodexHookInput(raw, options = {}) {
  if (Buffer.byteLength(raw, 'utf8') > MAX_INPUT_BYTES)
    return { decision: 'advisory', reason: 'Codex hook input exceeded the bounded handler limit.' };
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return { decision: 'advisory', reason: 'Codex hook input was not valid JSON.' };
  }
  const envelope = translateCodexEvent(input, options);
  return envelope
    ? { decision: 'advisory', latchkit: envelope }
    : { decision: 'advisory', reason: 'Codex event is informational and was not mapped.' };
}

if (process.argv[1] && process.argv[1].endsWith('codex-handler.js')) {
  let raw = '';
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk) => {
    raw += chunk;
  });
  stdin.on('end', () => {
    stdout.write(`${JSON.stringify(handleCodexHookInput(raw))}\n`);
  });
}
