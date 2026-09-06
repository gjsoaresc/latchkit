# Cursor IDE adapter

The Cursor IDE adapter treats Cursor as an editor integration. It never launches `cursor` or
`agent`, treats opening a workspace as starting an Agent task, reads credentials, or claims that a
configured hook has been observed. Cursor CLI remains a separate provider contract.

## Detection and status

Inspection reports these facts independently:

- **Installed**: a known editor application path is present. On Windows this includes the normal
  per-user installation even when the shell launcher is absent; macOS and Linux application paths
  are checked separately. Version comes from local application metadata when readable.
- **Launcher available**: a `cursor` launcher exists on `PATH`. This does not prove that an Agent
  session can be controlled.
- **Integration configured**: the owned hook entries and packaged handler match the project
  ownership record.
- **Session observed**: only explicit, opaque evidence supplied by a caller. Latchkit does not infer
  this from editor installation, workspace opening, or hook configuration.

Authentication stays unknown because inspection does not read provider credentials. A configured
but unobserved integration remains end-to-end unverified.

## Skills, rules, and activation

Cursor shares `.agents/skills`; Latchkit writes that destination once even if Codex, Antigravity CLI,
Cursor IDE, and Cursor CLI are selected together. Cursor may also discover skills in other provider
roots, so selecting a provider is not a visibility boundary. After sync, open Cursor's Rules
settings, inspect the available skills, and reload the window if a new skill is absent.

Scoped instructions use `.cursor/rules/latchkit-*.mdc` through the common rule serializer. When a
selected Codex `AGENTS.md` hierarchy is already visible to Cursor, Latchkit reports that discovery
and does not create a duplicate Cursor rule.

Starting and resuming Agent Chat, stopping a generation, and inspecting usage are manual. There is
no command preview because the adapter has no supported invocation plan.

## Opt-in project hooks

Hook installation is a separate explicit operation. It merges owned entries into
`.cursor/hooks.json` and installs a bounded CommonJS handler under
`.latchkit/providers/cursor-ide/`. Both changes use the registered-resource transaction engine. The
serializer retains unrelated events and unknown JSON keys; reapplying an unchanged registration
does not rewrite the file. Removal verifies each owned entry and the handler hash, removes only
those unchanged resources, and blocks on edited or missing owned content. The transaction journal
holds exact before/after bytes during mutation and rolls back failures.

The adapter registers only these documented Agent events: `sessionStart`, `sessionEnd`,
`preToolUse`, `postToolUse`, `postToolUseFailure`, `preCompact`, and `stop`. It does not install Tab
hooks or `workspaceOpen`, and translations label those sources so they cannot be reported as Agent
task progress. It does not enable Cursor's Claude Code compatibility import.

Project commands run from the project root according to Cursor's hook contract. The generated
command quotes the absolute Node executable and relative handler path, with the repository's tested
native Windows command quoting. The handler accepts at most 64 KB of JSON on stdin and returns an
advisory no-op. By default it is non-persistent: it does not read environment credentials, log raw
payloads, start sessions, or override provider permissions. Workspace trust, a local disabled-hooks
setting, or managed policy can prevent execution and is reported separately from configuration.

Release qualification may explicitly enable privacy-safe hook evidence through the export API:

```js
await applyCursorIdeHookExport(root, {
  enabled: true,
  evidence: {
    enabled: true,
    outputPath: '.latchkit/providers/cursor-ide/evidence/manual-run.json',
  },
});
```

The output must be a bounded `.json` file directly under the owned evidence directory. The handler
records only schema version, contiguous sequence, normalized event name, and
`success`/`failure`/`refusal` classification. It never stores timestamps, prompts, transcripts,
tool arguments or results, workspace paths, conversation/session IDs, account identifiers,
environment values, or credentials. Updates are cross-process serialized, size/count bounded,
written through an fsynced temporary file and rename, and use restrictive permissions where the
filesystem supports them. Unsafe paths, links/junctions, malformed state, unknown events, and full
evidence files are refused without replacing existing evidence. Disabling the integration leaves
the evidence file for explicit review and removal.

Normalized translation allowlists event metadata and omits email, transcript paths, tool input,
commands, and other credential-bearing raw fields. Cursor conversation IDs remain opaque
correlation values. `stop` maps to `turn-completed`, never verified task completion;
`sessionEnd` maps to `session-terminated`. Session start, tool, and compaction events remain typed
observations because the shared lifecycle envelope has no equivalent kind.

## Repeatable manual smoke checklist

Record Cursor version, operating system, workspace trust state, local/managed hook policy, and the
exact commit tested. Do not mark a step verified without observing it in that editor/version.

1. Sync a project selecting only Cursor IDE. In Settings > Rules, confirm one copy of each selected
   skill under `.agents/skills` and each expected scoped `.mdc` rule. Reload Cursor and check again.
2. Enable the Cursor hook export explicitly with qualification evidence directed to a new file
   under `.latchkit/providers/cursor-ide/evidence/`. Preview first, confirm only the seven Agent
   events and the packaged Node handler are proposed, then apply. Confirm existing custom hooks and
   unknown keys remain.
3. Trust the workspace and confirm hooks are enabled by local and managed policy. Start Agent Chat
   manually and exercise session start, a read/write or shell tool, compaction where practical,
   stop, and session end. Inspect the allowlisted evidence with `inspectCursorIdeHookEvidence`;
   missing records remain missing and must not be inferred from configured entries.
4. Confirm a Tab completion and workspace reopen do not appear as Agent task progress. Confirm no
   automatic Tab or workspace hook was added and Claude compatibility was not enabled.
5. Confirm the handler starts with the project root as its working directory on the tested OS.
   Repeat a path-with-spaces test on native Windows.
6. Add an unrelated custom hook and unknown top-level key, disable the integration, and confirm both
   remain. Re-enable, edit one owned entry, and confirm removal blocks rather than deleting it.
7. Reload/restart Cursor and repeat discovery. Record any unavailable event or policy restriction as
   unverified or unsupported, not as a passing end-to-end result.

Official references: [Cursor hooks](https://cursor.com/docs/hooks),
[Cursor skills](https://cursor.com/docs/skills), and
[Cursor rules](https://cursor.com/docs/rules).
