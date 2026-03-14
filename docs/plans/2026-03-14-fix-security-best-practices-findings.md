---
# Fix Security Best Practices Findings

## Overview
Implement fixes for 10 security findings identified in security_best_practices_report.md, focusing on critical/high priority issues: HTTP server hardening, request body limits, proxy trust configuration, and auth state storage security.

## Context
- Files involved: cmd/bot/main.go, internal/server/mcp_audit.go, internal/server/server.go, internal/bot/sleep_import.go, web/static/js/features/auth-flow.js, web/static/js/sync.js, internal/store/store.go
- Related patterns: httptest for HTTP handler tests, MaxBytesReader already used in many handlers
- Dependencies: None - all fixes are internal hardening

## Development Approach
- **Testing approach**: Regular (code first, then tests) - use httptest for HTTP handlers
- Complete each task fully before moving to the next
- Follow existing test patterns in internal/server/*_test.go
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Add HTTP Server Timeouts and Header Limits

**Files:**
- Modify: `cmd/bot/main.go:178-183`

- [ ] Add ReadHeaderTimeout: 10 * time.Second to http.Server config
- [ ] Add MaxHeaderBytes: 1 << 20 (1MB) to http.Server config
- [ ] Write test in cmd/bot/main_test.go to verify server configuration (create new test file)
- [ ] Verify server starts correctly with new settings
- [ ] run project test suite - must pass before task 2

### Task 2: Add Request Body Size Limits to MCP Audit Handler

**Files:**
- Modify: `internal/server/mcp_audit.go:38`

- [ ] Add r.Body = http.MaxBytesReader(w, r.Body, 1<<20) before io.ReadAll(r.Body) on line 38
- [ ] Update existing TestHandleMCPAudit to test body size limit (add test case for oversized body)
- [ ] Update existing TestHandleMCPAudit_InvalidSignature to include body size verification
- [ ] run project test suite - must pass before task 3

### Task 3: Change Proxy Trust Default to Distrust

**Files:**
- Modify: `internal/server/server.go:341`

- [ ] Change parseBoolEnv("AUTH_TRUST_PROXY", true) to parseBoolEnv("AUTH_TRUST_PROXY", false)
- [ ] Add comment explaining AUTH_TRUST_PROXY must be explicitly set when behind trusted reverse proxy
- [ ] Update .env.example (if exists) to document AUTH_TRUST_PROXY setting
- [ ] Write test in internal/server/auth_test.go to verify default proxy trust behavior
- [ ] run project test suite - must pass before task 4

### Task 4: Add HTTP Client Timeout to Sleep Import

**Files:**
- Modify: `internal/bot/sleep_import.go:72`

- [ ] Replace http.Get(fileURL) with http.Client{Timeout: 30 * time.Second}.Get(fileURL)
- [ ] Update #nosec G107 comment to note timeout is now set
- [ ] Write test in internal/bot/sleep_import_test.go (create new test file) to test timeout behavior with mock server
- [ ] run project test suite - must pass before task 5

### Task 5: Improve Debug Panel XSS Protection

**Files:**
- Modify: `web/static/js/sync.js:39, 69, 201`

- [ ] Add robust fallback for escapeHtml in window object: inline escape function with full HTML entity encoding
- [ ] Replace window['escapeHtml'] access with robust fallback that uses inline function if undefined
- [ ] Verify all innerHTML uses in sync.js have escape protection
- [ ] Add inline test helper function for escapeHtml to sync.js (can be run in browser console)
- [ ] run project test suite - must pass before task 6

### Task 6: Adjust HSTS and CSP Security Headers

**Files:**
- Modify: `internal/server/server.go:302-303`

- [ ] Reduce HSTS max-age from 31536000 (1 year) to 15552000 (~6 months) for operational flexibility
- [ ] Remove 'unsafe-inline' from style-src CSP if all styles are in external files (verify first)
- [ ] If inline styles exist, add comment documenting risk and 'unsafe-inline' necessity
- [ ] Write test in internal/server/server_handlers_test.go to verify security headers are set correctly
- [ ] run project test suite - must pass before task 7

### Task 7: Verify SQL Column Validation Allowlist

**Files:**
- Modify: `internal/store/store.go:2041, 2062` (only if allowlist needs updating)

- [ ] Review all fmt.Sprintf SQL queries in store.go that use dynamic columns
- [ ] Verify column validation allowlist includes all possible column values
- [ ] If any columns are missing, add them to the allowlist
- [ ] Add test in internal/store/store_test.go to verify only allowlisted columns are accepted
- [ ] run project test suite - must pass before task 8

### Task 8: Document Auth State Storage Risk

**Files:**
- Modify: `web/static/js/features/auth-flow.js`

- [ ] Add comment at top of auth-flow.js explaining localStorage auth cache is for UX only, not security
- [ ] Note that HttpOnly cookies provide the real authentication security
- [ ] Document that XSS on the page can read this cache, but it has no sensitive data
- [ ] No code changes needed - documentation only
- [ ] run project test suite - must pass before task 9

### Task 9: Document CORS Policy

**Files:**
- Create: `docs/security/cors-policy.md` (or add to README.md)

- [ ] Create documentation explaining no explicit CORS middleware is configured
- [ ] Document this is the correct default for self-hosted single-user application
- [ ] Add example for future CORS implementation if third-party integrations are needed
- [ ] run project test suite - must pass before task 10

### Task 10: Verify acceptance criteria

- [ ] manual test: Run application and verify all endpoints still work
- [ ] manual test: Test authentication flow with Telegram Mini App
- [ ] run full test suite: go test ./...
- [ ] verify all security report findings are addressed (check against security_best_practices_report.md)

### Task 11: Update documentation

- [ ] Update CLAUDE.md with new security configurations (AUTH_TRUST_PROXY, server timeouts)
- [ ] Update README.md if user-facing security changes needed
- [ ] Delete security_best_practices_report.md after findings are fixed
- [ ] Move this plan to docs/plans/completed/
