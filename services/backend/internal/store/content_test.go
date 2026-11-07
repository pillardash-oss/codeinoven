package store

import (
	"testing"
	"time"
)

func TestLikePattern(t *testing.T) {
	t.Parallel()

	cases := map[string]string{
		"":           "%",
		"   ":        "%",
		"fix":        "%fix%",
		"100%_done":  "%100!%!_done%",
		"bang!":      "%bang!!%",
		"  padded  ": "%padded%",
	}
	for input, want := range cases {
		if got := LikePattern(input); got != want {
			t.Fatalf("LikePattern(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestValidSchemaName(t *testing.T) {
	t.Parallel()

	valid := []string{
		"store_0123456789abcdef0123",
		"store_ffffffffffffffffffff",
	}
	for _, name := range valid {
		if !ValidSchemaName(name) {
			t.Fatalf("%q should be accepted", name)
		}
	}

	invalid := []string{
		"",
		"public",
		"store_",
		"store_0123456789ABCDEF0123",
		"store_0123456789abcdef012",
		"store_0123456789abcdef01234",
		`store_0123456789abcdef0123"`,
		`public"; DROP SCHEMA public CASCADE; --`,
	}
	for _, name := range invalid {
		if ValidSchemaName(name) {
			t.Fatalf("%q must be rejected", name)
		}
	}
}

func TestNewSchemaNameShape(t *testing.T) {
	t.Parallel()

	seen := make(map[string]bool, 128)
	for i := 0; i < 128; i++ {
		name := NewSchemaName()
		if !ValidSchemaName(name) {
			t.Fatalf("generated %q, which is not a valid schema name", name)
		}
		if seen[name] {
			t.Fatalf("duplicate schema name %q", name)
		}
		seen[name] = true
	}
}

func TestClampLimit(t *testing.T) {
	t.Parallel()

	if got := clampLimit(0); got != 50 {
		t.Fatalf("zero limit = %d", got)
	}
	if got := clampLimit(10); got != 10 {
		t.Fatalf("ten = %d", got)
	}
	if got := clampLimit(5000); got != 200 {
		t.Fatalf("over the cap = %d", got)
	}
}

func TestMillisRoundTrip(t *testing.T) {
	t.Parallel()

	const want Millis = 1_767_225_600_123
	got := FromTime(time.UnixMilli(int64(want)))
	if got != want {
		t.Fatalf("millisecond round trip lost precision: got %d, want %d", got, want)
	}
	if got.Time().UnixMilli() != int64(want) {
		t.Fatalf("Millis.Time() lost precision: %d", got.Time().UnixMilli())
	}
}
