package cloudserver

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"io"

	"golang.org/x/crypto/hkdf"
)

// tgTokenInfo is the HKDF domain-separation label for the bot-token sealing
// key. Bumping it (v2, …) intentionally orphans every stored token — a key
// rotation, not a compatible change.
const tgTokenInfo = "mt/tg-token/v1"

// tgSealKey derives the 32-byte AES-256 key that seals Telegram bot tokens at
// rest from the process SESSION_SECRET via HKDF-SHA256. Zero new secrets to
// operate; rotating SESSION_SECRET orphans stored tokens (users re-link) — a
// documented trade-off.
func tgSealKey(sessionSecret string) ([]byte, error) {
	key := make([]byte, 32)
	r := hkdf.New(sha256.New, []byte(sessionSecret), nil, []byte(tgTokenInfo))
	if _, err := io.ReadFull(r, key); err != nil {
		return nil, err
	}
	return key, nil
}

// sealTGToken encrypts a bot token under the HKDF-derived key with AES-GCM,
// returning (ciphertext, nonce). The nonce is stored alongside the ciphertext.
func sealTGToken(sessionSecret, token string) (ct, nonce []byte, err error) {
	key, err := tgSealKey(sessionSecret)
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
	ct = gcm.Seal(nil, nonce, []byte(token), nil)
	return ct, nonce, nil
}

// openTGToken reverses sealTGToken.
func openTGToken(sessionSecret string, ct, nonce []byte) (string, error) {
	key, err := tgSealKey(sessionSecret)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	pt, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return "", err
	}
	return string(pt), nil
}
