package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"log"
)

func main() {
	// Generate a new private key
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		log.Fatalf("Failed to generate private key: %v", err)
	}

	// Get the public key
	publicKey := &privateKey.PublicKey

	// Encode keys to base64url (without padding)
	privBytes, err := x509PrivateKeyToBytes(privateKey)
	if err != nil {
		log.Fatalf("Failed to marshal private key: %v", err)
	}

	pubBytes := elliptic.Marshal(elliptic.P256(), publicKey.X, publicKey.Y)

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
