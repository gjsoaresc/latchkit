import { runGeminiHook } from './gemini.js';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', async () => {
  try {
    process.stdout.write(await runGeminiHook({ stdin: input }));
  } catch (error) {
    process.stderr.write(`latchkit Gemini hook failed: ${error.message}\n`);
    process.exitCode = 2;
  }
});
