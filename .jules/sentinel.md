## 2026-04-18 - SSRF in JWKS Fetch
**Vulnerability:** The JWKS fetch function `refreshJWKS` dynamically constructed a URL using the user-provided `h.config.PocketIDURL` and fetched it via an HTTP client. This URL was missing scheme validation, allowing potential SSRF vulnerabilities (e.g., using `file://` or other schemes).
**Learning:** `gosec` statically flags dynamic URLs (G107), but developers must implement runtime checks (like `strings.HasPrefix`) and keep the `// #nosec G107` to satisfy the linter while actually protecting the app.
**Prevention:** Always validate URL schemes (e.g., ensure `http://` or `https://`) before making requests with user-supplied base URLs, and retain `#nosec` comments when employing runtime checks that static analysis cannot detect.
