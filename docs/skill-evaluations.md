# Skill evaluations

`npm run evaluate:skills` runs the offline fixture harness and prints a versioned JSON result. It creates a fresh temporary copy of each small original fixture, checks files, execution records, task evidence, and prohibited side effects, then removes that copy. The default executor is explicitly a harness fixture; it is not an agent run and does not measure provider quality.

Use `--format markdown` for a concise human-readable report and `--output <file>` to retain either form. Results include Node/platform versions, timeout and run limits, comparison mode, counts, and redacted artifacts. Do not treat a provider's prose such as “all tests passed” as evidence: scenarios requiring execution or task evidence fail when those records are absent or contradictory.

The scenario specification is version 1 (`schemas/skill-evaluation-v1.schema.json`). Visible task instructions are separate from expectations so the grader can assess outcomes rather than headings or copied wording. The included fixture set covers feature delivery, defect repair, requirements and review without implementation, handoff/resume, interrupted verification, unsupported capabilities, and conflicting authorization. It deliberately includes prose-only scenarios, for which a meaningful response rather than manufactured source tests is the observable outcome.

Live comparisons are opt-in and bounded:

```sh
node scripts/skill-evaluations.js --real --authorized --provider codex --mode baseline --max-runs 8 --timeout 60000 --output baseline.json
node scripts/skill-evaluations.js --real --authorized --provider codex --mode skills --max-runs 8 --timeout 60000 --output skills.json
```

Use the same provider, model/settings, fixture revision, run limit, and repeated-run plan for both modes. The command uses only the published Claude/Codex adapter invocation plan and the existing host-local authorized runner; it does not install hooks, change approval policy, authenticate, or select a model. `--authorized` is required because a real provider may use credentials and incur cost. Unsupported or unavailable providers are recorded as `skipped`, never as a pass. A process exit is still not acceptance: real runs without required task evidence fail, and the repository does not claim an improvement until a bounded baseline-versus-skill sample is retained.

Interpretation should be predeclared: report all passes, failures, skips, ties, and regressions; record sample count and variability; exclude only runs with a stated environmental cause; and never extrapolate a fixture result into a quality guarantee or leaderboard.
