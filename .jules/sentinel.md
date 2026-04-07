## 2025-04-07 - Ephemeral Session Secrets Cause Silent Invalidation
**Vulnerability:** Application silently generated ephemeral (in-memory) session secrets (`generateSessionSecret`) if `SESSION_SECRET` was missing or too short, instead of failing on startup.
**Learning:** Generating ephemeral secrets on startup causes all active user sessions to be silently invalidated on every process restart or update, masking configuration errors and severely degrading user experience while appearing to "solve" a missing secret issue.
**Prevention:** For critical persistent secrets like `SESSION_SECRET`, always fail-fast using `os.Exit(1)` on application startup if the configuration is missing or insecure, forcing administrators to explicitly provision persistent credentials.
