---
name: latchkit-review
description: Review a specified change for actionable defects and requirement gaps using code and execution evidence. Use for code or implementation reviews; it does not authorize fixing or publishing the reviewed change.
---

# Latchkit review

Find issues a contributor can act on, with a concrete trigger and an explained consequence. This skill provides a review procedure; it does not launch a separate reviewer automatically or make a quality-gate claim.

## Establish the review scope

Determine the intended change, applicable requirements, and exact review target: working diff, commit, branch comparison, or supplied files. Confirm the base exists before comparing branches. Inspect relevant project guidance and surrounding callers, tests, and interfaces; avoid judging a snippet without its context.

Preserve the review boundary. Do not modify implementation, commit, publish comments, or contact the author unless the user has authorized those actions. A local review note may be written at `.latchkit/notes/<unique-task-slug>-review.md`; keep it inline when the request prohibits file writes.

## Trace realistic failures

Check whether the change satisfies the requested behavior and preserves adjacent contracts. Prioritize correctness, data loss, exposed trust boundaries, resource lifetime, and actual platform differences. Follow input through the changed path to identify a plausible failing case.

Use focused execution or existing tests where helpful. Before a command that mutates shared state or calls external services, establish that it is within the task's authorization; use local fixtures when possible. Passing tests narrow the risk but do not prove the whole change correct.

For each finding, capture:

- The affected file and narrow location.
- A concrete input, environment, or sequence that triggers the issue.
- Why the code produces the result and what the user experiences.
- Evidence from code, requirements, or execution, with an uncertainty label if needed.

Remove findings that are only preferences, hypothetical rewrites, or already explained by project intent. Distinguish an existing defect from one introduced or exposed by the change. Do not manufacture findings to meet a quota.

## Report

Present actionable findings in impact order with concise proposed directions, without implementing them. State the reviewed scope and checks actually performed. If no actionable findings remain, say so and name material untested areas without inventing objections.

Record any useful local review evidence in the note. Describe a review performed by this agent as self-review; call it independent only if a separate reviewer actually examined the work. A review note alone does not mark implementation verified or satisfy an external approval requirement.
