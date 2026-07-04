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

func TestRouter_HostVariants(t *testing.T) {
	store := setupStore(t)
	ctx := t.Context()
	now := time.Now().UTC()
	if _, err := store.CreateAccount(ctx, "acc-1", "known-sub", []byte("hash"), now.Add(time.Hour), now); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}

	h := New("app.example.com", store, testFS())

	cases := []struct {
		name       string
		host       string
		path       string
		wantStatus int
		wantBody   string
	}{
		{"base domain serves landing page", "app.example.com", "/", http.StatusOK, "landing page"},
		{"base domain with dev port", "app.example.com:8080", "/", http.StatusOK, "landing page"},
		{"known subdomain serves account shell", "known-sub.app.example.com", "/", http.StatusOK, "account shell"},
		{"known subdomain asset passes through", "known-sub.app.example.com", "/css/cloud.css", http.StatusOK, "body{}"},
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
		})
	}
}
