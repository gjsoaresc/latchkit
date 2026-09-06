import type { DeclaredCommand, ProjectInstructionScope } from './types.js';

function inlineCode(value: string): string {
  return `\`${value.replaceAll('\r', '\\r').replaceAll('\n', '\\n').replaceAll('`', '\\`')}\``;
}

function displayCommand(command: DeclaredCommand): string {
  return [command.executable, ...command.args]
    .map((part) => (/^[a-zA-Z0-9_./:@+-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(' ');
}

export function renderScopeInstructions(scope: ProjectInstructionScope): string {
  const lines = [
    '# Latchkit project instructions',
    '',
    `Scope: ${inlineCode(scope.path || '.')}. Generated deterministically from explicit project files; no repository code or project command was run.`,
  ];
  if (scope.facts.length) {
    lines.push('', '## Declared project facts', '');
    for (const fact of scope.facts)
      lines.push(
        `- ${fact.value} (${fact.kind}; source ${inlineCode(fact.sourcePath)}; unverified).`,
      );
  }
  if (scope.commands.length) {
    lines.push('', '## Declared commands', '');
    for (const item of scope.commands)
      lines.push(
        `- ${item.name}: ${inlineCode(displayCommand(item))} (declared by ${inlineCode(item.sourcePath)}; not run or verified).`,
      );
  }
  lines.push('', '## Working agreement', '');
  for (const instruction of scope.originalInstructions) lines.push(`- ${instruction}`);
  if (scope.instructions.length) {
    lines.push('', '## User overrides', '');
    for (const instruction of scope.instructions) lines.push(`- ${instruction}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderCursorRule(scope: ProjectInstructionScope, instructions: string): string {
  const globs = scope.path ? `${scope.path}/**/*` : '**/*';
  return `---\ndescription: ${JSON.stringify(`Latchkit facts and working agreements for ${scope.path || 'this project'}`)}\nglobs: ${JSON.stringify(globs)}\nalwaysApply: false\n---\n\n${instructions}`;
}

export function renderClaudeRule(scope: ProjectInstructionScope, instructions: string): string {
  if (!scope.path) return instructions;
  return `---\npaths:\n  - ${JSON.stringify(`${scope.path}/**/*`)}\n---\n\n${instructions}`;
}
