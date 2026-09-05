# ADR 0003: Optional Playwright acceptance driver

## Status

Accepted.

## Context

Acceptance verification needs a maintained browser engine, but Latchkit has no runtime dependencies and must remain useful for non-web projects. Browser downloads are large, platform-specific, and unsuitable as an unconditional install side effect.

## Decision

The acceptance verifier dynamically imports `@playwright/test` only for a declared `browser` check. It returns `unsupported` with `missing-browser-runtime` when the package or requested installed browser is unavailable. It never downloads a browser. Contributors and CI install browsers explicitly.

Automated browser targets are restricted to loopback. Page screenshots and traces are disabled by default because they can contain private content or authentication state. A check must explicitly opt into either capture. Attachments are capped at 5 MB, the structured artifact at 256 KB, and only the newest 25 artifact directories per task are retained. CI opts into a screenshot only for the repository-owned credential-free fixture and retains that sanitized evidence for seven days.

## Consequences

CLI and HTTP checks need no optional package or browser download. Browser coverage is honest about missing runtime and unsupported devices. A manual/provider-owned device check is separate `unsupported` evidence until a human or provider records appropriate approval through task state; a screenshot alone never produces a pass.
