package appattest

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// DeviceCheck hosts ("Accessing and modifying per-device data").
const (
	DeviceCheckProductionURL  = "https://api.devicecheck.apple.com"
	DeviceCheckDevelopmentURL = "https://api.development.devicecheck.apple.com"
)

// DeviceCheckConfig authenticates to DeviceCheck with an ES256 JWT signed by
// the team's .p8 key. SECURITY INVARIANT: none of it appears in errors.
type DeviceCheckConfig struct {
	KeyID      string
	TeamID     string
	PrivateKey *ecdsa.PrivateKey
	// BaseURL overrides the Env-derived host; tests point it at a fake.
	BaseURL string
}

// ErrDeviceCheck wraps every DeviceCheck failure (→ 503). It carries at most
// the HTTP status, never the token, JWT or key.
var ErrDeviceCheck = errors.New("appattest: devicecheck unavailable")

// Apple's answer, with HTTP 200, for a device whose bits were never written.
const bitStateNotFound = "Failed to find bit state"

var deviceCheckHTTP = &http.Client{Timeout: 10 * time.Second}

// ParsePrivateKeyPEM parses a DeviceCheck .p8 (PEM-wrapped PKCS#8 EC P-256).
func ParsePrivateKeyPEM(p8 []byte) (*ecdsa.PrivateKey, error) {
	block, _ := pem.Decode(p8)
	if block == nil {
		return nil, errors.New("appattest: devicecheck key is not PEM")
	}
	k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, errors.New("appattest: devicecheck key is not PKCS#8")
	}
	ec, ok := k.(*ecdsa.PrivateKey)
	if !ok {
		return nil, errors.New("appattest: devicecheck key is not ECDSA")
	}
	return ec, nil
}

// QueryBits reads the two per-device bits. found=false (no error) when Apple
// has no state for the device yet.
func (c Config) QueryBits(ctx context.Context, deviceToken string) (bit0, bit1, found bool, err error) {
	body, err := c.deviceCheckPost(ctx, "/v1/query_two_bits", deviceToken, nil)
	if err != nil {
		return false, false, false, err
	}
	if strings.TrimSpace(string(body)) == bitStateNotFound {
		return false, false, false, nil
	}
	var bits struct {
		Bit0 bool `json:"bit0"`
		Bit1 bool `json:"bit1"`
	}
	if err := json.Unmarshal(body, &bits); err != nil {
		return false, false, false, fmt.Errorf("%w: unreadable response", ErrDeviceCheck)
	}
	return bits.Bit0, bits.Bit1, true, nil
}

// UpdateBits writes both per-device bits.
func (c Config) UpdateBits(ctx context.Context, deviceToken string, bit0, bit1 bool) error {
	_, err := c.deviceCheckPost(ctx, "/v1/update_two_bits", deviceToken, map[string]any{"bit0": bit0, "bit1": bit1})
	return err
}

func (c Config) deviceCheckPost(ctx context.Context, path, deviceToken string, extra map[string]any) ([]byte, error) {
	dc := c.DeviceCheck
	if dc.PrivateKey == nil || dc.KeyID == "" || dc.TeamID == "" {
		return nil, fmt.Errorf("%w: not configured", ErrDeviceCheck)
	}
	base := dc.BaseURL
	if base == "" {
		base = DeviceCheckProductionURL
		if c.env() == EnvDevelopment {
			base = DeviceCheckDevelopmentURL
		}
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodES256, jwt.MapClaims{"iss": dc.TeamID, "iat": time.Now().Unix()})
	tok.Header["kid"] = dc.KeyID
	signed, err := tok.SignedString(dc.PrivateKey)
	if err != nil {
		return nil, fmt.Errorf("%w: sign", ErrDeviceCheck)
	}
	payload := map[string]any{
		"device_token":   deviceToken,
		"transaction_id": uuid.NewString(),
		"timestamp":      time.Now().UnixMilli(),
	}
	for k, v := range extra {
		payload[k] = v
	}
	reqBody, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+path, bytes.NewReader(reqBody))
	if err != nil {
		return nil, fmt.Errorf("%w: request", ErrDeviceCheck)
	}
	req.Header.Set("Authorization", "Bearer "+signed)
	req.Header.Set("Content-Type", "application/json")
	resp, err := deviceCheckHTTP.Do(req)
	if err != nil {
		// SECURITY INVARIANT: fixed string; never the transport error text.
		return nil, fmt.Errorf("%w: transport", ErrDeviceCheck)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return nil, fmt.Errorf("%w: read", ErrDeviceCheck)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: status %d", ErrDeviceCheck, resp.StatusCode)
	}
	return body, nil
}
