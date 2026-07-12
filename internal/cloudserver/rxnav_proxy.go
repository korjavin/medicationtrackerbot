package cloudserver

import (
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Public RxNav endpoints (keyless). Overridable in tests only.
const (
	defaultRxNavBaseURL        = "https://rxnav.nlm.nih.gov"
	defaultRxNavInteractionURL = "https://lhncbc.nlm.nih.gov/RxNav/APIs"
)

// RxNavProxyAPI provides a blind same-origin proxy for the public RxNav
// drug-name and interaction APIs so the DEK-bearing app document's
// connect-src can stay 'self' + BYO hosts (never add rxnav to the CSP).
//
// SECURITY INVARIANT (mirrors FoodProxyAPI): the proxy is blind — the drug
// name / rxcui / interaction list must never appear in a log line, a
// response header, or a body beyond the upstream JSON passthrough. Logging
// lives in proxyUpstream, which strips the URL-bearing *url.Error wrapper
// before logging (the upstream URL embeds the drug name).
type RxNavProxyAPI struct {
	baseURL        string
	interactionURL string
	store          sessionStore
	sessionSecret  string
	client         *http.Client
}

// NewRxNavProxyAPI creates a new RxNavProxyAPI. Empty baseURL /
// interactionURL default to the public RxNav endpoints.
func NewRxNavProxyAPI(store sessionStore, sessionSecret string, baseURL, interactionURL string) *RxNavProxyAPI {
	if baseURL == "" {
		baseURL = defaultRxNavBaseURL
	}
	if interactionURL == "" {
		interactionURL = defaultRxNavInteractionURL
	}
	return &RxNavProxyAPI{
		baseURL:        strings.TrimRight(baseURL, "/"),
		interactionURL: strings.TrimRight(interactionURL, "/"),
		store:          store,
		sessionSecret:  sessionSecret,
		client: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// RegisterRoutes adds the RxNav proxy routes to mux. RequireSession gives
// 401 for unauthenticated requests.
func (a *RxNavProxyAPI) RegisterRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/rxnav/rxcui", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.Rxcui)))
	mux.Handle("GET /api/rxnav/approximate", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.Approximate)))
	mux.Handle("GET /api/rxnav/properties", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.Properties)))
	mux.Handle("GET /api/rxnav/interactions", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.Interactions)))
}

// Rxcui proxies an exact drug-name lookup.
func (a *RxNavProxyAPI) Rxcui(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" {
		http.Error(w, "missing name parameter", http.StatusBadRequest)
		return
	}
	a.proxyRequest(a.baseURL+"/REST/rxcui.json?name="+url.QueryEscape(name), w, r)
}

// Approximate proxies an approximate drug-name lookup.
func (a *RxNavProxyAPI) Approximate(w http.ResponseWriter, r *http.Request) {
	term := r.URL.Query().Get("term")
	if term == "" {
		http.Error(w, "missing term parameter", http.StatusBadRequest)
		return
	}
	a.proxyRequest(a.baseURL+"/REST/approximateTerm.json?term="+url.QueryEscape(term)+"&maxEntries=1", w, r)
}

// Properties proxies an rxcui properties lookup. rxcui must be all digits
// (trust boundary — the value is interpolated into the upstream path).
func (a *RxNavProxyAPI) Properties(w http.ResponseWriter, r *http.Request) {
	rxcui := r.URL.Query().Get("rxcui")
	if rxcui == "" {
		http.Error(w, "missing rxcui parameter", http.StatusBadRequest)
		return
	}
	if !allDigits(rxcui) {
		http.Error(w, "rxcui must be a number", http.StatusBadRequest)
		return
	}
	a.proxyRequest(a.baseURL+"/REST/rxcui/"+rxcui+"/properties.json", w, r)
}

// Interactions proxies an interaction-list lookup. rxcuis is comma-separated;
// each part must be all digits (trust boundary — the value is interpolated
// into the upstream URL) and is rejoined with the '+' the upstream expects.
func (a *RxNavProxyAPI) Interactions(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("rxcuis")
	if raw == "" {
		http.Error(w, "missing rxcuis parameter", http.StatusBadRequest)
		return
	}
	parts := strings.Split(raw, ",")
	for _, p := range parts {
		if !allDigits(p) {
			http.Error(w, "rxcuis must be comma-separated numbers", http.StatusBadRequest)
			return
		}
	}
	a.proxyRequest(a.interactionURL+"/api/interaction/list.json?rxcuis="+strings.Join(parts, "+"), w, r)
}

// allDigits reports whether s is non-empty and ASCII digits only.
func allDigits(s string) bool {
	if s == "" {
		return false
	}
	return strings.IndexFunc(s, func(c rune) bool { return c < '0' || c > '9' }) == -1
}

func (a *RxNavProxyAPI) proxyRequest(upstreamURL string, w http.ResponseWriter, r *http.Request) {
	proxyUpstream(a.client, "rxnavproxy", upstreamURL, "", w, r)
}
