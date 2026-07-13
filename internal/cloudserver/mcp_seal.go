package cloudserver

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"io"

	"golang.org/x/crypto/hkdf"
)

// mcpPairingKeyInfo is the HKDF domain-separation label for the mcp_remote
// pairing-key sealing key. It is distinct from tgTokenInfo so bot tokens and
// pairing keys are sealed under different derived keys (domain separation),
// while sharing the same SESSION_SECRET-derived pattern. Bumping it (v2, …)
// intentionally orphans every stored pairing key — a key rotation.
const mcpPairingKeyInfo = "mt/mcp-pairing-key/v1"

// mcpSealKey derives the 32-byte AES-256 key that seals mcp_remote pairing keys
// at rest from the process SESSION_SECRET via HKDF-SHA256 — the same shape as
// tgSealKey, with an mcp-specific info label. Rotating SESSION_SECRET orphans
// stored pairing keys (already-paired remotes must re-pair), the same
// documented trade-off tg_bots tokens carry.
func mcpSealKey(sessionSecret string) ([]byte, error) {
	key := make([]byte, 32)
	r := hkdf.New(sha256.New, []byte(sessionSecret), nil, []byte(mcpPairingKeyInfo))
	if _, err := io.ReadFull(r, key); err != nil {
		return nil, err
	}
	return key, nil
}

// sealMCPPairingKey encrypts a pairing key under the HKDF-derived key with
// AES-GCM, returning (ciphertext, nonce). Mirrors sealTGToken.
func sealMCPPairingKey(sessionSecret string, pairingKey []byte) (ct, nonce []byte, err error) {
	key, err := mcpSealKey(sessionSecret)
	if err != nil {
		return nil, nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, nil, err
	}
	nonce = make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, nil, err
	}
	ct = gcm.Seal(nil, nonce, pairingKey, nil)
	return ct, nonce, nil
}

// openMCPPairingKey reverses sealMCPPairingKey.
func openMCPPairingKey(sessionSecret string, ct, nonce []byte) ([]byte, error) {
	key, err := mcpSealKey(sessionSecret)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, nonce, ct, nil)
}
