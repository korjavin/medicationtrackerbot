package cloudserver

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRouter_AppleAppSiteAssociation(t *testing.T) {
	store := setupStore(t)
	now := time.Now().UTC()
	if _, err := store.CreateAccount(t.Context(), "acc-1", "known-sub", []byte("hash"), now.Add(time.Hour), now, "", "", ""); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}
	get := func(h *Handler, host string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, aasaPath, nil)
		req.Host = host
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	h := New("app.example.com", store, testFS(), testAppFS(), testDomainFS(), nil, "", false, false)
	if rec := get(h, "known-sub.app.example.com"); rec.Body.Len() > 0 && rec.Header().Get("Content-Type") == "application/json" {
		t.Fatalf("unset: AASA served: %q", rec.Body.String())
	}
	h.SetAppleAppSiteAssociation("TEAM123456", "")
	if rec := get(h, "app.example.com"); rec.Header().Get("Content-Type") == "application/json" {
		t.Fatalf("half-set: AASA served")
	}
	h.SetAppleAppSiteAssociation("TEAM123456", "com.example.app")
	want := `{"webcredentials":{"apps":["TEAM123456.com.example.app"]}}`
	for _, host := range []string{"app.example.com", "known-sub.app.example.com", "unknown.app.example.com"} {
		rec := get(h, host)
		if rec.Code != http.StatusOK || rec.Body.String() != want || rec.Header().Get("Content-Type") != "application/json" {
			t.Fatalf("%s: got %d %q %q", host, rec.Code, rec.Header().Get("Content-Type"), rec.Body.String())
		}
	}
}
