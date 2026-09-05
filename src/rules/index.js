import { discoverProjectFacts } from './discovery.js';
import { createProjectInstructionModel } from './model.js';
import { planProviderExports } from './exporters.js';

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

export async function buildProjectRuleExports(root, providerIds, options = {}) {
  const scopes = await discoverProjectFacts(root, options);
  const model = createProjectInstructionModel(scopes, options);
  return { model, ...planProviderExports(model, providerIds) };
}
