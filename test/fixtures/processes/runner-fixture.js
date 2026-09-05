import { spawn } from 'node:child_process';

const [mode, ...args] = process.argv.slice(2);
if (mode === 'args') process.stdout.write(JSON.stringify(args));
else if (mode === 'split') {
  process.stdout.write(Buffer.from([0xf0, 0x9f]));
  setTimeout(() => {
    process.stdout.write(Buffer.from([0x98, 0x80]));
    process.stderr.write(Buffer.from([0xe2, 0x82, 0xac]));
  }, 5);
} else if (mode === 'flood') {
  for (let index = 0; index < 200; index += 1) {
    process.stdout.write('out-'.repeat(100));
    process.stderr.write('err-'.repeat(100));
  }
} else if (mode === 'sleep') setTimeout(() => {}, 10_000);
else if (mode === 'exit') process.exit(Number(args[0]));
else if (mode === 'child') {
  const child = spawn(process.execPath, [process.argv[1], 'sleep'], { stdio: 'ignore' });
  process.stdout.write(String(child.pid));
  setTimeout(() => {}, 10_000);
}
