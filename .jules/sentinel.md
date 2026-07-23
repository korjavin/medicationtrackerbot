## 2025-04-18 - Missing Session Rotation on Authentication
**Vulnerability:** Session Fixation / Lack of Session Rotation (TM-010)
**Learning:** `createSessionToken` generated a deterministic token using only the user's email and server secret. Consequently, re-authenticating issued the exact same token value without rotation. A compromised token would remain valid indefinitely without explicit state tracking or embedded expiration.
**Prevention:** Incorporate a random component (e.g., a nonce) and a creation timestamp into the signed payload (e.g. `email|nonce|timestamp`) to ensure the token uniquely rotates on each issuance and allows the server to enforce an expiration window.
## 2026-04-18 - Unbounded HTTP Client Defaults in JWKS Fetch
**Vulnerability:** Resource exhaustion / Denial of Service via unbounded external HTTP fetches.
**Learning:** Initializing an `http.Client` with only a generic `Timeout` (e.g., 30s) leaves it vulnerable to Slowloris, hanging TLS handshakes, or decompression bombs if the underlying `Transport` defaults and response body reads (`io.ReadAll`) are unrestricted.
**Prevention:** Always explicitly configure a custom `http.Transport` (setting `DialContext`, `TLSHandshakeTimeout`), enforce a `context.WithTimeout` on the request, and wrap `resp.Body` in an `io.LimitReader` when reading external JSON payloads.
## 2025-04-19 - XSS Vulnerability in HTML String Replacement
**Vulnerability:** Cross-Site Scripting (XSS) via `r.Host` injected using `strings.ReplaceAll` instead of `html/template`.
**Learning:** Because the project serves HTML by reading static files and injecting variables (like `r.Host` or environmental overrides) via `strings.ReplaceAll`, it bypasses the automatic context-aware escaping provided by `html/template`. Unsanitized HTTP headers or external inputs injected directly into HTML payloads can lead to XSS.
**Prevention:** Always explicitly wrap injected variables derived from HTTP requests or external sources with `html.EscapeString()` when using string substitution for templating.
## 2026-06-25 - Rate Limiting Bypass via IP Spoofing (TM-009)
**Vulnerability:** IP Spoofing / Rate Limiting Bypass via X-Forwarded-For
**Learning:** Parsing the `X-Forwarded-For` header for the client IP by taking the leftmost element (`parts[0]`) allows trivial IP spoofing when behind a single trusted reverse proxy (like Traefik). An attacker can supply their own fake `X-Forwarded-For` header; Traefik appends the real IP to the end of the list, meaning the leftmost IP remains the attacker-controlled spoofed value. This breaks per-IP rate limiting by allowing the attacker to cycle through fake IPs.
**Prevention:** When behind a single trusted reverse proxy that appends the client IP to the `X-Forwarded-For` list, extract the rightmost non-empty element (`parts[len(parts)-1]`) to obtain the true IP that connected to the proxy.
## 2026-06-26 - Dynamic Column Name in SQL Queries
**Vulnerability:** SQL Injection (SQLi)
**Learning:** Building SQL queries using `fmt.Sprintf` to dynamically insert column names, even when protected by an allowlist map, is prone to human error and potential SQL injection vulnerabilities if the map is improperly maintained or bypassed. It's safer to avoid dynamic string concatenation entirely for structural SQL elements like column or table names.
**Prevention:** Use explicit `switch` statements mapping verified input directly to hardcoded, static SQL query strings. This completely eliminates the risk of dynamically injected structures while maintaining safety without relying on easily misconfigured maps.
## 2026-06-27 - [Add Timeouts to Default HTTP Clients]
**Vulnerability:** Use of default `http.Client{}` without timeouts in external API calls (e.g., OIDC userinfo, OpenFoodFacts).
**Learning:** Default HTTP clients in Go have no timeout, meaning a slow or unresponsive external server can cause goroutines to hang indefinitely, leading to resource exhaustion (DoS).
**Prevention:** Always initialize `http.Client` with explicit timeouts (e.g., `&http.Client{Timeout: 10 * time.Second}`) when making external requests.
## 2026-07-07 - Update Go Version for Security Patch
**Vulnerability:** Trivy reported multiple High/Critical vulnerabilities in the Go standard library (net/mail, net/http, net, crypto/x509, crypto/tls) (CVEs).
**Learning:** Container images and dependency trees that rely on an outdated minor or patch version of the Go toolchain retain the compiled vulnerable standard library functions. Regular security audits (like `trivy-container-scan`) require both the `go.mod` directive and the CI/Dockerfile environments to use the patched version.
**Prevention:** Monitor Trivy scan results regularly and upgrade the Go toolchain to the latest secure patch release across `go.mod`, GitHub Actions, and Docker base images whenever standard library vulnerabilities are reported.
## 2026-07-07 - Missing HTTP Request Body Size Limits
**Vulnerability:** Denial of Service (DoS) via unbounded HTTP request body sizes (Memory Exhaustion).
**Learning:** Many POST handlers read from `r.Body` via `json.NewDecoder` without wrapping the reader in an `http.MaxBytesReader`. An attacker can send a massively oversized JSON payload, forcing the server to buffer it in memory, leading to out-of-memory crashes.
**Prevention:** Always wrap `r.Body` with `http.MaxBytesReader(w, r.Body, maxBytes)` at the beginning of a handler that accepts request bodies to enforce a hard upper bound on memory consumption per request.
