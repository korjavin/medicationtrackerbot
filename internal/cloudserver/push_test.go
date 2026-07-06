package cloudserver

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestGetVapidPublicKey_PerAccount guards the per-account VAPID design: two
// accounts must see their own distinct key on their own subdomain, and a
// base-domain request (no account resolved) 404s rather than leaking any key.
func TestGetVapidPublicKey_PerAccount(t *testing.T) {
	store := setupStore(t)
	accountA, _ := setupInvite(t, store)
	accountB, _ := setupInvite(t, store)

	pushAPI := NewPushAPI(store, &fakeSender{}, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	pushAPI.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "")

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

func postTestPush(t *testing.T, h http.Handler, host string, session *http.Cookie, req testPushRequest) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(req)
	r := httptest.NewRequest(http.MethodPost, "/api/push/test", bytes.NewReader(body))
	r.Host = host
	r.AddCookie(session)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec
}

// TestPostTestPush_TargetsOnlyNamedEndpoint guards the this-device-only test
// affordance: with two subscriptions on the same account, POST
// /api/push/test must send to exactly the named endpoint (never fan out to
// the other device), forward ct verbatim (the server stays blind to
// plaintext), and 404 an endpoint that isn't registered to the account.
func TestPostTestPush_TargetsOnlyNamedEndpoint(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	webauthnAPI := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	sender := &fakeSender{}
	pushAPI := NewPushAPI(store, sender, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	pushAPI.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "")

	session := registerAndGetSession(t, h, host, claimToken)

	ctx := t.Context()
	if err := store.UpsertPushSubscription(ctx, account.ID, "https://push.example/device-a", "p256dh", "auth", time.Now().UTC()); err != nil {
		t.Fatalf("UpsertPushSubscription A: %v", err)
	}
	if err := store.UpsertPushSubscription(ctx, account.ID, "https://push.example/device-b", "p256dh", "auth", time.Now().UTC()); err != nil {
		t.Fatalf("UpsertPushSubscription B: %v", err)
	}

	rec := postTestPush(t, h, host, session, testPushRequest{Endpoint: "https://push.example/device-a", CT: []byte("test-ct")})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("POST /api/push/test status = %d, body %q", rec.Code, rec.Body.String())
	}
	if len(sender.sent) != 1 {
		t.Fatalf("expected exactly 1 send (this-device-only), got %d: %+v", len(sender.sent), sender.sent)
	}
	if sender.sent[0].endpoint != "https://push.example/device-a" {
		t.Fatalf("sent to %q, want only device-a (device-b must not receive the test)", sender.sent[0].endpoint)
	}
	if string(sender.sent[0].ct) != "test-ct" {
		t.Fatalf("sent ct = %q, want %q — server must forward ciphertext verbatim (blind)", sender.sent[0].ct, "test-ct")
	}

	recUnknown := postTestPush(t, h, host, session, testPushRequest{Endpoint: "https://push.example/unknown-device", CT: []byte("test-ct")})
	if recUnknown.Code != http.StatusNotFound {
		t.Fatalf("POST /api/push/test to unknown endpoint status = %d, want 404", recUnknown.Code)
	}
}
