package crypto

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
)

// RandomKey generates a cryptographically random key of the given byte length,
// returned as a base64-encoded string.
func RandomKey(byteLen int) (string, error) {
	b := make([]byte, byteLen)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate random key: %w", err)
	}
	return base64.StdEncoding.EncodeToString(b), nil
}

// RandomHex generates a cryptographically random hex string of the given byte length.
func RandomHex(byteLen int) (string, error) {
	b := make([]byte, byteLen)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate random hex: %w", err)
	}
	return fmt.Sprintf("%x", b), nil
}
