package cloudserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"
)

func TestRouter_AndroidAssetLinks(t *testing.T) {
	store := setupStore(t)
	now := time.Now().UTC()
	if _, err := store.CreateAccount(t.Context(), "acc-1", "known-sub", []byte("hash"), now.Add(time.Hour), now, "", "", ""); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}
	get := func(h *Handler, method, host string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, assetLinksPath, nil)
		req.Host = host
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	h := New("app.example.com", store, testFS(), testAppFS(), testDomainFS(), nil, "", false, false)
	for _, host := range []string{"app.example.com", "known-sub.app.example.com", "unknown.app.example.com"} {
		if rec := get(h, http.MethodGet, host); rec.Header().Get("Content-Type") == "application/json" {
			t.Fatalf("unset: %s served %q", host, rec.Body.String())
		}
	}
	h.SetAndroidAssetLinks("com.example.app", "")
	if rec := get(h, http.MethodGet, "app.example.com"); rec.Header().Get("Content-Type") == "application/json" {
		t.Fatalf("no fingerprints: served")
	}
	h.SetAndroidAssetLinks("", "AA:BB")
	if rec := get(h, http.MethodGet, "app.example.com"); rec.Header().Get("Content-Type") == "application/json" {
		t.Fatalf("no package: served")
	}

	h.SetAndroidAssetLinks("com.example.app", " AA:BB:CC , dd:ee:ff,")
	want := []any{map[string]any{
		"relation": []any{"delegate_permission/common.get_login_creds", "delegate_permission/common.handle_all_urls"},
		"target": map[string]any{
			"namespace":                "android_app",
			"package_name":             "com.example.app",
			"sha256_cert_fingerprints": []any{"AA:BB:CC", "DD:EE:FF"},
		},
	}}
	for _, host := range []string{"app.example.com", "known-sub.app.example.com", "unknown.app.example.com"} {
		rec := get(h, http.MethodGet, host)
		var got any
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil || rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "application/json" || !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: got %d %q %q", host, rec.Code, rec.Header().Get("Content-Type"), rec.Body.String())
		}
		if rec := get(h, http.MethodHead, host); rec.Code != http.StatusOK {
			t.Fatalf("%s HEAD: %d", host, rec.Code)
		}
	}
	if rec := get(h, http.MethodPost, "app.example.com"); rec.Header().Get("Content-Type") == "application/json" && rec.Code == http.StatusOK {
		t.Fatalf("POST served the file")
	}
}
