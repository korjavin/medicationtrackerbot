// Package mcpshim is the shim's transport + crypto core (docs/cloud-mode.md
// "MCP", Tier 1): the pieces cmd/mcpshim's stdio server wraps, kept in a
// package (rather than inline in main) so the Go integration test can drive
// dial/encrypt/correlate directly against a fake in-process device, with no
// subprocess involved.
//
// Wire contract (both directions, shim <-> browser responder, piped opaquely
// by internal/cloudserver's relay):
//
//	frame = nonce(12) ‖ AES-GCM(key, payload, aad)
//	aad   = encodeFields("mt/v1/mcp", pairing_id)
//	payload = one JSON-RPC 2.0 MCP message (github.com/modelcontextprotocol/go-sdk/jsonrpc.EncodeMessage)
//
// key is the 32-byte pairing key from the pairing code (pairingcode.go);
// binding pairing_id into the AAD stops a frame minted for one pairing from
// being replayed into another pairing's leg even if a key were ever reused.
package mcpshim

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/binary"
	"fmt"
)

const (
	frameAADPrefix = "mt/v1/mcp"
	nonceSize      = 12
)

// encodeFields mirrors web/cloud/js/crypto.js's encodeFields: uint16-BE
// length ‖ bytes per field, concatenated in argument order. Keeping the same
// framing on both sides (rather than plain concatenation) matches this
// codebase's established AAD convention even though, for these two
// fixed-shape fields, plain concatenation would already be unambiguous.
func encodeFields(parts ...string) []byte {
	total := 0
	for _, p := range parts {
		total += 2 + len(p)
	}
	out := make([]byte, total)
	offset := 0
	for _, p := range parts {
		binary.BigEndian.PutUint16(out[offset:], uint16(len(p)))
		copy(out[offset+2:], p)
		offset += 2 + len(p)
	}
	return out
}

func frameAAD(pairingID string) []byte {
	return encodeFields(frameAADPrefix, pairingID)
}

func gcmFor(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("mcpshim: new cipher: %w", err)
	}
	return cipher.NewGCM(block)
}

// sealFrame encrypts payload under key, bound to pairingID via the AAD.
func sealFrame(key []byte, pairingID string, payload []byte) ([]byte, error) {
	gcm, err := gcmFor(key)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, nonceSize)
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("mcpshim: nonce: %w", err)
	}
	ct := gcm.Seal(nil, nonce, payload, frameAAD(pairingID))
	return append(nonce, ct...), nil
}

// openFrame decrypts a frame produced by sealFrame (or its browser-side
// equivalent). Returns an error on any tampered nonce/ciphertext/aad, or on a
// frame too short to contain a nonce.
func openFrame(key []byte, pairingID string, frame []byte) ([]byte, error) {
	if len(frame) < nonceSize {
		return nil, fmt.Errorf("mcpshim: frame too short (%d bytes)", len(frame))
	}
	gcm, err := gcmFor(key)
	if err != nil {
		return nil, err
	}
	nonce, ct := frame[:nonceSize], frame[nonceSize:]
	return gcm.Open(nil, nonce, ct, frameAAD(pairingID))
}
