// Harness benchmark is independent of the Electron app and never reads harness stores.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/mem"
)

const schema = 1

var version = "0.1.0"
var signatures = map[string][]string{
	"pi":          {"pi", "@mariozechner/pi-coding-agent", "pi-harness", "pi-harness.cjs", "pi-harness.js"},
	"opencode":    {"opencode", "opencode2", "opencode-ai"},
	"codex":       {"codex", "@openai/codex"},
	"claude":      {"claude", "@anthropic-ai/claude-code"},
	"cline":       {"cline", "@cline/cli"},
	"antigravity": {"agy", "antigravity"},
	"muse":        {"muse", "muse-code"},
}
var commands = map[string][]string{
	"pi": {"pi"}, "opencode": {"opencode", "opencode2"}, "codex": {"codex"},
	"claude": {"claude"}, "cline": {"cline"}, "antigravity": {"agy"}, "muse": {"muse"},
}

type systemInfo struct {
	OS          string `json:"os"`
	OSVersion   string `json:"os_version"`
	Kernel      string `json:"kernel"`
	Arch        string `json:"arch"`
	CPU         string `json:"cpu"`
	LogicalCPUs int    `json:"logical_cpus"`
	RAM         uint64 `json:"ram_bytes"`
	Hostname    string `json:"hostname"`
}
type harnessInfo struct {
	Version string `json:"version"`
	Source  string `json:"version_source"`
}
type metadata struct {
	Schema          int                    `json:"schema"`
	Collector       string                 `json:"collector_version"`
	RunID           string                 `json:"run_id"`
	Started         time.Time              `json:"started_utc"`
	System          systemInfo             `json:"system"`
	Mode            string                 `json:"mode"`
	Label           string                 `json:"label"`
	Model           string                 `json:"model"`
	Revision        string                 `json:"project_revision"`
	WorkloadHash    string                 `json:"workload_sha256"`
	Workload        string                 `json:"workload_id"`
	Threads         int                    `json:"expected_threads"`
	IntervalSeconds float64                `json:"interval_seconds"`
	Volume          string                 `json:"volume_path"`
	InitialFree     *uint64                `json:"initial_volume_free_bytes"`
	InitialTotal    *uint64                `json:"volume_total_bytes"`
	Harnesses       map[string]harnessInfo `json:"harnesses"`
	Notes           []string               `json:"notes"`
}
type metrics struct {
	Processes      int      `json:"processes"`
	Roots          int      `json:"roots"`
	CPU            *float64 `json:"cpu_percent_one_core"`
	RSS            *float64 `json:"rss_bytes"`
	Read           *float64 `json:"read_bytes_per_second"`
	Write          *float64 `json:"write_bytes_per_second"`
	CPUCoverage    int      `json:"cpu_processes_measured"`
	MemoryCoverage int      `json:"memory_processes_measured"`
	IOCoverage     int      `json:"io_processes_measured"`
}
type processIdentity struct {
	PID     int32  `json:"pid"`
	Created int64  `json:"created_unix_ms"`
	Harness string `json:"harness"`
	Root    bool   `json:"root"`
}
type storageSample struct {
	VolumeFree *uint64       `json:"volume_free_bytes"`
	UsedDelta  *float64      `json:"volume_used_delta_bytes"`
	Growth     *float64      `json:"volume_growth_bytes_per_second"`
	Watches    []watchResult `json:"watches,omitempty"`
}
type event struct {
	Type      string            `json:"type"`
	Time      time.Time         `json:"time_utc"`
	Meta      *metadata         `json:"metadata,omitempty"`
	Harness   string            `json:"harness,omitempty"`
	Metrics   *metrics          `json:"metrics,omitempty"`
	Processes []processIdentity `json:"process_identities,omitempty"`
	Storage   *storageSample    `json:"storage,omitempty"`
	Job       *jobResult        `json:"job,omitempty"`
	Message   string            `json:"message,omitempty"`
	ScanMS    float64           `json:"collection_ms,omitempty"`
}
type stringsFlag []string

func (s *stringsFlag) String() string     { return strings.Join(*s, ",") }
func (s *stringsFlag) Set(v string) error { *s = append(*s, v); return nil }
func pointer(v float64) *float64          { return &v }
func main() {
	if err := run(); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) > 1 && os.Args[1] == "report" {
		return report(os.Args[2:])
	}
	if len(os.Args) > 1 && (os.Args[1] == "version" || os.Args[1] == "--version") {
		fmt.Println(version)
		return nil
	}
	fs := flag.NewFlagSet("harness-benchmark", flag.ContinueOnError)
	output := fs.String("out", "", "New JSONL file; default benchmark-<UTC>-<unique>.jsonl")
	interval := fs.Duration("interval", time.Second, "Resource sampling interval, minimum 250ms")
	duration := fs.Duration("duration", 0, "Stop after this duration; default until Ctrl+C or workload completes")
	volume := fs.String("volume", ".", "Existing path on volume to monitor")
	workloadPath := fs.String("workload", "", "JSON workload file; launches exactly --threads jobs")
	threads := fs.Int("threads", 10, "Expected concurrent agent jobs; passive mode records this as intent only")
	label := fs.String("label", "", "Run label, e.g. oven identity")
	model := fs.String("model", "unknown", "Model and reasoning configuration, for comparison grouping")
	revision := fs.String("revision", "unknown", "Project commit or fixture revision")
	workloadID := fs.String("workload-id", "unspecified", "Stable workload/fixture identity")
	var watches, overrides, pids stringsFlag
	fs.Var(&watches, "watch", "Directory to measure logical storage, repeatable; bounded background scans")
	fs.Var(&overrides, "harness-version", "id=version override for bundled/embedded harnesses, repeatable")
	fs.Var(&pids, "pid", "id=PID explicit root, repeatable; process creation time prevents PID reuse")
	if err := fs.Parse(os.Args[1:]); err != nil {
		return err
	}
	if fs.NArg() != 0 || *interval < 250*time.Millisecond || *duration < 0 || *threads < 1 || *threads > 256 {
		return errors.New("invalid arguments: interval >=250ms, threads 1..256, duration >=0; see -h")
	}
	absVolume, err := filepath.Abs(*volume)
	if err != nil {
		return err
	}
	if _, err = os.Stat(absVolume); err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, terminationSignal())
	defer stop()
	var work *workload
	if *workloadPath != "" {
		work, err = loadWorkload(*workloadPath, *threads)
		if err != nil {
			return err
		}
	}
	roots, err := explicitRoots(ctx, pids)
	if err != nil {
		return err
	}
	for _, path := range watches {
		info, e := os.Stat(path)
		if e != nil {
			return e
		}
		if !info.IsDir() {
			return fmt.Errorf("watch is not a directory: %s", path)
		}
	}
	meta := metadata{Schema: schema, Collector: version, RunID: fmt.Sprintf("%d-%d", time.Now().UnixNano(), os.Getpid()), Started: time.Now().UTC(), Mode: "observe", Label: *label, Model: *model, Revision: *revision, Workload: *workloadID, Threads: *threads, IntervalSeconds: interval.Seconds(), Volume: absVolume, Harnesses: map[string]harnessInfo{}}
	meta.System = readSystem(ctx)
	meta.Notes = append(meta.Notes, "Process discovery runs every 5 seconds, plus workload step starts, and can miss short-lived children. RSS sums may double-count shared pages. CPU 100 means one fully occupied logical core.", "Read/write rates are physical disk-byte counters on Linux/macOS and process I/O transfer counters on Windows, which can include cached/device I/O. Null means unavailable or no complete delta. Volume growth includes all activity on that filesystem.", "Observe mode cannot infer actual conversation count, task success, or semantic agent errors. Workload error rate is failed jobs / completed jobs, excluding cancelled jobs.", "Percentiles are approximate log-histogram quantiles of observed samples, not independent-run confidence estimates.")
	// Never execute version probes from an untrusted discovered command line.
	for id, candidates := range commands {
		info := harnessInfo{Version: "unknown", Source: "PATH version unavailable; supply --harness-version for embedded runtimes"}
		for _, name := range candidates {
			if v, e := probeVersion(ctx, name); e == nil {
				info = harnessInfo{Version: v, Source: "PATH CLI --version; not proof of detected process version"}
				break
			}
		}
		meta.Harnesses[id] = info
	}
	for _, v := range overrides {
		id, value, ok := strings.Cut(v, "=")
		if !ok || len(value) == 0 || signatures[id] == nil {
			return fmt.Errorf("invalid harness-version: %s", v)
		}
		meta.Harnesses[id] = harnessInfo{Version: value, Source: "operator override"}
	}
	if work != nil {
		meta.Mode = "workload"
		meta.WorkloadHash = work.fingerprint
	}
	meta.Started = time.Now().UTC()
	if d, e := disk.UsageWithContext(ctx, absVolume); e == nil {
		meta.InitialFree = &d.Free
		meta.InitialTotal = &d.Total
	} else {
		meta.Notes = append(meta.Notes, "volume baseline unavailable: "+e.Error())
	}
	if *duration > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, *duration)
		defer cancel()
	}
	if *output == "" {
		*output = "benchmark-" + meta.Started.Format("20060102T150405Z") + "-" + meta.RunID + ".jsonl"
	}
	f, err := os.OpenFile(*output, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	completedJobs, failedJobs := 0, 0
	emit := func(e event) error {
		if e.Time.IsZero() {
			e.Time = time.Now().UTC()
		}
		if err := enc.Encode(e); err != nil {
			return err
		}
		if e.Type == "job_completed" && e.Job != nil {
			completedJobs++
			if e.Job.Outcome != "success" {
				failedJobs++
			}
		}
		return nil
	}
	if err = emit(event{Type: "start", Meta: &meta}); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Recording", *output, ". Stop with Ctrl+C.")
	changes := make(chan event, 512)
	var workloadDone <-chan struct{}
	if work != nil {
		workloadDone = launchWorkload(ctx, *work, changes)
	}
	// On every error path cancel owned jobs and drain events so a full queue
	// cannot deadlock worker shutdown.
	defer func() {
		stop()
		if workloadDone != nil {
			for {
				select {
				case <-workloadDone:
					return
				case <-changes:
				}
			}
		}
	}()
	scanner := newCollector(roots)
	scanner.onlyExplicit = work != nil
	storage := newStorage(ctx, watches, absVolume, meta.InitialFree)
	ticker := time.NewTicker(*interval)
	defer ticker.Stop()
	sample := func() error {
		start := time.Now()
		groups, identities, diagnostics := scanner.sample(ctx)
		for _, d := range diagnostics {
			if e := emit(event{Type: "diagnostic", Message: d}); e != nil {
				return e
			}
		}
		for id, m := range groups {
			if e := emit(event{Type: "sample", Harness: id, Metrics: &m, Processes: identities[id]}); e != nil {
				return e
			}
		}
		s := storage.sample(ctx)
		return emit(event{Type: "storage", Storage: &s, ScanMS: float64(time.Since(start).Microseconds()) / 1000})
	}
	if err = sample(); err != nil {
		stop()
		return err
	}
	reason := "workload_complete"
	running := true
	for running {
		select {
		case <-ctx.Done():
			reason = ctx.Err().Error()
			running = false
		case <-workloadDone:
			running = false
		case e := <-changes:
			if e.Type == "job_started" {
				scanner.track(e.Job)
			}
			if err = emit(e); err != nil {
				stop()
				return err
			}
		case <-ticker.C:
			if err = sample(); err != nil {
				stop()
				return err
			}
		}
	}
	stop()
	if workloadDone != nil {
		waiting := true
		for waiting {
			select {
			case <-workloadDone:
				waiting = false
			case e := <-changes:
				if err = emit(e); err != nil {
					return err
				}
			}
		}
	}
	for len(changes) > 0 {
		if err = emit(<-changes); err != nil {
			return err
		}
	}
	if err = emit(event{Type: "end", Message: reason}); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if work != nil && (failedJobs > 0 || completedJobs != len(work.Jobs)) {
		return fmt.Errorf("workload finished: %d/%d jobs recorded, %d failed or cancelled; see JSONL", completedJobs, len(work.Jobs), failedJobs)
	}
	return nil
}
func readSystem(ctx context.Context) systemInfo {
	s := systemInfo{OS: runtime.GOOS, Arch: runtime.GOARCH, LogicalCPUs: runtime.NumCPU(), OSVersion: "unknown", Kernel: "unknown", CPU: "unknown"}
	if h, e := host.InfoWithContext(ctx); e == nil {
		s.OSVersion = h.Platform + " " + h.PlatformVersion
		s.Kernel = h.KernelVersion
		s.Hostname = h.Hostname
	}
	if m, e := mem.VirtualMemoryWithContext(ctx); e == nil {
		s.RAM = m.Total
	}
	if c, e := cpu.InfoWithContext(ctx); e == nil && len(c) > 0 {
		s.CPU = c[0].ModelName
	}
	return s
}

// A bounded output sink also bounds badly behaved --version commands.
type limitedOutput struct{ data []byte }

func (b *limitedOutput) Write(p []byte) (int, error) {
	n := len(p)
	left := 4096 - len(b.data)
	if left > 0 {
		if len(p) > left {
			p = p[:left]
		}
		b.data = append(b.data, p...)
	}
	return n, nil
}
func decodeFile(path string, target *workload) error {
	f, e := os.Open(path)
	if e != nil {
		return e
	}
	defer f.Close()
	info, e := f.Stat()
	if e != nil {
		return e
	}
	if info.Size() > 1024*1024 {
		return errors.New("workload exceeds 1 MiB")
	}
	dec := json.NewDecoder(io.LimitReader(f, 1024*1024))
	dec.DisallowUnknownFields()
	if e = dec.Decode(target); e != nil {
		return e
	}
	var extra json.RawMessage
	if e = dec.Decode(&extra); e != io.EOF {
		return errors.New("workload must contain one JSON object under 1 MiB")
	}
	return nil
}
