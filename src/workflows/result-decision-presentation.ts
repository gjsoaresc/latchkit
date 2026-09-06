/**
 * Which surface a provider's own running session should prefer when
 * presenting the end-of-execution result decision (approve / request
 * changes / review later). Delegates to the generic table in
 * `decision-presentation.ts`, shared with the end-of-spec decision
 * (`spec-decision-presentation.ts`, #97) — both offer the same three-way
 * native-question/native-plan-approval/text-fallback shape and the
 * underlying per-provider evidence is identical.
 */

import {
  selectDecisionPresentation,
  type DecisionPresentation,
  type DecisionPresentationMode,
} from './decision-presentation.js';

export type ResultDecisionPresentationMode = DecisionPresentationMode;

export type ResultDecisionPresentation = DecisionPresentation;

/**
 * Look up the documented decision-presentation surface for a provider ID
 * (e.g. `claude`, `codex`, `antigravity`, `cursor`, `cursor-cli`, matching
 * `src/providers/registry.ts`). Never returns a native mode unless it is
 * documented for that provider; see `decision-presentation.ts`.
 */
export function selectResultDecisionPresentation(providerId: string): ResultDecisionPresentation {
  return selectDecisionPresentation(providerId);
}
