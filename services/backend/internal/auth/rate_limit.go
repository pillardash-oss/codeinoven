package auth

import (
	"sync"
	"time"
)

// Limiter is a fixed window in-memory rate limiter. It is intentionally local:
// one process, no Redis, and a restart forgives everyone. That is enough for the
// abuse it defends against (password guessing against one account).
type Limiter struct {
	limit  int
	window time.Duration
	now    func() time.Time

	mu      sync.Mutex
	buckets map[string]bucket
}

type bucket struct {
	count   int
	resetAt time.Time
}

// NewLimiter returns a limiter allowing limit attempts per key per window.
func NewLimiter(limit int, window time.Duration) *Limiter {
	return &Limiter{
		limit:   limit,
		window:  window,
		now:     time.Now,
		buckets: make(map[string]bucket),
	}
}

// NewLimiterWithClock is NewLimiter with an injectable clock, for tests.
func NewLimiterWithClock(limit int, window time.Duration, now func() time.Time) *Limiter {
	return &Limiter{limit: limit, window: window, now: now, buckets: make(map[string]bucket)}
}

// Allow records an attempt and reports whether it is inside the budget.
func (l *Limiter) Allow(key string) bool {
	if l == nil || l.limit <= 0 {
		return true
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	if len(l.buckets) > 10_000 {
		l.sweepLocked(now)
	}

	current, ok := l.buckets[key]
	if !ok || !now.Before(current.resetAt) {
		l.buckets[key] = bucket{count: 1, resetAt: now.Add(l.window)}
		return true
	}

	current.count++
	l.buckets[key] = current
	return current.count <= l.limit
}

// AllowAll reports whether every key is inside its budget, recording one attempt
// per key only when all of them are. Use it to charge an IP and an email
// together without burning the second key when the first is exhausted.
func (l *Limiter) AllowAll(keys ...string) bool {
	if l == nil || l.limit <= 0 {
		return true
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	for _, key := range keys {
		current, ok := l.buckets[key]
		if ok && now.Before(current.resetAt) && current.count >= l.limit {
			return false
		}
	}
	for _, key := range keys {
		current, ok := l.buckets[key]
		if !ok || !now.Before(current.resetAt) {
			l.buckets[key] = bucket{count: 1, resetAt: now.Add(l.window)}
			continue
		}
		current.count++
		l.buckets[key] = current
	}
	return true
}

// Reset forgets a key, used after a successful sign-in so a correct password is
// not punished by earlier typos.
func (l *Limiter) Reset(key string) {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.buckets, key)
}

func (l *Limiter) sweepLocked(now time.Time) {
	for key, entry := range l.buckets {
		if !now.Before(entry.resetAt) {
			delete(l.buckets, key)
		}
	}
}
