/**
 * Which surface a provider's own running session should prefer when
 * presenting the end-of-spec decision (approve and build / add notes / keep
 * for later). This is the exact public API introduced by #97; its
 * implementation now delegates to the generic `decision-presentation.ts`
 * table shared with the end-of-execution result decision
 * (`result-decision-presentation.ts`) introduced by #101, since both offer
 * the same three-way native-question/native-plan-approval/text-fallback
 * shape and the underlying per-provider evidence is identical. The exported
 * names, shapes, and behavior below are unchanged from #97.
 */

import {
  selectDecisionPresentation,
  type DecisionPresentation,
  type DecisionPresentationMode,
} from './decision-presentation.js';

export type SpecDecisionPresentationMode = DecisionPresentationMode;

export type SpecDecisionPresentation = DecisionPresentation;

/**
 * Look up the documented decision-presentation surface for a provider ID
 * (e.g. `claude`, `codex`, `antigravity`, `cursor`, `cursor-cli`, matching
 * `src/providers/registry.ts`). Never returns a native mode unless it is
 * documented for that provider; see `decision-presentation.ts`.
 */
export function selectSpecDecisionPresentation(providerId: string): SpecDecisionPresentation {
  return selectDecisionPresentation(providerId);
}
