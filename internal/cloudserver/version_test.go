package cloudserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

// stampedAppFS mimics what CI actually serves: index.html with the deploy
// timestamp seded onto every asset URL.
func stampedAppFS(buildTS string) fstest.MapFS {
	return fstest.MapFS{
		"index.html": {Data: []byte(`<html><head></head><body><script src="/static/js/app.js?v=` + buildTS + `"></script></body></html>`)},
		"js/app.js":  {Data: []byte("console.log(1)")},
	}
}

func newTestHandler(t *testing.T, appFS fstest.MapFS) *Handler {
	t.Helper()
	store := setupStore(t)
	now := time.Now().UTC()
	if _, err := store.CreateAccount(t.Context(), "acc-1", "known-sub", []byte("hash"), now.Add(time.Hour), now, "", "", ""); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}
	return New("app.example.com", store, testFS(), appFS, testDomainFS(), nil, "", false, false)
}

func get(t *testing.T, h *Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Host = "known-sub.app.example.com"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestBuildIDFrom(t *testing.T) {
	cases := map[string]struct{ idx, want string }{
		"stamped by CI":      {`<script src="/static/js/app.js?v=20260710-1432"></script>`, "20260710-1432"},
		"stamped by docker":  {`<link href="/static/css/a.css?v=1783036800">`, "1783036800"},
		"unstamped dev tree": {`<script src="/static/js/app.js?v=TIMESTAMP_PLACEHOLDER"></script>`, devBuildID},
		"no assets at all":   {`<html><head></head></html>`, devBuildID},
	}
	for name, tc := range cases {
		if got := buildIDFrom([]byte(tc.idx)); got != tc.want {
			t.Errorf("%s: buildIDFrom = %q, want %q", name, got, tc.want)
		}
	}
}

// The two halves of "am I stale?": the id the tab booted with (a meta tag in the
// served index) and the id the server is serving right now (the endpoint). They
// must agree, or the client compares apples to oranges and prompts forever.
func TestRouter_BuildIDIsReadableBothWays(t *testing.T) {
	h := newTestHandler(t, stampedAppFS("20260710-1432"))

	idx := get(t, h, "/")
	if !strings.Contains(idx.Body.String(), `<meta name="medtracker-build-id" content="20260710-1432">`) {
		t.Fatalf("index.html carries no build-id meta: %q", idx.Body.String())
	}

	rec := get(t, h, "/api/version")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var got map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal %q: %v", rec.Body.String(), err)
	}
	if got["build_id"] != "20260710-1432" {
		t.Fatalf("build_id = %q, want 20260710-1432", got["build_id"])
	}
	if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "no-store") {
		t.Fatalf("/api/version Cache-Control = %q, want no-store (a cached staleness check is useless)", cc)
	}
}

// /api/version must not be swallowed by the account-scoped API mux, and must
// answer even when no API handler is wired at all (every router test passes nil).
func TestRouter_VersionDoesNotDependOnAPIHandler(t *testing.T) {
	h := newTestHandler(t, stampedAppFS("20260710-1432"))
	if rec := get(t, h, "/api/version"); rec.Code != http.StatusOK {
		t.Fatalf("status = %d with nil api handler, want 200", rec.Code)
	}
	if rec := get(t, h, "/api/whatever"); rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d for an unrouted /api/ path, want 404", rec.Code)
	}
}

// med-jb7.4: every asset path cmd/cloud serves carries an explicit revalidate
// policy. The shell's own /js/*.js have no ?v= fingerprint, so a heuristic
// intermediary cache is the only thing standing between a deploy and a stale
// cloud-boot.js.
func TestRouter_AssetsCarryExplicitCacheControl(t *testing.T) {
	h := newTestHandler(t, stampedAppFS("20260710-1432"))

	// Only 200s: Go's http.Error strips Cache-Control off error responses, so a
	// 404 legitimately carries none.
	for _, path := range []string{"/", "/static/js/app.js", "/static/config.js", "/domain/bp.js", "/js/cloud-boot.js", "/unlock"} {
		rec := get(t, h, path)
		if rec.Code != http.StatusOK {
			t.Errorf("%s: status = %d, want 200 (fixture missing?)", path, rec.Code)
			continue
		}
		if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "no-store") {
			t.Errorf("%s: Cache-Control = %q, want no-store", path, cc)
		}
	}
}
