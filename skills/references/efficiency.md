# Optional efficiency policy

Apply this policy when the caller asks to minimize usage, latency, or unnecessary implementation. Preserve the acceptance criteria and existing authorization.

Before adding a dependency or abstraction, inspect the current implementation and the relevant tool's native capabilities. Prefer the smallest coherent change that meets the criteria. Reuse applicable project memory after checking its assumptions against current source; do not repeat an unchanged investigation or a passing check without a new reason.

When a task or workflow is explicitly set to fast verification mode (`--verification-mode fast`, or the project default from `latchkit verification`), the host already builds a bounded, change-focused check plan and reuses an unchanged passing check instead of rerunning it; do not additionally invent your own skip logic. A new failure, a changed dependency, or missing prior evidence always forces a rerun regardless of mode. Fast mode still runs every required check at least once and applies its own explicit time/execution budget; when that budget is reached before every check has run, the host reports the gap and the exact next check rather than declaring the work verified, and standard mode remains the unbounded fallback for establishing full confidence. Never claim a check passed because an earlier unrelated run of it passed.

Delegate only an independent, bounded assignment. Send its objective, exact source snapshot, allowed files, relevant excerpts, acceptance criteria, prior findings, and limits. Do not send the complete conversation by default. Choose an economical capable model for straightforward work; use a stronger reviewer for process ownership, security boundaries, concurrency, and data recovery. Cheap implementation that repeatedly needs repair can consume more total usage.

For commands, keep the exact invocation, exit status, elapsed time, and a deterministic result summary. Retain bounded sanitized original evidence separately. A filtered summary must not replace the original exit status or hide failed checks. Never rerun a command merely to obtain a shorter display.

Track coordinator and worker usage together. Character counts, token estimates, provider-measured counters, public API list-price estimates, and actual billed charges are different quantities. Missing counters remain unknown. Free-tier routing still consumes inference and may have limits; never switch providers, models, or paid fallback silently.

Compare baseline and optimized runs on the same fixture, acceptance checks, source snapshot, and declared model settings. Report acceptance success, regressions, all participating agents' usage, elapsed time, and changed-code volume. A reduction in context or code size alone is not evidence of equal quality or guaranteed savings.
