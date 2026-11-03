package auth

import (
	"testing"
	"time"
)

func TestLimiterAllowsUpToTheBudget(t *testing.T) {
	t.Parallel()

	now := time.Unix(1_700_000_000, 0)
	limiter := NewLimiterWithClock(3, 15*time.Minute, func() time.Time { return now })

	for attempt := 1; attempt <= 3; attempt++ {
		if !limiter.Allow("k") {
			t.Fatalf("attempt %d should be allowed", attempt)
		}
	}
	if limiter.Allow("k") {
		t.Fatal("the fourth attempt should be refused")
	}
}

func TestLimiterWindowExpiry(t *testing.T) {
	t.Parallel()

	now := time.Unix(1_700_000_000, 0)
	limiter := NewLimiterWithClock(1, 15*time.Minute, func() time.Time { return now })

	if !limiter.Allow("k") {
		t.Fatal("first attempt should be allowed")
	}
	if limiter.Allow("k") {
		t.Fatal("second attempt inside the window should be refused")
	}

	now = now.Add(15*time.Minute + time.Second)
	if !limiter.Allow("k") {
		t.Fatal("an attempt after the window should be allowed again")
	}
}

func TestLimiterKeysAreIndependent(t *testing.T) {
	t.Parallel()

	now := time.Unix(1_700_000_000, 0)
	limiter := NewLimiterWithClock(1, time.Minute, func() time.Time { return now })

	if !limiter.Allow("ip:1.2.3.4") {
		t.Fatal("first key should be allowed")
	}
	if limiter.Allow("ip:1.2.3.4") {
		t.Fatal("first key should be exhausted")
	}
	if !limiter.Allow("ip:5.6.7.8") {
		t.Fatal("a different key keeps its own budget")
	}
}

func TestLimiterAllowAllChargesEveryKeyOnlyWhenPermitted(t *testing.T) {
	t.Parallel()

	now := time.Unix(1_700_000_000, 0)
	limiter := NewLimiterWithClock(3, time.Minute, func() time.Time { return now })

	if !limiter.AllowAll("ip", "email") {
		t.Fatal("first combined attempt should be allowed")
	}
	if !limiter.AllowAll("ip", "email") {
		t.Fatal("second combined attempt should be allowed")
	}
	// Exhaust the ip key on its own, leaving email one attempt under budget.
	if !limiter.Allow("ip") {
		t.Fatal("the third ip attempt should be allowed")
	}
	if limiter.AllowAll("ip", "email") {
		t.Fatal("the attempt should be refused once ip is exhausted")
	}

	// "email" was not charged by the refused attempt, so it keeps its last slot.
	if !limiter.Allow("email") {
		t.Fatal("the refused attempt must not charge a key that was under budget")
	}
	if limiter.Allow("email") {
		t.Fatal("email should now be exhausted too")
	}
}

func TestLimiterAllowAllRefusesWhenOneKeyIsExhausted(t *testing.T) {
	t.Parallel()

	now := time.Unix(1_700_000_000, 0)
	limiter := NewLimiterWithClock(1, time.Minute, func() time.Time { return now })

	if !limiter.Allow("ip") {
		t.Fatal("priming the ip key should be allowed")
	}
	if limiter.AllowAll("ip", "fresh-email") {
		t.Fatal("an exhausted key must refuse the whole attempt")
	}
	if !limiter.Allow("fresh-email") {
		t.Fatal("the fresh key must not have been charged")
	}
}

func TestLimiterReset(t *testing.T) {
	t.Parallel()

	now := time.Unix(1_700_000_000, 0)
	limiter := NewLimiterWithClock(1, time.Minute, func() time.Time { return now })

	if !limiter.Allow("k") {
		t.Fatal("first attempt should be allowed")
	}
	limiter.Reset("k")
	if !limiter.Allow("k") {
		t.Fatal("a reset key gets its budget back")
	}
}

func TestLimiterDisabledWhenLimitIsZero(t *testing.T) {
	t.Parallel()

	limiter := NewLimiter(0, time.Minute)
	for i := 0; i < 100; i++ {
		if !limiter.Allow("k") {
			t.Fatal("a zero limit disables the limiter")
		}
	}
	var nilLimiter *Limiter
	if !nilLimiter.Allow("k") {
		t.Fatal("a nil limiter must not block requests")
	}
}
