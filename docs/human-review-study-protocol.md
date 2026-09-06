# Human-review study protocol

Status: **protocol only. Participants: 0. Runs: 0.** No session under this protocol has been run. This document exists so the [requirement-change evaluation harness](requirement-change-evaluations.md) has a predeclared, honest plan for the one measure it cannot supply itself: how much active effort a person spends reviewing the requirement-change workflow's output. It is issue [#116](https://github.com/willahealm/latchkit/issues/116) acceptance criterion 4, and the parent [#109](https://github.com/willahealm/latchkit/issues/109) is explicit that qualifying and running this protocol is not required to close this first slice — only publishing an honest zero is.

## Why this is separate from the automated harness

The automated harness (`npm run evaluate:requirement-change`) measures whether the scripted controller's output is behaviorally correct, not how long a person takes to understand and trust it, or how many mistakes a reviewer makes while doing so. Artifact count, word count, and scripted click counts are cheap proxies the automated harness *can* report, but they are not measured human time or measured human error, and this repository does not relabel them as such. Only an actual consenting participant's recorded session produces that evidence.

## Design

**Type:** within-subject, counterbalanced walkthrough. Each participant reviews outcomes from **both** arms of one requirement-change scenario (currently `export-visibility` or `notification-opt-out` from [the harness fixtures](requirement-change-evaluations.md)); the presentation order of "ordinary current Latchkit" vs. "intent/reconciliation flow" alternates across participants (ABBA or a randomized order) to control for learning and fatigue effects. The reconciliation arm cannot be walked through until [#110](https://github.com/willahealm/latchkit/issues/110)–[#112](https://github.com/willahealm/latchkit/issues/112) merge; until then this protocol can only be piloted against two independently produced baseline traces (e.g. two different scripted-controller or model-driven runs of the same scenario), never published as an arm comparison.

**Materials shown to the participant, identically across arms:**

1. The scenario's starting requirement and the changed requirement (the exact `initialRequirement`/`changedRequirement` text from the fixture).
2. The decision delta: what changed and what the recorded rationale for the change is.
3. The flagged unknown-impact dependency, exactly as the arm reported it.
4. The set of preserved vs. discarded work.
5. The final acceptance-check result (pass/fail per mandatory assertion).

**Decisions and outcome questions asked identically in both arms** (a fixed instrument, not adapted per arm):

- "Do you agree with what changed and why?" (agree / disagree / unsure)
- "Is there anything you would flag for further review before trusting this?" (free text)
- "Would you accept this as ready, given only what you were shown?" (yes / no / need more information)
- "How confident are you that no required constraint from the new requirement was silently dropped?" (1–5)
- "How confident are you that no unrelated work was silently lost?" (1–5)

**What is recorded, and only from actual sessions:**

- Active review time: wall-clock time from first material shown to the final answer submitted, per arm, per participant. Idle/away time is excluded by a simple start/stop control the participant operates.
- Errors: a wrong answer against a predetermined answer key for any objective question (e.g. misjudging whether a mandatory constraint was actually dropped, when the harness's own gate result says otherwise). Subjective questions (agreement, confidence) are recorded as data, not scored as errors.
- Participant and run counts, published alongside every result, including zero.

**What is not claimed:** a sample size below the field's conventional minimum for a statistically supported comparison (commonly cited as small-N pilot territory, not a powered study) is reported as a pilot observation, not a validated effect. No percentage improvement, competitive win, or "faster review" claim is made from this protocol without a stated participant count, run count, and the actual recorded distribution — never a single selected successful trace.

## Consent and scope

Only actual, informed, consenting participants are recorded. No transcript, timing, or answer is collected without explicit opt-in for that specific session, and a participant may withdraw and have their data discarded at any point before publication. This protocol does not authorize recruitment, compensation, or publication by itself — see [AGENTS.md](../AGENTS.md) and the [#109 epic](https://github.com/willahealm/latchkit/issues/109), which reserve those to explicit future authorization. Running this protocol, publishing its results externally, and any participant recruitment are all separately gated and are out of scope for this increment.

## Current status

| Field | Value |
| --- | --- |
| Protocol version | 1 (this document) |
| Participants recruited | 0 |
| Sessions run | 0 |
| Results published | none |

This table is the authoritative "no fabricated result" statement for this measure: any future report that cites human review time or error counts must update this table with the real participant and run counts it is drawn from.
