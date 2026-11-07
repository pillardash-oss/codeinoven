package auth

import (
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Password policy and argon2id parameters. The parameters are stored inside the
// encoded hash, so changing these constants does not invalidate old hashes.
const (
	MinPasswordLength = 12
	MaxPasswordLength = 128

	argonTime    = 3
	argonMemory  = 64 * 1024 // KiB, 64 MiB
	argonThreads = 2
	argonSaltLen = 16
	argonKeyLen  = 32
	argonVersion = argon2.Version
)

// ErrPasswordPolicy is returned when a password fails the length policy.
var ErrPasswordPolicy = fmt.Errorf(
	"password must be between %d and %d characters",
	MinPasswordLength, MaxPasswordLength,
)

// ValidatePassword enforces the length policy. There are no composition rules.
func ValidatePassword(password string) error {
	if len([]rune(password)) < MinPasswordLength || len([]rune(password)) > MaxPasswordLength {
		return ErrPasswordPolicy
	}
	return nil
}

// HashPassword returns a PHC formatted argon2id hash:
// $argon2id$v=19$m=65536,t=3,p=2$<salt>$<hash>
func HashPassword(password string) (string, error) {
	if err := ValidatePassword(password); err != nil {
		return "", err
	}
	salt := NewRandomBytes(argonSaltLen)
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf(
		"$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argonVersion, argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	), nil
}

// VerifyPassword reports whether password matches the encoded argon2id hash, in
// constant time with respect to the hash bytes.
func VerifyPassword(password, encoded string) (bool, error) {
	params, salt, want, err := decodeHash(encoded)
	if err != nil {
		return false, err
	}
	got := argon2.IDKey(
		[]byte(password),
		salt,
		params.time,
		params.memory,
		params.threads,
		uint32(len(want)),
	)
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

type argonParams struct {
	memory  uint32
	time    uint32
	threads uint8
}

func decodeHash(encoded string) (argonParams, []byte, []byte, error) {
	var params argonParams
	parts := strings.Split(encoded, "$")
	// "", "argon2id", "v=19", "m=...,t=...,p=...", salt, hash
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" {
		return params, nil, nil, errors.New("auth: hash is not an argon2id PHC string")
	}

	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil {
		return params, nil, nil, fmt.Errorf("auth: parse argon2 version: %w", err)
	}
	if version != argonVersion {
		return params, nil, nil, fmt.Errorf("auth: unsupported argon2 version %d", version)
	}

	var memory, timeCost uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &timeCost, &threads); err != nil {
		return params, nil, nil, fmt.Errorf("auth: parse argon2 parameters: %w", err)
	}
	if memory == 0 || timeCost == 0 || threads == 0 {
		return params, nil, nil, errors.New("auth: argon2 parameters must be positive")
	}

	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return params, nil, nil, fmt.Errorf("auth: decode argon2 salt: %w", err)
	}
	key, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return params, nil, nil, fmt.Errorf("auth: decode argon2 hash: %w", err)
	}
	if len(salt) == 0 || len(key) == 0 {
		return params, nil, nil, errors.New("auth: argon2 salt and hash must not be empty")
	}

	params = argonParams{memory: memory, time: timeCost, threads: threads}
	return params, salt, key, nil
}
