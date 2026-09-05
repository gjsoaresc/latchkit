# Contributing to Latchkit

Start with the [roadmap](docs/roadmap.md) and open an issue for substantial changes. Small bug fixes and documentation improvements can go directly to a pull request.

Use Node.js 22 or newer. Run `npm ci`, `npm run check`, and `npm test`. The console is plain HTML/CSS/JavaScript served by Node; no build step is needed. `npm start` opens a local server and prints its browser URL.

Cross-platform behavior is part of the product. Use Node filesystem APIs, handle paths with spaces and Unicode, and test on Windows, macOS and Linux. Keep shell commands out of portable installation code. New provider integrations need cited upstream documentation and tests that distinguish exported skills from verified runtime behavior.

Preserve users' existing files and permission settings. Keep skills focused on their stated workflow. Explain whether a behavior is an instruction, an observable check, or an enforced gate.

The project is MIT-licensed. Submit original work or compatible contributions with required attribution. Do not copy Pilot Shell's proprietary source, skill text, documentation or visual assets.

Pull requests should explain the user-visible change and relevant validation. New adapters, lifecycle hooks and process launchers should include failure-path tests, including cancellation and Windows argument handling where applicable.
