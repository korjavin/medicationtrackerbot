## 2025-04-18 - Missing Session Rotation on Authentication
**Vulnerability:** Session Fixation / Lack of Session Rotation (TM-010)
**Learning:** `createSessionToken` generated a deterministic token using only the user's email and server secret. Consequently, re-authenticating issued the exact same token value without rotation. A compromised token would remain valid indefinitely without explicit state tracking or embedded expiration.
**Prevention:** Incorporate a random component (e.g., a nonce) and a creation timestamp into the signed payload (e.g. `email|nonce|timestamp`) to ensure the token uniquely rotates on each issuance and allows the server to enforce an expiration window.
