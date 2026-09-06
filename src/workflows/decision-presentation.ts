/**
 * Which surface a provider's own running session should prefer when
 * presenting a durable end-of-phase decision to the user (approve / add
 * notes / defer). Latchkit's TypeScript runtime never drives another
 * provider's conversation (see docs/architecture.md, "Provider contracts and
 * lifecycle bridge"), so this table cannot detect a live tool at runtime. It
 * records only what the provider's *documented* CLI/skill surface offers,
 * sourced from `docs/providers/*.md` and `docs/compatibility.md`.
 * `documented: false` means Latchkit has not found and recorded such
 * evidence; skills must fall back to the concise text choice for that
 * provider rather than assume one exists.
 *
 * This module is shared by every durable decision point that offers the same
 * three-way shape (approve / notes / defer) — today the end-of-spec decision
 * (`spec-decision-presentation.ts`, kept for the exact #97 public API) and
 * the end-of-execution result decision (`result-decision-presentation.ts`).
 * The table's `control`/`note` text intentionally stays generic across those
 * callers rather than naming "the plan" or "the result" specifically.
 */

export type DecisionPresentationMode = 'native-question' | 'native-plan-approval' | 'text-fallback';

export type DecisionPresentation = {
  providerId: string;
  mode: DecisionPresentationMode;
  control: string | null;
  documented: boolean;
  evidenceUrl: string | null;
  note: string;
};

const TABLE: Readonly<Record<string, Omit<DecisionPresentation, 'providerId'>>> = Object.freeze({
  claude: Object.freeze({
    mode: 'native-question',
    control: 'AskUserQuestion tool or plan-mode approval',
    documented: true,
    evidenceUrl: 'https://code.claude.com/docs/en/cli-usage',
    note: 'Claude Code documents an interactive question tool and a plan-mode approval flow; prefer whichever is available in the current session before falling back to text.',
  }),
  codex: Object.freeze({
    mode: 'text-fallback',
    control: null,
    documented: false,
    evidenceUrl: null,
    note: 'No documented Codex CLI surface for a free-form multi-choice question; use the concise text fallback.',
  }),
  antigravity: Object.freeze({
    mode: 'text-fallback',
    control: null,
    documented: false,
    evidenceUrl: null,
    note: 'Antigravity CLI print-mode invocation has no documented interactive choice control in this adapter; use the concise text fallback.',
  }),
  cursor: Object.freeze({
    mode: 'text-fallback',
    control: null,
    documented: false,
    evidenceUrl: null,
    note: 'No documented Cursor Agent surface this adapter can invoke for a structured choice; use the concise text fallback.',
  }),
  'cursor-cli': Object.freeze({
    mode: 'text-fallback',
    control: null,
    documented: false,
    evidenceUrl: null,
    note: 'No documented cursor-agent CLI surface for a structured choice; use the concise text fallback.',
  }),
});

const FALLBACK: Omit<DecisionPresentation, 'providerId'> = Object.freeze({
  mode: 'text-fallback',
  control: null,
  documented: false,
  evidenceUrl: null,
  note: 'Unknown or unrecognized provider; use the concise text fallback rather than assume a native control.',
});

/**
 * Look up the documented decision-presentation surface for a provider ID
 * (e.g. `claude`, `codex`, `antigravity`, `cursor`, `cursor-cli`, matching
 * `src/providers/registry.ts`). Never returns a native mode unless it is
 * present in `TABLE` above with `documented: true`.
 */
export function selectDecisionPresentation(providerId: string): DecisionPresentation {
  const entry = TABLE[providerId] ?? FALLBACK;
  return { providerId, ...entry };
}
