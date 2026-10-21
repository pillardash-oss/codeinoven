# Harness resource benchmark

The standalone Go module records Pi, OpenCode, Codex, Claude Code, Cline, Antigravity and Muse Code. These identities follow `src/main/agents/harness-registry.ts`, including `opencode2` and Antigravity's `agy` executable. It runs outside Electron and does not read conversation databases or harness credential stores. Source: `tools/harness-benchmark/main.go`, `tools/harness-benchmark/collector.go`.

## Build and start

Install Go 1.26 or newer and Bun on the build machine. From the repository root:

```sh
bun tools/harness-benchmark/build.ts
```

This builds eight separate, self-contained binaries into `.cio/work/harness-benchmark/bin/`. Copy the appropriate binary onto the measurement machine. Bun and Go are build tools only; the distributed collector needs neither. Each OS and architecture needs its own binary. Targets are macOS Apple Silicon; Linux x86 32-bit, AMD64, ARMv7 and ARM64; Windows x86 32-bit, AMD64 and ARM64. The build helper limits compilation to two concurrent builds with two compiler workers each. Source: `tools/harness-benchmark/build.ts`, `tools/harness-benchmark/go.mod`. Go has no current Windows ARM32 target, and x86 and x64 mean distinct targets rather than a universal executable. Reference: [Go target environment](https://go.dev/doc/install/source#environment).

Run the copied binary with no arguments to start passive collection in the current directory. It creates a uniquely named JSONL file and stops on Ctrl+C. Windows uses `harness-benchmark.exe` in the commands below. Source: `tools/harness-benchmark/main.go`.

```sh
./harness-benchmark
```

For a labeled, finite measurement:

```sh
./harness-benchmark -duration 30m -interval 1s \
  -out oven-a-20261021.jsonl -label oven-a \
  -volume . -watch ./benchmark-projects \
  -model model-name-reasoning-high -revision project-commit \
  -workload-id agent-build-v1 -harness-version codex=installed-version
```

Output files must be new. Existing files are never overwritten. The default interval is one second, with a minimum of 250ms. Without `-duration`, observation continues until interrupted. A duration starts after version discovery. Source: `tools/harness-benchmark/main.go`.

## Ten concurrent development jobs

Passive mode watches work already running. Its `-threads 10` value records intended concurrency, not a count of actual conversations. A CLI process can host several conversations, and a conversation can start several processes. For measurable job latency and error rate, supply a controlled workload. Source: `tools/harness-benchmark/main.go`, `tools/harness-benchmark/workload.go`.

`tools/harness-benchmark/example.workload.json` is a ten-job Codex template. Prepare ten independent, disposable copies of the same baseline project in `benchmark-projects/01` through `benchmark-projects/10`, relative to the directory where you invoke the collector. Each copy needs an identical `BENCHMARK_TASK.md` containing a fixed implementation task, acceptance criteria, test commands and build commands. The template invokes `codex exec` for the task, followed by independent `bun test` and `bun run build` validation. Replace those verification commands with the target project's actual commands, and pin the model and reasoning options in the harness invocation. The template is an explicit workload, not something the collector runs by default. Source: `tools/harness-benchmark/example.workload.json`, `tools/harness-benchmark/workload.go`.

```sh
./harness-benchmark -workload example.workload.json -threads 10 \
  -out oven-a-codex-day1.jsonl -label oven-a \
  -model fixed-model-and-reasoning -revision fixture-commit \
  -workload-id agent-build-v1 -harness-version codex=installed-version \
  -watch ./benchmark-projects
```

Every job has `harness`, `directory`, and an ordered `steps` array of `command` and `args`. The runner releases all jobs together, executes each job's steps sequentially, stops a job at its first failing step, and logs its total wall time and outcome. It requires exactly the requested job count and separate existing directories without ancestor/descendant overlap, resolves symlinks, and rejects unknown fields or configurations over 1 MiB. It does not create project copies or choose agent permissions. Configure and authenticate each CLI before benchmarking. Source: `tools/harness-benchmark/workload.go`, `tools/harness-benchmark/main.go`.

For other harnesses, change the harness ID and agent invocation to the installed CLI's noninteractive command, keeping the task and verification steps identical. Accepted IDs are `pi`, `opencode`, `codex`, `claude`, `cline`, `antigravity`, and `muse`. The collector makes no assumption that their prompt flags or permission settings are interchangeable. Workload mode attributes only its own launched process trees, plus explicitly supplied `-pid` roots, so unrelated live sessions are excluded. Commands inherit the invocation environment; stdout and stderr are discarded to avoid growing agent-output logs. Failure records retain the exit code, failed step and process error. Source: `tools/harness-benchmark/main.go`, `tools/harness-benchmark/workload.go`, `tools/harness-benchmark/collector.go`.

Owned workload processes are cleaned up when each command step ends, the collector is cancelled or a job times out. macOS/Linux use process groups; Windows uses a job object with kill-on-close. Windows enrollment happens immediately after process creation, so a child that escapes before enrollment may evade that job object. Detached children outside the tracked process groups are also outside attribution and cleanup. Passive observation never terminates a detected harness. Failed or cancelled workloads return a nonzero collector exit status after writing their final records. Source: `tools/harness-benchmark/process_unix.go`, `tools/harness-benchmark/process_windows.go`, `tools/harness-benchmark/workload.go`, `tools/harness-benchmark/main.go`.

## Measurements and limits

| Measurement           | Interpretation                                                                                                                                                                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CPU                   | Process-tree CPU time divided by elapsed time. 100% is one logical core, so ten busy workers can exceed 100%.                                                                                                                                                                                        |
| RAM                   | Sum of resident bytes across a harness's processes and discovered descendants. Shared pages can be counted more than once.                                                                                                                                                                           |
| Read/write throughput | Counter deltas divided by actual elapsed seconds. Linux/macOS use disk-byte counters. Windows uses process I/O transfer counters, which can include cached or device I/O. These are observed workload rates, not maximum drive speed or per-operation latency.                                       |
| Volume storage        | Initial free and total bytes, current free bytes, change in used bytes and growth bytes/second. Other programs, filesystem behavior and the benchmark log itself also affect this volume.                                                                                                            |
| Directory storage     | Optional logical file bytes and growth for each `-watch` path. Symlinks are skipped; hard links can be counted more than once. This is not allocated disk space.                                                                                                                                     |
| Job speed             | Total wall time across all configured steps, plus a separate successful-job latency distribution.                                                                                                                                                                                                    |
| Error rate            | Failed jobs, launch errors and job timeouts divided by completed jobs. User/run cancellations are counted separately. This does not infer semantic errors, retries, individual failed agent tool calls or token-generation rate. Independent verification steps make acceptance failures observable. |

Metric definitions and implementation: `tools/harness-benchmark/collector.go`, `tools/harness-benchmark/storage.go`, `tools/harness-benchmark/workload.go`, `tools/harness-benchmark/report.go`. OS counter support follows [gopsutil](https://pkg.go.dev/github.com/shirou/gopsutil/v4).

Null means unavailable or insufficient measurement history, never zero. A process-tree total is null if any included process lacks that metric, with per-metric coverage counts in the same record. The first CPU/I/O sample establishes a baseline. Discovery runs every five seconds and is refreshed when workload steps start, so short-lived build/test children can be missed. PID and process creation time together guard against PID reuse. Four workers collect process data under a four-second scan context; slow OS calls can still exceed a context deadline. The log reports collection duration so overhead is visible. Source: `tools/harness-benchmark/collector.go`, `tools/harness-benchmark/main.go`.

Directory scans run separately every 30 seconds, yield after each batch of 256 entries, and stop at 200,000 entries or a two-second context deadline. Incomplete scans record an error and null bytes. Filesystem calls already blocked in the OS cannot be interrupted by that deadline. No directory scanning runs without `-watch`. Source: `tools/harness-benchmark/storage.go`.

Automatic detection examines executable names and runtime script/package positions, not arbitrary prompt substrings. It includes test/build descendants, avoids assigning one process twice and excludes the collector's own descendants unless they are controlled workload roots. Embedded runtimes and custom launchers may need an explicit root:

```sh
./harness-benchmark -pid pi=12345 -harness-version pi=bundled-version
```

CLI versions are queried from PATH using bounded `--version` calls. A PATH version is not proof that an already running process uses that binary. Use `-harness-version id=version` to record the actual deployed version, especially for embedded Pi and mixed installations. Unknown versions are recorded explicitly. The collector version, schema, UTC date/time, run ID, OS/version/kernel, architecture, CPU, logical CPU count, device RAM, hostname, volume baseline, intended concurrency, project revision, model, workload label and workload SHA-256 are recorded in the start record. Metadata probes that fail retain unknown or zero values; zero RAM means unknown. Source: `tools/harness-benchmark/main.go`, `tools/harness-benchmark/collector.go`, `tools/harness-benchmark/workload.go`.

## Analyze runs across days

```sh
./harness-benchmark report -out comparison.json \
  oven-a-codex-day1.jsonl oven-a-codex-day2.jsonl
```

The report streams JSONL and uses bounded logarithmic histograms for P50, P90, P95 and P99, with an approximation error of at most 1% of `1 + abs(value)` over the metric range encountered here. It reports exact sample count, min, max and arithmetic mean as well. Longer runs contribute more samples and carry more weight. CPU, RAM and I/O percentiles describe active observed resource samples; job-duration percentiles describe jobs. They are different populations. Source: `tools/harness-benchmark/report.go`.

Groups keep machine identity/specifications, OS version, architecture, collector version, harness/version/source, model, project revision, workload ID/hash, label, expected concurrency, interval, and observe/workload modes separate. Filesystem measurements appear under `__storage__`, since they cannot be assigned to a harness from free-space counters alone. Storage groups additionally keep the harness version inventory, volume path and volume size separate. Supply accurate version/model/revision labels; unknown metadata cannot establish a valid controlled comparison. Repeated input run IDs are rejected. Truncated final records and missing end records are flagged, while malformed complete records fail analysis. Each input record is limited to 4 MiB. Source: `tools/harness-benchmark/report.go`.

Run the same harness/version against the same task, baseline, model, permission policy and ten-job concurrency on each day. Record warm versus cold cache conditions in the label, keep competing machine activity comparable, and retain raw JSONL files and workload configurations. Ten latency observations do not establish a stable P99; repeat the controlled runs and inspect the reported sample counts before drawing conclusions. The software records observations, not a claim that a harness is faster. No paid, ten-agent benchmark is run as part of building the tool. Sources: `tools/harness-benchmark/report.go`, `tools/harness-benchmark/example.workload.json`.
