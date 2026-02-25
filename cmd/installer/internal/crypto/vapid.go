package crypto

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"fmt"
)

// VAPIDKeyPair holds a VAPID public/private key pair.
type VAPIDKeyPair struct {
	PublicKey  string
	PrivateKey string // #nosec G117 -- VAPID key pair struct, intentionally holds private key
}

// GenerateVAPIDKeys generates a new VAPID key pair for web push notifications.
func GenerateVAPIDKeys() (*VAPIDKeyPair, error) {
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate VAPID private key: %w", err)
	}

	publicKey := &privateKey.PublicKey

	// Get raw private key bytes (32 bytes for P256)
	d := privateKey.D.Bytes()
	if len(d) < 32 {
		padded := make([]byte, 32)
		copy(padded[32-len(d):], d)
		d = padded
	}

	pubBytes := elliptic.Marshal(elliptic.P256(), publicKey.X, publicKey.Y)

	return &VAPIDKeyPair{
		PrivateKey: base64.RawURLEncoding.EncodeToString(d),
		PublicKey:  base64.RawURLEncoding.EncodeToString(pubBytes),
	}, nil
}
