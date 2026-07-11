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
	"html"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"strings"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

// accountStore is the subset of *cloudstore.Repo the router needs to resolve
// a subdomain to an account and read its egress-host allowlist (for the app
// document's scoped connect-src).
type accountStore interface {
	AccountBySubdomain(ctx context.Context, subdomain string) (*cloudstore.Account, error)
	EgressHosts(ctx context.Context, accountID string) ([]string, error)
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
	buildID    string       // asset fingerprint lifted out of appIndex; see version.go
	api        http.Handler
	mcp        http.Handler // Task 2: hosted-remote streamable-HTTP MCP endpoint, mounted at "/mcp/<token>"; nil until SetMCPHandler is called
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
// trialAI / trialVoice advertise the operator's trial-key proxy routes
// (docs/cloud-mode.md → Trial provider keys) as boolean <meta> flags —
// booleans only, never key/URL/model material (security invariant).
func New(baseDomain string, store accountStore, shellFS fs.FS, appFS fs.FS, domainFS fs.FS, api http.Handler, foodDBURL string, trialAI, trialVoice bool) *Handler {
	idx, err := fs.ReadFile(appFS, "index.html")
	if err != nil {
		panic("cloudserver: appFS missing index.html: " + err.Error())
	}
	buildID := buildIDFrom(idx)
	return &Handler{
		baseDomain: baseDomain,
		store:      store,
		shell:      http.FileServerFS(shellFS),
		app:        http.StripPrefix("/static/", http.FileServerFS(appFS)),
		domain:     http.StripPrefix("/domain/", http.FileServerFS(domainFS)),
		appIndex:   injectCloudBoot(idx, foodDBURL, trialAI, trialVoice, buildID),
		buildID:    buildID,
		api:        api,
	}
}

// SetMCPHandler wires the Task 2 hosted-remote streamable-HTTP MCP endpoint
// onto the router's "/mcp/<token>" path. Separate from New (rather than a
// constructor param) because it's built from *MCPRemoteAPI, which itself
// needs the router's account resolution at request time via
// AccountFromContext — a constructor-time cycle the two-step wiring avoids.
// Every existing router test leaves this nil, which 404s every /mcp/*
// request, same as an unmounted route.
func (h *Handler) SetMCPHandler(mcp http.Handler) {
	h.mcp = mcp
}

// BuildID exposes the asset fingerprint already served at GET /api/version, so
// /readyz can report which build answered without a second source of truth.
func (h *Handler) BuildID() string {
	return h.buildID
}

// injectCloudBoot splices the operator's default food-DB URL (as a
// CSP-safe <meta>, read by web/cloud/js/fooddb.js — an inline <script>
// would be blocked by our own script-src 'self', see setSecurityHeaders)
// and a classic (non-module) <script src="/js/cloud-boot.js"> tag right
// after <head>, served from cloudweb.FS's js/ directory via the default
// shell-fallback branch below. cloud-boot.js must run before every other
// web/static script — as a classic script it blocks parsing synchronously,
// setting window.__MEDTRACKER_CLOUD__ before messenger-adapter.js /
// app-shell.js / data-store.js ever check it — so it goes first, ahead of
// even native-bootstrap.js. web/static/index.html itself stays untouched;
// this only rewrites the copy cmd/cloud serves.
func injectCloudBoot(idx []byte, foodDBURL string, trialAI, trialVoice bool, buildID string) []byte {
	const marker = "<head>"
	inject := "<head>\n    <meta name=\"medtracker-food-db-url\" content=\"" + html.EscapeString(foodDBURL) + "\">"
	inject += "\n    <meta name=\"medtracker-build-id\" content=\"" + html.EscapeString(buildID) + "\">"
	if trialAI {
		inject += "\n    <meta name=\"medtracker-trial-ai\" content=\"1\">"
	}
	if trialVoice {
		inject += "\n    <meta name=\"medtracker-trial-voice\" content=\"1\">"
	}
	inject += "\n    <script src=\"/js/cloud-boot.js\"></script>"
	// Deferred module (unlike cloud-boot.js, which must block parsing): it only
	// compares the build-id meta above against GET /api/version and, on a
	// mismatch, offers the user a reload. Independent of unlock — a stale tab
	// should be told so whether or not the vault is open. See med-jb7.3.
	inject += "\n    <script type=\"module\" src=\"/js/update-check.js\"></script>"
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
// appDocument scopes connect-src to a per-account egress allowlist for the app
// document ("/") only: 'self' + each provider host the account registered
// (https://) + the fixed https://api.elevenlabs.io (+ wss:). C2c food runs
// browser-direct calls to the user's own AI provider (aiclient.js) and food-DB
// (fooddb.js); rather than a wildcard `https:` that lets an on-origin XSS POST
// the in-memory DEK + decrypted records to ANY origin (rated catastrophic in
// docs/cloud-crypto.md), the client registers its provider HOSTNAMES after
// unlock (PUT /api/egress-hosts) and the server emits exactly those hosts here.
// No document on the origin ever serves a wildcard-`https:` connect-src, so an
// XSS spawning a same-origin child frame inherits this same scoped allowlist
// and gains no new egress reach. HONEST RESIDUAL: an XSS can call the
// registration endpoint to add an attacker host and then force a reload to pick
// up the widened CSP — strictly harder than today's instant arbitrary-origin
// exfil (needs persistence + a navigation), not a total close. Same-origin
// fallbacks (trial AI /api/trial/*, operator-default food-db /api/food/*) are
// 'self' and need no allowlist entry. The base-domain shell, the passkey
// ceremony pages (/unlock, /claim, /recover, /devices, /connectors), and the
// /static/* + /domain/* asset responses make no app-realm fetches and keep
// connect-src 'self'.
//
// appDocument loads the @elevenlabs/client voice SDK as an ES module, but from
// OUR OWN origin (/static/vendor/elevenlabs-client.min.js) — no third-party
// script executes on the DEK-bearing page, so script-src keeps 'self' (bd
// med-7e7.1). blob: and data: remain because the SDK builds its AudioWorklets
// (rawAudioProcessor / audioConcatProcessor) from blob: URLs and Chrome falls
// back worklet-src → worker-src → script-src. Those are same-origin-authored
// blobs, not a foreign script host: an attacker who can mint a blob: script
// already has script execution.
//
// wss://api.elevenlabs.io is listed explicitly: the voice SDK opens a wss:
// socket, and relying on the CSP3 https:→wss: scheme-coercion match is fragile
// across browsers (WebKit/iOS Safari has been inconsistent).
func setSecurityHeaders(w http.ResponseWriter, appDocument bool, egressHosts []string) {
	h := w.Header()
	connectSrc := "connect-src 'self'"
	scriptSrc := "script-src 'self'"
	workerSrc := ""
	mediaSrc := ""
	if appDocument {
		connectSrc = buildConnectSrc(egressHosts)
		scriptSrc = "script-src 'self' blob: data:"
		workerSrc = "worker-src 'self' blob:; "
		mediaSrc = "media-src 'self' blob:; "
	}
	h.Set("Content-Security-Policy", "default-src 'self'; "+scriptSrc+"; style-src 'self'; img-src 'self'; "+workerSrc+mediaSrc+connectSrc+"; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
}

// buildConnectSrc renders the app document's scoped connect-src directive:
// 'self', each stored provider host as https://<host>, and the fixed
// ElevenLabs voice host (https + wss). Hosts are already normalized/validated by
// the egress endpoint; there is deliberately no bare `https:` or `wss:` token.
func buildConnectSrc(hosts []string) string {
	var b strings.Builder
	b.WriteString("connect-src 'self'")
	for _, host := range hosts {
		b.WriteString(" https://")
		b.WriteString(host)
	}
	b.WriteString(" https://api.elevenlabs.io wss://api.elevenlabs.io")
	return b.String()
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	host := stripPort(r.Host)
	// Strict connect-src 'self' by default. The app document ("/") overrides
	// this with its per-account scoped egress allowlist below, once the account
	// is resolved; every other path (shell, ceremony pages, /static/* + /domain/*
	// assets, /api/*) keeps 'self'.
	setSecurityHeaders(w, false, nil)
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

	// Ahead of the /api/ forward: the build id lives on the Handler (it is read
	// out of appIndex), not on any of the account-scoped API handlers.
	if r.URL.Path == "/api/version" {
		h.serveVersion(w, r)
		return
	}

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
	// renders devices.js's list — see web/cloud/js/app.js), and /connectors is
	// the Claude/MCP connector picker split out of it (connectors.js, med-lyv).
	// /connectors rather than /mcp: the relay's capability endpoint owns the
	// "/mcp/<token>" prefix below, and a shell page one slash away from it is a
	// trap for both readers and path matching.
	// The shell's own assets (css/js/vendor/sw.js) are root-relative — anything
	// that isn't "/", the shell's explicit paths, "/static/*" (the real app,
	// C1), or "/domain/*" (the runtime-agnostic BP/weight modules) is assumed
	// to be one of those and also goes to the shell.
	switch {
	case r.URL.Path == "/unlock" || r.URL.Path == "/claim" || r.URL.Path == "/recover" ||
		r.URL.Path == "/devices" || r.URL.Path == "/connectors":
		noStore(w)
		r.URL.Path = "/signup.html"
		h.shell.ServeHTTP(w, r)
		return
	case r.URL.Path == "/":
		// The app document holds the in-memory DEK + decrypted records; scope its
		// connect-src to this account's registered provider hosts (+ ElevenLabs).
		// A read failure degrades to the fixed allowlist (still no bare https:),
		// never to a wildcard.
		hosts, err := h.store.EgressHosts(r.Context(), account.ID)
		if err != nil {
			slog.Error("cloudserver: read egress hosts", "error", err, "subdomain", sub)
		}
		setSecurityHeaders(w, true, hosts)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.Write(h.appIndex)
		return
	case r.URL.Path == "/static/config.js":
		// The shared web/static index.html loads /static/config.js, which bot
		// mode generates on the fly (serveConfigJS: window.BOT_USERNAME +
		// window.OIDC_CONFIG). Cloud mode is passkey-only — no Telegram bot, no
		// OIDC — and has no such file, so without this it 404s (and the browser
		// refuses the text/plain body) on every load (med-eas.21). Serve the
		// cloud-appropriate defaults; the frontend already guards both globals to
		// exactly these values.
		w.Header().Set("Content-Type", "application/javascript")
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.Write([]byte("window.BOT_USERNAME = \"\";\nwindow.OIDC_CONFIG = {\"enabled\":false};\n"))
		return
	case strings.HasPrefix(r.URL.Path, "/static/"):
		noStore(w)
		h.app.ServeHTTP(w, r)
		return
	case strings.HasPrefix(r.URL.Path, "/domain/"):
		noStore(w)
		h.domain.ServeHTTP(w, r)
		return
	case strings.HasPrefix(r.URL.Path, "/mcp/"):
		if h.mcp == nil {
			http.NotFound(w, r)
			return
		}
		h.mcp.ServeHTTP(w, r)
		return
	}
	noStore(w)
	h.shell.ServeHTTP(w, r)
}

// noStore is the explicit cache policy for every asset cmd/cloud serves, and
// mirrors bot mode (internal/server/server.go). Cloud has two kinds of asset:
// /static/* + /domain/* carry a `?v=<build_ts>` fingerprint, but the shell's own
// files (/js/cloud-boot.js, /js/sync.js, /sw.js — injected and root-relative)
// carry none at all, so nothing would ever bust them. Revalidating everything is
// the one policy that is correct for both; long-lived immutable caching would
// only be safe if EVERY path were fingerprinted, and the shell's are not.
func noStore(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
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
