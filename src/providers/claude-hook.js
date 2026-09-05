#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { translateClaudeLifecycleInput } from './claude.js';

try {
  const { values } = parseArgs({ options: { event: { type: 'string' } } });
  const input = JSON.parse(await readFile(0, 'utf8'));
  const result = translateClaudeLifecycleInput(input, { eventName: values.event });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`Latchkit Claude hook rejected input: ${error.message}\n`);
  process.exitCode = 2;
}
