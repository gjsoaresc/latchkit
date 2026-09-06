# ADR 0003: Foreground local scheduler

Schedules are an optional project-local JSON record under `.latchkit/schedules/`. They run only while `latchkit schedule start` remains in the foreground; Latchkit does not install a Windows Task Scheduler job, launch daemon, cron entry, launchd agent, service, or WSL bridge.

Each schedule stores its IANA timezone, fixed-minute recurrence, next absolute instant, target project, provider, instructions, explicit authorization scope/reference, host-local authorization flag, output and timeout limits, skip-overlap policy, skip-missed-run policy, and bounded redacted run result metadata. The foreground process uses existing provider adapters and the owned process runner. It does not alter provider authentication, sandboxing, or approval policy.

On startup, a formerly running record becomes `interrupted`; past due times move to the next interval without catch-up. Fixed-minute recurrence uses absolute instants, so DST and clock rollback do not create duplicate local-wall-clock runs. A missing explicit host-local authorization produces a persisted `blocked` run and never starts a provider command. Cancellation targets only the foreground scheduler's AbortController/process tree.

Native Windows works from PowerShell with a project path containing spaces and no administrator rights: `latchkit schedule start --project "C:\\work\\my project"`. Linux and macOS use the same foreground CLI behavior. WSL is a separate Linux process and scheduler state; it neither controls nor adopts native Windows runs. These are smoke procedures, not evidence of a provider-authenticated session.
