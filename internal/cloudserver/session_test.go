package cloudserver

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"testing"
	"time"
)

// mintSessionTokenAt builds a session token whose embedded mint timestamp is
// ts, mirroring NewSessionToken (which always stamps time.Now). It lets the
// skew tests forge past/future timestamps without a clock shim.
func mintSessionTokenAt(accountID string, credentialID []byte, secret string, ts time.Time) string {
	payload := fmt.Sprintf("%s|%s|%d", accountID, hex.EncodeToString(credentialID), ts.Unix())
	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(payload))
	sig := hex.EncodeToString(h.Sum(nil))
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + sig
}

func TestVerifySessionToken_FutureSkew(t *testing.T) {
	const secret = "super-secret-session-key-at-least-32b"
	accountID := "acc-skew"
	credID := []byte{1, 2, 3, 4}
	now := time.Now()

	cases := []struct {
		name   string
		ts     time.Time
		wantOK bool
	}{
		{"fresh", now, true},
		{"within TTL", now.Add(-sessionTTL / 2), true},
		{"just expired", now.Add(-sessionTTL - time.Minute), false},
		{"slightly future within skew", now.Add(sessionMaxFutureSkew / 2), true},
		{"far future beyond skew", now.Add(sessionMaxFutureSkew + time.Minute), false},
		{"absurd future (clock rollback attack)", now.Add(365 * 24 * time.Hour), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tok := mintSessionTokenAt(accountID, credID, secret, tc.ts)
			gotAccount, gotCred, ok := VerifySessionToken(tok, secret)
			if ok != tc.wantOK {
				t.Fatalf("VerifySessionToken ok = %v, want %v", ok, tc.wantOK)
			}
			if ok {
				if gotAccount != accountID {
					t.Fatalf("account = %q, want %q", gotAccount, accountID)
				}
				if string(gotCred) != string(credID) {
					t.Fatalf("credID = %x, want %x", gotCred, credID)
				}
			}
		})
	}
}
