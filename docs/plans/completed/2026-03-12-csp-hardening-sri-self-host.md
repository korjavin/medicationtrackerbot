# CSP Hardening: Remove unsafe-inline, CDN Whitelist, SRI, and Add base-uri

## Overview

Fix 4 MEDIUM CSP/SRI findings by: self-hosting the two CDN libraries (Dexie, ZXing), extracting the two inline config scripts to a server-generated endpoint, and updating the security headers middleware with a hardened CSP. This supersedes the existing `docs/plans/2026-03-12-security-headers-middleware.md` plan (which accepted unsafe-inline and cdn.jsdelivr.net).

## Context

- Files involved: `web/static/index.html`, `internal/server/server.go`, `internal/server/server_handlers_test.go`
- The two inline scripts in index.html (`window.BOT_USERNAME`, `window.OIDC_CONFIG`) are injected by `serveIndexWithBotUsername` via string replacement — moving them to a dedicated handler eliminates the need for `unsafe-inline` in script-src entirely
- Two CDN scripts at lines 19-20 of index.html reference `cdn.jsdelivr.net` — self-hosting them removes both the CDN whitelist finding and the SRI finding
- The existing `noCacheMiddleware` pattern in `server.go` shows how to add middleware
- The security headers middleware from the existing plan is included here with a hardened CSP

## Development Approach

- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Self-host Dexie.js and @zxing/library

**Files:**
- Create: `web/static/vendor/dexie.min.js` (download from jsDelivr: `https://cdn.jsdelivr.net/npm/dexie@3/dist/dexie.min.js`)
- Create: `web/static/vendor/zxing.min.js` (download from jsDelivr: `https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js`)
- Modify: `web/static/index.html`

- [ ] Download Dexie 3 minified bundle: `curl -o web/static/vendor/dexie.min.js https://cdn.jsdelivr.net/npm/dexie@3/dist/dexie.min.js`
- [ ] Download ZXing 0.21.3 UMD bundle: `curl -o web/static/vendor/zxing.min.js https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js`
- [ ] Replace the two cdn.jsdelivr.net script tags in index.html with `/static/vendor/dexie.min.js` and `/static/vendor/zxing.min.js`
- [ ] No tests needed for this task (static file change); manual spot-check that app loads
- [ ] Run `go test ./...` — must pass

### Task 2: Move inline config scripts to a server-generated endpoint

**Files:**
- Modify: `internal/server/server.go`
- Modify: `web/static/index.html`

- [ ] Add `serveConfigJS` handler on `*Server` that writes `Content-Type: application/javascript`, `Cache-Control: no-cache`, and returns `window.BOT_USERNAME = "<value>"; window.OIDC_CONFIG = <json>;` — reuse the same OIDC struct logic already in `serveIndexWithBotUsername`
- [ ] Register route `mux.HandleFunc("/static/config.js", s.serveConfigJS)` in `Routes()` before the `/static/` file server handler (exact match takes priority in Go mux)
- [ ] Remove the two inline `<script>window.BOT_USERNAME...` and `<script>window.OIDC_CONFIG...` blocks from index.html
- [ ] Add `<script src="/static/config.js"></script>` in their place (no cache-busting parameter needed since the handler already sends no-cache headers)
- [ ] Remove `BOT_USERNAME_PLACEHOLDER` and `OIDC_CONFIG_PLACEHOLDER` string replacements from `serveIndexWithBotUsername`
- [ ] Write test in `server_handlers_test.go`: GET `/static/config.js` returns 200, content-type application/javascript, body contains `window.BOT_USERNAME` and `window.OIDC_CONFIG`
- [ ] Run `go test ./internal/server/...` — must pass

### Task 3: Add security headers middleware with hardened CSP

**Files:**
- Modify: `internal/server/server.go`
- Modify: `internal/server/server_handlers_test.go`

- [ ] Add `securityHeadersMiddleware` function after `noCacheMiddleware`, setting these headers:
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: SAMEORIGIN`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()`
  - `Cross-Origin-Opener-Policy: same-origin-allow-popups`
  - `Cross-Origin-Resource-Policy: same-site`
  - `Strict-Transport-Security: max-age=31536000; includeSubDomains`
  - `Content-Security-Policy: default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; base-uri 'self'; frame-ancestors 'self'`
- [ ] Wrap the mux returned from `Routes()` with `securityHeadersMiddleware` as the outermost layer
- [ ] Write test: GET `/` asserts each security header is present with expected value; confirm `script-src` does NOT contain `unsafe-inline` or `cdn.jsdelivr.net`; confirm `base-uri 'self'` is present
- [ ] Run `go test ./internal/server/...` — must pass

### Task 4: Verify acceptance criteria

- [ ] Manual test: load the app in browser, open devtools Network tab, inspect response headers on `/` — confirm CSP is correct, no CDN references in script-src
- [ ] Manual test: confirm app works normally (Dexie and ZXing load from vendor paths, config loads from /static/config.js, bot username is set)
- [ ] Run full test suite: `go test ./...`
- [ ] Run linter: `go vet ./...`

### Task 5: Update documentation

- [ ] Archive the superseded plan: move `docs/plans/2026-03-12-security-headers-middleware.md` to `docs/plans/completed/`
- [ ] Move this plan to `docs/plans/completed/`
