package main

import (
	"context"
	"io/fs"
	"path/filepath"
	"time"

	"github.com/shirou/gopsutil/v4/disk"
)

type watchResult struct {
	Path    string    `json:"path"`
	At      time.Time `json:"measured_utc"`
	Bytes   *float64  `json:"logical_bytes"`
	Delta   *float64  `json:"delta_since_first_scan_bytes"`
	Growth  *float64  `json:"growth_bytes_per_second"`
	Entries int       `json:"entries"`
	Error   string    `json:"error,omitempty"`
}
type storageCollector struct {
	path         string
	initial      *uint64
	previousFree *uint64
	previousAt   time.Time
	results      chan []watchResult
	latest       []watchResult
}

func newStorage(ctx context.Context, paths []string, volume string, initial *uint64) *storageCollector {
	s := &storageCollector{path: volume, initial: initial, results: make(chan []watchResult, 1)}
	if len(paths) == 0 {
		return s
	}
	go func() {
		baseline := map[string]float64{}
		previous := map[string]watchResult{}
		scan := func() {
			results := make([]watchResult, 0, len(paths))
			for _, path := range paths {
				if ctx.Err() != nil {
					return
				}
				path, _ = filepath.Abs(path)
				r := scanDirectory(ctx, path)
				if r.Bytes != nil {
					first, ok := baseline[path]
					if !ok {
						first = *r.Bytes
						baseline[path] = first
					}
					r.Delta = pointer(*r.Bytes - first)
					if old, ok := previous[path]; ok && old.Bytes != nil {
						dt := r.At.Sub(old.At).Seconds()
						if dt > 0 {
							r.Growth = pointer((*r.Bytes - *old.Bytes) / dt)
						}
					}
					previous[path] = r
				}
				results = append(results, r)
			}
			select {
			case s.results <- results:
			default:
			}
		}
		scan()
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				scan()
			}
		}
	}()
	return s
}
func scanDirectory(parent context.Context, path string) watchResult {
	ctx, cancel := context.WithTimeout(parent, 2*time.Second)
	defer cancel()
	r := watchResult{Path: path, At: time.Now().UTC()}
	var total float64
	err := filepath.WalkDir(path, func(_ string, d fs.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if e = ctx.Err(); e != nil {
			return e
		}
		r.Entries++
		if r.Entries > 200000 {
			return fs.ErrInvalid
		}
		// Yield in batches and do not follow symlinks. This is logical size, not allocated blocks.
		if r.Entries%256 == 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Millisecond):
			}
		}
		if d.Type().IsRegular() {
			info, e := d.Info()
			if e != nil {
				return e
			}
			total += float64(info.Size())
		}
		return nil
	})
	if err != nil {
		r.Error = err.Error()
	} else {
		r.Bytes = &total
	}
	return r
}
func (s *storageCollector) sample(ctx context.Context) storageSample {
	select {
	case s.latest = <-s.results:
	default:
	}
	r := storageSample{Watches: s.latest}
	if d, e := disk.UsageWithContext(ctx, s.path); e == nil {
		now := time.Now()
		r.VolumeFree = &d.Free
		if s.initial != nil {
			r.UsedDelta = pointer(float64(*s.initial) - float64(d.Free))
		}
		if s.previousFree != nil {
			dt := now.Sub(s.previousAt).Seconds()
			if dt > 0 {
				r.Growth = pointer((float64(*s.previousFree) - float64(d.Free)) / dt)
			}
		}
		s.previousFree = &d.Free
		s.previousAt = now
	}
	return r
}
