import { discoverProjectFacts } from './discovery.js';
import { createProjectInstructionModel } from './model.js';
import { planProviderExports } from './exporters.js';
import type { PlannedRuleExports, ProjectInstructionModel } from './types.js';

export { discoverProjectFacts } from './discovery.js';
export { createProjectInstructionModel } from './model.js';
export { ORIGINAL_INSTRUCTIONS } from './model.js';
export { planProviderExports } from './exporters.js';
export {
  SECTION_END,
  SECTION_START,
  digest,
  findManagedSection,
  lineEndingOf,
  mergeManagedSection,
  removeManagedSection,
  renderManagedSection,
} from './ownership.js';
export { renderClaudeRule, renderCursorRule, renderScopeInstructions } from './render.js';

export async function buildProjectRuleExports(
  root: string,
  providerIds: readonly string[],
  options: { overrides?: readonly unknown[]; scopes?: readonly string[] } = {},
): Promise<{ model: ProjectInstructionModel } & PlannedRuleExports> {
  const scopes = await discoverProjectFacts(root, options);
  const model = createProjectInstructionModel(scopes, options);
  return { model, ...planProviderExports(model, providerIds) };
}
