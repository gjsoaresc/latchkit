# Security audit and trust boundaries

This review records the security boundary for the v1 candidate at the exact commit under review. Latchkit is a local workflow coordinator, not a sandbox against a malicious process running as the same operating-system user.

## Assets and boundaries

| Asset or input                                 | Trust level                      | Control and evidence                                                                                                                                                               |
| ---------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser session token                          | Secret, bearer capability        | Per-launch random token, loopback-only binding, constant-time comparison, fragment URL, and authenticated API regression tests.                                                    |
| Project configuration and manifests            | User-controlled state            | Versioned validation, optimistic revisions, atomic writes, backups, and transaction recovery tests.                                                                                |
| Imported skills, packs, rules, and annotations | Untrusted text and bytes         | Bounded reads, strict relative paths, symlink/junction rejection, text-only rendering, and ownership/integrity checks. They never grant approval or execution permission.          |
| Provider output and hook payloads              | Untrusted external input         | Versioned envelope validation, redacted bounded evidence, explicit authorization, and no implicit hook service.                                                                    |
| Process arguments and environments             | High-impact execution boundary   | Validated executable-plus-argument vectors, explicit `host-local-authorized` profile, Windows shim escaping, bounded output, owned cancellation, and process-runner tests.         |
| Task worktrees                                 | Managed filesystem state         | Registry-bound task IDs, immutable base revisions, containment checks, non-forced cleanup, and dirty-work preservation.                                                            |
| Memory, logs, and support bundles              | Potentially sensitive local data | Explicit capture only, key/path/URL redaction, bounded files, allowlisted bundle contents, local export only, and redaction tests.                                                 |
| Package and workflow supply chain              | Release input                    | No runtime dependencies, `npm ci --ignore-scripts`, pinned release actions, read-only default workflow permissions, package smoke tests, and reproducible release artifact checks. |

## Findings and disposition

The review found no unresolved critical or high exploitable issue in the in-scope implementation. Existing controls were retained and regression-tested. Lower-risk limitations have explicit owners and are not launch claims:

| Finding                                                                                                              | Severity | Disposition                                                                                    |
| -------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| A same-user process with equivalent filesystem privileges can alter project state or race local files.               | Medium   | Accepted limitation; documented in `SECURITY.md`, transaction recovery, and architecture docs. |
| Filesystems that do not honor directory fsync or durable rename may lose the last operation during hardware failure. | Medium   | Accepted platform limitation; documented in `docs/recovery.md`.                                |
| Redaction is pattern-based and cannot guarantee detection of every novel secret format.                              | Low      | Accepted limitation; support bundles require local review and never upload automatically.      |
| Provider-specific capabilities and live credentials are not all available in credential-free CI.                     | Low      | Report as unsupported or unverified evidence, never as a passing capability.                   |

## Reproducible evidence

Run the following from the repository root:

```text
npm ci --ignore-scripts
npm run check
npm test
npm pack --dry-run
npm audit --omit=dev --audit-level=high
```

The test suite exercises unauthenticated API denial, origin and host checks, arbitrary-file refusal, stale revision rejection, malformed persisted state, path traversal and link refusal, redacted diagnostics, process authorization, cancellation, and recovery conflicts. GitHub Actions repeats the package and test checks on Node 22 and 24 across Windows, Linux, and macOS, with browser and WSL smoke jobs. No private workspace is submitted to an external scanner by default.

## Reporting and response

Use GitHub's private vulnerability reporting feature for a suspected vulnerability. Include a minimal reproduction, affected commit/version, impact, and proposed mitigation; do not include credentials or confidential project contents. Maintainers triage privately, prepare a reviewed patch and regression test, run the cross-platform/package checks, publish a patched version through the controlled release workflow, and document the fix in the release notes. If private reporting is unavailable, open a minimal public issue requesting a private contact route without exploit details.
