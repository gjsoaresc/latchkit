# Local usage observations

Usage is opt-in for each project. Enable it before starting the sessions you want to observe:

```powershell
latchkit usage enable
latchkit usage inspect
latchkit usage export
latchkit usage disable
```

The console's Usage view reads the same `.latchkit/usage/state-v1.json` ledger. Direct task sessions, scheduled tasks, workflow inference phases, and independent reviewers feed that ledger for supported Claude and Codex result formats. Existing sessions and transcripts are not scanned automatically. Turning observation off prevents subsequent writes; retained records remain until explicit deletion or retention cleanup.

Workflow and review observation runs a bounded `--version` command only after local execution authorization and only while usage is enabled. The probe uses the invocation's executable, working directory, environment mode, and cancellation signal. It has a maximum five-second timeout and 4 KiB output cap. Probes never count as inference, and no prompt is sent with them. The workflow reviewer wrapper recognizes only an exact bounded version command; inference retains its read-only permission checks. Unknown or failed version evidence yields unavailable counts rather than an invented provider version. Disabled observation adds neither a version probe nor a usage-file write.

Each workflow phase uses its persisted action ID, and each reviewer uses its persisted assignment ID, as the observation identity. Reviewer counts are written to the source project's ledger and attributed to the parent task, even when the reviewer executes in a separate worktree. Workflow-level review delegation does not record the same reviewer twice. When the provider supplies a documented session/thread identity, it is retained separately. Replaying an observation with the same identity replaces the prior record rather than adding its counts again, including unavailable observations from older versions of this ledger.

Observation happens as soon as the inference process returns, before workflow or review output validation. A failed exit, cancelled run, or malformed business result can therefore still contribute reported usage. A cancellation during the version probe launches no inference and creates no inference record. Usage parsing/storage failures remain advisory; they cannot approve a workflow, suppress provider failure, or change provider permissions. The usage ledger stores normalized counts and provenance, not prompts, transcripts or environment values. FCC calls retain the explicit replacement environment selected for their existing runner.

Measured tokens are not proof of billing. Missing fields remain unknown, and a mixed or incomplete total is not displayed as zero. Actual subscription charges remain unknown. Monetary estimates require explicit public API pricing provenance; automatically observed token counts do not manufacture a rate or treat a provider's reported list price as the user's bill. This is local diagnostic evidence, not invoice reconciliation or full account-wide usage tracking.

The workflow and reviewer changes alter the workflow policy artifact digest. Complete or stop an existing workflow under its original installed runtime; a workflow recorded with an older policy cannot silently resume under the new one.

Validation uses injected, credential-free provider result fixtures. It covers workflow phases, separate reviewer workspaces, failures, disabled observation, version uncertainty, cancellation, replay, and FCC environment propagation. Those fixtures do not establish real-provider or other-platform qualification.
