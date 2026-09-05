# Acceptance verification

Latchkit can execute declared CLI, HTTP, browser, and manual checks against existing durable task criteria. The input contract is `schemas/acceptance-checks-v1.schema.json`; each result is recorded with `recordEvidence`, so task, run, criterion revision, and Git/source digest remain the source of completion truth. Editing the criterion or source makes prior passing evidence inapplicable during task verification.

Run a task, write a check document, and explicitly authorize its local execution:

```sh
latchkit acceptance verify --project . --task task_... --file acceptance.json --host-local-authorized
```

```json
{
  "schemaVersion": 1,
  "checks": [
    {
      "id": "cli-help",
      "criterionId": "criterion_...",
      "label": "CLI help exits successfully",
      "type": "cli",
      "plan": { "executable": "node", "args": ["src/cli.js", "--help"] },
      "timeoutMs": 5000,
      "outputLimitBytes": 65536
    },
    {
      "id": "local-api",
      "criterionId": "criterion_...",
      "label": "Local API returns the expected object",
      "type": "http",
      "target": "http://127.0.0.1:${PORT}/api",
      "fixture": {
        "plan": { "executable": "node", "args": ["test/fixture-app.js"] },
        "port": 0,
        "portEnvironment": "PORT",
        "readinessPath": "/ready",
        "readinessTimeoutMs": 10000
      },
      "assertions": [
        { "kind": "status", "equals": 200 },
        { "kind": "json", "pointer": "/ok", "equals": true }
      ]
    }
  ]
}
```

Executable and arguments stay separate and owned CLI/fixture processes use the existing process runner. A fixture with port `0` receives an available loopback port through `PORT` (or `portEnvironment`); `${PORT}` in its target and arguments is replaced. A requested occupied port fails as `fixture-port-conflict` before launch and Latchkit never terminates the existing listener. Readiness has a deadline, and cancellation stops only the fixture process tree launched by the current verifier while retaining completed and cancelled evidence.

HTTP requests declare method, target, assertions, timeout, response bound, and redirect behavior. Redirects fail unless `followRedirects` is true, and even then cross-origin redirects are refused. Response bodies are used for assertions but not retained. Supported assertion kinds are `status`, `header`, `body-includes`, and RFC 6901-style `json` pointers.

Browser checks support `click`, `fill`, `press`, relative `goto`, and a diagnostic `close` action, plus `visible`, `text`, `url`, and `title` assertions. `close` exists to prove that a lost page/browser is reported as `browser-crashed`, never as a pass. Targets must be loopback; Playwright is optional as described in [ADR 0003](adr/0003-optional-playwright-acceptance-driver.md). `captureScreenshot` and `captureTrace` are explicit privacy opt-ins and default to false. `manual` checks always record `unsupported`/`manual-verification-required`; they describe coverage gaps without turning an image into an assertion pass.

Artifacts follow `schemas/acceptance-evidence-v1.schema.json` and live under `.latchkit/tasks/acceptance-evidence/<task>/<artifact>/`. Each contains a declaration digest and a non-secret reproduction summary alongside source, criterion, driver, platform, runtime, timing, assertion, and fixture-cleanup provenance. Structured output is capped at 256 KB, browser attachments at 5 MB each, and retention at 25 artifacts per task. Values pass through the diagnostics redactor. Task-state stores only a controlled relative location, digest, size, driver type, and status. The local API endpoint `POST /api/acceptance/verify` accepts the same document and explicit `executionAuthorized: true`; `POST /api/acceptance/cancel` cancels an active verifier in that server. The console displays outcomes and locations as inert text.

CI runs the real drivers against maintained credential-free fixtures on native Windows and POSIX hosts. Browser jobs identify actual Playwright execution and retain the opted-in fixture screenshot and structured evidence for seven days. These checks are application verification, not provider-session verification or comparative skill evaluation.
