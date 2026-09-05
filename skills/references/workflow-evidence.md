# Workflow evidence

Use this compact note shape when a task-state service is unavailable or when a human-readable companion note is useful:

```markdown
# <task title>

## Scope

- Request and authorization reference:
- Included paths or criteria:
- Non-goals and limits:

## Evidence

| Criterion | Command or observation | Result                                  | Artifact        |
| --------- | ---------------------- | --------------------------------------- | --------------- |
| ...       | ...                    | passed / failed / skipped / unsupported | path or summary |

## Gaps and next action

- Unresolved or untested:
- Next concrete action:
```

Use repository-relative paths and redact credentials, tokens, private transcripts, and full environment dumps. A command result is evidence only for the boundary and environment where it actually ran.
