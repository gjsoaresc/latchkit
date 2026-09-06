# Provider verification evidence

The current release target is Windows 11 x64. Qualification focuses on one complete
Codex delivery workflow on that setup. Additional provider probes, interruption
scenarios, and other operating systems are deferred; they are available as optional
diagnostics below and are not additional 1.0 release gates.

`npm test` and pull-request CI are credential-free contract coverage. They never download a provider, invoke a model, or use an account. The offline tests cover the five adapter contracts, known-version fixtures, generated resources, invocation vectors, lifecycle translation, unsupported fallbacks, task cancellation, quality-gate failure, and managed-file removal.

Use the separate runner only from a disposable project/worktree after an operator has authorized a provider session:

```sh
npm run verify:providers -- --provider codex --mode live --authorized --version 0.1.0 --fixture disposable-basic --timeout 30000 --turns 1 --retries 0 --output .latchkit/provider-evidence.json
```

It executes at most one safe text-only prompt, has a 120-second hard upper timeout, and does not pass approval-bypass flags. A login, approval, permission prompt, timeout, cancellation, or missing executable is blocked/fail evidence, never a pass. Output evidence stores no command arguments, transcripts, credentials, or usage guesses. Keep provider credentials in the provider session or the approved CI secret store.

The output follows `schemas/provider-e2e-evidence-v1.schema.json`; it binds the tested commit, adapter configuration hash, provider version, Node/runtime and configured limits. A real run should additionally retain the disposable fixture artifact under the operator's protected evidence location, after sanitization.

For an explicitly authorized Codex release-candidate lifecycle, first build the exact archive and record its SHA-256, then run:

```sh
npm run verify:lifecycle -- --authorized --provider codex --artifact <standalone.zip> --artifact-sha256 <sha256> --output .github/release-evidence/1.0.0/lifecycle-codex-windows.evidence.json
```

The candidate archive must come from clean, committed source. The harness verifies
the supplied digest, extracts the exact standalone archive outside the checkout,
and relaunches under its private Node runtime. It binds evidence to the embedded
manifest and imports all Latchkit operations from the extracted application.
It then creates a disposable Git project, installs the candidate's bundled skills,
records an expected failing check, terminates one owned provider process,
recovers the interrupted task, performs one bounded implementation, resumes its
provider thread for a handoff, and runs one isolated review. It also verifies that
failed, unauthorized, and unsupported evidence cannot become task completion.
The retained JSON contains statuses, hashes, versions, limits, and finding counts
only; provider output, prompts, command arguments, credentials, usage guesses,
and the disposable project are not retained. This is one native-host Codex cell,
not evidence for another provider or operating system.

The full delivery controller has its own exact-archive harness:

```sh
npm run verify:workflow -- --authorized --provider codex --artifact <standalone.zip> --artifact-sha256 <sha256> --output .github/release-evidence/1.0.0/workflow-codex-windows.evidence.json
```

Use `node scripts/live-provider-adapter-evidence.js` with the same authorization,
archive, digest, provider, and output arguments for a bounded read-only Codex or
Claude adapter probe. All three harnesses use the coding tool's configured model.

## Current qualification scope

Codex on native Windows is the delivery workflow under qualification. Its exact
archive evidence must show requirements, plan approval, implementation, acceptance
checks, independent review, and handoff. Provider exit status alone is insufficient.

Claude Code, Cursor CLI, and Cursor IDE retain their implemented adapters and offline
contract coverage. Their live sessions are not part of this candidate's release gate.
Antigravity retains its documented limited print-mode capabilities. WSL, Linux, and
macOS qualification is deferred. Historical evidence for a different archive or host
does not establish current support.

## Cursor IDE manual workflow

In a disposable project, record Cursor version, commit, OS, workspace trust and hook policy. Detect
the installed editor, sync only Cursor, list the discovered skills, and enable the opt-in hook
export with an explicit output such as
`.latchkit/providers/cursor-ide/evidence/manual-run.json`. Invoke one bounded skill manually, then
inspect the allowlisted file with `inspectCursorIdeHookEvidence`. Observe session start, one tool
event, stop, and session end; annotate missing records rather than inferring them. The evidence file
contains no transcripts, tool payloads, paths, provider IDs, accounts, or credentials. Disable the
integration and confirm an unrelated custom hook/file survives; the evidence is retained until the
operator explicitly removes it. A Cursor CLI run is not a substitute for this workflow.
