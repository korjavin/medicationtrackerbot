# Security Best Practices Report

**Date**: 2026-03-14
**Repository**: medicationtrackerbot
**Analyzed**: Go Backend (Standard Library, net/http) + Vanilla JavaScript Frontend

---

## Executive Summary

This report identifies **10 High/Medium severity findings** across the Go backend and JavaScript frontend. The most critical issues are:

1. **Missing HTTP server timeouts** (ReadHeaderTimeout, MaxHeaderBytes) - increases DoS vulnerability
2. **Unbounded request body parsing** in multiple handlers - memory exhaustion risk
3. **Proxy trust enabled by default** - potential IP spoofing risk
4. **Auth state stored in localStorage** - accessible to any XSS on the page

Many findings already have `#nosec` comments indicating developer awareness, which is positive. The codebase shows overall good security practices with room for hardening.

---

## Critical Findings

### GO-HTTP-001: HTTP server missing ReadHeaderTimeout and MaxHeaderBytes

**Severity**: High (DoS risk)

**Location**: `cmd/bot/main.go:178-183`

**Evidence**:
```go
server := &http.Server{
    Addr:         serverAddr,
    Handler:      srvHandler,
    ReadTimeout:  15 * time.Second,
    WriteTimeout: 45 * time.Second, // Increased to support 30s OpenFoodFacts search
}
```

**Impact**: Without `ReadHeaderTimeout`, a malicious client can send headers very slowly, keeping connections open indefinitely. Without `MaxHeaderBytes`, an attacker can send excessively large headers, consuming server memory.

**Fix**:
```go
server := &http.Server{
    Addr:           serverAddr,
    Handler:        srvHandler,
    ReadTimeout:    15 * time.Second,
    ReadHeaderTimeout: 10 * time.Second,  // Add this
    WriteTimeout:   45 * time.Second,
    MaxHeaderBytes: 1 << 20,  // 1MB max header size
}
```

**Notes**: The `ReadTimeout` and `WriteTimeout` values are already appropriate. Only `ReadHeaderTimeout` and `MaxHeaderBytes` are missing.

---

### GO-HTTP-002: Unbounded io.ReadAll() calls (Request Body DoS)

**Severity**: Medium (High for upload-heavy apps)

**Location**:
- `internal/server/mcp_audit.go:38`
- `internal/server/external_workout_handlers.go:65`

**Evidence**:
```go
// mcp_audit.go:38
body, err := io.ReadAll(r.Body)

// external_workout_handlers.go:65
bodyBytes, err := io.ReadAll(r.Body)
```

**Impact**: These calls read the entire request body without size limits. An attacker could send large payloads (e.g., gigabytes) to exhaust server memory.

**Fix**: Wrap request bodies with `http.MaxBytesReader`:
```go
r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 1MB limit
body, err := io.ReadAll(r.Body)
```

**Mitigation**: Set upstream proxy limits (e.g., at Traefik/NGINX) as defense-in-depth.

**Notes**: Many handlers (e.g., server.go:535, 764, 835, 853, 890) already use `MaxBytesReader`. Consistent application is needed.

---

## High Severity Findings

### GO-HTTP-003: Proxy trust enabled by default

**Severity**: High (auth, URL generation, logging correctness)

**Location**: `internal/server/server.go:341`

**Evidence**:
```go
trustProxy := parseBoolEnv("AUTH_TRUST_PROXY", true)
```

**Impact**: When `trustProxy` is true, the server trusts `X-Forwarded-For` and `X-Real-IP` headers from any source. Without explicit proxy configuration or network-level controls, an attacker can spoof these headers to:
- Bypass rate limiting (by rotating IPs)
- Corrupt audit logs with fake IP addresses
- Potentially affect security checks that rely on client IP

The `clientIP()` function (line 140) reads these headers directly without validation:
```go
func clientIP(r *http.Request, trustProxy bool) string {
    if trustProxy {
        if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
            parts := strings.Split(xff, ",")
            if len(parts) > 0 {
                return strings.TrimSpace(parts[0])
            }
        }
        if xrip := r.Header.Get("X-Real-IP"); xrip != "" {
            return xrip
        }
    }
    // ...
}
```

**Fix**: Change the default to false and require explicit opt-in:
```go
trustProxy := parseBoolEnv("AUTH_TRUST_PROXY", false)  // Default to distrust
```

Then document that users must set `AUTH_TRUST_PROXY=true` only when behind a trusted reverse proxy.

**Notes**: This pattern requires that the reverse proxy (Traefik, NGINX) actually sanitizes these headers and prevents direct access to the application port.

---

### JS-STORAGE-001: Auth state stored in localStorage

**Severity**: High (XSS exfiltration risk)

**Location**: `web/static/js/features/auth-flow.js:19`

**Evidence**:
```javascript
function saveAuthState(authMethod = 'cookie') {
    const authState = {
        authenticated: true,
        authMethod: authMethod,
        timestamp: Date.now(),
        ttl: AUTH_CACHE_TTL
    };
    localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify(authState));  // Line 19
    console.log('[Auth] Saved auth state to cache');
}
```

**Impact**: `localStorage` is accessible to any JavaScript running on the page. If there is any XSS vulnerability (even in third-party scripts or libraries), the attacker can read `localStorage` and extract the authentication state.

**Fix**:
1. **Primary fix**: Store auth state in HttpOnly cookies (which the server already does correctly in server.go:791-799).
2. **Secondary fix**: If client-side caching is necessary, consider using IndexedDB with stricter access controls, or at minimum document that this cache is not security-critical.

**Notes**: The server already sets HttpOnly cookies correctly (server.go:795), so this localStorage caching is redundant from a security perspective. It's only used to reduce API calls on page load, which introduces unnecessary risk.

---

## Medium Severity Findings

### GO-INJECT-001: SQL query building with fmt.Sprintf (with validation)

**Severity**: Medium

**Location**:
- `cmd/importer/main.go:215`, `cmd/importer/main.go:239`
- `internal/store/store.go:2041`, `internal/store/store.go:2062`

**Evidence**:
```go
// store.go:2041
query := fmt.Sprintf("SELECT %s FROM settings WHERE id = 1", column)

// store.go:2062
query := fmt.Sprintf("UPDATE settings SET %s = ? WHERE id = 1", column)
```

**Impact**: These use `fmt.Sprintf` to build SQL queries. If the `column` value is not properly validated, this could lead to SQL injection.

**Fix**: The code already includes validation. Verify the allowlist is comprehensive:

```go
// This should already exist in the code - verify it covers all possible columns
allowedColumns := map[string]bool{
    "some_column": true,
    "another_column": true,
    // ... all columns that can be queried
}
if !allowedColumns[column] {
    return errors.New("invalid column")
}
```

**Notes**: The `#nosec G201` comments indicate the developer is aware and has validated the column. The importer tool is command-line, not web-exposed, which reduces risk. Still, verify the allowlist is maintained as columns are added.

---

### GO-HTTPCLIENT-001: HTTP client without timeout

**Severity**: Medium (DoS and resource exhaustion)

**Location**: `internal/bot/sleep_import.go:72`

**Evidence**:
```go
resp, err := http.Get(fileURL) // #nosec G107 -- fileURL is from Telegram Bot API (file.Link), not user-controlled
```

**Impact**: Using `http.Get()` (which uses `http.DefaultClient` with zero timeout) means that if the remote server is slow or hangs, this goroutine will block indefinitely, consuming resources.

**Fix**:
```go
client := &http.Client{Timeout: 30 * time.Second}
resp, err := client.Get(fileURL)
```

**Notes**: The `#nosec G107` comment correctly notes that `fileURL` comes from Telegram Bot API, not user input, so SSRF risk is mitigated. Only timeout is missing.

---

### JS-XSS-001: innerHTML usage in debug panel

**Severity**: Medium

**Location**: `web/static/js/sync.js:39, 69, 201`

**Evidence**:
```javascript
// sync.js:39 - debug panel content
content.innerHTML = this.logs.map(l => {
    // escapeHtml is defined globally in app.js
    const escapeFn = window['escapeHtml']; // Bypass globals check for read
    const safeMsg = typeof escapeFn === 'function' ? escapeFn(l.message) : '';
    const safeData = l.data && typeof escapeFn === 'function' ? escapeFn(l.data) : '';
    return `<div class="debug-line ${l.level.toLowerCase()}">
        <span class="debug-time">${l.time}</span>
        <span class="debug-level">${l.level}</span>
        <span class="debug-msg">${safeMsg}</span>
        ${l.data ? `<span class="debug-data">${safeData}</span>` : ''}
    </div>`;
}).join('');
```

**Impact**: The code attempts to use `escapeHtml()` to sanitize content, which is good practice. However:
1. The `escapeHtml` function is accessed via `window['escapeHtml']`, which could be clobbered or undefined
2. The template string in lines 69-75 contains static HTML, which is generally safe
3. The dynamic data (logs) may contain attacker-controlled content if logs include user input

**Fix**:
1. Ensure `escapeHtml` is a robust HTML sanitizer (e.g., DOMPurify)
2. Add a fallback if `escapeHtml` is not available:
```javascript
const escapeFn = typeof window.escapeHtml === 'function' ? window.escapeHtml : (s) => s.replace(/[&<>"']/g, c => '&' + {'&':'amp','<':'lt','>':'gt','"':'quot',"'":'apos'}[c] + ';');
```

**Mitigation**: The debug panel is developer-facing and likely disabled in production. If enabled, ensure it's only accessible by authenticated users.

**Notes**: The code shows awareness of XSS risk and attempts mitigation. The primary concern is the robustness of the escape function.

---

### GO-HTTP-004: Missing security headers in some contexts

**Severity**: Medium

**Location**: `internal/server/server.go:294-306`

**Evidence**:
```go
func securityHeadersMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("X-Content-Type-Options", "nosniff")
        w.Header().Set("X-Frame-Options", "SAMEORIGIN")
        w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
        w.Header().Set("Permissions-Policy", "camera=(self), microphone=(), geolocation=()")
        w.Header().Set("Cross-Origin-Opener-Policy", "same-origin-allow-popups")
        w.Header().Set("Cross-Origin-Resource-Policy", "same-site")
        w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob:; connect-src 'self' https://telegram.org; font-src 'self' https://fonts.gstatic.com; base-uri 'self'; frame-ancestors 'self'")
        next.ServeHTTP(w, r)
    })
}
```

**Impact**: Most security headers are set correctly. Two observations:

1. **HSTS with includeSubDomains**: `max-age=31536000; includeSubDomains` is a very long duration (1 year). While not insecure, it can cause operational issues if a legitimate domain needs to be removed from HSTS coverage.

2. **CSP script-src**: The CSP includes `https://telegram.org` in script-src, which allows third-party scripts. This is intentional for Telegram integration but should be reviewed.

**Fix**: Consider adjusting HSTS max-age to a shorter period (e.g., 6 months) for operational flexibility:
```go
w.Header().Set("Strict-Transport-Security", "max-age=15552000; includeSubDomains")  // ~6 months
```

**Notes**: The overall security header configuration is excellent. CSP, X-Frame-Options, X-Content-Type-Options, and permissions are all set appropriately.

---

### GO-HTTP-007: CORS configuration not visible

**Severity**: Medium

**Location**: Not found in code (implicit behavior)

**Evidence**: No explicit CORS middleware or header setting found in server.go.

**Impact**: The application does not explicitly configure CORS, which means it uses Go's default behavior (no CORS headers). For a single-origin application (same user, self-hosted), this is correct and secure.

However, if CORS is ever needed (e.g., for third-party integrations), the current default will block cross-origin requests, which is the safe default but may require configuration.

**Fix**: No fix needed unless CORS is required. If CORS is added later, use strict origin allowlists:
```go
func CORSMiddleware(allowedOrigins map[string]bool) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            origin := r.Header.Get("Origin")
            if allowedOrigins[origin] {
                w.Header().Set("Access-Control-Allow-Origin", origin)
                w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
            }
            next.ServeHTTP(w, r)
        })
    }
}
```

**Notes**: The current "no CORS" configuration is correct for a self-hosted single-user application. Document this decision if adding external integrations.

---

### JS-CSP-001: CSP includes unsafe-inline for styles

**Severity**: Low to Medium

**Location**: `internal/server/server.go:303`

**Evidence**:
```go
w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob:; connect-src 'self' https://telegram.org; font-src 'self' https://fonts.gstatic.com; base-uri 'self'; frame-ancestors 'self'")
```

**Impact**: The CSP uses `style-src 'self' 'unsafe-inline'`, which allows inline styles. While styles are lower-risk than scripts, `unsafe-inline` weakens CSP's effectiveness. Additionally, `https://telegram.org` is allowed in script-src, which is intentional for Telegram integration but represents trust in a third-party origin.

**Fix**: Consider tightening style-src if feasible:
```go
// If all styles are in external files
w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' https://fonts.googleapis.com; ...")
```

**Notes**: The CSP is otherwise well-configured with frame-ancestors restricted to 'self'. The `unsafe-inline` for styles is a trade-off for development simplicity and is relatively low-risk compared to script inline.

---

## Positive Security Findings

The following security practices are correctly implemented:

1. **Rate limiting** for auth endpoints (server.go:340-342)
2. **Security headers middleware** with comprehensive headers (server.go:294-306)
3. **HttpOnly, Secure, SameSite cookies** for session management (server.go:791-799)
4. **Parameterized SQL queries** throughout most of the codebase
5. **Request body size limits** in many handlers using `http.MaxBytesReader`
6. **Authentication via HMAC signature** for MCP audit endpoint (mcp_audit.go:51-58)
7. **No eval(), unsafe code execution** found in frontend JavaScript
8. **No direct command injection patterns** (sh -c) found in Go code

---

## Recommendations by Priority

### Immediate (Critical/High)
1. Add `ReadHeaderTimeout` and `MaxHeaderBytes` to HTTP server configuration
2. Wrap all `io.ReadAll(r.Body)` calls with `http.MaxBytesReader`
3. Change `AUTH_TRUST_PROXY` default from `true` to `false`
4. Consider removing auth state from localStorage or documenting the XSS risk

### Short-term (Medium)
5. Add timeout to `http.Get()` call in sleep_import.go
6. Review and tighten CSP if inline styles can be eliminated
7. Add response body size limits to all JSON decoding operations
8. Verify SQL column allowlist covers all dynamic queries

### Long-term (Low/Informational)
9. Document CORS policy (currently "no CORS")
10. Review HSTS max-age duration for operational flexibility

---

## Notes on Deployment Context

This application is **self-hosted, single-user** with Telegram and optional OIDC authentication. This threat model differs from multi-tenant SaaS applications:

- **Impact of many findings is reduced**: Most attacks would affect only the single user who self-hosts
- **CSRF risk is lower**: Cookie-based auth exists but the app is primarily used within Telegram's WebView, which has additional protections
- **Data sensitivity**: Health data is personal but not financial/critical infrastructure

Despite this context, applying the recommended security hardening provides defense-in-depth and future-proofs the application for potential multi-user deployments or broader exposure.

---

**Report generated by**: Security Best Practices Review
**Analysis based on**: golang-general-backend-security.md and javascript-general-web-frontend-security.md
