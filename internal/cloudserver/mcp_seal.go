package cloudserver

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"io"

	"golang.org/x/crypto/hkdf"
)

// mcpPairingKeyInfo is the HKDF domain-separation label for the mcp_remote
// pairing-key sealing key. It is distinct from tgTokenInfo so bot tokens and
// pairing keys are sealed under different derived keys (domain separation),
// while sharing the same SESSION_SECRET-derived pattern. Bumping it (v2, …)
// intentionally orphans every stored pairing key — a key rotation.
const mcpPairingKeyInfo = "mt/mcp-pairing-key/v1"

// mcpRemoteTokenInfo labels the key that seals mcp_remote.token (the hosted
// connector's bearer token) — its own domain, so a pairing-key blob can't be
// swapped in as a token blob or vice versa.
const mcpRemoteTokenInfo = "mt/mcp-remote-token/v1"

// mcpGCM derives a 32-byte AES-256 key from the process SESSION_SECRET via
// HKDF-SHA256 under info — the same shape as tgSealKey — and returns its GCM.
// Rotating SESSION_SECRET orphans stored pairing keys and tokens (already-paired
// remotes must re-enable), the same documented trade-off tg_bots tokens carry.
func mcpGCM(sessionSecret, info string) (cipher.AEAD, error) {
	key := make([]byte, 32)
	r := hkdf.New(sha256.New, []byte(sessionSecret), nil, []byte(info))
	if _, err := io.ReadFull(r, key); err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func mcpSeal(sessionSecret, info string, plaintext []byte) (ct, nonce []byte, err error) {
	gcm, err := mcpGCM(sessionSecret, info)
	if err != nil {
		return nil, nil, err
	}
	nonce = make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, nil, err
	}
	return gcm.Seal(nil, nonce, plaintext, nil), nonce, nil
}

func mcpOpen(sessionSecret, info string, ct, nonce []byte) ([]byte, error) {
	gcm, err := mcpGCM(sessionSecret, info)
	if err != nil {
		return nil, err
	}
	if len(nonce) != gcm.NonceSize() {
		return nil, errors.New("mcp seal: bad nonce length")
	}
	return gcm.Open(nil, nonce, ct, nil)
}

// sealMCPPairingKey encrypts a pairing key with AES-GCM, returning
// (ciphertext, nonce). Mirrors sealTGToken.
func sealMCPPairingKey(sessionSecret string, pairingKey []byte) (ct, nonce []byte, err error) {
	return mcpSeal(sessionSecret, mcpPairingKeyInfo, pairingKey)
}

// openMCPPairingKey reverses sealMCPPairingKey.
func openMCPPairingKey(sessionSecret string, ct, nonce []byte) ([]byte, error) {
	return mcpOpen(sessionSecret, mcpPairingKeyInfo, ct, nonce)
}

// sealMCPRemoteToken encrypts the connector bearer token for mcp_remote.token_ct.
func sealMCPRemoteToken(sessionSecret, token string) (ct, nonce []byte, err error) {
	return mcpSeal(sessionSecret, mcpRemoteTokenInfo, []byte(token))
}

// openMCPRemoteToken reverses sealMCPRemoteToken.
func openMCPRemoteToken(sessionSecret string, ct, nonce []byte) (string, error) {
	pt, err := mcpOpen(sessionSecret, mcpRemoteTokenInfo, ct, nonce)
	return string(pt), err
}
