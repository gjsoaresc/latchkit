# BAML setup

Latchkit uses BAML for deterministic workflow policy, phase prompts, and typed
next-action selection. Provider CLIs still own authentication, model
execution, and permission boundaries. The BAML layer does not require model
credentials and does not add a direct model API integration.

## Pinned toolchain

The repository pins both the compiler and TypeScript runtime to `0.17.0`:

- `.baml-version` contains the compiler version.
- `package.json` pins `@boundaryml/baml-bridge` to the same exact version.
- `scripts/baml.js` checks the compiler version, exports `BAML_VERSION`, and
  runs the compiler with a 120-second timeout.

The installed 0.2.4 wrapper does not implement `baml toolchain pin`. The
repository pin is therefore enforced by `.baml-version` and `scripts/baml.js`;
do not rely on that unavailable command.

On Windows, install the official toolchain and the agent skill with:

```powershell
./scripts/setup-baml.ps1
```

The script installs exactly `0.17.0` with the user PATH entry enabled, runs
`baml agent install`, and executes the credential-free `baml run main` smoke.
On macOS or Linux, use:

```sh
sh scripts/setup-baml.sh
```

The POSIX script performs the same pinned installation and smoke. The scripts
install into the user BAML directory and do not write system-wide settings.

## Editing and generation

Read the installed `baml-core` skill before editing `.baml` files. From the
repository root, inspect the installed generator and TypeScript target when
needed:

```sh
baml describe typescript
baml describe generator
```

The project generator is configured in `baml.toml` for `typescript/node`. The
initial bridge setup, when reproducing the project from a fresh BAML workspace,
is:

```sh
baml init
baml generate add typescript/node
```

Run generation through the repository wrapper so the exact compiler/runtime
pair is checked:

```sh
npm run baml:check
npm run baml:test
npm run baml:generate
npm run baml:check-generated
```

The checked-in SDK under `src/baml_sdk/` is generated output. Its functions
are asynchronous and the workflow calls are pure and credential-free for
policy decisions. `baml:check-generated` regenerates into the working tree and
fails when the checked-in output changes, which keeps source and SDK drift
visible in CI.

## Workflow boundary

`baml_src/workflow.baml` defines `WorkflowSnapshot`, `WorkflowAction`, and
`WorkflowOutcome`, together with policy and phase prompts for:

```text
requirements → plan approval → implementation → verification
→ independent review → handoff
```

The TypeScript workflow controller validates generated actions before invoking
existing services. Approval is bound to the requirements digest, exact plan
digest, acceptance-check digest, authorization scope, policy version, and
prompt version. An implementation has three persisted repair attempts. Provider
authentication failures, malformed output, missing capabilities, unresolved
requirements, and ambiguous interrupted actions pause the workflow instead of
silently retrying or resetting its budget.

An interrupted action requires phase-specific evidence. A result may be marked
observed only with matching durable task evidence; otherwise the operator must
abandon the action or explicitly authorize a retry. A provider exit status by
itself is not completion evidence.
