package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
)

const (
	// TokenPrefix marks plaintext API tokens. The OAuth middleware uses the
	// same prefix to recognize Bearer values as long-lived (or short-lived,
	// voice-session) API tokens before falling through to JWT validation.
	TokenPrefix = "mcp_"

	// tokenRandBytes is the number of random bytes embedded in a plaintext
	// token. 32 bytes hex-encoded yields a 64-char suffix, for a 68-char
	// total token length including the "mcp_" prefix.
	tokenRandBytes = 32
)

// GeneratePlaintextToken returns a fresh plaintext token of the form
// "mcp_" + 32 random bytes hex-encoded. The plaintext is intended to be
// returned to the caller exactly once and never persisted — only its
// HashToken value is stored in the api_tokens table.
func GeneratePlaintextToken() (string, error) {
	buf := make([]byte, tokenRandBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return TokenPrefix + hex.EncodeToString(buf), nil
}

// HashToken returns the sha256 hex-encoded hash of a plaintext token. The
// OAuth middleware compares against this hash when looking up Bearer values
// in api_tokens.
func HashToken(plaintext string) string {
	sum := sha256.Sum256([]byte(plaintext))
	return hex.EncodeToString(sum[:])
}
