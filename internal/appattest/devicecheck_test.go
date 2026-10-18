package appattest

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/golang-jwt/jwt/v5"
)

// fakeDeviceCheck mirrors Apple's DeviceCheck contract ("Accessing and
// modifying per-device data"): POST /v1/query_two_bits and
// /v1/update_two_bits with JSON {device_token, transaction_id, timestamp
// [, bit0, bit1]} and an ES256 JWT bearer (kid header, iss=team, iat). A
// device never written answers HTTP 200 with the plain-text body
// "Failed to find bit state"; an unknown token answers 400 "Missing or
// incorrectly formatted device token payload".
type fakeDeviceCheck struct {
	cfg  DeviceCheckConfig
	mu   sync.Mutex
	bits map[string][2]bool
	fail int // non-zero: answer every request with this status
}

func (f *fakeDeviceCheck) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	auth := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	tok, err := jwt.Parse(auth, func(tk *jwt.Token) (any, error) {
		if tk.Header["kid"] != f.cfg.KeyID {
			return nil, errors.New("kid")
		}
		return &f.cfg.PrivateKey.PublicKey, nil
	}, jwt.WithValidMethods([]string{"ES256"}), jwt.WithIssuedAt())
	if err != nil {
		http.Error(w, "Unable to verify authorization token", http.StatusUnauthorized)
		return
	}
	if iss, _ := tok.Claims.GetIssuer(); iss != f.cfg.TeamID {
		http.Error(w, "Unable to verify authorization token", http.StatusUnauthorized)
		return
	}
	var req struct {
		DeviceToken   string `json:"device_token"`
		TransactionID string `json:"transaction_id"`
		Timestamp     int64  `json:"timestamp"`
		Bit0, Bit1    bool
	}
	if json.NewDecoder(r.Body).Decode(&req) != nil || req.DeviceToken == "" || req.TransactionID == "" || req.Timestamp == 0 {
		http.Error(w, "Missing or incorrectly formatted device token payload", http.StatusBadRequest)
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail != 0 {
		w.WriteHeader(f.fail)
		return
	}
	switch r.URL.Path {
	case "/v1/query_two_bits":
		b, ok := f.bits[req.DeviceToken]
		if !ok {
			_, _ = w.Write([]byte(bitStateNotFound))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"bit0": b[0], "bit1": b[1], "last_update_time": "2026-10"})
	case "/v1/update_two_bits":
		f.bits[req.DeviceToken] = [2]bool{req.Bit0, req.Bit1}
	default:
		http.NotFound(w, r)
	}
}

func (f *fakeDeviceCheck) setFail(code int) { f.mu.Lock(); f.fail = code; f.mu.Unlock() }

func newFakeDeviceCheck(t *testing.T) (*fakeDeviceCheck, Config) {
	k := newKey(t)
	der, err := x509.MarshalPKCS8PrivateKey(k)
	if err != nil {
		t.Fatal(err)
	}
	// Round-trip through the .p8 parser the routes bead uses.
	parsed, err := ParsePrivateKeyPEM(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeDeviceCheck{bits: map[string][2]bool{}, cfg: DeviceCheckConfig{KeyID: "KEY123", TeamID: "TEAM123", PrivateKey: parsed}}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	cfg := Config{DeviceCheck: f.cfg}
	cfg.DeviceCheck.BaseURL = srv.URL
	return f, cfg
}

func TestDeviceCheckBits(t *testing.T) {
	f, cfg := newFakeDeviceCheck(t)
	ctx := context.Background()
	const token = "c2VjcmV0LWRldmljZS10b2tlbg=="

	// Apple quirk: never-written device → 200 "Failed to find bit state" → found=false.
	if b0, b1, found, err := cfg.QueryBits(ctx, token); err != nil || found || b0 || b1 {
		t.Fatalf("unwritten: %v %v %v %v", b0, b1, found, err)
	}
	if err := cfg.UpdateBits(ctx, token, true, false); err != nil {
		t.Fatal(err)
	}
	if b0, b1, found, err := cfg.QueryBits(ctx, token); err != nil || !found || !b0 || b1 {
		t.Fatalf("after update: %v %v %v %v", b0, b1, found, err)
	}

	// Any other non-200 → ErrDeviceCheck carrying the status, never the token or key.
	f.setFail(http.StatusServiceUnavailable)
	_, _, _, err := cfg.QueryBits(ctx, token)
	if !errors.Is(err, ErrDeviceCheck) || !strings.Contains(err.Error(), "503") || strings.Contains(err.Error(), token) || strings.Contains(err.Error(), cfg.DeviceCheck.KeyID) {
		t.Fatalf("err=%v", err)
	}

	// Wrong signing key → Apple's 401 surfaces as ErrDeviceCheck.
	f.setFail(0)
	bad := cfg
	bad.DeviceCheck.PrivateKey = newKey(t)
	if err := bad.UpdateBits(ctx, token, true, false); !errors.Is(err, ErrDeviceCheck) || !strings.Contains(err.Error(), "401") {
		t.Fatalf("err=%v", err)
	}

	// Unconfigured → ErrDeviceCheck without a network call.
	if _, _, _, err := (Config{}).QueryBits(ctx, token); !errors.Is(err, ErrDeviceCheck) {
		t.Fatalf("err=%v", err)
	}
}
