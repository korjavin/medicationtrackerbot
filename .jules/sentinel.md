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
## 2024-06-01 - Fix OAuth audience/subject bypass (TM-008)
**Vulnerability:** The MCP server previously treated an empty `MCP_ALLOWED_SUBJECT` environment variable as "allow any subject," potentially permitting any valid OAuth token from the configured issuer to access sensitive health data if the audience validation was bypassed or broad (e.g. accepting a common Client ID).
**Learning:** Optional allowlists in authorization code often lead to fail-open behavior. If the configuration is missing or incorrectly mapped in the environment, the system gracefully degrades to zero authorization checks instead of failing fast.
**Prevention:** Always use fail-closed logic for authorization configurations. If a subject allowlist is a security boundary, its presence must be strictly enforced during initialization rather than defaulting to open access at runtime.
