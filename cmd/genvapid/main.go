package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"log/slog"
	"os"
)

func main() {
	// Generate a new private key
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		slog.Error("Failed to generate private key", "error", err)
		os.Exit(1)
	}

	// Get the public key
	publicKey := &privateKey.PublicKey

	// Encode keys to base64url (without padding)
	privBytes, err := x509PrivateKeyToBytes(privateKey)
	if err != nil {
		slog.Error("Failed to marshal private key", "error", err)
		os.Exit(1)
	}

	pubBytes := append([]byte{0x04}, publicKey.X.Bytes()...)
	pubBytes = append(pubBytes, publicKey.Y.Bytes()...)

	fmt.Printf("VAPID_PRIVATE_KEY=%s\n", base64.RawURLEncoding.EncodeToString(privBytes))
	fmt.Printf("VAPID_PUBLIC_KEY=%s\n", base64.RawURLEncoding.EncodeToString(pubBytes))
	fmt.Println("VAPID_SUBJECT=mailto:admin@example.com")
}

// Minimal implementation to get private key bytes directly for P256
// WebPush libraries often need the raw bytes (32 bytes for P256)
func x509PrivateKeyToBytes(key *ecdsa.PrivateKey) ([]byte, error) {
	d := key.D.Bytes()
	// Pad to 32 bytes if needed
	if len(d) < 32 {
		padded := make([]byte, 32)
		copy(padded[32-len(d):], d)
		return padded, nil
	}
	return d, nil
}
