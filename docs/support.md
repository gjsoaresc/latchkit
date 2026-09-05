# Support and troubleshooting

Start with the command that produced the failure and keep the output's stable error code. Do not disable operating-system permissions or provider safety controls globally to work around an error.

## Triage flow

1. Check `node --version` and run `latchkit doctor --project <path>`.
2. Run the failed command with `--dry-run` when available (`sync`, `migrate`, and `recover`).
3. If a mutation was interrupted, stop other Latchkit processes and run `latchkit recover --dry-run --project <path>`.
4. If the preview reports an edited or unknown resource, preserve the user file, reconcile it manually, and retry. Never replace it with a generated copy without reviewing the diff.
5. Create a local support bundle only after reviewing its contents:

   ```sh
   latchkit diagnostics --project <path>
   latchkit diagnostics --project <path> --export
   ```

   The bundle is an allowlisted local JSON file containing runtime/configuration metadata, redacted diagnostic events, and recovery evidence. It is never uploaded. Inspect and redact it again before sharing.

## Actionable error codes

| Code | Meaning | Safe next action |
| --- | --- | --- |
| `CONFIG_INVALID` / `CONFIG_INVALID_JSON` | The project configuration fails the published contract. | Restore a reviewed valid file or use `migrate --dry-run`; do not hand-edit away unknown fields without a backup. |
| `CONFIG_UNSUPPORTED_VERSION` | This Latchkit version cannot read the configuration schema. | Install a version that supports the schema, or restore a reviewed backup; automatic downgrade is not supported. |
| `CONFIG_MIGRATION_UNSUPPORTED` | The requested migration target is not supported. | Use the current schema target or follow the manual restore procedure in [migration](migration.md). |
| `CONFIG_REVISION_CONFLICT` / `SYNC_PLAN_STALE` | Another writer changed configuration after the preview. | Re-read configuration, generate a fresh preview, and apply it only after review. |
| `RECOVERY_LOCK_BLOCKED` | A live or ambiguous operation lock prevents mutation. | Stop the owning process; inspect with `recover --dry-run`. Never delete a live lock. |
| `OPERATION_CONFLICT` | A managed resource was edited, replaced, or reached through a link. | Preserve the resource, review the conflict list, and reconcile before retrying. |
| `OPERATION_FAILED` | An unexpected operation or filesystem failure occurred. | Keep the diagnostic code and bundle; retry only after checking the reported stage and path. |

Messages and paths can contain local details. Diagnostic persistence redacts credential-like values, authorization headers, sensitive path segments, prompts, provider streams, and source contents by default, but treat every exported bundle as shareable only after human review.

## Provider failures and capability evidence

`doctor` checks executable discovery, not login, subscription, model access, or an end-to-end agent turn. Offline tests and CI are credential-free. A provider matrix cell is `unknown` until a sanitized, observed evidence record exists for that provider/version/OS combination. See [provider verification](verification/provider-e2e.md) and the provider-specific notes in [compatibility](compatibility.md).

## Security and privacy reports

Do not put credentials, tokens, transcripts, or private source files in an issue. Report a suspected security problem privately through the repository's GitHub security reporting path when available; otherwise contact the maintainer before publishing details. Include the Latchkit version, platform, stable error code, reproduction using disposable data, and a redacted support bundle. Keep credentials in the provider's own credential store.

## Accessibility and local console limitations

The console has automated coverage for keyboard completion, accessible names, empty selections, concurrent-save recovery, and narrow layouts. Use the CLI if the browser surface is unavailable. The browser suite is evidence for those flows, not a claim that every assistive technology or browser combination has been manually certified.
