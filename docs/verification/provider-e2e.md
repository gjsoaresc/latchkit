# Provider verification evidence

`npm test` and pull-request CI are credential-free contract coverage. They never download a provider, invoke a model, or use an account. The offline tests cover the five adapter contracts, known-version fixtures, generated resources, invocation vectors, lifecycle translation, unsupported fallbacks, task cancellation, quality-gate failure, and managed-file removal.

Use the separate runner only from a disposable project/worktree after an operator has authorized a provider session:

```sh
npm run verify:providers -- --provider codex --mode live --authorized --version 0.1.0 --fixture disposable-basic --timeout 30000 --turns 1 --retries 0 --output .latchkit/provider-evidence.json
```

It executes at most one safe text-only prompt, has a 120-second hard upper timeout, and does not pass approval-bypass flags. A login, approval, permission prompt, timeout, cancellation, or missing executable is blocked/fail evidence, never a pass. Output evidence stores no command arguments, transcripts, credentials, or usage guesses. Keep provider credentials in the provider session or the approved CI secret store.

The output follows `schemas/provider-e2e-evidence-v1.schema.json`; it binds the tested commit, adapter configuration hash, provider version, Node/runtime and configured limits. A real run should additionally retain the disposable fixture artifact under the operator's protected evidence location, after sanitization.

For an explicitly authorized Codex release-candidate lifecycle, first build the exact archive and record its SHA-256, then run:

```sh
npm run verify:lifecycle -- --authorized --provider codex --artifact <archive.tgz> --artifact-sha256 <sha256> --output .github/release-evidence/issue-36/lifecycle-codex-windows.json
```

The candidate checkout must be clean and committed. The harness verifies the supplied digest, installs that exact archive outside the checkout with lifecycle scripts disabled, and imports all Latchkit operations from the installed package. It then creates a disposable Git project, installs the candidate's bundled skills, records an expected failing check, terminates one owned provider process, recovers the interrupted task, performs one bounded implementation, resumes its provider thread for a handoff, and runs one isolated review. It also verifies that failed, unauthorized, and unsupported evidence cannot become task completion. The retained JSON contains statuses, hashes, versions, limits, and finding counts only; provider output, prompts, command arguments, credentials, usage guesses, and the disposable project are not retained. This is one native-host Codex cell, not evidence for another provider or operating system.

## Release matrix

| Provider    | Native Windows | WSL2    | Linux   | macOS   | Evidence required       |
| ----------- | -------------- | ------- | ------- | ------- | ----------------------- |
| Claude Code | unknown        | unknown | unknown | unknown | authenticated CLI smoke |
| Codex       | unknown        | unknown | unknown | unknown | authenticated CLI smoke |
| Gemini CLI  | unknown        | unknown | unknown | unknown | authenticated CLI smoke |
| Cursor IDE  | unknown        | unknown | unknown | unknown | manual editor workflow  |
| Cursor CLI  | unknown        | unknown | unknown | unknown | authenticated CLI smoke |

`unknown` means no observed provider session exists; it is not support. WSL2 is an independent runtime and cannot inherit native Windows evidence. Mark each cell `pass`, `fail`, `unsupported`, `blocked`, or `skipped` with a reason and an evidence record. Only observed cells may be promoted to supported release claims.

## Cursor IDE manual workflow

In a disposable project, record Cursor version, commit, OS, workspace trust and hook policy. Detect the installed editor, sync only Cursor, list the discovered skills, enable the opt-in hook export, and invoke one bounded skill manually. Observe session start, one tool event, stop, and session end; annotate unavailable events rather than inferring them. Then disable the integration and confirm an unrelated custom hook/file survives. A Cursor CLI run is not a substitute for this workflow.
