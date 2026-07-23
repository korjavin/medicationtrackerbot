## 2025-02-15 - [Title]
**Vulnerability:** DoS vulnerability in wait-for-HTTP healthcheck using `http.DefaultClient`.
**Learning:** `http.DefaultClient` has no configured timeout. If the server delays indefinitely, the request will block forever.
**Prevention:** Replace `http.DefaultClient` with `&http.Client{Timeout: 5 * time.Second}` in all HTTP requests where untrusted servers or unpredictable delays are involved.
