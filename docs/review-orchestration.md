# Independent review orchestration

`src/reviews/orchestrator.js` runs explicitly authorized, observation-only Claude or Codex reviews. Each assignment receives a separate durable child task and task-owned worktree when Git is available. The parent checkout is never used as a write target, and dirty source state is represented by the captured revision and dirty fingerprint taken before reviewers start.

Review records live in `.latchkit/reviews/state-v1.json`. They include reviewer identity, provider, source snapshot, worktree/task ownership, bounded process state, findings, and limitations. Results are strict JSON and findings are deduplicated by path, title, and detail. Provider output and errors are redacted before persistence.

The controller requires `host-local-authorized`, caps reviewer count and concurrency, allows one bounded invocation per reviewer, enforces a wall-clock timeout through the existing process runner, rejects nested orchestration, and propagates cancellation to children owned by the current process. Unknown provider usage remains explicitly unknown; it is never estimated or reported as zero.

An independent review is evidence about a snapshot, not user approval, task completion, or merge permission. Failed, unavailable, timed-out, cancelled, and missing reviews remain visible and cannot satisfy a required acceptance criterion. The controller does not apply patches, merge branches, or publish comments.

CLI example:

```sh
latchkit review run --project path/to/project --task task_<uuid> --provider codex --host-local-authorized
```

The local API accepts `POST /api/reviews` with the orchestrator input and `POST /api/reviews/cancel` with `{ "reviewId": "..." }`.
