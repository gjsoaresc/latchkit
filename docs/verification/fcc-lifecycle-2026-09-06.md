# FCC lifecycle verification — 2026-09-06

Environment: Windows x64, OS build `10.0.26200`, Node `v26.8.1`, Python `3.14.7`, uv `0.12.10`. This is observed Windows evidence, not a Node 22, Linux, macOS, release-bundle or provider-inference qualification.

The audited pin is FCC `5.22.8`, source commit `c9b75088b09cbd3251d1e828b710cfdcd1ff3c5a`, ZIP SHA-256 `7de379974935a29a59419b96665464205ea847f010cbb5684d098edf139686df`. Source extraction validated 679 regular-file members. The installed dependency set used `uv sync --frozen --no-dev --no-editable --no-config --link-mode copy --no-managed-python --no-python-downloads --python <explicit-python>` in the permanent runtime directory.

The original draft `c1989204` was reproduced in a disposable fixture: setting `runtimeDirectory` to `../outside` caused removal to delete a fixture-owned sentinel outside the tool root. The repaired regression rejects that state and preserves the sentinel. No user file or provider process was used for this reproduction.

An initial AppData installation revealed a real Admin failure: `model_combobox.js` and two chat assets returned 404. Their installed bytes matched the pinned archive. Windows package virtualization lengthened the canonical path; Python's resolved asset directory lost the extended-path prefix before longer filenames were appended. The default now uses the canonical home-local `.local/share/latchkit-tools/fcc` location, rejects root redirection, verifies asset resolution before activation, and checks all six Admin asset URLs during readiness. The earlier installation was stopped through its owned controller and deregistered; all runtime and profile files were retained. No vendor payload was modified.

Observed real-package operations:

- Scratch installation, authenticated readiness, running inspection and owned shutdown passed without a provider key.
- Installation directly into the home-local permanent directory passed. The resulting FCC process was started and left running for the authorized parent task.
- All six Admin assets returned nonempty HTTP 200 responses.
- Installed upstream settings proved saved-token precedence, loopback bind, proxy authentication, messaging disabled, empty fallback and per-Claude-model overrides, disabled automatic browser opening, and child-only home selection.
- The invocation bridge proved ownership and authenticated readiness, supplied child-only Claude connection credentials, removed conflicting inherited Anthropic keys, preserved unrelated environment state, and added loopback proxy bypass. Its test callback did not run Claude or inference.

Commands run from the FCC worktree:

```powershell
npm ci
npm run format -- --log-level warn
npm run check
node --test test/fcc.test.js
node --test test/review-orchestration.test.js
$env:FCC_TEST_ARCHIVE = '.latchkit/fcc-c9b75088.zip'
$env:FCC_TEST_ROOT = 'C:/Users/gjsoa/.local/share/latchkit-tools/fcc'
$env:FCC_TEST_LIVE = '1'
npm test
```

Final checks passed. The full suite ran 243 tests: 240 passed, zero failed, and three symlink tests were skipped because this Windows session lacks the required symlink capability. All four opt-in real FCC tests ran and passed. An earlier full run hit an unrelated `EBUSY` while deleting a review-test temporary directory; that four-test file and the subsequent full run both passed. The focused FCC suite passed 13 behavioral tests, including malformed archives and state, forged live PID records, edited runtime preservation, failed installation/recovery, process startup failures, occupied ports, missing Admin assets, rejected unauthenticated proxies, aborted activation, owner crash, and total HTTP/subprocess deadlines.

Limits: no NIM key entry, Claude inference, paid provider call or end-to-end agent task was performed by this verification. Attachment, pin upgrades, recursive cleanup, draft-v1 migration and non-Windows qualification remain unsupported. Removal retains runtime, profile and cache trees. Stale operation locks, edited managed records and live unverified controller PIDs require manual inspection. The controller uses an owned child handle and owner-pipe shutdown rather than treating a persisted PID as termination authority.
