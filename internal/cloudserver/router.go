// Package cloudserver holds cmd/cloud's HTTP handlers: host-based routing
// (base domain vs. per-account subdomain) plus, in later plans, the
// account-scoped WebAuthn and envelope API. It must never import
// internal/server, internal/domain, or internal/bot — see
// internal/cloudstore's arch_test.go for the durable import-boundary guard.
package cloudserver

import (
	"context"
	"database/sql"
	"errors"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"strings"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

// accountStore is the subset of *cloudstore.Repo the router needs to resolve
// a subdomain to an account.
type accountStore interface {
	AccountBySubdomain(ctx context.Context, subdomain string) (*cloudstore.Account, error)
}

// Handler routes requests by Host: the exact base domain gets the static
// landing page, "<sub>.<base>" gets the account shell + account-scoped API
// (unknown subdomains get a 404), and everything else is served from the same
// embedded static FS.
type Handler struct {
	baseDomain string
	store      accountStore
	static     http.Handler
	api        http.Handler
}

// New builds the host-routing Handler. staticFS is the embedded web/cloud
// tree (cloudweb.FS) containing index.html, signup.html, css/, js/. api
// handles "/api/*" requests on the subdomain branch (nil serves 404 for
// them) — see WebAuthnAPI.Routes.
func New(baseDomain string, store accountStore, staticFS fs.FS, api http.Handler) *Handler {
	return &Handler{
		baseDomain: baseDomain,
		store:      store,
		static:     http.FileServerFS(staticFS),
		api:        api,
	}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	host := stripPort(r.Host)
	if host == h.baseDomain {
		h.static.ServeHTTP(w, r)
		return
	}

	sub, ok := strings.CutSuffix(host, "."+h.baseDomain)
	if !ok || sub == "" {
		http.NotFound(w, r)
		return
	}

	account, err := h.store.AccountBySubdomain(r.Context(), sub)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			http.NotFound(w, r)
			return
		}
		slog.Error("cloudserver: resolve account", "error", err, "subdomain", sub)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	r = r.WithContext(withAccount(r.Context(), account))

	if strings.HasPrefix(r.URL.Path, "/api/") {
		if h.api == nil {
			http.NotFound(w, r)
			return
		}
		h.api.ServeHTTP(w, r)
		return
	}

	// The account shell lives at signup.html (it self-selects claim wizard
	// vs. unlock flow at runtime — see web/cloud/js/app.js), not index.html.
	if r.URL.Path == "/" {
		r.URL.Path = "/signup.html"
	}
	h.static.ServeHTTP(w, r)
}

// accountCtxKey is the context key the resolved account is stashed under by
// ServeHTTP, so account-scoped API handlers (webauthn.go) don't need a second
// AccountBySubdomain round trip.
type accountCtxKey struct{}

func withAccount(ctx context.Context, a *cloudstore.Account) context.Context {
	return context.WithValue(ctx, accountCtxKey{}, a)
}

// AccountFromContext returns the account resolved for this request's
// subdomain host. Only set for requests routed through Handler's subdomain
// branch.
func AccountFromContext(ctx context.Context) (*cloudstore.Account, bool) {
	a, ok := ctx.Value(accountCtxKey{}).(*cloudstore.Account)
	return a, ok
}

// stripPort mirrors net/http's canonical host-header handling: dev requests
// carry a ":port" suffix (e.g. "acme.localhost:8080") that must not be
// compared against the bare base domain.
func stripPort(host string) string {
	if h, _, err := net.SplitHostPort(host); err == nil {
		return h
	}
	return host
}
