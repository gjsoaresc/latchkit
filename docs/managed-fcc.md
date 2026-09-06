# Managed FCC lifecycle

FCC is an optional tool, independent from the coding-provider adapters. The current implementation installs one audited source pin and manages its local process. It does not change provider permissions or import provider credentials.

```powershell
latchkit tool fcc preview --archive <pinned.zip> --python <absolute-python.exe> --uv <absolute-uv.exe>
latchkit tool fcc install --archive <pinned.zip> --python <absolute-python.exe> --uv <absolute-uv.exe>
latchkit tool fcc start
latchkit tool fcc inspect
latchkit tool fcc stop
latchkit tool fcc recover --archive <pinned.zip>
latchkit tool fcc remove
```

All commands also accept `--tool-root <path>`. The default is `%USERPROFILE%/.local/share/latchkit-tools/fcc`. The root must match its canonical filesystem location before materialization. This avoids Windows packaged-app redirection and the longer paths it can produce. The implementation targets Windows first; other operating systems are unqualified. Python executables are explicit, and no registry, global package, PATH, shell-profile, credential or provider-policy changes occur.

Managed metadata uses [schema v2](../schemas/managed-tool-fcc-v2.schema.json). State binds the exact pin to an installation UUID and its derived runtime basename. The ownership manifest hashes managed records; edited records block mutation. A complete runtime hash receipt blocks launches after file additions, removals or edits. Generated Python bytecode is disabled during launcher probes and server execution.

The lifecycle has three installation stages: recorded intent, source materialization and dependency build, then activation. Source files use registered-resource transactions. uv's private venv and cache writes are external build materialization covered by the lifecycle record. They are not individually transactional. Interruption may leave files behind, but cannot activate an incomplete runtime. Recovery preserves those trees and permits installation into a new unique directory. It never relocates a venv or recursively deletes a tree.

The retained profile is `<tool-root>/profile/.fcc`, supplied through child-only HOME and USERPROFILE variables. FCC owns this configuration after initialization; its Admin UI may save the NIM key and model. The generated inference proxy token is local to that profile. Upstream's managed token takes precedence over an environment token, so startup reads the effective token privately and uses it only for local readiness. Inspection, logs returned by Latchkit, and project support bundles contain no token. Existing user `~/.fcc` is preserved.

The controller receives its plan through a private parent IPC channel, not command-line credentials. It starts a Python adapter around FCC's `ServerSupervisor`, retaining its own child handle. The adapter watches stdin and requests upstream shutdown on stop or owner EOF. The controller binds a random loopback control port. Status proves possession of a separate random control key through HMAC over a fresh challenge and installation identity. Stop first verifies that proof, then authenticates its shutdown request. The controller can stop only its own child; request bodies cannot select a process, path or command. A graceful shutdown timeout may terminate that retained child handle. No process is killed based on an active record's PID.

Installation verifies that the pinned package can resolve each Admin asset. Readiness verifies health, rejected unauthenticated and accepted authenticated `HEAD /v1/messages` requests, and successful nonempty responses for all six pinned Admin asset URLs. It never posts inference. The parent persists an activation record before confirming the controller; loss of parent IPC before confirmation aborts startup. A running controller can outlive its launcher. Its compiled Node controller file should therefore remain available for future starts; no OS service or boot-time autostart is installed.

The internal `runWithFccClaudeEnvironment(options, invoke)` helper proves controller ownership and authenticated proxy readiness before returning `{ environment, environmentMode: 'replace' }` to its callback. The callback must pass `environment` as the bounded runner's `plan.environment` and pass `environmentMode` as its execution option. Replacement is required: merging a filtered map into the parent's environment would restore removed API keys and custom headers. The runner validates this code-only policy and checks MCP requirements against the exact environment it will spawn. Ordinary launches retain their existing inheritance behavior.

The selected environment supplies child-only `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`, clears conflicting inherited Anthropic connection variables, and preserves other environment variables. It changes no provider files, CLI arguments, permissions or approvals. The callback must never serialize the selection or its environment. This helper is deliberately absent from JSON API and CLI output surfaces; no token-printing operation is provided. It does not start an inference call by itself.

Known limits: attachment, upgrades, rollback between pins, non-Windows qualification and provider inference verification are unsupported. Removal deregisters metadata and retains runtime, profile and cache files. A stale operation lock, metadata conflict, or a live PID without controller ownership proof requires manual inspection; the implementation refuses to infer ownership. Draft v1 records are refused and preserved, not silently migrated.

Upstream contracts were inspected in the pinned MIT source: `config/settings.py`, `config/loader.py`, `config/paths.py`, `api/routes.py`, `api/dependencies.py`, and `cli/commands.py`. The adapter code and lifecycle implementation are original Latchkit code. The installed source archive retains upstream licensing.
