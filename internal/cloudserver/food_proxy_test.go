package cloudserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// newFoodTestHandlerAPI mirrors cmd/cloud/main.go's wiring for the food
// proxy so the tests drive the real subdomain-routing + session + proxy
// contract.
func newFoodTestHandlerAPI(t *testing.T, dbURL string) (http.Handler, *FoodProxyAPI, string, string) {
	t.Helper()
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"
	secret := "test-session-secret-at-least-32-bytes-long"

	webauthnAPI := NewWebAuthnAPI(store, secret)
	proxyAPI := NewFoodProxyAPI(store, secret, dbURL)
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

	handler, _, host, claimToken := newFoodTestHandlerAPI(t, mockDB.URL)
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
