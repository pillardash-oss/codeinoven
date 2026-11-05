// Package auth holds the service's credential primitives: id generation,
// argon2id password hashing, opaque session tokens and the in-memory rate
// limiter. Nothing here touches the database.
package auth

import (
	"crypto/rand"
	"encoding/base32"
)

// idEncoding is RFC 4648 base32 with lower case letters and no padding, so ids
// stay copy friendly and URL safe.
var idEncoding = base32.NewEncoding("abcdefghijklmnopqrstuvwxyz234567").WithPadding(base32.NoPadding)

// idBytes is how much randomness every id carries (80 bits, 16 characters).
const idBytes = 10

// Entity id prefixes. Every id the service mints uses one of these.
const (
	PrefixUser       = "usr"
	PrefixAccount    = "acc"
	PrefixSession    = "ses"
	PrefixDevice     = "dev"
	PrefixEmailToken = "emt"
	PrefixStore      = "sto"
	PrefixOven       = "ovn"
	PrefixProject    = "prj"
	PrefixThread     = "th"
	PrefixMessage    = "msg"
	// PrefixOAuthCode names a one-time handoff code row, never a token.
	PrefixOAuthCode = "oac"
	PrefixPrompt    = "prm"
	// PrefixAttachment names one file the phone sent with a message.
	PrefixAttachment = "att"
)

// NewID returns `<prefix>_<16 base32 characters>` backed by crypto/rand.
func NewID(prefix string) string {
	return prefix + "_" + NewRandomString(idBytes)
}

// NewRandomString returns n random bytes encoded with the id alphabet.
func NewRandomString(n int) string {
	return idEncoding.EncodeToString(NewRandomBytes(n))
}

// NewRandomBytes returns n bytes from crypto/rand. crypto/rand never fails in
// practice; a broken source is not recoverable, so it panics.
func NewRandomBytes(n int) []byte {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		panic("auth: crypto/rand unavailable: " + err.Error())
	}
	return buf
}
