// Deterministic scripted controller for the "notification-opt-out" fixture
// (issue #116). See export-visibility/apply-change.mjs for the design note:
// this is a fixed, known-good patch, not a model call, and the harness does
// not trust its self-report alone.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export default async function applyChange({ workspace, scenario }) {
  const notifyPath = path.join(workspace, 'src', 'notify.js');
  const original = await readFile(notifyPath, 'utf8');
  const updated = original.replace(
    'export function notifyOrderOwner(order, _context) {\n  return renderConfirmation(order);\n}\n',
    'export function notifyOrderOwner(order, _context) {\n' +
      '  if (order?.optedOut) return null;\n' +
      '  return renderConfirmation(order);\n' +
      '}\n',
  );
  if (updated === original)
    throw new Error('Scripted controller could not locate the expected notify.js contents.');
  await writeFile(notifyPath, updated);

  const requirementPath = path.join(workspace, 'requirement.md');
  await writeFile(
    requirementPath,
    `# Order confirmation notifications\n\n${scenario.changedRequirement}\n`,
  );

  const memoryPath = path.join(workspace, 'memory.json');
  const memory = JSON.parse(await readFile(memoryPath, 'utf8'));
  for (const record of memory)
    if (record.id === 'decision-notify-all')
      record.supersededBy =
        'Requirement change at ' +
        scenario.changePoint.after +
        ': opt-out now suppresses order notifications.';
  await writeFile(memoryPath, `${JSON.stringify(memory, null, 2)}\n`);

  const changeLog = {
    requirementApplied: scenario.changedRequirement,
    authorized: true,
    claimsComplete: true,
    touchedFiles: ['src/notify.js', 'requirement.md', 'memory.json'],
    flaggedDependencies: ['digest-sender'],
    supersededMemoryRecordIds: ['decision-notify-all'],
  };
  await writeFile(
    path.join(workspace, 'change-log.json'),
    `${JSON.stringify(changeLog, null, 2)}\n`,
  );

  return {
    response:
      'Applied the opt-out check to src/notify.js, updated requirement.md, marked the ' +
      'now-misleading notify-all decision as superseded, and flagged the shared digest-sender ' +
      'helper as an unresolved unknown-impact dependency instead of silently changing it.',
    changeLog,
  };
}
