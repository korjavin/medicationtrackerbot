package cloudserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestGetVapidPublicKey_PerAccount guards the per-account VAPID design: two
// accounts must see their own distinct key on their own subdomain, and a
// base-domain request (no account resolved) 404s rather than leaking any key.
func TestGetVapidPublicKey_PerAccount(t *testing.T) {
	store := setupStore(t)
	accountA, _ := setupInvite(t, store)
	accountB, _ := setupInvite(t, store)

	pushAPI := NewPushAPI(store, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	pushAPI.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux)

	getKey := func(host string) (int, string) {
		req := httptest.NewRequest(http.MethodGet, "/api/push/vapid-public-key", nil)
		req.Host = host
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		var resp vapidPublicKeyResponse
		if rec.Code == http.StatusOK {
			if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
				t.Fatalf("decode response: %v", err)
			}
		}
		return rec.Code, resp.PublicKey
	}

	codeA, keyA := getKey(accountA.Subdomain + ".localhost")
	codeB, keyB := getKey(accountB.Subdomain + ".localhost")
	if codeA != http.StatusOK || codeB != http.StatusOK {
		t.Fatalf("expected 200 for both accounts, got %d and %d", codeA, codeB)
	}
	if keyA == "" || keyB == "" {
		t.Fatalf("expected non-empty keys, got %q and %q", keyA, keyB)
	}
	if keyA == keyB {
		t.Fatalf("expected distinct per-account keys, both were %q", keyA)
	}
	if accountA.VAPIDPublicKey == nil || keyA != *accountA.VAPIDPublicKey {
		t.Fatalf("returned key %q does not match account A's stored key", keyA)
	}

	codeBase, _ := getKey("localhost")
	if codeBase != http.StatusNotFound {
		t.Fatalf("base-domain request status = %d, want 404 (no account in context)", codeBase)
	}
}

// TestValidatePushEndpoint guards the authenticated-SSRF filter: real push
// hosts pass; loopback / metadata / private literal-IP targets and non-https
// schemes are rejected before the endpoint can be stored and relayed to.
func TestValidatePushEndpoint(t *testing.T) {
	ok := []string{
		"https://fcm.googleapis.com/fcm/send/abc",
		"https://web.push.apple.com/xyz",
		"https://updates.push.services.mozilla.com/wpush/v2/gAAA",
	}
	for _, e := range ok {
		if err := validatePushEndpoint(e); err != nil {
			t.Errorf("validatePushEndpoint(%q) = %v, want nil", e, err)
		}
	}

	bad := []string{
		"http://fcm.googleapis.com/fcm/send/abc",    // not https
		"https://127.0.0.1/x",                       // loopback
		"https://169.254.169.254/latest/meta-data/", // cloud metadata (link-local)
		"https://10.0.0.5/x",                        // private
		"https://192.168.1.1/x",                     // private
		"https://[::1]/x",                           // loopback v6
		"https://0.0.0.0/x",                         // unspecified
		"",                                          // empty
		"://nonsense",                               // unparseable / no scheme
	}
	for _, e := range bad {
		if err := validatePushEndpoint(e); err == nil {
			t.Errorf("validatePushEndpoint(%q) = nil, want error", e)
		}
	}
}
