'use strict';
/* global Buffer, process */

// Packaged project hook. It validates a bounded JSON object and returns an
// advisory no-op. A future authorized consumer can replace the response path;
// this handler never starts a provider session or reads credentials.
const LIMIT = 64 * 1024;
let bytes = 0;
const chunks = [];
process.stdin.on('data', (chunk) => {
  bytes += chunk.length;
  if (bytes > LIMIT) {
    process.stderr.write('Cursor hook input exceeds 64 KB.\n');
    process.exitCode = 1;
    process.stdin.destroy();
    return;
  }
  chunks.push(chunk);
});
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('Expected an object.');
    process.stdout.write('{}\n');
  } catch (error) {
    process.stderr.write(`Invalid Cursor hook input: ${error.message}\n`);
    process.exitCode = 1;
  }
});
