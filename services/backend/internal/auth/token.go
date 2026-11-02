package auth

import (
	"crypto/sha256"
	"encoding/base64"
)

// SessionTokenPrefix marks a token as ours. The database never sees the token
// itself, only the SHA-256 of the string returned to the client (prefix included).
const SessionTokenPrefix = "cio_"

// tokenBytes is the entropy in every token: 256 bits.
const tokenBytes = 32

// NewSessionToken returns the raw token to hand to the client and the hash to
// store. The raw token looks like cio_<43 base64url characters>.
func NewSessionToken() (token string, hash []byte) {
	token = SessionTokenPrefix + NewTokenValue()
	return token, HashToken(token)
}

// NewEmailToken returns a raw single-use token and its hash. Email tokens carry
// no cio_ prefix because they travel in links, not headers.
func NewEmailToken() (token string, hash []byte) {
	token = NewTokenValue()
	return token, HashToken(token)
}

// NewTokenValue returns 32 random bytes as 43 base64url characters.
func NewTokenValue() string {
	return base64.RawURLEncoding.EncodeToString(NewRandomBytes(tokenBytes))
}

// HashToken returns the SHA-256 of a raw token string.
func HashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// NewOpaqueToken returns a 32 byte base64url token without a prefix, used for
// signing state that must be unguessable but need not be stored.
func NewOpaqueToken() string {
	return NewTokenValue()
}

// EncodeBase64URL is a small helper so callers do not import encoding/base64
// only to build a token-shaped string.
func EncodeBase64URL(raw []byte) string {
	return base64.RawURLEncoding.EncodeToString(raw)
}
