package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"sort"
	"strings"
	"time"
)

// Sparse, bounded logarithmic histogram. Error <= 1% of (1+abs(value)).
// Negative growth is retained. At most 8193 bins per metric.
type histogram struct {
	bins  map[int]uint64
	Count uint64  `json:"count"`
	Sum   float64 `json:"-"`
	Min   float64 `json:"min"`
	Max   float64 `json:"max"`
}

func (h *histogram) add(v float64) {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return
	}
	if h.bins == nil {
		h.bins = map[int]uint64{}
		h.Min = v
		h.Max = v
	}
	k := int(math.Ceil(math.Log1p(math.Abs(v)) / math.Log(1.01)))
	if k > 4096 {
		k = 4096
	}
	if v < 0 {
		k = -k
	}
	h.bins[k]++
	h.Count++
	h.Sum += v
	h.Min = math.Min(h.Min, v)
	h.Max = math.Max(h.Max, v)
}

type distribution struct {
	Count uint64  `json:"count"`
	Min   float64 `json:"min"`
	Max   float64 `json:"max"`
	Mean  float64 `json:"mean"`
	P50   float64 `json:"p50"`
	P90   float64 `json:"p90"`
	P95   float64 `json:"p95"`
	P99   float64 `json:"p99"`
}

func (h *histogram) result() distribution {
	keys := make([]int, 0, len(h.bins))
	for k := range h.bins {
		keys = append(keys, k)
	}
	sort.Ints(keys)
	q := func(p float64) float64 {
		rank := uint64(math.Ceil(float64(h.Count) * p))
		var count uint64
		for _, k := range keys {
			count += h.bins[k]
			if count >= rank {
				v := math.Expm1(float64(abs(k)) * math.Log(1.01))
				if k < 0 {
					v = -v
				}
				return math.Max(h.Min, math.Min(h.Max, v))
			}
		}
		return h.Max
	}
	if h.Count == 0 {
		return distribution{}
	}
	return distribution{h.Count, h.Min, h.Max, h.Sum / float64(h.Count), q(.5), q(.9), q(.95), q(.99)}
}
func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

type groupKey struct {
	HarnessInventory map[string]harnessInfo `json:"harness_inventory,omitempty"`
	VolumePath       string                 `json:"volume_path,omitempty"`
	VolumeTotal      *uint64                `json:"volume_total_bytes,omitempty"`
	System           systemInfo             `json:"system"`
	Collector        string                 `json:"collector"`
	Harness          string                 `json:"harness"`
	Version          harnessInfo            `json:"harness_version"`
	Mode             string                 `json:"mode"`
	Label            string                 `json:"label"`
	Model            string                 `json:"model"`
	Revision         string                 `json:"project_revision"`
	WorkloadHash     string                 `json:"workload_sha256"`
	Workload         string                 `json:"workload_id"`
	Threads          int                    `json:"expected_threads"`
	Interval         float64                `json:"interval_seconds"`
}
type summary struct {
	Key       groupKey                `json:"group"`
	Runs      int                     `json:"runs"`
	First     time.Time               `json:"first_run_utc"`
	Last      time.Time               `json:"last_run_utc"`
	Completed int                     `json:"completed_jobs"`
	Failed    int                     `json:"failed_jobs"`
	Cancelled int                     `json:"cancelled_jobs"`
	ErrorRate *float64                `json:"job_error_rate"`
	Metrics   map[string]distribution `json:"metrics"`
	hist      map[string]*histogram
	runIDs    map[string]bool
}

func (s *summary) add(name string, v *float64) {
	if v == nil {
		return
	}
	if s.hist[name] == nil {
		s.hist[name] = &histogram{}
	}
	s.hist[name].add(*v)
}

type reportOutput struct {
	Schema          int        `json:"schema"`
	Notes           []string   `json:"notes"`
	Groups          []*summary `json:"groups"`
	Diagnostics     int        `json:"collector_diagnostics"`
	IncompleteFiles []string   `json:"incomplete_files"`
}

func report(args []string) error {
	fs := flag.NewFlagSet("report", flag.ContinueOnError)
	output := fs.String("out", "", "New report JSON file, default stdout")
	if e := fs.Parse(args); e != nil {
		return e
	}
	if fs.NArg() == 0 {
		return errors.New("usage: harness-benchmark report [-out report.json] run1.jsonl run2.jsonl ...")
	}
	groups := map[string]*summary{}
	seenRuns := map[string]bool{}
	result := reportOutput{Schema: schema, Notes: []string{"Quantiles use a bounded logarithmic histogram; error <=1% of (1+absolute value). Samples are pooled across runs with identical group metadata. Longer runs have more weight.", "Resource quantiles cover active observed process trees. Missing/partial metrics are omitted, never zero-filled. Sample count is reported for each metric.", "Job error rate includes nonzero exits, launch errors and timeouts. Cancelled jobs are counted separately. It does not measure semantic correctness, individual tool errors, or retries.", "Volume metrics are filesystem-wide and grouped separately as __storage__. Watch metrics count logical file sizes, with symlinks skipped.", "Ten job latencies cannot give a stable P99. Repeat the same controlled workload across many days; compare versions, models and machines separately."}}
	for _, path := range fs.Args() {
		f, e := os.Open(path)
		if e != nil {
			return e
		}
		e = func() error {
			defer f.Close()
			reader := bufio.NewReaderSize(f, 4*1024*1024)
			var meta *metadata
			ended := false
			seenWatches := map[string]time.Time{}
			lineNo := 0
			for {
				line, readErr := reader.ReadSlice('\n')
				lineNo++
				// Bound every record. Collector writes one harness group per record.
				if errors.Is(readErr, bufio.ErrBufferFull) {
					return fmt.Errorf("%s:%d record exceeds 4MiB", path, lineNo)
				}
				if readErr == io.EOF && len(line) > 0 {
					result.IncompleteFiles = append(result.IncompleteFiles, path+": ignored incomplete final line")
					break
				}
				if readErr != nil && readErr != io.EOF {
					return readErr
				}
				if len(line) > 0 {
					var ev event
					if e := json.Unmarshal(line, &ev); e != nil {
						return fmt.Errorf("%s:%d: %w", path, lineNo, e)
					}
					if ended {
						return fmt.Errorf("%s: records after end", path)
					}
					if ev.Type == "start" {
						if meta != nil || ev.Meta == nil || ev.Meta.Schema != schema {
							return fmt.Errorf("%s: invalid or unsupported start record", path)
						}
						meta = ev.Meta
						if seenRuns[meta.RunID] {
							return fmt.Errorf("duplicate run ID %s", meta.RunID)
						}
						seenRuns[meta.RunID] = true
					} else {
						if meta == nil {
							return fmt.Errorf("%s: missing start record", path)
						}
						get := func(id string) *summary {
							key := groupKey{System: meta.System, Collector: meta.Collector, Harness: id, Version: meta.Harnesses[id], Mode: meta.Mode, Label: meta.Label, Model: meta.Model, Revision: meta.Revision, Workload: meta.Workload, Threads: meta.Threads, Interval: meta.IntervalSeconds, WorkloadHash: meta.WorkloadHash}
							if id == "__storage__" {
								key.HarnessInventory = meta.Harnesses
								key.VolumePath = meta.Volume
								key.VolumeTotal = meta.InitialTotal
							}
							encoded, _ := json.Marshal(key)
							k := string(encoded)
							s := groups[k]
							if s == nil {
								s = &summary{Key: key, First: meta.Started, Last: meta.Started, hist: map[string]*histogram{}, runIDs: map[string]bool{}}
								groups[k] = s
							}
							if !s.runIDs[meta.RunID] {
								s.runIDs[meta.RunID] = true
								s.Runs++
								if meta.Started.Before(s.First) {
									s.First = meta.Started
								}
								if meta.Started.After(s.Last) {
									s.Last = meta.Started
								}
							}
							return s
						}
						switch ev.Type {
						case "sample":
							if ev.Metrics == nil {
								return errors.New("sample missing metrics")
							}
							m := ev.Metrics
							s := get(ev.Harness)
							s.add("cpu_percent_one_core", m.CPU)
							s.add("rss_bytes", m.RSS)
							s.add("read_bytes_per_second", m.Read)
							s.add("write_bytes_per_second", m.Write)
							s.add("processes", pointer(float64(m.Processes)))
							s.add("roots", pointer(float64(m.Roots)))
						case "storage":
							if ev.Storage == nil {
								return errors.New("storage record missing metrics")
							}
							s := get("__storage__")
							m := ev.Storage
							s.add("volume_used_delta_bytes", m.UsedDelta)
							s.add("volume_growth_bytes_per_second", m.Growth)
							if m.VolumeFree != nil {
								s.add("volume_free_bytes", pointer(float64(*m.VolumeFree)))
							}
							s.add("collection_ms", pointer(ev.ScanMS))
							for _, w := range m.Watches {
								// Only count fresh background scans once, rather than every sample.
								if w.At.After(seenWatches[w.Path]) {
									seenWatches[w.Path] = w.At
									s.add("watch:"+w.Path+":logical_bytes", w.Bytes)
									s.add("watch:"+w.Path+":growth_bytes_per_second", w.Growth)
								}
							}
						case "job_completed":
							if ev.Job == nil {
								return errors.New("job completion missing result")
							}
							s := get(ev.Harness)
							if ev.Job.Outcome == "cancelled" {
								s.Cancelled++
							} else {
								s.Completed++
								if ev.Job.Outcome != "success" {
									s.Failed++
								}
								s.add("job_duration_ms", pointer(ev.Job.DurationMS))
								if ev.Job.Outcome == "success" {
									s.add("successful_job_duration_ms", pointer(ev.Job.DurationMS))
								}
							}
						case "diagnostic":
							result.Diagnostics++
						case "end":
							ended = true
						}
					}
				}
				if readErr == io.EOF {
					break
				}
			}
			if meta == nil {
				return fmt.Errorf("%s: no run metadata", path)
			}
			if !ended {
				result.IncompleteFiles = append(result.IncompleteFiles, path+": no end record")
			}
			return nil
		}()
		if e != nil {
			return e
		}
	}
	keys := make([]string, 0, len(groups))
	for k := range groups {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		s := groups[k]
		s.Metrics = map[string]distribution{}
		for name, h := range s.hist {
			s.Metrics[name] = h.result()
		}
		if s.Completed > 0 {
			s.ErrorRate = pointer(float64(s.Failed) / float64(s.Completed))
		}
		result.Groups = append(result.Groups, s)
	}
	var writer io.Writer = os.Stdout
	if *output != "" {
		if strings.HasSuffix(*output, ".jsonl") {
			return errors.New("report output must differ from JSONL inputs")
		}
		f, e := os.OpenFile(*output, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			return e
		}
		defer f.Close()
		writer = f
	}
	enc := json.NewEncoder(writer)
	enc.SetIndent("", "  ")
	return enc.Encode(result)
}
