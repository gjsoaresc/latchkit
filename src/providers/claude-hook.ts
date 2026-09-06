#!/usr/bin/env node
import { stdin } from 'node:process';
import { parseArgs } from 'node:util';
import { translateClaudeLifecycleInput } from './claude.js';
import { errorMessage } from '../types.js';

try {
  const { values } = parseArgs({ options: { event: { type: 'string' as const } } });
  let raw = '';
  for await (const chunk of stdin) raw += String(chunk);
  const input = JSON.parse(raw);
  const result = translateClaudeLifecycleInput(input, { eventName: values.event });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`Latchkit Claude hook rejected input: ${errorMessage(error)}\n`);
  process.exitCode = 2;
}
