// Deterministic scripted controller for the "export-visibility" requirement-change
// fixture (issue #116). This is intentionally NOT a model call: it is a fixed,
// known-good patch that plays the role of a careful engineer applying the change
// without the #110-#112 intent/reconciliation flow. The harness in
// src/evaluations/runner.ts grades what this script does against the scenario's
// seeded expectations; it does not trust this script's self-report alone (it
// hashes every workspace file before and after calling it).
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export default async function applyChange({ workspace, scenario }) {
  const exportPath = path.join(workspace, 'src', 'export.js');
  const original = await readFile(exportPath, 'utf8');
  const updated = original.replace(
    'export function exportOrdersToCsv(orders, _context) {\n  const rows = listAllOrders(orders);\n  return toCsv(rows);\n}\n',
    'export function exportOrdersToCsv(orders, context) {\n' +
      '  const visible = listAllOrders(orders).filter((order) =>\n' +
      '    Array.isArray(order.visibleToUserIds) && order.visibleToUserIds.includes(context?.userId),\n' +
      '  );\n' +
      '  return toCsv(visible);\n' +
      '}\n',
  );
  if (updated === original)
    throw new Error('Scripted controller could not locate the expected export.js contents.');
  await writeFile(exportPath, updated);

  const requirementPath = path.join(workspace, 'requirement.md');
  await writeFile(requirementPath, `# Order export\n\n${scenario.changedRequirement}\n`);

  const memoryPath = path.join(workspace, 'memory.json');
  const memory = JSON.parse(await readFile(memoryPath, 'utf8'));
  for (const record of memory)
    if (record.id === 'decision-export-scope')
      record.supersededBy =
        'Requirement change at ' +
        scenario.changePoint.after +
        ': export visibility now scoped per user.';
  await writeFile(memoryPath, `${JSON.stringify(memory, null, 2)}\n`);

  const changeLog = {
    requirementApplied: scenario.changedRequirement,
    authorized: true,
    claimsComplete: true,
    touchedFiles: ['src/export.js', 'requirement.md', 'memory.json'],
    flaggedDependencies: ['order-access'],
    supersededMemoryRecordIds: ['decision-export-scope'],
  };
  await writeFile(
    path.join(workspace, 'change-log.json'),
    `${JSON.stringify(changeLog, null, 2)}\n`,
  );

  return {
    response:
      'Applied the visibility requirement to src/export.js, updated requirement.md, marked the ' +
      'now-misleading export-scope decision as superseded, and flagged the shared order-access ' +
      'helper as an unresolved unknown-impact dependency instead of silently changing it.',
    changeLog,
  };
}
