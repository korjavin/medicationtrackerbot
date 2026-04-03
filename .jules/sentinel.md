## 2024-05-24 - Secure Oauth State Verification
**Vulnerability:** OAuth state parameter comparison in `handleOIDCCallback` was vulnerable to timing attacks due to the use of regular string inequality `!=`.
**Learning:** Oauth state verification should employ constant-time operations such as `subtle.ConstantTimeCompare`, as the state parameter functions as a security token against CSRF attacks. Relying on string comparison makes it susceptible to timing side-channel attacks that can theoretically allow an attacker to reconstruct the token.
**Prevention:** Always use `subtle.ConstantTimeCompare` (in Go) or `hmac.Equal` when comparing cryptographic secrets or tokens like signatures, hashes, and OAuth state values.

## 2025-05-14 - SQL Injection in SQL-Generating Tool
**Vulnerability:** SQL Injection in `cmd/importer/main.go` through direct string interpolation into SQL statements.
**Learning:** Tools that generate SQL scripts as text output are still vulnerable to SQL injection if user-provided strings are not properly escaped and quoted. Since parameterized queries are not applicable when generating a text script, manual escaping of single quotes and wrapping in single quotes is necessary.
**Prevention:** Implement a robust helper function to escape single quotes (e.g., doubling them for SQLite/standard SQL) and wrap string literals in single quotes when constructing SQL statements as strings.

## 2025-05-18 - Missing Request Size Limits in HTTP Handlers
**Vulnerability:** The MCP endpoint handler `/mcp` in `internal/mcp/mcp.go` was missing a limit on the HTTP request body size, making it vulnerable to DoS attacks via memory exhaustion from maliciously large payloads.
**Learning:** While other handlers used `http.MaxBytesReader` to limit payloads (e.g., to 1MB), the MCP server integration lacked this protection. Any endpoint parsing unbounded request bodies must enforce a strict size limit.
**Prevention:** Apply a middleware wrapper using `http.MaxBytesReader` around handlers that read the request body to enforce a safe maximum size (e.g., `1<<20` for 1MB).

## 2025-05-22 - Secure Hex Signature Comparison
**Vulnerability:** Comparing HMAC signatures by encoding the expected raw bytes to hex and doing `hmac.Equal` on the string representations of the hex characters.
**Learning:** While `hmac.Equal` handles equal-length strings securely, comparing hex string encodings rather than raw bytes is brittle and non-standard. A malformed signature length or string might bypass checks or leak expected length. Hex signatures should always be decoded *first*, catching any formatting errors early, before being compared using the raw 32-byte representations.
**Prevention:** Always decode external hex signatures via `hex.DecodeString()` and then use `hmac.Equal()` on the resulting byte slice against the unencoded computed MAC output.
