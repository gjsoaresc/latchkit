# Security

The alpha serves one project on `127.0.0.1` with an ephemeral session token. API calls require that token; the console does not execute arbitrary commands or read provider credentials. Do not share the printed console URL or expose the port through a proxy or tunnel.

Managed skill writes reject symlink/junction paths, validate install destinations and preserve files that fail ownership checks. These protections prevent ordinary accidental overwrites; Latchkit is not a sandbox against other processes running as the same OS user. A process crash or disk failure can leave a partially applied sync or a lock requiring manual recovery. See [architecture](docs/architecture.md).

Skills run inside the selected provider and inherit its tools, account and permissions. Prompt instructions are not enforcement boundaries. Use the provider's approval and sandbox controls.

For vulnerabilities, use the repository's private vulnerability reporting feature when available. Otherwise open a minimal issue asking for a private contact route, without including exploit details, tokens, personal paths or confidential project content.
