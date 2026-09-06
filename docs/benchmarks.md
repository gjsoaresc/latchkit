# Development performance baseline

This page records reproducible development measurements before choosing a Go or
Rust worker. It is not standalone-artifact qualification, a hardware target, or
a native-worker recommendation.

The Windows baseline was captured on 2026-09-06 with Node 24.20.0 from the
private runtime candidate. It ran the emitted `dist/` tree on native Windows.
The full machine and sample data are retained in
[`benchmarks-windows.json`](../.github/release-evidence/rc2/benchmarks-windows.json).

| Operation                    |                    Dataset | Runs |      Median |         P95 | Observed post-operation RSS |
| ---------------------------- | -------------------------: | ---: | ----------: | ----------: | --------------------------: |
| `latchkit --version` startup |            Fresh CLI child |    7 |    29.30 ms |    30.35 ms |                    50.42 MB |
| Initial pack sync            | 1,000 portable skill files |    3 | 5,272.55 ms | 5,351.45 ms |                   141.64 MB |
| Memory search                |   10,000 validated records |    3 |    32.36 ms |    35.02 ms |                   200.63 MB |
| Isolated-worktree diff       |  300 changed tracked files |    3 |   518.20 ms |   583.62 ms |                   175.17 MB |

The script creates fresh temporary projects for each workload. It validates the
synthetic project-memory state before persisting it, creates an actual owned
Git worktree for diff processing, and removes every fixture afterward. Setup
time is outside the measured operation: the pack sample measures `syncProject`,
the memory sample measures `searchProjectMemory`, and the diff sample measures
`inspectDiff` after its repository and worktree exist.

RSS is sampled after each operation. The accompanying JSON also includes
Node's `process.resourceUsage().maxRSS`, converted from KiB; on Windows that
value is process cumulative rather than an allocator trace for one operation.
The measurements therefore identify where to investigate, but do not establish
per-operation retained memory or a final-distribution memory budget.

Run the baseline with the development command `node scripts/benchmarks.js`
using the intended Node runtime. The proposed package command is
`benchmark:baseline`; it should be added with the release/build command work
so CI and release scripts own its invocation policy.

These synthetic local results show that initial large-pack synchronization is
the slowest measured workload. They do not, by themselves, select Go or Rust,
and no native worker is introduced from this baseline.
