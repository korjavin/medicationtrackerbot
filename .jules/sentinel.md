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
## 2026-07-24 - Missing http.MaxBytesReader wrappers leading to DoS memory exhaustion vector
**Vulnerability:** Found multiple JSON decoding paths (`BYO`, `EditReply`, and `CancelRefire` in `internal/cloudserver/telegram.go`) that used `json.NewDecoder` against HTTP request bodies without first wrapping `r.Body` in `http.MaxBytesReader`. While some used `io.LimitReader`, that alone does not properly close the underlying HTTP connection upon exceeding limits, making it insufficient for robust DoS protection.
**Learning:** `json.NewDecoder` is vulnerable to memory exhaustion attacks if unbounded or improperly bounded. A simple `io.LimitReader` truncates the stream, but the connection might remain open or cause other issues. Wrapping the request body via `r.Body = http.MaxBytesReader(w, r.Body, maxBytes)` is essential because it guarantees the connection will close when the limit is reached, signaling a standard 413 Request Entity Too Large.
**Prevention:** Establish a strict pattern: all JSON decoding operations against HTTP request bodies must use `http.MaxBytesReader`. Use a linter or manual review to verify that `r.Body` is reassigned using this function prior to being passed into `json.NewDecoder`.
## 2026-07-24 - Rate Limiting: Browser-Hit Endpoints Only, Not Webhooks
**Vulnerability:** Unauthenticated, browser-hit endpoints (`GET /api/push/vapid-public-key`, `POST /api/transfer/{slot_id}/claim`) lacked per-IP rate limiting, exposing them to hammering / brute-force.
**Learning:** Per-IP rate limiting (`limitByIP` keyed on the last X-Forwarded-For hop) is correct ONLY for endpoints hit directly by distinct client browsers. It is the WRONG primitive for Telegram webhooks (`POST /tg/manager/{secret}`, `POST /tg/bot/{ref}/{secret}`): Telegram delivers all webhook fan-in from a small set of shared Telegram server IPs, so a shared-source-IP limit collectively throttles ALL bots'/users' legitimate traffic (429 → dropped messages). Those webhooks are already authenticated by the path secret.
**Prevention:** Rate-limit unauthenticated endpoints that real client browsers hit directly. For webhooks, rely on the path secret + request body-size limits + fast rejection, NOT a shared-source-IP limit. Never blanket-apply `limitByIP` to webhook routes.
## 2026-07-25 - Missing Rate Limiting on ShimSocket Endpoint
**Vulnerability:** Rate Limiting Bypass / Endpoint Brute-Forcing
**Learning:** The unauthenticated `GET /api/mcp/relay/shim` endpoint lacked per-IP rate limiting, leaving it exposed to brute-force attacks on pairing IDs or potential DoS via hammering. Unauthenticated browser-hit endpoints should always be protected with rate limiting.
**Prevention:** Ensure `limitByIP` is consistently applied to all unauthenticated browser-facing routes, particularly those validating dynamic identifiers (like pairing IDs), to prevent brute force and connection exhaustion.
## 2026-08-11 - Unhandled PRNG Error in Session Token Generation
**Vulnerability:** Weak Session Token / Predictable Tokens
**Learning:** Generating nonces for session tokens using `rand.Read(nonce)` without checking the returned error can lead to a silent failure. If the system's entropy pool is depleted or the PRNG fails, the byte slice remains zero-initialized, resulting in predictable session tokens and severely weakened cryptographic strength.
**Prevention:** Always check the error returned by `crypto/rand.Read`. If it fails to generate random bytes for security-sensitive purposes (like session tokens or encryption keys), fail securely by returning an error or panicking (since a PRNG failure is typically an unrecoverable state).
## 2026-08-11 - Rate Limiting Bypass on Legacy Auth Endpoints
**Vulnerability:** Rate Limiting Bypass / Brute Force
**Learning:** In `internal/server/server.go`, the legacy backward-compatibility authentication routes (`/auth/google/login` and `/auth/google/callback`) were configured using `mux.HandleFunc` without the `authLimit` middleware. Because newer routes (`/auth/oidc/login`) were correctly wrapped using `mux.Handle("/...", authLimit(...))`, attackers could bypass the intended rate limits simply by targeting the older, un-wrapped endpoints.
**Prevention:** When introducing newer, rate-limited aliases for existing endpoints, always ensure that all backward-compatibility paths mapping to the same underlying handler are also wrapped with the exact same rate-limiting middleware to prevent trivial bypasses.

## 2026-08-18 - Fix DoS vulnerability in Telegram webhook
**Vulnerability:** Telegram webhook handlers `ManagerWebhook` and `ChildWebhook` in `internal/cloudserver/telegram.go` used `io.LimitReader` directly inside `io.ReadAll` for request bodies. While `io.LimitReader` bounds the read, the HTTP server might still try to consume the remainder of the oversized request body to keep the connection alive, potentially leading to resource exhaustion (DoS).
**Learning:** `io.LimitReader` silently truncates payloads over the limit, causing downstream parsing errors, but does not explicitly close the connection when the limit is exceeded.
**Prevention:** Always wrap `r.Body` with `http.MaxBytesReader(w, r.Body, maxBytes)` before reading or decoding the request body in HTTP POST handlers. `MaxBytesReader` explicitly returns an error if the limit is exceeded and signals the server to close the underlying connection, successfully mitigating potential Denial of Service (DoS) attacks via oversized payloads.
