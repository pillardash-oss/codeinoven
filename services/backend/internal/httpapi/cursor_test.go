package httpapi

import (
	"testing"

	"github.com/pillardash-oss/codeinoven/services/backend/internal/store"
)

func TestCursorRoundTrip(t *testing.T) {
	t.Parallel()

	cases := []store.Cursor{
		{Sort: "activity", Number: 1_767_225_600_000, ID: "th_abcdefghijklmnop"},
		{Sort: "name", Name: "codeinoven", ID: "prj_abcdefghijklmnop"},
		{Sort: "activity", Number: 42, Flag: true, ID: "th_zzzzzzzzzzzzzzzz"},
		{Sort: "sequence", Number: 7, ID: "msg_abcdefghijklmnop"},
	}

	for _, original := range cases {
		encoded := encodeCursor(original)
		if encoded == "" {
			t.Fatalf("encoding %v produced an empty cursor", original)
		}

		decoded, err := decodeCursor(encoded, original.Sort)
		if err != nil {
			t.Fatalf("decoding %q: %v", encoded, err)
		}
		if decoded != original {
			t.Fatalf("round trip changed the cursor: got %+v, want %+v", decoded, original)
		}
	}
}

func TestCursorIsOpaque(t *testing.T) {
	t.Parallel()

	encoded := encodeCursor(store.Cursor{Sort: "activity", Number: 5, ID: "prj_abcdefghijklmnop"})
	for i := 0; i < len(encoded); i++ {
		if encoded[i] == '{' || encoded[i] == ':' {
			t.Fatalf("cursor %q leaks JSON structure", encoded)
		}
	}
}

func TestDecodeCursorRejectsAWrongSort(t *testing.T) {
	t.Parallel()

	encoded := encodeCursor(store.Cursor{Sort: "activity", Number: 5, ID: "prj_abcdefghijklmnop"})
	if _, err := decodeCursor(encoded, "name"); err == nil {
		t.Fatal("a cursor from another ordering must be rejected")
	}
}

func TestDecodeCursorRejectsGarbage(t *testing.T) {
	t.Parallel()

	cases := []string{
		"",
		"not-base64!!",
		"eyJzIjoiYWN0aXZpdHkifQ",      // {"s":"activity"} with no id
		"eyJzIjoibmFtZSIsImkiOiJ4In0", // sort mismatch for the caller
		"bm90anNvbg",                  // "notjson"
	}
	for _, raw := range cases {
		if _, err := decodeCursor(raw, "activity"); err == nil {
			t.Fatalf("expected %q to be rejected", raw)
		}
	}
}

func TestDecodeCursorRejectsAnEmptyID(t *testing.T) {
	t.Parallel()

	encoded := encodeCursor(store.Cursor{Sort: "activity"})
	if _, err := decodeCursor(encoded, "activity"); err == nil {
		t.Fatal("a cursor without a row id must be rejected")
	}
}
