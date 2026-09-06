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
| `latchkit --version` startup |            Fresh CLI child |    7 |    31.64 ms |    37.72 ms |                    50.63 MB |
| Initial pack sync            | 1,000 portable skill files |    3 | 2,622.58 ms | 2,723.23 ms |                   150.01 MB |
| Memory search                |   10,000 validated records |    3 |    29.08 ms |    33.21 ms |                   195.87 MB |
| Isolated-worktree diff       |  300 changed tracked files |    3 |   849.65 ms | 1,297.02 ms |                   198.83 MB |

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

Run the baseline with `npm run benchmark:baseline` using the intended Node
runtime. The package command keeps CI and release scripts in control of the
invocation policy.

These synthetic local results show that initial large-pack synchronization is
the slowest measured workload. They do not, by themselves, select Go or Rust,
and no native worker is introduced from this baseline.

## Sync execution result

On the same native Windows worktree and private Node 24.20.0 runtime, the
pre-change normal sync run had a 5,209.85 ms median and 7,516.48 ms P95 for
the 1,000-file fixture. The current normal run is 2,622.58 ms median and
2,723.23 ms P95: a 49.7% median reduction. Peak post-operation RSS increased
from 141.88 MB to 150.01 MB in this process-level measurement.

The diagnostic run, `node scripts/benchmarks.js --profile-sync`, keeps ordered
resource boundaries so it can report transaction timing. Before batching it
recorded 1,000 transaction resources, with a 840.23 ms median to durable
journal publication and a 3,676.72 ms median from the first through last
resource boundary. Those calls identify per-resource transaction work as the
dominant cost; diagnostic mode is intentionally not the throughput result
above.

The runtime now processes independent resource snapshots and writes in batches
of 16 only when no fault boundary was requested. Every resource still verifies
its pre-state, writes atomically with file fsync, remains represented in the
durable journal, and is eligible for the existing recovery flow. A supplied
fault boundary retains ordered per-resource writes for deterministic crash
tests and tracing.

This result does not support a Go or Rust migration. The remaining bottleneck
is durable filesystem work under Node, not demonstrated TypeScript CPU cost.
Reconsider a native worker only after a representative end-user workload shows
an unmet latency or memory target and an implementation retains the same
registered-resource ownership, symlink/junction refusal, fsync, transaction,
and recovery evidence under the Windows release runtime. The concurrent batch
also raises observed process RSS modestly and should be remeasured on a release
bundle and contended disks before increasing its size.

The measurements were captured while separate local installer, UI, and FCC
work was active in other worktrees. They do not include a CPU, disk, or
antivirus contention trace, so repeat the benchmark from the exact release
bundle on a quiet and a deliberately contended Windows host before using it as
release qualification evidence.
