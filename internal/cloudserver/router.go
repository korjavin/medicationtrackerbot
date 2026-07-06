// Package cloudserver holds cmd/cloud's HTTP handlers: host-based routing
// (base domain vs. per-account subdomain) plus, in later plans, the
// account-scoped WebAuthn and envelope API. It must never import
// internal/server, internal/domain, or internal/bot — see
// internal/cloudstore's arch_test.go for the durable import-boundary guard.
package cloudserver

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"strconv"
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
	domain     http.Handler // web/domain modules, mounted under /domain/
	appIndex   []byte       // web/static/index.html, served at "/" on subdomains
	api        http.Handler
}

// New builds the host-routing Handler. shellFS is the embedded web/cloud tree
// (cloudweb.FS) containing index.html, signup.html, css/, js/ — the passkey
// unlock/claim/recover wizard. appFS is the embedded web/static tree
// (webstatic.FS) — the real health-tracking frontend served to unlocked
// accounts, ported by C1. domainFS is the embedded web/domain tree
// (domainweb.FS) — the runtime-agnostic BP/weight modules, served under
// "/domain/" because web/cloud/js/apishim.js imports them from there
// (../../domain/*.js). api handles "/api/*" requests on the subdomain
// branch (nil serves 404 for them) — see WebAuthnAPI.Routes. foodDBURL is
// the operator's default FastFoodDB instance (CLOUD_FOOD_DB_URL, cmd/cloud)
// — a URL, not a secret; "" disables the operator default (remote food
// search stays local-only until the user sets their own in Settings).
func New(baseDomain string, store accountStore, shellFS fs.FS, appFS fs.FS, domainFS fs.FS, api http.Handler, foodDBURL string) *Handler {
	idx, err := fs.ReadFile(appFS, "index.html")
	if err != nil {
		panic("cloudserver: appFS missing index.html: " + err.Error())
	}
	return &Handler{
		baseDomain: baseDomain,
		store:      store,
		shell:      http.FileServerFS(shellFS),
		app:        http.StripPrefix("/static/", http.FileServerFS(appFS)),
		domain:     http.StripPrefix("/domain/", http.FileServerFS(domainFS)),
		appIndex:   injectCloudBoot(idx, foodDBURL),
		api:        api,
	}
}

// injectCloudBoot splices a config script (the operator's default food-DB
// URL, read by web/cloud/js/fooddb.js as window.__MEDTRACKER_FOOD_DB_URL__)
// and a classic (non-module) <script src="/js/cloud-boot.js"> tag right
// after <head>, served from cloudweb.FS's js/ directory via the default
// shell-fallback branch below. cloud-boot.js must run before every other
// web/static script — as a classic script it blocks parsing synchronously,
// setting window.__MEDTRACKER_CLOUD__ before messenger-adapter.js /
// app-shell.js / data-store.js ever check it — so it goes first, ahead of
// even native-bootstrap.js. web/static/index.html itself stays untouched;
// this only rewrites the copy cmd/cloud serves.
func injectCloudBoot(idx []byte, foodDBURL string) []byte {
	const marker = "<head>"
	inject := "<head>\n    <script>window.__MEDTRACKER_FOOD_DB_URL__ = " + strconv.Quote(foodDBURL) + ";</script>" +
		"\n    <script src=\"/js/cloud-boot.js\"></script>"
	out := bytes.Replace(idx, []byte(marker), []byte(inject), 1)
	if bytes.Equal(out, idx) {
		panic("cloudserver: index.html missing <head> to inject cloud-boot.js")
	}
	return out
}

// setSecurityHeaders hardens the E2EE origin. The threat model
// (docs/cloud-crypto.md) rates on-origin XSS as catastrophic — it can read the
// in-memory DEK and drive the non-extractable LDK — and names a strict CSP with
// zero third-party script as the real defense. Script/style/img/default stay
// self-only (no inline script/style, WebAuthn isn't CSP-governed).
//
// accountApp relaxes connect-src to `'self' https:` for the per-account app
// only: C2c food runs browser-direct calls to the user's own AI provider
// (aiclient.js) and food-DB (fooddb.js), whose origins are BYO/vault-secret and
// so unknowable server-side — a scoped allowlist is impossible. The base-domain
// signup/unlock shell makes no cross-origin calls and keeps connect-src 'self'.
func setSecurityHeaders(w http.ResponseWriter, accountApp bool) {
	h := w.Header()
	connectSrc := "connect-src 'self'"
	if accountApp {
		connectSrc = "connect-src 'self' https:"
	}
	h.Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; "+connectSrc+"; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	host := stripPort(r.Host)
	setSecurityHeaders(w, host != h.baseDomain)
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
	// the Emergency Kit redemption page (see web/cloud/js/recover.js), /devices
	// is the device-list page (warm-unlocks silently via the LDK cache, then
	// renders devices.js's list — see web/cloud/js/app.js). The shell's own
	// assets (css/js/vendor/sw.js) are root-relative — anything that isn't
	// "/", the shell's explicit paths, "/static/*" (the real app, C1), or
	// "/domain/*" (the runtime-agnostic BP/weight modules) is assumed to be
	// one of those and also goes to the shell.
	switch {
	case r.URL.Path == "/unlock" || r.URL.Path == "/claim" || r.URL.Path == "/recover" || r.URL.Path == "/devices":
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
	case strings.HasPrefix(r.URL.Path, "/domain/"):
		h.domain.ServeHTTP(w, r)
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
