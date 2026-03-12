# Add Security Headers Middleware

## Overview
Add a security headers middleware to the HTTP server that sets all missing security headers identified in the scan: COOP, CORP, CSP, HSTS, Permissions-Policy, Referrer-Policy, X-Content-Type-Options, and X-Frame-Options.

## Context
- Files involved: `internal/server/server.go`, `internal/server/server_handlers_test.go`
- Related patterns: existing `noCacheMiddleware` in `server.go` — follow the same pattern
- The app is a Telegram Mini App with inline `<script>` blocks and external scripts from `telegram.org` and `cdn.jsdelivr.net`, so CSP must allow `unsafe-inline` for scripts and those CDN origins

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Add securityHeadersMiddleware and apply it globally

**Files:**
- Modify: `internal/server/server.go`

- [ ] Add `securityHeadersMiddleware` function after the existing `noCacheMiddleware` function
- [ ] Set these headers in the middleware:
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: SAMEORIGIN`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()`
  - `Cross-Origin-Opener-Policy: same-origin-allow-popups` (looser than `same-origin` to not break Telegram OAuth popups)
  - `Cross-Origin-Resource-Policy: same-site`
  - `Strict-Transport-Security: max-age=31536000; includeSubDomains`
  - `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' https://telegram.org https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'self'`
- [ ] Wrap the entire mux returned from `Routes()` with `securityHeadersMiddleware` as the outermost layer
- [ ] Write a test in `internal/server/server_handlers_test.go` that makes a GET request to `/` and asserts each security header is present with the expected value
- [ ] Run `go test ./internal/server/...` — must pass

### Task 2: Verify acceptance criteria

- [ ] manual test: run the app and use curl or browser devtools to confirm headers appear on HTML pages, API responses, and static files
- [ ] run full test suite: `go test ./...`
- [ ] run linter: `go vet ./...`

### Task 3: Update documentation

- [ ] move this plan to `docs/plans/completed/`
