package mcpshim

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
)

// pairingCodePrefix marks the one-time code's version, so a future format
// bump fails loudly instead of silently misparsing.
const pairingCodePrefix = "mtmcp1."

// pairingKeyBytes is the pairing key length (docs/plans/2026-07-05-cloud-c4-poc-mcp-blind-relay.md
// Task 2: "32 random bytes from the browser").
const pairingKeyBytes = 32

// PairingCode is the parsed form of the one-time code the cloud app's
// "Connect Claude" screen generates client-side (Task 4) and the user pastes
// into MEDTRACKER_MCP_CODE. The code never touches the server — only its
// pairing_id does, via POST /api/mcp/pairings — so Key is the only secret
// the relay never sees.
type PairingCode struct {
	RelayURL  string
	PairingID string
	Key       []byte
}

// pairingCodeWire is the JSON payload embedded in the code, base64url-encoded.
// Key round-trips through encoding/json's built-in []byte<->base64 (standard,
// padded) support, matching web/cloud/js/crypto.js's toBase64/fromBase64.
type pairingCodeWire struct {
	RelayURL  string `json:"relay_url"`
	PairingID string `json:"pairing_id"`
	Key       []byte `json:"key"`
}

// ParsePairingCode parses a "mtmcp1.<base64url(json)>" code.
func ParsePairingCode(code string) (*PairingCode, error) {
	rest, ok := strings.CutPrefix(code, pairingCodePrefix)
	if !ok {
		return nil, fmt.Errorf("mcpshim: pairing code missing %q prefix", pairingCodePrefix)
	}
	raw, err := base64.RawURLEncoding.DecodeString(rest)
	if err != nil {
		return nil, fmt.Errorf("mcpshim: decode pairing code: %w", err)
	}
	var wire pairingCodeWire
	if err := json.Unmarshal(raw, &wire); err != nil {
		return nil, fmt.Errorf("mcpshim: unmarshal pairing code: %w", err)
	}
	if wire.RelayURL == "" || wire.PairingID == "" {
		return nil, fmt.Errorf("mcpshim: pairing code missing relay_url or pairing_id")
	}
	if len(wire.Key) != pairingKeyBytes {
		return nil, fmt.Errorf("mcpshim: pairing key is %d bytes, want %d", len(wire.Key), pairingKeyBytes)
	}
	return &PairingCode{RelayURL: wire.RelayURL, PairingID: wire.PairingID, Key: wire.Key}, nil
}

// FormatPairingCode is ParsePairingCode's inverse. Production codes are
// generated client-side (Task 4); this exists so Go tests (a fake device
// standing in for the browser) can produce a real code for the shim to
// parse, instead of duplicating the wire format in test fixtures.
func FormatPairingCode(pc *PairingCode) (string, error) {
	raw, err := json.Marshal(pairingCodeWire{RelayURL: pc.RelayURL, PairingID: pc.PairingID, Key: pc.Key})
	if err != nil {
		return "", fmt.Errorf("mcpshim: marshal pairing code: %w", err)
	}
	return pairingCodePrefix + base64.RawURLEncoding.EncodeToString(raw), nil
}
