# Experimental BAML integration

The complete BAML integration is preserved on
[`feat/experimental-baml`](https://github.com/willahealm/latchkit/tree/feat/experimental-baml)
at commit `fc8507864033e0b4aadae5e1d8735752613efdf0`.
The 1.0 release uses strict TypeScript for workflow policy and execution and
has no BAML compiler, generated SDK, or bridge runtime dependency.

The experiment pins the official BAML toolchain and TypeScript bridge to
`0.17.0`. Its exact Windows standalone bundle completed a real Codex delivery
loop using private Node 24.20.0, with approval, host verification, independent
review, handoff, and no repair attempts. That preflight does not qualify the
TypeScript release artifacts.

The pinned compiler failed portable generated-output checks. Moving test
fixtures outside production sources removed absolute checkout paths, but
production bytecode still serializes platform-specific source separators.
Windows test staging also encountered busy-directory cleanup failures.
These issues are recorded in the
[experimental qualification run](https://github.com/willahealm/latchkit/actions/runs/34031089316).
The release does not patch compiler bytecode or waive generation checks.

To work on the experiment, use its branch and its setup instructions. Read
the installed `baml-core` skill and use `baml describe typescript` and
`baml describe generator` before editing BAML. Reintroduction requires a
portable, pinned compiler/runtime pair and fresh exact-artifact qualification
on all supported release platforms.
