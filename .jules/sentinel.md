## 2024-05-24 - Secure Oauth State Verification
**Vulnerability:** OAuth state parameter comparison in `handleOIDCCallback` was vulnerable to timing attacks due to the use of regular string inequality `!=`.
**Learning:** Oauth state verification should employ constant-time operations such as `subtle.ConstantTimeCompare`, as the state parameter functions as a security token against CSRF attacks. Relying on string comparison makes it susceptible to timing side-channel attacks that can theoretically allow an attacker to reconstruct the token.
**Prevention:** Always use `subtle.ConstantTimeCompare` (in Go) or `hmac.Equal` when comparing cryptographic secrets or tokens like signatures, hashes, and OAuth state values.

## 2025-05-14 - SQL Injection in SQL-Generating Tool
**Vulnerability:** SQL Injection in `cmd/importer/main.go` through direct string interpolation into SQL statements.
**Learning:** Tools that generate SQL scripts as text output are still vulnerable to SQL injection if user-provided strings are not properly escaped and quoted. Since parameterized queries are not applicable when generating a text script, manual escaping of single quotes and wrapping in single quotes is necessary.
**Prevention:** Implement a robust helper function to escape single quotes (e.g., doubling them for SQLite/standard SQL) and wrap string literals in single quotes when constructing SQL statements as strings.
