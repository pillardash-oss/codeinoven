package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/process"
)

type rootRef struct {
	id      string
	created int64
}
type procRow struct {
	pid, parent int32
	created     int64
	match       string
}
type counter struct {
	at          time.Time
	cpu         float64
	cpuOK       bool
	read, write uint64
	ioOK        bool
	created     int64
}
type procMetric struct {
	valid                 bool
	row                   procRow
	cpu, rss, read, write *float64
	next                  counter
}
type collector struct {
	onlyExplicit bool
	explicit     map[int32]rootRef
	rows         []procRow
	discovered   time.Time
	previous     map[int32]counter
	owned        map[int32]rootRef
}

func explicitRoots(ctx context.Context, values []string) (map[int32]rootRef, error) {
	roots := map[int32]rootRef{}
	for _, v := range values {
		id, raw, ok := strings.Cut(v, "=")
		pid, e := strconv.ParseInt(raw, 10, 32)
		if !ok || e != nil || pid <= 0 || signatures[id] == nil {
			return nil, fmt.Errorf("invalid --pid %q, expected harness=PID", v)
		}
		p, e := process.NewProcessWithContext(ctx, int32(pid))
		if e != nil {
			return nil, e
		}
		created, e := p.CreateTimeWithContext(ctx)
		if e != nil {
			return nil, e
		}
		roots[int32(pid)] = rootRef{id, created}
	}
	return roots, nil
}
func newCollector(roots map[int32]rootRef) *collector {
	return &collector{explicit: roots, previous: map[int32]counter{}, owned: map[int32]rootRef{}}
}
func (c *collector) track(j *jobResult) {
	if j != nil && j.PID > 0 && j.Created > 0 {
		c.explicit[j.PID] = rootRef{j.Harness, j.Created}
		c.discovered = time.Time{}
	}
}
func tokenMatch(args []string, name string) string {
	// Inspect only executable/script/package positions before prompt/options. Never search prompt text.
	tokens := []string{name}
	if len(args) > 0 {
		tokens = append(tokens, args[0])
	}
	base := strings.TrimSuffix(strings.ToLower(filepath.Base(name)), ".exe")
	runtimeLauncher := base == "node" || base == "bun" || base == "deno" || base == "python" || base == "python3"
	if runtimeLauncher && len(args) > 1 && !strings.HasPrefix(args[1], "-") {
		tokens = append(tokens, args[1])
	}
	for _, t := range tokens {
		normalized := strings.ToLower(strings.ReplaceAll(t, "\\", "/"))
		base := strings.TrimSuffix(filepath.Base(normalized), ".exe")
		for id, aliases := range signatures {
			for _, alias := range aliases {
				if base == alias || strings.Contains(normalized, "/node_modules/"+alias+"/") {
					return id
				}
			}
		}
	}
	return ""
}
func (c *collector) discover(ctx context.Context) error {
	ps, e := process.ProcessesWithContext(ctx)
	if e != nil {
		return e
	}
	// Bound metadata collection concurrency. No goroutine per system process.
	jobs := make(chan *process.Process)
	out := make(chan procRow, len(ps))
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for p := range jobs {
				if ctx.Err() != nil {
					continue
				}
				parent, e := p.PpidWithContext(ctx)
				if e != nil {
					continue
				}
				created, e := p.CreateTimeWithContext(ctx)
				if e != nil {
					continue
				}
				name, _ := p.NameWithContext(ctx)
				args, _ := p.CmdlineSliceWithContext(ctx)
				out <- procRow{pid: p.Pid, parent: parent, created: created, match: tokenMatch(args, name)}
			}
		}()
	}
feed:
	for _, p := range ps {
		select {
		case jobs <- p:
		case <-ctx.Done():
			break feed
		}
	}
	close(jobs)
	wg.Wait()
	close(out)
	rows := make([]procRow, 0, len(ps))
	for row := range out {
		rows = append(rows, row)
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].pid < rows[j].pid })
	c.rows = rows
	c.discovered = time.Now()
	return nil
}
func (c *collector) sample(parent context.Context) (map[string]metrics, map[string][]processIdentity, []string) {
	ctx, cancel := context.WithTimeout(parent, 4*time.Second)
	defer cancel()
	diagnostics := []string{}
	if time.Since(c.discovered) >= 5*time.Second {
		if e := c.discover(ctx); e != nil {
			diagnostics = append(diagnostics, "process discovery: "+e.Error())
		}
	}
	byPID := map[int32]procRow{}
	for _, r := range c.rows {
		byPID[r.pid] = r
	}
	// Exclude the collector and every child, including its own version probes.
	excluded := map[int32]bool{int32(os.Getpid()): true}
	var isExcluded func(int32, int) bool
	isExcluded = func(pid int32, depth int) bool {
		if excluded[pid] {
			return true
		}
		r, ok := byPID[pid]
		if !ok || depth > 128 || r.parent == pid {
			return false
		}
		if isExcluded(r.parent, depth+1) {
			excluded[pid] = true
			return true
		}
		return false
	}
	// Explicit workload roots are intentionally descendants of the collector.
	// Stop exclusion at their boundary and keep all of their build/test descendants.
	for pid := range c.explicit {
		excluded[pid] = false
	}
	owner := func(row procRow) (string, int32) {
		id := ""
		var root int32
		seen := map[int32]bool{}
		r := row
		for depth := 0; depth < 128 && !seen[r.pid]; depth++ {
			seen[r.pid] = true
			if x, ok := c.explicit[r.pid]; ok && x.created == r.created {
				return x.id, r.pid
			}
			if r.pid == int32(os.Getpid()) {
				break
			}
			if r.match != "" {
				id = r.match
				root = r.pid
			}
			next, ok := byPID[r.parent]
			if !ok {
				break
			}
			r = next
		}
		if id == "" {
			if x, ok := c.owned[row.pid]; ok && x.created == row.created {
				return x.id, row.pid
			}
		}
		if c.onlyExplicit {
			if x, ok := c.owned[row.pid]; ok && x.created == row.created {
				return x.id, row.pid
			}
			return "", 0
		}
		return id, root
	}
	groups := map[string]metrics{}
	identities := map[string][]processIdentity{}
	selected := []procRow{}
	ownership := map[int32]string{}
	rootIDs := map[int32]int32{}
	for _, r := range c.rows {
		id, root := owner(r)
		if id == "" {
			continue
		}
		// owner finds explicit roots before reaching this collector; auto-detected
		// collector children otherwise remain excluded.
		explicit := false
		walk := r
		for depth := 0; depth < 128; depth++ {
			if x, ok := c.explicit[walk.pid]; ok && x.created == walk.created {
				explicit = true
				break
			}
			n, ok := byPID[walk.parent]
			if !ok || n.pid == walk.pid {
				break
			}
			walk = n
		}
		if !explicit && isExcluded(r.pid, 0) {
			continue
		}
		ownership[r.pid] = id
		rootIDs[r.pid] = root
		selected = append(selected, r)
	}
	jobs := make(chan procRow)
	out := make(chan procMetric, len(selected))
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for r := range jobs {
				old := c.previous[r.pid]
				now := time.Now()
				m := procMetric{row: r, next: counter{at: now, created: r.created}}
				fresh, e := process.NewProcessWithContext(ctx, r.pid)
				if e != nil {
					out <- m
					continue
				}
				actual, e := fresh.CreateTimeWithContext(ctx)
				if e != nil || actual != r.created {
					out <- m
					continue
				}
				m.valid = true
				dt := now.Sub(old.at).Seconds()
				same := old.created == r.created && dt > 0
				if t, e := fresh.TimesWithContext(ctx); e == nil {
					total := t.User + t.System
					m.next.cpu = total
					m.next.cpuOK = true
					if same && old.cpuOK && total >= old.cpu {
						m.cpu = pointer((total - old.cpu) / dt * 100)
					}
				}
				if v, e := fresh.MemoryInfoWithContext(ctx); e == nil {
					m.rss = pointer(float64(v.RSS))
				}
				if io, e := fresh.IOCountersWithContext(ctx); e == nil {
					if runtime.GOOS != "windows" {
						io.ReadBytes = io.DiskReadBytes
						io.WriteBytes = io.DiskWriteBytes
					}
					m.next.ioOK = true
					m.next.read = io.ReadBytes
					m.next.write = io.WriteBytes
					if same && old.ioOK && io.ReadBytes >= old.read && io.WriteBytes >= old.write {
						m.read = pointer(float64(io.ReadBytes-old.read) / dt)
						m.write = pointer(float64(io.WriteBytes-old.write) / dt)
					}
				}
				out <- m
			}
		}()
	}
	for _, r := range selected {
		jobs <- r
	}
	close(jobs)
	wg.Wait()
	close(out)
	next := map[int32]counter{}
	owned := map[int32]rootRef{}
	for v := range out {
		if !v.valid {
			continue
		}
		id := ownership[v.row.pid]
		m := groups[id]
		m.Processes++
		root := rootIDs[v.row.pid] == v.row.pid
		if root {
			m.Roots++
		}
		identities[id] = append(identities[id], processIdentity{v.row.pid, v.row.created, id, root})
		next[v.row.pid] = v.next
		owned[v.row.pid] = rootRef{id, v.row.created}
		if v.cpu != nil {
			if m.CPU == nil {
				m.CPU = pointer(0)
			}
			*m.CPU += *v.cpu
			m.CPUCoverage++
		}
		if v.rss != nil {
			if m.RSS == nil {
				m.RSS = pointer(0)
			}
			*m.RSS += *v.rss
			m.MemoryCoverage++
		}
		if v.read != nil {
			if m.Read == nil {
				m.Read = pointer(0)
				m.Write = pointer(0)
			}
			*m.Read += *v.read
			*m.Write += *v.write
			m.IOCoverage++
		}
		groups[id] = m
	}
	// Partial sums are not presented as complete process-tree measurements.
	for id, m := range groups {
		if m.CPUCoverage != m.Processes {
			m.CPU = nil
		}
		if m.MemoryCoverage != m.Processes {
			m.RSS = nil
		}
		if m.IOCoverage != m.Processes {
			m.Read = nil
			m.Write = nil
		}
		groups[id] = m
	}
	c.previous = next
	c.owned = owned
	return groups, identities, diagnostics
}
