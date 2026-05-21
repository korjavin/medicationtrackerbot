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
## 2026-05-18 - Fail-Open Authorization Defaults
**Vulnerability:** OAuth Token Bypass via Empty Allowed Subject (TM-008).
**Learning:** The `MCP_ALLOWED_SUBJECT` check allowed any subject to authenticate if the configuration string was empty or whitespace. This "fail-open" default contradicts secure-by-default design principles and could allow unauthorized OAuth clients to access read-only health data.
**Prevention:** Authorization lists or policies should enforce fail-closed behavior. Require explicit configurations for critical paths and evaluate empty string parameters as explicitly denied rather than unconditionally allowed.
