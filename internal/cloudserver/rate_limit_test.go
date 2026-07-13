package cloudserver

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestClientIP is the Traefik regression guard (med-yor.15): cmd/cloud always
// runs behind Traefik, which appends the real client to X-Forwarded-For and
// leaves RemoteAddr as its own address. clientIP MUST key on the forwarded
// client, not RemoteAddr — otherwise every user shares one bucket and one
// client's ceremonies rate-limit everyone's login.
func TestClientIP(t *testing.T) {
	tests := []struct {
		name       string
		xff        string
		xRealIP    string
		remoteAddr string
		want       string
	}{
		{name: "xff single hop", xff: "203.0.113.7", remoteAddr: "10.0.0.1:5000", want: "203.0.113.7"},
		// Traefik appends the connecting client last, so the last hop is the real
		// client and a client-supplied leading entry cannot spoof it.
		{name: "xff multi hop takes last", xff: "1.2.3.4, 203.0.113.7", remoteAddr: "10.0.0.1:5000", want: "203.0.113.7"},
		{name: "x-real-ip fallback", xRealIP: "203.0.113.8", remoteAddr: "10.0.0.1:5000", want: "203.0.113.8"},
		{name: "xff wins over x-real-ip", xff: "203.0.113.7", xRealIP: "203.0.113.8", remoteAddr: "10.0.0.1:5000", want: "203.0.113.7"},
		{name: "remoteaddr fallback", remoteAddr: "198.51.100.9:44321", want: "198.51.100.9"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/api/webauthn/login/begin", nil)
			r.RemoteAddr = tc.remoteAddr
			if tc.xff != "" {
				r.Header.Set("X-Forwarded-For", tc.xff)
			}
			if tc.xRealIP != "" {
				r.Header.Set("X-Real-IP", tc.xRealIP)
			}
			if got := clientIP(r); got != tc.want {
				t.Fatalf("clientIP = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestLimitByIP covers the three properties the bead asks for on the middleware
// itself: (1) the limit trips after max hits and resets after the window, (2)
// two distinct forwarded IPs get independent buckets, and (3) the 429 body is
// identical for every caller so it leaks no account/credential existence.
func TestLimitByIP(t *testing.T) {
	const max = 3
	window := 60 * time.Millisecond
	limiter := newRateLimiter(max, window)
	h := limitByIP(limiter, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	call := func(ip string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/api/webauthn/login/begin", nil)
		r.Header.Set("X-Forwarded-For", ip)
		rec := httptest.NewRecorder()
		h(rec, r)
		return rec
	}

	// (1) trip: max allowed, then 429.
	for i := 0; i < max; i++ {
		if rec := call("203.0.113.1"); rec.Code != http.StatusOK {
			t.Fatalf("hit %d for IP-A = %d, want 200", i+1, rec.Code)
		}
	}
	tripped := call("203.0.113.1")
	if tripped.Code != http.StatusTooManyRequests {
		t.Fatalf("over-limit hit for IP-A = %d, want 429", tripped.Code)
	}

	// (2) independence: a distinct forwarded IP is unaffected while IP-A is
	// throttled. This is the anti-outage guard — one client tripping the limit
	// must not lock out everyone sharing Traefik's RemoteAddr.
	if rec := call("203.0.113.2"); rec.Code != http.StatusOK {
		t.Fatalf("IP-B while IP-A throttled = %d, want 200 (buckets must be independent)", rec.Code)
	}

	// (3) no enumeration oracle: the 429 body must be the generic message, not
	// anything derived from account/credential state.
	if body := strings.TrimSpace(tripped.Body.String()); body != "Too Many Requests" {
		t.Fatalf("429 body = %q, want generic %q", body, "Too Many Requests")
	}

	// reset: after the window elapses IP-A is allowed again.
	time.Sleep(window + 20*time.Millisecond)
	if rec := call("203.0.113.1"); rec.Code != http.StatusOK {
		t.Fatalf("IP-A after window reset = %d, want 200", rec.Code)
	}
}

// TestWebAuthnRoutes_PerIPRateLimited proves the limiter is actually wired onto
// the real ceremony routes (not just available as a helper), and that the
// per-IP keying holds end to end through the registered mux. The limiter is
// outermost, so malformed bodies still count and still 429 once tripped — no
// valid crypto is needed to exercise it.
func TestWebAuthnRoutes_PerIPRateLimited(t *testing.T) {
	store := setupStore(t)
	api := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	api.RegisterRoutes(mux)

	post := func(ip string) int {
		r := httptest.NewRequest(http.MethodPost, "/api/webauthn/register/begin", strings.NewReader("{}"))
		r.Host = "acct.localhost"
		r.Header.Set("X-Forwarded-For", ip)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, r)
		return rec.Code
	}

	for i := 0; i < ceremonyRateLimitMax; i++ {
		if code := post("198.51.100.10"); code == http.StatusTooManyRequests {
			t.Fatalf("hit %d for IP-A was 429 before limit reached", i+1)
		}
	}
	if code := post("198.51.100.10"); code != http.StatusTooManyRequests {
		t.Fatalf("IP-A over limit = %d, want 429", code)
	}
	// A different client IP is not swept up in IP-A's throttling.
	if code := post("198.51.100.11"); code == http.StatusTooManyRequests {
		t.Fatalf("IP-B = 429, want independent bucket")
	}
}
