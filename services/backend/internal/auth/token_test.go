package auth

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"regexp"
	"testing"
)

func TestNewSessionToken(t *testing.T) {
	t.Parallel()

	token, hash := NewSessionToken()

	if got := len(token); got != len(SessionTokenPrefix)+43 {
		t.Fatalf("expected 43 base64url characters after the prefix, got %d in %q", got, token)
	}
	if token[:len(SessionTokenPrefix)] != SessionTokenPrefix {
		t.Fatalf("expected the %q prefix, got %q", SessionTokenPrefix, token)
	}

	raw, err := base64.RawURLEncoding.DecodeString(token[len(SessionTokenPrefix):])
	if err != nil {
		t.Fatalf("token payload is not raw base64url: %v", err)
	}
	if len(raw) != 32 {
		t.Fatalf("expected 32 random bytes, got %d", len(raw))
	}

	sum := sha256.Sum256([]byte(token))
	if !bytes.Equal(hash, sum[:]) {
		t.Fatal("the stored hash must be the SHA-256 of the raw token")
	}
	if len(hash) != 32 {
		t.Fatalf("expected a 32 byte hash, got %d", len(hash))
	}
}

func TestNewSessionTokenIsUnique(t *testing.T) {
	t.Parallel()

	seen := make(map[string]bool, 512)
	for i := 0; i < 512; i++ {
		token, _ := NewSessionToken()
		if seen[token] {
			t.Fatalf("duplicate token generated: %q", token)
		}
		seen[token] = true
	}
}

func TestNewEmailTokenHasNoPrefix(t *testing.T) {
	t.Parallel()

	token, hash := NewEmailToken()
	if len(token) != 43 {
		t.Fatalf("expected 43 base64url characters, got %d in %q", len(token), token)
	}
	if token[:4] == SessionTokenPrefix {
		t.Fatal("email tokens must not carry the session prefix")
	}
	if !bytes.Equal(hash, HashToken(token)) {
		t.Fatal("the returned hash must match HashToken")
	}
}

func TestHashTokenIsStableAndDistinct(t *testing.T) {
	t.Parallel()

	first := HashToken("cio_abcdefghijklmnopqrstuvwxyz234567abcdefghijklmno")
	again := HashToken("cio_abcdefghijklmnopqrstuvwxyz234567abcdefghijklmno")
	other := HashToken("cio_abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnq")

	if !bytes.Equal(first, again) {
		t.Fatal("hashing the same token twice must produce the same bytes")
	}
	if bytes.Equal(first, other) {
		t.Fatal("different tokens must hash differently")
	}
}

func TestNewIDShape(t *testing.T) {
	t.Parallel()

	pattern := regexp.MustCompile(`^usr_[a-z2-7]{16}$`)
	for i := 0; i < 200; i++ {
		if id := NewID(PrefixUser); !pattern.MatchString(id) {
			t.Fatalf("id %q does not match %s", id, pattern)
		}
	}
	if id := NewID(PrefixThread); id[:3] != "th_" {
		t.Fatalf("expected the th_ prefix, got %q", id)
	}
}

func TestNewOpaqueTokenIsURLSafe(t *testing.T) {
	t.Parallel()

	token := NewOpaqueToken()
	if len(token) != 43 {
		t.Fatalf("expected 43 characters, got %d", len(token))
	}
	if _, err := base64.RawURLEncoding.DecodeString(token); err != nil {
		t.Fatalf("opaque token is not raw base64url: %v", err)
	}
}
