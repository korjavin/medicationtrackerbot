package cloudserver

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"
)

// newTestShareHandler mirrors newTestTransferHandler: wires WebAuthn + share
// routes onto one mux so the test can mint a real session via the register
// ceremony before exercising /api/share. The base domain is "localhost", so
// created links read https://localhost/s/<id>.
func newTestShareHandler(t *testing.T) (http.Handler, string, string) {
	t.Helper()
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	webauthnAPI := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	shareAPI := NewShareAPI(store, "test-session-secret-at-least-32-bytes-long", "localhost")
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	shareAPI.RegisterRoutes(mux)

	return New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false), host, claimToken
}

func postShare(t *testing.T, h http.Handler, host string, session *http.Cookie, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/share", bytes.NewReader(body))
	req.Host = host
	if session != nil {
		req.AddCookie(session)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func createShareLink(t *testing.T, h http.Handler, host string, session *http.Cookie, ct []byte) createShareResponse {
	t.Helper()
	body, _ := json.Marshal(createShareRequest{CT: ct})
	rec := postShare(t, h, host, session, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/share status = %d, body %q", rec.Code, rec.Body.String())
	}
	var created createShareResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("unmarshal create response: %v", err)
	}
	return created
}

func TestShare_CreateRequiresSession(t *testing.T) {
	h, host, _ := newTestShareHandler(t)
	body, _ := json.Marshal(createShareRequest{CT: []byte("opaque-blob")})
	if rec := postShare(t, h, host, nil, body); rec.Code != http.StatusUnauthorized {
		t.Fatalf("POST /api/share without session = %d, want 401", rec.Code)
	}
}

func TestShare_CreateReturnsLink(t *testing.T) {
	h, host, claimToken := newTestShareHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)
	before := time.Now().UTC()

	created := createShareLink(t, h, host, session, []byte("opaque-gcm-blob"))

	if matched, _ := regexp.MatchString(`^[A-Za-z0-9]{10}$`, created.ID); !matched {
		t.Fatalf("id %q is not 10 base62 chars", created.ID)
	}
	if want := "https://localhost/s/" + created.ID; created.URL != want {
		t.Fatalf("url = %q, want %q", created.URL, want)
	}
	wantExp := before.Add(shareLinkTTL)
	if created.ExpiresAt.Before(wantExp.Add(-5*time.Minute)) || created.ExpiresAt.After(wantExp.Add(5*time.Minute)) {
		t.Fatalf("expires_at = %v, want ≈ %v", created.ExpiresAt, wantExp)
	}
}

func TestShare_CreateRejectsBadCT(t *testing.T) {
	h, host, claimToken := newTestShareHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)

	// Empty ct.
	body, _ := json.Marshal(createShareRequest{CT: []byte{}})
	if rec := postShare(t, h, host, session, body); rec.Code != http.StatusBadRequest {
		t.Fatalf("empty ct status = %d, want 400", rec.Code)
	}
	// Missing ct field decodes to nil: same 400.
	if rec := postShare(t, h, host, session, []byte(`{}`)); rec.Code != http.StatusBadRequest {
		t.Fatalf("missing ct status = %d, want 400", rec.Code)
	}
	// Not JSON at all.
	if rec := postShare(t, h, host, session, []byte(`{oops`)); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad JSON status = %d, want 400", rec.Code)
	}
	// 16385 decoded bytes: one past the cap.
	big := bytes.Repeat([]byte("x"), maxShareCTLen+1)
	body, _ = json.Marshal(createShareRequest{CT: big})
	if rec := postShare(t, h, host, session, body); rec.Code != http.StatusBadRequest {
		t.Fatalf("16385-byte ct status = %d, want 400", rec.Code)
	}
	// Body past the 24 KiB transport cap: well-formed JSON with a valid ct
	// plus an ignored padding field pushing the wire size over the cap, so
	// the 400 can only come from MaxBytesReader (a 16385-byte ct would 400
	// on maxShareCTLen instead, and non-JSON would 400 on decode).
	huge := []byte(fmt.Sprintf(`{"ct":"b3A=","pad":%q}`, strings.Repeat("x", 25<<10)))
	if len(huge) <= maxShareBodyBytes {
		t.Fatalf("test body is %d bytes, want it past the %d transport cap", len(huge), maxShareBodyBytes)
	}
	if rec := postShare(t, h, host, session, huge); rec.Code != http.StatusBadRequest {
		t.Fatalf("25 KiB body status = %d, want 400", rec.Code)
	}
}

func TestShare_CreateEnforcesLiveCap(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"
	shareAPI := NewShareAPI(store, "test-session-secret-at-least-32-bytes-long", "localhost")
	webauthnAPI := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	shareAPI.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)
	session := registerAndGetSession(t, h, host, claimToken)

	now := time.Now().UTC()
	for i := 0; i < maxLiveShareLinks; i++ {
		id := fmt.Sprintf("cap%07d", i)
		if err := store.CreateShareLink(t.Context(), id, account.ID, []byte("c"), now, now.Add(time.Hour)); err != nil {
			t.Fatalf("seed link %d: %v", i, err)
		}
	}
	body, _ := json.Marshal(createShareRequest{CT: []byte("one-too-many")})
	if rec := postShare(t, h, host, session, body); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("101st live link status = %d, want 429", rec.Code)
	}
}

func getShare(t *testing.T, h http.Handler, host, id string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/s/"+id, nil)
	req.Host = host
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestShare_GetRoundTrip(t *testing.T) {
	h, host, claimToken := newTestShareHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)
	created := createShareLink(t, h, host, session, []byte("opaque-gcm-blob"))

	for _, reqHost := range []string{host, "localhost"} {
		rec := getShare(t, h, reqHost, created.ID)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET /api/s/%s on %s = %d, want 200", created.ID, reqHost, rec.Code)
		}
		var got getShareResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatalf("unmarshal get response: %v", err)
		}
		if string(got.CT) != "opaque-gcm-blob" {
			t.Fatalf("ct = %q, want the stored blob", got.CT)
		}
		if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "no-store") {
			t.Fatalf("Cache-Control = %q, want no-store", cc)
		}
	}
}

func TestShare_Get404Uniform(t *testing.T) {
	h, _, _ := newTestShareHandler(t)

	// Unknown but well-formed id.
	if rec := getShare(t, h, "localhost", "ZZZZZZZZZZ"); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown id status = %d, want 404", rec.Code)
	}
	// Malformed: 9 and 11 chars never reach the store.
	for _, bad := range []string{"abcdefghi", "abcdefghijk", "has-dash!!", "under_score!"} {
		if rec := getShare(t, h, "localhost", bad); rec.Code != http.StatusNotFound {
			t.Fatalf("malformed id %q status = %d, want 404", bad, rec.Code)
		}
	}
	// Encoded traversal decodes to "../" inside the handler: still 404.
	if rec := getShare(t, h, "localhost", "..%2F"); rec.Code != http.StatusNotFound {
		t.Fatalf("encoded traversal status = %d, want 404", rec.Code)
	}
	// Raw ".." is cleaned to a redirect by net/http itself; the redirect
	// target carries no route on either branch, so the exchange ends in 404
	// with the blob never served.
	req := httptest.NewRequest(http.MethodGet, "/api/s/../", nil)
	req.Host = "localhost"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	for rec.Code/100 == 3 {
		loc := rec.Header().Get("Location")
		if loc == "" {
			t.Fatalf("redirect without Location")
		}
		req = httptest.NewRequest(http.MethodGet, loc, nil)
		req.Host = "localhost"
		rec = httptest.NewRecorder()
		h.ServeHTTP(rec, req)
	}
	if rec.Code != http.StatusNotFound {
		t.Fatalf("traversal exchange final status = %d, want 404", rec.Code)
	}
}

func TestShare_GetExpired404(t *testing.T) {
	store := setupStore(t)
	account, _ := setupInvite(t, store)
	host := account.Subdomain + ".localhost"
	shareAPI := NewShareAPI(store, "test-session-secret-at-least-32-bytes-long", "localhost")
	mux := http.NewServeMux()
	shareAPI.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)

	now := time.Now().UTC()
	if err := store.CreateShareLink(t.Context(), "DeadLink01", account.ID, []byte("c"),
		now.Add(-31*24*time.Hour), now.Add(-time.Hour)); err != nil {
		t.Fatalf("seed expired: %v", err)
	}
	if rec := getShare(t, h, host, "DeadLink01"); rec.Code != http.StatusNotFound {
		t.Fatalf("expired link status = %d, want 404", rec.Code)
	}
	if rec := getShare(t, h, "localhost", "DeadLink01"); rec.Code != http.StatusNotFound {
		t.Fatalf("expired link on base domain status = %d, want 404", rec.Code)
	}
}

func TestShare_OtherAPIPrefixNotForwarded(t *testing.T) {
	h, _, _ := newTestShareHandler(t)
	for _, p := range []string{"/api/envelopes", "/api/share", "/api/version/other"} {
		req := httptest.NewRequest(http.MethodGet, p, nil)
		req.Host = "localhost"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("base-domain GET %s = %d, want 404", p, rec.Code)
		}
	}
}

func TestShare_CreateSweepsExpired(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"
	shareAPI := NewShareAPI(store, "test-session-secret-at-least-32-bytes-long", "localhost")
	webauthnAPI := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	shareAPI.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)
	session := registerAndGetSession(t, h, host, claimToken)

	now := time.Now().UTC()
	if err := store.CreateShareLink(t.Context(), "StaleLink01", account.ID, []byte("stale"),
		now.Add(-31*24*time.Hour), now.Add(-time.Hour)); err != nil {
		t.Fatalf("seed expired: %v", err)
	}
	createShareLink(t, h, host, session, []byte("fresh"))

	// Assert on the row, not the read: ShareLink's expiry filter would mask a
	// missing sweep. A second sweep must find nothing left to delete.
	swept, err := store.SweepExpiredShareLinks(t.Context(), time.Now().UTC())
	if err != nil {
		t.Fatalf("second sweep: %v", err)
	}
	if swept != 0 {
		t.Fatalf("second sweep deleted %d rows: the POST did not sweep", swept)
	}
}
