package cloudserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// newFoodTestHandlerAPI mirrors cmd/cloud/main.go's wiring for the food
// proxy so the tests drive the real subdomain-routing + session + proxy
// contract.
func newFoodTestHandlerAPI(t *testing.T, dbURL, dbAPIKey string) (http.Handler, *FoodProxyAPI, string, string) {
	t.Helper()
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"
	secret := "test-session-secret-at-least-32-bytes-long"

	webauthnAPI := NewWebAuthnAPI(store, secret)
	proxyAPI := NewFoodProxyAPI(store, secret, dbURL, dbAPIKey)
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	proxyAPI.RegisterRoutes(mux)

	return New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false), proxyAPI, host, claimToken
}

func TestFoodProxyAPI(t *testing.T) {
	mockDB := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/v1/food/search" {
			q := r.URL.Query().Get("q")
			if q == "apple" {
				w.Write([]byte(`{"results": [{"name": "Apple", "kcal100g": 52}]}`))
				return
			}
			w.Write([]byte(`{"results": []}`))
			return
		}
		if r.URL.Path == "/api/v1/food/barcode/12345678" {
			w.Write([]byte(`{"name": "Barcode Apple", "kcal100g": 52}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer mockDB.Close()

	handler, _, host, claimToken := newFoodTestHandlerAPI(t, mockDB.URL, "")
	session := registerAndGetSession(t, handler, host, claimToken)

	t.Run("Search routes correctly", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "http://"+host+"/api/food/search?q=apple", nil)
		req.AddCookie(session)

		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("Expected 200, got %d", w.Code)
		}

		var resp struct {
			Results []struct {
				Name string `json:"name"`
			} `json:"results"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("Failed to decode response: %v", err)
		}
		if len(resp.Results) != 1 || resp.Results[0].Name != "Apple" {
			t.Errorf("Unexpected response: %s", w.Body.String())
		}
	})

	t.Run("Barcode routes correctly", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "http://"+host+"/api/food/barcode/12345678", nil)
		req.AddCookie(session)

		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("Expected 200, got %d", w.Code)
		}

		var resp struct {
			Name string `json:"name"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("Failed to decode response: %v", err)
		}
		if resp.Name != "Barcode Apple" {
			t.Errorf("Unexpected response: %s", w.Body.String())
		}
	})

	t.Run("Requires session", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "http://"+host+"/api/food/search?q=apple", nil)

		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("Expected 401, got %d", w.Code)
		}
	})
}

// med-eas.39: the operator's real food DB is keyed. Without X-API-Key the
// upstream 401s, so CLOUD_FOOD_DB_URL alone was never enough to make food
// search work on a fresh cloud account.
func TestFoodProxyForwardsOperatorAPIKey(t *testing.T) {
	var gotKey string
	var gotAuth string
	mockDB := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKey = r.Header.Get("X-API-Key")
		gotAuth = r.Header.Get("Authorization")
		if gotKey != "operator-secret-key" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"results": [{"name": "Apple", "kcal100g": 52}]}`))
	}))
	defer mockDB.Close()

	handler, _, host, claimToken := newFoodTestHandlerAPI(t, mockDB.URL, "operator-secret-key")
	session := registerAndGetSession(t, handler, host, claimToken)

	req := httptest.NewRequest(http.MethodGet, "http://"+host+"/api/food/search?q=apple", nil)
	req.AddCookie(session)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("keyed upstream rejected the proxied request: got %d, body %s", w.Code, w.Body.String())
	}
	if gotKey != "operator-secret-key" {
		t.Errorf("upstream saw X-API-Key %q, want the operator key", gotKey)
	}
	if gotAuth != "" {
		t.Errorf("proxy sent an unexpected Authorization header: %q", gotAuth)
	}

	// SECURITY INVARIANT (mirrors TrialConfig): the operator key must never
	// reach the browser — not in the body, not in a response header.
	if body := w.Body.String(); strings.Contains(body, "operator-secret-key") {
		t.Errorf("operator key leaked into the response body: %s", body)
	}
	for name, values := range w.Header() {
		for _, v := range values {
			if strings.Contains(v, "operator-secret-key") {
				t.Errorf("operator key leaked into response header %s: %s", name, v)
			}
		}
	}
}

// An unkeyed upstream must keep working: no CLOUD_FOOD_DB_API_KEY means no
// X-API-Key header at all, rather than an empty one.
func TestFoodProxyOmitsAPIKeyHeaderWhenUnset(t *testing.T) {
	var hadKeyHeader bool
	mockDB := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, hadKeyHeader = r.Header["X-Api-Key"]
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"results": []}`))
	}))
	defer mockDB.Close()

	handler, _, host, claimToken := newFoodTestHandlerAPI(t, mockDB.URL, "")
	session := registerAndGetSession(t, handler, host, claimToken)

	req := httptest.NewRequest(http.MethodGet, "http://"+host+"/api/food/search?q=apple", nil)
	req.AddCookie(session)
	handler.ServeHTTP(httptest.NewRecorder(), req)

	if hadKeyHeader {
		t.Error("proxy sent an X-API-Key header despite no operator key being configured")
	}
}
