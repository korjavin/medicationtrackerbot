package cloudserver

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

func setupStore(t *testing.T) *cloudstore.Repo {
	t.Helper()
	d, err := storedb.Open(":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	r, err := cloudstore.New(d)
	if err != nil {
		t.Fatalf("cloudstore.New: %v", err)
	}
	return r
}

func testFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html":       {Data: []byte("landing page")},
		"signup.html":      {Data: []byte("account shell")},
		"css/cloud.css":    {Data: []byte("body{}")},
		"js/cloud-boot.js": {Data: []byte("window.__MEDTRACKER_CLOUD__=true;")},
	}
}

func testAppFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html": {Data: []byte("<html><head></head><body>real app</body></html>")},
		"js/app.js":  {Data: []byte("console.log(1)")},
	}
}

func testDomainFS() fstest.MapFS {
	return fstest.MapFS{
		"bp.js":     {Data: []byte("export const createBPDomain = () => ({});")},
		"weight.js": {Data: []byte("export const createWeightDomain = () => ({});")},
	}
}

// med-eas.21: bot mode generates /static/config.js; cloud mode must serve a
// passkey-mode equivalent as real JavaScript, or the shared index.html's
// <script src="/static/config.js"> 404s and the browser refuses the text/plain
// body on every load.
func TestRouter_CloudConfigJS(t *testing.T) {
	store := setupStore(t)
	now := time.Now().UTC()
	if _, err := store.CreateAccount(t.Context(), "acc-1", "known-sub", []byte("hash"), now.Add(time.Hour), now, "", "", ""); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}
	h := New("app.example.com", store, testFS(), testAppFS(), testDomainFS(), nil, "https://food.example.com", false, false)

	req := httptest.NewRequest(http.MethodGet, "/static/config.js", nil)
	req.Host = "known-sub.app.example.com"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/javascript" {
		t.Fatalf("Content-Type = %q, want application/javascript (a wrong MIME is the bug)", ct)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "window.OIDC_CONFIG") || !strings.Contains(body, "window.BOT_USERNAME") {
		t.Fatalf("body does not define the expected globals: %q", body)
	}
}

// With no TRIAL_* envs configured the served index must carry no trial
// markers at all — behavior is byte-identical to pure BYO.
func TestRouter_TrialFlagsOff_NoTrialMetas(t *testing.T) {
	store := setupStore(t)
	now := time.Now().UTC()
	if _, err := store.CreateAccount(t.Context(), "acc-1", "known-sub", []byte("hash"), now.Add(time.Hour), now, "", "", ""); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}
	h := New("app.example.com", store, testFS(), testAppFS(), testDomainFS(), nil, "https://food.example.com", false, false)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Host = "known-sub.app.example.com"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "medtracker-trial") {
		t.Fatalf("index with trial flags off leaks trial markers: %q", rec.Body.String())
	}
}

func TestRouter_HostVariants(t *testing.T) {
	store := setupStore(t)
	ctx := t.Context()
	now := time.Now().UTC()
	if _, err := store.CreateAccount(ctx, "acc-1", "known-sub", []byte("hash"), now.Add(time.Hour), now, "", "", ""); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}

	h := New("app.example.com", store, testFS(), testAppFS(), testDomainFS(), nil, "https://food.example.com", true, true)

	cases := []struct {
		name       string
		host       string
		path       string
		wantStatus int
		wantBody   string
	}{
		{"base domain serves landing page", "app.example.com", "/", http.StatusOK, "landing page"},
		{"base domain with dev port", "app.example.com:8080", "/", http.StatusOK, "landing page"},
		{"known subdomain serves the real app at root", "known-sub.app.example.com", "/", http.StatusOK, "<html><head>\n    <meta name=\"medtracker-food-db-url\" content=\"https://food.example.com\">\n    <meta name=\"medtracker-build-id\" content=\"dev\">\n    <meta name=\"medtracker-trial-ai\" content=\"1\">\n    <meta name=\"medtracker-trial-voice\" content=\"1\">\n    <script src=\"/js/cloud-boot.js\"></script></head><body>real app</body></html>"},
		{"known subdomain serves the unlock shell", "known-sub.app.example.com", "/unlock", http.StatusOK, "account shell"},
		{"known subdomain claim serves the shell", "known-sub.app.example.com", "/claim", http.StatusOK, "account shell"},
		{"known subdomain recover serves the shell", "known-sub.app.example.com", "/recover", http.StatusOK, "account shell"},
		{"known subdomain devices serves the shell", "known-sub.app.example.com", "/devices", http.StatusOK, "account shell"},
		{"known subdomain app asset resolves", "known-sub.app.example.com", "/static/js/app.js", http.StatusOK, "console.log(1)"},
		{"known subdomain domain module resolves", "known-sub.app.example.com", "/domain/bp.js", http.StatusOK, "export const createBPDomain = () => ({});"},
		{"known subdomain cloud-boot.js resolves via shell fallback", "known-sub.app.example.com", "/js/cloud-boot.js", http.StatusOK, "window.__MEDTRACKER_CLOUD__=true;"},
		{"unknown subdomain is 404", "no-such-sub.app.example.com", "/", http.StatusNotFound, ""},
		{"unrelated host is 404", "evil.example.org", "/", http.StatusNotFound, ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			req.Host = tc.host
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)

			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d (body %q)", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if tc.wantBody != "" && rec.Body.String() != tc.wantBody {
				t.Fatalf("body = %q, want %q", rec.Body.String(), tc.wantBody)
			}

			if tc.name == "known subdomain serves the real app at root" {
				if cc := rec.Header().Get("Cache-Control"); cc != "no-cache, no-store, must-revalidate" {
					t.Errorf("Cache-Control = %q, want no-cache, no-store, must-revalidate", cc)
				}
			}
			// Every response on the E2EE origin must carry the hardening headers,
			// including 404s (docs/cloud-crypto.md rates on-origin XSS catastrophic).
			csp := rec.Header().Get("Content-Security-Policy")
			if csp == "" {
				t.Errorf("missing Content-Security-Policy header")
			}
			// Account-subdomain app pages (/, /static/*, /domain/*) relax
			// connect-src to permit browser-direct C2c food calls to BYO
			// AI/food-DB origins — an accepted weakening since those pages also
			// hold the in-memory DEK. The base domain and the passkey ceremony
			// pages make no cross-origin calls and stay strict.
			wantConnect := "connect-src 'self';"
			// Account app pages also load the @elevenlabs/client voice SDK from
			// esm.sh (blob: AudioWorklets); base/ceremony pages stay strict.
			wantScript := "script-src 'self';"
			accountApp := stripPort(tc.host) != "app.example.com" &&
				(tc.path == "/" || strings.HasPrefix(tc.path, "/static/") || strings.HasPrefix(tc.path, "/domain/"))
			if accountApp {
				wantConnect = "connect-src 'self' https: wss:;"
				wantScript = "script-src 'self' https://esm.sh blob: data:;"
			}
			if !strings.Contains(csp, wantConnect) {
				t.Errorf("CSP connect-src = %q, want it to contain %q", csp, wantConnect)
			}
			if !strings.Contains(csp, wantScript) {
				t.Errorf("CSP script-src = %q, want it to contain %q", csp, wantScript)
			}
			if accountApp && !strings.Contains(csp, "worker-src 'self' blob:;") {
				t.Errorf("CSP = %q, want worker-src 'self' blob: for account app SDK worklets", csp)
			}
			if xcto := rec.Header().Get("X-Content-Type-Options"); xcto != "nosniff" {
				t.Errorf("X-Content-Type-Options = %q, want nosniff", xcto)
			}
		})
	}
}
