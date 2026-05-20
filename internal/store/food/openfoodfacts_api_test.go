package food

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSearchRemoteAPI_NotConfigured(t *testing.T) {
	r := setupFoodRepo(t)
	// No SetRemoteConfig call — both URL and Domain are empty.

	if _, err := r.SearchRemoteAPI(context.Background(), "apple"); err == nil {
		t.Fatal("expected error when food remote search is not configured, got nil")
	} else if !strings.Contains(err.Error(), "not configured") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSearchRemoteAPI_UsesInjectedURLAndAPIKey(t *testing.T) {
	var gotAuth, gotPath string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		gotAuth = req.Header.Get("X-API-Key")
		gotPath = req.URL.Path + "?" + req.URL.RawQuery
		_ = json.NewEncoder(w).Encode(map[string]any{
			"results": []map[string]any{
				{"name": "Apple", "barcode": "111", "kcal100g": 52.0},
			},
		})
	}))
	defer upstream.Close()

	r := setupFoodRepo(t)
	r.SetRemoteConfig(RemoteConfig{
		URL:    upstream.URL,
		APIKey: "test-injected-key",
	})

	results, err := r.SearchRemoteAPI(context.Background(), "apple")
	if err != nil {
		t.Fatalf("SearchRemoteAPI: %v", err)
	}
	if len(results) != 1 || results[0].Name != "Apple" {
		t.Fatalf("unexpected results: %+v", results)
	}
	if gotAuth != "test-injected-key" {
		t.Errorf("X-API-Key header = %q, want test-injected-key", gotAuth)
	}
	if !strings.Contains(gotPath, "/api/v1/food/search") {
		t.Errorf("upstream path = %q, want search path", gotPath)
	}
}

func TestSearchRemoteAPI_DomainFallback(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"results": []map[string]any{}})
	}))
	defer upstream.Close()

	r := setupFoodRepo(t)
	// Strip the scheme to simulate a bare domain; the code is supposed to
	// prepend https:// — for the test we use the full upstream URL as
	// "domain" since both http:// and https:// prefixes are recognised.
	r.SetRemoteConfig(RemoteConfig{Domain: upstream.URL})

	if _, err := r.SearchRemoteAPI(context.Background(), "apple"); err != nil {
		t.Fatalf("SearchRemoteAPI: %v", err)
	}
}

func TestSearchRemoteAPI_NoAPIKeyHeaderWhenUnset(t *testing.T) {
	var saw string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		saw = req.Header.Get("X-API-Key")
		_ = json.NewEncoder(w).Encode(map[string]any{"results": []map[string]any{}})
	}))
	defer upstream.Close()

	r := setupFoodRepo(t)
	r.SetRemoteConfig(RemoteConfig{URL: upstream.URL})

	if _, err := r.SearchRemoteAPI(context.Background(), "apple"); err != nil {
		t.Fatalf("SearchRemoteAPI: %v", err)
	}
	if saw != "" {
		t.Errorf("X-API-Key header = %q, want empty (no APIKey configured)", saw)
	}
}

func TestSearchRemoteAPI_BarcodePath(t *testing.T) {
	var gotPath string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		gotPath = req.URL.Path
		_ = json.NewEncoder(w).Encode(map[string]any{
			"name":     "Single Product",
			"barcode":  "12345678",
			"kcal100g": 100.0,
		})
	}))
	defer upstream.Close()

	r := setupFoodRepo(t)
	r.SetRemoteConfig(RemoteConfig{URL: upstream.URL})

	results, err := r.SearchRemoteAPI(context.Background(), "12345678")
	if err != nil {
		t.Fatalf("SearchRemoteAPI: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected one result, got %d", len(results))
	}
	if !strings.Contains(gotPath, "/api/v1/food/barcode/") {
		t.Errorf("upstream path = %q, want barcode path", gotPath)
	}
}
