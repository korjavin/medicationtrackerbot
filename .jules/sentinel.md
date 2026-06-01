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
## 2026-04-19 - MCP OAuth Token Validation Subject Bypass
**Vulnerability:** OAuth audience/subject bypass (TM-008). The `MCP_ALLOWED_SUBJECT` environment variable configures an allowlist of subjects for the MCP server. However, it was not strictly enforced when loaded via `LoadConfigFromEnv` and could be empty, allowing any valid token from the Pocket-ID identity provider with a matching audience to access the sensitive MCP health endpoints.
**Learning:** Configurations that control authorization allowlists (like subject names or client IDs) should default to a secure posture (fail-closed). Leaving an allowlist optional enables a misconfiguration where the application grants access by default when the variable is omitted.
**Prevention:** Ensure that required security configurations (e.g., `MCP_ALLOWED_SUBJECT`) are explicitly validated during application startup, returning a fatal error if they are missing or empty, enforcing fail-closed behavior unless a specific explicit override is present.
