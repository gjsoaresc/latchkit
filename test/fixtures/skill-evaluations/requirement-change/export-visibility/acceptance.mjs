// Independently specified, executable acceptance assertions for the
// "export-visibility" fixture (issue #116). These are derived from the
// scenario's requirement text ("only orders visible to this user"), not from
// whatever src/export.js happens to do, so grading does not become circular.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export default async function acceptance({ workspace }) {
  const results = {};
  let exportModule;
  try {
    exportModule = await import(pathToFileURL(path.join(workspace, 'src', 'export.js')).href);
  } catch {
    exportModule = undefined;
  }

  const orders = [
    { id: 'o1', customerId: 'c1', total: 10, visibleToUserIds: ['u1'] },
    { id: 'o2', customerId: 'c2', total: 20, visibleToUserIds: ['u2'] },
    { id: 'o3', customerId: 'c1', total: 30, visibleToUserIds: ['u1', 'u2'] },
  ];
  const context = { userId: 'u1' };
  let csv = '';
  if (exportModule && typeof exportModule.exportOrdersToCsv === 'function') {
    try {
      csv = exportModule.exportOrdersToCsv(orders, context) ?? '';
    } catch {
      csv = '';
    }
  }

  results['visibility-filters-to-current-user'] =
    csv.includes('o1') && csv.includes('o3') && !csv.includes('o2');
  results['csv-still-has-header'] = csv.startsWith('id,customerId,total');
  results['csv-format-preserved'] = csv.includes('10.00') && csv.includes('30.00');

  let requirementText = '';
  try {
    requirementText = await readFile(path.join(workspace, 'requirement.md'), 'utf8');
  } catch {
    // Left as the initial empty string; the assertion below fails honestly.
  }
  results['requirement-doc-updated'] = requirementText.toLowerCase().includes('visible');

  let memory = [];
  try {
    memory = JSON.parse(await readFile(path.join(workspace, 'memory.json'), 'utf8'));
  } catch {
    // Left as the initial empty array; the assertion below fails honestly.
  }
  const decision = Array.isArray(memory)
    ? memory.find((item) => item && item.id === 'decision-export-scope')
    : undefined;
  results['misleading-decision-superseded'] = Boolean(decision && decision.supersededBy);

  return {
    results,
    response:
      'Requirement-change acceptance assertions evaluated against the workspace export module.',
  };
}
