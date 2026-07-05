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
// landing page, "<sub>.<base>" gets the real web/static app (with the
// passkey unlock/claim/recover shell at explicit paths) + account-scoped
// API (unknown subdomains get a 404).
type Handler struct {
	baseDomain string
	store      accountStore
	shell      http.Handler // web/cloud: base-domain landing page + /unlock, /claim, /recover
	app        http.Handler // web/static assets, mounted under /static/
	appIndex   []byte       // web/static/index.html, served at "/" on subdomains
	api        http.Handler
}

// New builds the host-routing Handler. shellFS is the embedded web/cloud tree
// (cloudweb.FS) containing index.html, signup.html, css/, js/ — the passkey
// unlock/claim/recover wizard. appFS is the embedded web/static tree
// (webstatic.FS) — the real health-tracking frontend served to unlocked
// accounts, ported by C1. api handles "/api/*" requests on the subdomain
// branch (nil serves 404 for them) — see WebAuthnAPI.Routes.
func New(baseDomain string, store accountStore, shellFS fs.FS, appFS fs.FS, api http.Handler) *Handler {
	idx, err := fs.ReadFile(appFS, "index.html")
	if err != nil {
		panic("cloudserver: appFS missing index.html: " + err.Error())
	}
	return &Handler{
		baseDomain: baseDomain,
		store:      store,
		shell:      http.FileServerFS(shellFS),
		app:        http.StripPrefix("/static/", http.FileServerFS(appFS)),
		appIndex:   idx,
		api:        api,
	}
}

// setSecurityHeaders hardens the E2EE origin. The threat model
// (docs/cloud-crypto.md) rates on-origin XSS as catastrophic — it can read the
// in-memory DEK and drive the non-extractable LDK — and names a strict CSP with
// zero third-party script as the real defense. The shell loads only same-origin
// modules/CSS (no inline script/style, WebAuthn isn't CSP-governed), so a
// self-only policy holds without exceptions.
func setSecurityHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	setSecurityHeaders(w)
	host := stripPort(r.Host)
	if host == h.baseDomain {
		h.shell.ServeHTTP(w, r)
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

	// The passkey shell lives at signup.html (it self-selects claim wizard,
	// device-transfer claim, or unlock flow at runtime — see
	// web/cloud/js/app.js), reached via explicit paths: /unlock is the
	// warm/cold unlock landing page, /claim is the QR/typed-fallback
	// hand-off page (see web/cloud/js/transfer.js; its slot id + TK ride the
	// URL fragment, which browsers never send to the server), /recover is
	// the Emergency Kit redemption page (see web/cloud/js/recover.js). The
	// shell's own assets (css/js/vendor/sw.js) are root-relative — anything
	// that isn't "/", the shell's explicit paths, or "/static/*" (the real
	// app, C1) is assumed to be one of those and also goes to the shell.
	switch {
	case r.URL.Path == "/unlock" || r.URL.Path == "/claim" || r.URL.Path == "/recover":
		r.URL.Path = "/signup.html"
		h.shell.ServeHTTP(w, r)
		return
	case r.URL.Path == "/":
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(h.appIndex)
		return
	case strings.HasPrefix(r.URL.Path, "/static/"):
		h.app.ServeHTTP(w, r)
		return
	}
	h.shell.ServeHTTP(w, r)
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
