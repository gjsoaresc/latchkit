// Independently specified, executable acceptance assertions for the
// "notification-opt-out" fixture (issue #116), derived from the scenario's
// requirement text rather than from whatever src/notify.js happens to do.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export default async function acceptance({ workspace }) {
  const results = {};
  let notifyModule;
  try {
    notifyModule = await import(pathToFileURL(path.join(workspace, 'src', 'notify.js')).href);
  } catch {
    notifyModule = undefined;
  }

  const call = (order) => {
    if (!notifyModule || typeof notifyModule.notifyOrderOwner !== 'function') return undefined;
    try {
      return notifyModule.notifyOrderOwner(order, {});
    } catch {
      return undefined;
    }
  };

  const optedOutResult = call({ id: 'o1', total: 5, optedOut: true });
  results['skips-opted-out-owner'] = !optedOutResult;

  const sentResult = call({ id: 'o2', total: 7.5, optedOut: false });
  results['still-sends-when-not-opted-out'] =
    typeof sentResult === 'string' && sentResult.includes('o2') && sentResult.includes('7.50');

  results['template-text-preserved'] =
    typeof sentResult === 'string' && sentResult.includes('has been placed.');

  let requirementText = '';
  try {
    requirementText = await readFile(path.join(workspace, 'requirement.md'), 'utf8');
  } catch {
    // Left as the initial empty string; the assertion below fails honestly.
  }
  results['requirement-doc-updated'] = requirementText.toLowerCase().includes('opted out');

  let memory = [];
  try {
    memory = JSON.parse(await readFile(path.join(workspace, 'memory.json'), 'utf8'));
  } catch {
    // Left as the initial empty array; the assertion below fails honestly.
  }
  const decision = Array.isArray(memory)
    ? memory.find((item) => item && item.id === 'decision-notify-all')
    : undefined;
  results['misleading-decision-superseded'] = Boolean(decision && decision.supersededBy);

  return {
    results,
    response:
      'Requirement-change acceptance assertions evaluated against the workspace notify module.',
  };
}
