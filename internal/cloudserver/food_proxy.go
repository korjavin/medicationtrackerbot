package cloudserver

import (
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// FoodProxyAPI provides a same-origin proxy for the operator's default
// FastFoodDB instance (CLOUD_FOOD_DB_URL) to bypass CORS restrictions.
//
// foodDBAPIKey (CLOUD_FOOD_DB_API_KEY) authenticates the operator against a
// keyed upstream, mirroring bot mode's FOOD_API_KEY -> X-API-Key header in
// internal/store/food/openfoodfacts_api.go. It carries the same SECURITY
// INVARIANT as TrialConfig: the key must never appear in a response body, a
// header echoed to the client, an injected meta tag, or a log line — the
// browser only ever learns that a food DB exists, never how to authenticate
// to it. Per-user BYO keys are unaffected; those go browser-direct from
// web/cloud/js/fooddb.js and never reach this proxy.
type FoodProxyAPI struct {
	foodDBURL     string
	foodDBAPIKey  string
	store         sessionStore
	sessionSecret string
	client        *http.Client
}

// NewFoodProxyAPI creates a new FoodProxyAPI
func NewFoodProxyAPI(store sessionStore, sessionSecret string, foodDBURL, foodDBAPIKey string) *FoodProxyAPI {
	return &FoodProxyAPI{
		foodDBURL:     strings.TrimRight(foodDBURL, "/"),
		foodDBAPIKey:  foodDBAPIKey,
		store:         store,
		sessionSecret: sessionSecret,
		client: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// RegisterRoutes adds the food proxy routes to mux. RequireSession gives 401
// for unauthenticated requests.
func (a *FoodProxyAPI) RegisterRoutes(mux *http.ServeMux) {
	if a.foodDBURL == "" {
		return
	}
	mux.Handle("GET /api/food/search", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.Search)))
	mux.Handle("GET /api/food/barcode/", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.Barcode)))
}

// Search proxies a search query to the upstream food DB.
func (a *FoodProxyAPI) Search(w http.ResponseWriter, r *http.Request) {
	if a.foodDBURL == "" {
		http.Error(w, "food db not configured", http.StatusServiceUnavailable)
		return
	}

	q := r.URL.Query().Get("q")
	if q == "" {
		http.Error(w, "missing q parameter", http.StatusBadRequest)
		return
	}

	limit := r.URL.Query().Get("limit")
	if limit == "" {
		limit = "20"
	}

	upstreamURL := a.foodDBURL + "/api/v1/food/search?q=" + url.QueryEscape(q) + "&limit=" + url.QueryEscape(limit)
	a.proxyRequest(upstreamURL, w, r)
}

// Barcode proxies a barcode lookup to the upstream food DB.
func (a *FoodProxyAPI) Barcode(w http.ResponseWriter, r *http.Request) {
	if a.foodDBURL == "" {
		http.Error(w, "food db not configured", http.StatusServiceUnavailable)
		return
	}

	barcode := strings.TrimPrefix(r.URL.Path, "/api/food/barcode/")
	if barcode == "" {
		http.Error(w, "missing barcode", http.StatusBadRequest)
		return
	}

	upstreamURL := a.foodDBURL + "/api/v1/food/barcode/" + url.PathEscape(barcode)
	a.proxyRequest(upstreamURL, w, r)
}

func (a *FoodProxyAPI) proxyRequest(upstreamURL string, w http.ResponseWriter, r *http.Request) {
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, upstreamURL, nil)
	if err != nil {
		slog.Error("foodproxy: failed to create request", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if a.foodDBAPIKey != "" {
		req.Header.Set("X-API-Key", a.foodDBAPIKey)
	}

	resp, err := a.client.Do(req)
	if err != nil {
		slog.Error("foodproxy: upstream request failed", "error", err)
		http.Error(w, "gateway timeout", http.StatusGatewayTimeout)
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}
