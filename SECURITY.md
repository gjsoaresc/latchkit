# Security

## Supported versions and reporting

The latest release on `main` is the supported security baseline. Development snapshots and older alpha packages may not receive backports. Report suspected vulnerabilities through GitHub's private vulnerability reporting feature; maintainers will acknowledge, reproduce privately, prepare a regression-tested fix, and publish it through the controlled release workflow. Do not include secrets, personal paths, or confidential project content in a public issue. See the [security audit](docs/security-audit.md) for the threat model, limitations, and reproducible evidence commands.

The alpha serves one project on `127.0.0.1` with an ephemeral session token. API calls require that token; the console does not execute arbitrary commands or read provider credentials. Do not share the printed console URL or expose the port through a proxy or tunnel.

Latchkit diagnostics are local-only. Failed API and CLI operations may append redacted structured records to `.latchkit/diagnostics/events.ndjson`; records are capped at 500 events and 256 KiB, and can be removed with `latchkit diagnostics --clear`. Redaction covers known credential fields, authorization/bearer values, URL query secrets, supplied secret values, and common sensitive path segments; it is not universal secret detection. Prompts, provider streams, environment dumps, source files, and credentials are not collected by default. `latchkit diagnostics` previews an allowlisted support bundle and `--export` writes it locally; review the listed contents before sharing. Nothing is uploaded automatically.

Managed skill writes reject symlink/junction paths, validate install destinations and preserve files that fail ownership checks. These protections prevent ordinary accidental overwrites; Latchkit is not a sandbox against other processes running as the same OS user. A process crash or disk failure can leave a partially applied sync or a lock requiring manual recovery. See [architecture](docs/architecture.md).

Skills run inside the selected provider and inherit its tools, account and permissions. Prompt instructions are not enforcement boundaries. Use the provider's approval and sandbox controls.

For vulnerabilities, use the repository's private vulnerability reporting feature when available. Otherwise open a minimal issue asking for a private contact route, without including exploit details, tokens, personal paths or confidential project content.
