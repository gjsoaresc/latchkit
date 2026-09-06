# Contributing to Latchkit

Start with the [roadmap](docs/roadmap.md) and open an issue for substantial changes. Small bug fixes and documentation improvements can go directly to a pull request. Before coding, inspect the current main branch, read the issue and its dependencies, and confirm that the requested change is bounded. Do not treat a skill, issue, or agent instruction as permission to merge, publish, deploy, or spend on provider sessions.

Use Node.js 22 or newer. From PowerShell or a POSIX shell, run `npm ci`, `npm run check`, and `npm test`. The application and browser code are strict TypeScript; `tsc` emits the Node ESM application and browser assets, while standalone CommonJS hooks use `.cts`. `npm start` opens a local server and prints its browser URL. `npm run format` applies the deterministic formatter; `npm run lint` and `npm run check:skills` run focused static checks. Workflow policy, prompts, and action contracts are strict TypeScript. The BAML integration is preserved separately on `feat/experimental-baml`. Run the API-backed console workflows with `npm run test:browser -- --project=chromium` after installing the matching Playwright browser. CI additionally runs Firefox and WebKit on Ubuntu and native Windows Chromium; unsupported local browser launchers should be reported as runner limitations.

## Issue-to-PR workflow

1. Inspect current `main`, the issue, linked prerequisites, and the relevant architecture and compatibility docs before editing.
2. Keep the implementation and diff limited to the issue. Preserve unrelated user work and do not assume dependency milestones are complete until their merged interfaces are present.
3. Add or update focused tests for behavior and failure paths. Run the repository checks and record exact commands, versions, results, and limitations in the pull request.
4. Attach useful evidence: what changed, what passed locally, what CI covers, and which provider, credential, OS, or integration scenarios were not exercised.
5. Report blockers truthfully and identify the specific missing authority or dependency. A blocked release or provider check does not justify bypassing permissions or claiming verification.

Cross-platform behavior is part of the product. Use Node filesystem APIs, handle paths with spaces and Unicode, and test on Windows, macOS and Linux. Keep shell commands out of portable installation code. New provider integrations need cited upstream documentation and tests that distinguish exported skills from verified runtime behavior. The 1.0 distribution target is GitHub Releases: user-local Windows x64, Linux x64/glibc (including WSL), and macOS x64/arm64 bundles containing the compiled application and private Node 24.20.0 runtime. Do not describe a platform as qualified until its exact bundle has passed its acceptance run.

Preserve users' existing files and permission settings. Keep skills focused on their stated workflow. Explain whether a behavior is an instruction, an observable check, or an enforced gate.

Changes to `.latchkit/config.json` or `.latchkit/manifest.json` must update the published schema, shared runtime validator, fixtures, compatibility documentation, and an explicit forward migration where applicable. Ordinary reads must remain non-mutating. Never remove or reinterpret an existing field during migration without retaining the exact original bytes and documenting restoration.

Managed filesystem changes must use the registered-resource transaction layer. Add deterministic fault-boundary and recovery tests for new resource types; serializers must preserve unrelated user content before passing whole-file bytes to the transaction core.

The project is MIT-licensed. Submit original work or compatible contributions with required attribution. Do not copy Pilot Shell's proprietary source, skill text, documentation or visual assets.

Pull requests should explain the user-visible change and relevant validation. New adapters, lifecycle hooks and process launchers should include failure-path tests, including cancellation and Windows argument handling where applicable.
