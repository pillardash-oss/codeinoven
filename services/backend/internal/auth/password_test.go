package auth

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestHashPasswordProducesPHCWithDeclaredParams(t *testing.T) {
	t.Parallel()

	encoded, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}

	parts := strings.Split(encoded, "$")
	if len(parts) != 6 {
		t.Fatalf("expected 6 $-separated fields, got %d in %q", len(parts), encoded)
	}
	if parts[1] != "argon2id" {
		t.Fatalf("expected argon2id, got %q", parts[1])
	}
	if parts[2] != "v=19" {
		t.Fatalf("expected v=19, got %q", parts[2])
	}
	if parts[3] != "m=65536,t=3,p=2" {
		t.Fatalf("expected m=65536,t=3,p=2, got %q", parts[3])
	}

	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		t.Fatalf("salt is not raw base64: %v", err)
	}
	if len(salt) != 16 {
		t.Fatalf("expected a 16 byte salt, got %d", len(salt))
	}

	key, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		t.Fatalf("key is not raw base64: %v", err)
	}
	if len(key) != 32 {
		t.Fatalf("expected a 32 byte key, got %d", len(key))
	}
}

func TestVerifyPassword(t *testing.T) {
	t.Parallel()

	encoded, err := HashPassword("a-perfectly-fine-password")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}

	ok, err := VerifyPassword("a-perfectly-fine-password", encoded)
	if err != nil {
		t.Fatalf("VerifyPassword: %v", err)
	}
	if !ok {
		t.Fatal("expected the correct password to verify")
	}

	ok, err = VerifyPassword("a-perfectly-fine-password ", encoded)
	if err != nil {
		t.Fatalf("VerifyPassword: %v", err)
	}
	if ok {
		t.Fatal("expected a different password to fail")
	}
}

func TestHashPasswordUsesAFreshSalt(t *testing.T) {
	t.Parallel()

	first, err := HashPassword("same-password-twice")
	if err != nil {
		t.Fatalf("first hash: %v", err)
	}
	second, err := HashPassword("same-password-twice")
	if err != nil {
		t.Fatalf("second hash: %v", err)
	}
	if first == second {
		t.Fatal("two hashes of the same password must differ")
	}
}

func TestPasswordPolicy(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name     string
		password string
		wantErr  bool
	}{
		{"empty", "", true},
		{"eleven characters", "abcdefghijk", true},
		{"twelve lowercase characters", "abcdefghijkl", false},
		{"one hundred twenty eight", strings.Repeat("a", 128), false},
		{"one hundred twenty nine", strings.Repeat("a", 129), true},
		{"no composition rules", "correcthorse", false},
		{"multi byte characters count as characters", strings.Repeat("é", 12), false},
	}

	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			err := ValidatePassword(test.password)
			if test.wantErr && err == nil {
				t.Fatalf("expected %q to be rejected", test.password)
			}
			if !test.wantErr && err != nil {
				t.Fatalf("expected %q to be accepted, got %v", test.password, err)
			}
		})
	}
}

func TestVerifyPasswordRejectsMalformedHashes(t *testing.T) {
	t.Parallel()

	malformed := []string{
		"",
		"plaintext",
		"$argon2i$v=19$m=65536,t=3,p=2$c2FsdA$aGFzaA",
		"$argon2id$v=16$m=65536,t=3,p=2$c2FsdA$aGFzaA",
		"$argon2id$v=19$m=0,t=3,p=2$c2FsdA$aGFzaA",
		"$argon2id$v=19$m=65536,t=0,p=2$c2FsdA$aGFzaA",
		"$argon2id$v=19$m=65536,t=3,p=0$c2FsdA$aGFzaA",
		"$argon2id$v=19$m=65536,t=3,p=2$not base64$aGFzaA",
		"$argon2id$v=19$m=65536,t=3,p=2$c2FsdA$",
	}

	for _, encoded := range malformed {
		ok, err := VerifyPassword("irrelevant-password", encoded)
		if err == nil {
			t.Fatalf("expected an error for %q", encoded)
		}
		if ok {
			t.Fatalf("expected no match for %q", encoded)
		}
	}
}
