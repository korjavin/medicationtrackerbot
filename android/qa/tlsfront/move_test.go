package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMoveFaultIsLimitedToArmedAccountBootstrapReads(t *testing.T) {
	f := &moveFixture{}
	arm := httptest.NewRequest(http.MethodPost, "/arm", strings.NewReader(`{"host":"one.qa.test"}`))
	w := httptest.NewRecorder()
	f.control(w, arm)
	if w.Code != http.StatusOK {
		t.Fatalf("arm: %d", w.Code)
	}
	for _, tc := range []struct {
		method, host, path string
		fail               bool
	}{
		{"GET", "one.qa.test", "/api/sync/snapshot", true},
		{"GET", "one.qa.test", "/api/sync/ops?since=0", true},
		{"POST", "one.qa.test", "/api/sync/ops", false},
		{"GET", "other.qa.test", "/api/sync/snapshot", false},
		{"GET", "one.qa.test", "/unlock", false},
	} {
		req := httptest.NewRequest(tc.method, "https://"+tc.host+tc.path, nil)
		w := httptest.NewRecorder()
		if got := f.failBootstrap(w, req); got != tc.fail {
			t.Fatalf("%s %s %s: got %v", tc.method, tc.host, tc.path, got)
		}
		if tc.fail && w.Code != http.StatusServiceUnavailable {
			t.Fatalf("fault status %d", w.Code)
		}
	}
	if f.hits != 2 {
		t.Fatalf("hits = %d", f.hits)
	}
	w = httptest.NewRecorder()
	f.control(w, httptest.NewRequest(http.MethodPost, "/release", nil))
	if f.failBootstrap(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "https://one.qa.test/api/sync/snapshot", nil)) {
		t.Fatal("fault still armed")
	}
}
