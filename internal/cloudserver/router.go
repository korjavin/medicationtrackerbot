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
// landing page, "<sub>.<base>" gets the account shell (unknown subdomains get
// a 404), and everything else is served from the same embedded static FS.
type Handler struct {
	baseDomain string
	store      accountStore
	static     http.Handler
}

// New builds the host-routing Handler. staticFS is the embedded web/cloud
// tree (cloudweb.FS) containing index.html, signup.html, css/, js/.
func New(baseDomain string, store accountStore, staticFS fs.FS) *Handler {
	return &Handler{
		baseDomain: baseDomain,
		store:      store,
		static:     http.FileServerFS(staticFS),
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

	if _, err := h.store.AccountBySubdomain(r.Context(), sub); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			http.NotFound(w, r)
			return
		}
		slog.Error("cloudserver: resolve account", "error", err, "subdomain", sub)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	// The account shell lives at signup.html (it self-selects claim wizard
	// vs. unlock flow at runtime — see web/cloud/js/app.js), not index.html.
	if r.URL.Path == "/" {
		r.URL.Path = "/signup.html"
	}
	h.static.ServeHTTP(w, r)
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
