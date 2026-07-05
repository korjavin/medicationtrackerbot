package cloudserver

import (
	"net/http"
	"net/http/httptest"
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
		"index.html":    {Data: []byte("landing page")},
		"signup.html":   {Data: []byte("account shell")},
		"css/cloud.css": {Data: []byte("body{}")},
	}
}

func testAppFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html": {Data: []byte("real app")},
		"js/app.js":  {Data: []byte("console.log(1)")},
	}
}

func TestRouter_HostVariants(t *testing.T) {
	store := setupStore(t)
	ctx := t.Context()
	now := time.Now().UTC()
	if _, err := store.CreateAccount(ctx, "acc-1", "known-sub", []byte("hash"), now.Add(time.Hour), now); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}

	h := New("app.example.com", store, testFS(), testAppFS(), nil)

	cases := []struct {
		name       string
		host       string
		path       string
		wantStatus int
		wantBody   string
	}{
		{"base domain serves landing page", "app.example.com", "/", http.StatusOK, "landing page"},
		{"base domain with dev port", "app.example.com:8080", "/", http.StatusOK, "landing page"},
		{"known subdomain serves the real app at root", "known-sub.app.example.com", "/", http.StatusOK, "real app"},
		{"known subdomain serves the unlock shell", "known-sub.app.example.com", "/unlock", http.StatusOK, "account shell"},
		{"known subdomain claim serves the shell", "known-sub.app.example.com", "/claim", http.StatusOK, "account shell"},
		{"known subdomain recover serves the shell", "known-sub.app.example.com", "/recover", http.StatusOK, "account shell"},
		{"known subdomain app asset resolves", "known-sub.app.example.com", "/static/js/app.js", http.StatusOK, "console.log(1)"},
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
			// Every response on the E2EE origin must carry the hardening headers,
			// including 404s (docs/cloud-crypto.md rates on-origin XSS catastrophic).
			if csp := rec.Header().Get("Content-Security-Policy"); csp == "" {
				t.Errorf("missing Content-Security-Policy header")
			}
			if xcto := rec.Header().Get("X-Content-Type-Options"); xcto != "nosniff" {
				t.Errorf("X-Content-Type-Options = %q, want nosniff", xcto)
			}
		})
	}
}
