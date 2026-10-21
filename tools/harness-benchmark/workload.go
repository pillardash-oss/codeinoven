package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/process"
)

type step struct {
	Command string   `json:"command"`
	Args    []string `json:"args"`
}
type job struct {
	Harness   string `json:"harness"`
	Directory string `json:"directory"`
	Steps     []step `json:"steps"`
}
type workload struct {
	Timeout     string `json:"timeout"`
	Jobs        []job  `json:"jobs"`
	timeout     time.Duration
	fingerprint string
}
type jobResult struct {
	Index      int     `json:"index"`
	Harness    string  `json:"harness"`
	PID        int32   `json:"pid,omitempty"`
	Created    int64   `json:"created_unix_ms,omitempty"`
	DurationMS float64 `json:"duration_ms"`
	ExitCode   int     `json:"exit_code"`
	FailedStep int     `json:"failed_step,omitempty"`
	Outcome    string  `json:"outcome"`
	Error      string  `json:"error,omitempty"`
}

func loadWorkload(path string, threads int) (*workload, error) {
	var w workload
	if e := decodeFile(path, &w); e != nil {
		return nil, e
	}
	encoded, e := json.Marshal(w)
	if e != nil {
		return nil, e
	}
	w.fingerprint = fmt.Sprintf("%x", sha256.Sum256(encoded))
	if len(w.Jobs) != threads {
		return nil, fmt.Errorf("workload has %d jobs, expected exactly %d", len(w.Jobs), threads)
	}
	w.timeout, e = time.ParseDuration(w.Timeout)
	if e != nil || w.timeout <= 0 {
		return nil, errors.New("workload timeout must be positive, e.g. 30m")
	}
	used := map[string]bool{}
	for i, j := range w.Jobs {
		if signatures[j.Harness] == nil || len(j.Steps) == 0 || len(j.Steps) > 64 {
			return nil, fmt.Errorf("job %d requires a known harness and 1..64 steps", i+1)
		}
		p, e := filepath.Abs(j.Directory)
		if e != nil {
			return nil, e
		}
		p, e = filepath.EvalSymlinks(p)
		if e != nil {
			return nil, e
		}
		info, e := os.Stat(p)
		if e != nil {
			return nil, e
		}
		if !info.IsDir() {
			return nil, fmt.Errorf("not a directory: %s", p)
		}
		key := p
		if os.PathSeparator == '\\' {
			key = strings.ToLower(p)
		}
		if used[key] {
			return nil, fmt.Errorf("jobs must use separate existing project copies: %s", p)
		}
		for existing := range used {
			if strings.HasPrefix(key, existing+string(os.PathSeparator)) || strings.HasPrefix(existing, key+string(os.PathSeparator)) {
				return nil, fmt.Errorf("job directories must not overlap: %s and %s", existing, key)
			}
		}
		used[key] = true
		w.Jobs[i].Directory = p
		for _, s := range j.Steps {
			if s.Command == "" {
				return nil, fmt.Errorf("job %d has an empty command", i+1)
			}
		}
	}
	return &w, nil
}
func launchWorkload(ctx context.Context, w workload, events chan<- event) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
		var wg sync.WaitGroup
		// All jobs share the same release gate. Job latency includes all steps.
		gate := make(chan struct{})
		for index, j := range w.Jobs {
			wg.Add(1)
			go func(index int, j job) {
				defer wg.Done()
				<-gate
				start := time.Now()
				jobCtx, cancel := context.WithTimeout(ctx, w.timeout)
				defer cancel()
				result := jobResult{Index: index + 1, Harness: j.Harness, Outcome: "success", ExitCode: 0}
				for n, s := range j.Steps {
					cmd := exec.CommandContext(jobCtx, s.Command, s.Args...)
					cmd.Dir = j.Directory
					cmd.Stdout = io.Discard
					cmd.Stderr = io.Discard
					prepareCommand(cmd)
					cmd.WaitDelay = 2 * time.Second
					cleanup, e := startManaged(cmd)
					if e != nil {
						result.Outcome = "launch_error"
						result.ExitCode = -1
						result.Error = e.Error()
						result.FailedStep = n + 1
						break
					}
					pid := int32(cmd.Process.Pid)
					var created int64
					if p, e := process.NewProcessWithContext(jobCtx, pid); e == nil {
						created, _ = p.CreateTimeWithContext(jobCtx)
					}
					events <- event{Type: "job_started", Time: time.Now().UTC(), Harness: j.Harness, Job: &jobResult{Index: index + 1, Harness: j.Harness, PID: pid, Created: created, Outcome: "running"}}
					e = cmd.Wait()
					cleanup()
					if e != nil {
						result.Outcome = "failed"
						result.ExitCode = -1
						result.Error = e.Error()
						result.FailedStep = n + 1
						var exit *exec.ExitError
						if errors.As(e, &exit) {
							result.ExitCode = exit.ExitCode()
						}
						if jobCtx.Err() != nil {
							result.Outcome = "cancelled"
							if ctx.Err() == nil {
								result.Outcome = "timeout"
							}
						}
						break
					}
				}
				result.DurationMS = float64(time.Since(start).Microseconds()) / 1000
				if jobCtx.Err() != nil {
					result.Outcome = "cancelled"
					if ctx.Err() == nil {
						result.Outcome = "timeout"
					}
				}
				events <- event{Type: "job_completed", Time: time.Now().UTC(), Harness: j.Harness, Job: &result}
			}(index, j)
		}
		close(gate)
		wg.Wait()
	}()
	return done
}
func probeVersion(parent context.Context, name string) (string, error) {
	path, e := exec.LookPath(name)
	if e != nil {
		return "", e
	}
	ctx, cancel := context.WithTimeout(parent, 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "--version")
	prepareCommand(cmd)
	cmd.WaitDelay = time.Second
	var out limitedOutput
	cmd.Stdout = &out
	cmd.Stderr = io.Discard
	if e = cmd.Run(); e != nil {
		return "", e
	}
	result := strings.TrimSpace(strings.SplitN(string(out.data), "\n", 2)[0])
	if result == "" {
		return "", errors.New("empty version")
	}
	return result, nil
}
