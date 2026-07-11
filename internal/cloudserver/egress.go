package cloudserver

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

// maxEgressHosts caps how many provider hostnames one account may register. The
// legitimate set is tiny (AI host, an optional distinct vision host, food-DB
// host — ElevenLabs is fixed and added server-side), so a small cap both bounds
// the CSP header size and blunts an XSS trying to widen egress wholesale.
const maxEgressHosts = 8

// maxEgressHostLen bounds a single hostname; 253 is the DNS name maximum.
const maxEgressHostLen = 253

// maxEgressBodyBytes caps the request body — 8 short hostnames plus JSON
// framing fit comfortably.
const maxEgressBodyBytes = 4 << 10

// egressStore is the subset of *cloudstore.Repo the egress-host endpoint needs.
type egressStore interface {
	SetEgressHosts(ctx context.Context, accountID string, hosts []string) error
	CredentialExists(ctx context.Context, credentialID []byte) (bool, error)
}

// EgressAPI persists the caller account's provider egress-host allowlist, which
// the router turns into a scoped connect-src CSP for the DEK-bearing app
// document (docs/cloud-crypto.md → egress allowlist). The client registers only
// provider HOSTNAMES here — never API keys, never health data.
type EgressAPI struct {
	store         egressStore
	sessionSecret string
}

// NewEgressAPI builds the egress-host handler.
func NewEgressAPI(store egressStore, sessionSecret string) *EgressAPI {
	return &EgressAPI{store: store, sessionSecret: sessionSecret}
}

// RegisterRoutes mounts the session-gated egress route on mux.
func (a *EgressAPI) RegisterRoutes(mux *http.ServeMux) {
	mux.Handle("PUT /api/egress-hosts", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.PutEgressHosts)))
}

type egressHostsRequest struct {
	Hosts []string `json:"hosts"`
}

// PutEgressHosts replaces the caller account's registered provider hostnames.
func (a *EgressAPI) PutEgressHosts(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var req egressHostsRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxEgressBodyBytes)).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if len(req.Hosts) > maxEgressHosts {
		http.Error(w, "too many hosts", http.StatusBadRequest)
		return
	}
	for _, h := range req.Hosts {
		if !validEgressHost(h) {
			http.Error(w, "invalid host", http.StatusBadRequest)
			return
		}
	}

	if err := a.store.SetEgressHosts(r.Context(), session.AccountID, req.Hosts); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// validEgressHost accepts a bare DNS hostname only — no scheme, port, path,
// query, userinfo, or IP-literal brackets. It rejects anything that could smuggle
// a second CSP source token (a space) or a path/scheme delimiter, so the emitted
// `https://<host>` source can never be broadened by the stored value itself.
func validEgressHost(h string) bool {
	if h == "" || len(h) > maxEgressHostLen {
		return false
	}
	if h != strings.ToLower(strings.TrimSpace(h)) {
		return false // force the client to send already-normalized hostnames
	}
	if strings.HasPrefix(h, ".") || strings.HasPrefix(h, "-") ||
		strings.HasSuffix(h, ".") || strings.HasSuffix(h, "-") || strings.Contains(h, "..") {
		return false
	}
	for _, c := range h {
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '-' {
			continue
		}
		return false
	}
	return true
}
