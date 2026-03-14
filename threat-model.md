# Medication Tracker Bot - Threat Model

**Repository**: `medicationtrackerbot`
**Date**: 2026-03-14
**Scope**: Runtime application (main bot + web server, MCP server)

---

## Executive Summary

This medication tracker bot is a single-user, self-hosted health tracking application with Telegram chat and web interfaces. The highest-risk areas are:

1. **MCP Server OAuth Token Validation** - The MCP server exposes read-only health data via OAuth with Pocket-ID; a token validation bypass or audience claim misconfiguration could allow unauthorized data access.

2. **Session Token Secret Management** - The `SESSION_SECRET` signs OIDC session cookies; if leaked or predictable, an attacker could forge sessions and gain full access to the user's health data.

3. **Litestream Backup Credentials** - R2/S3 access keys are stored in environment variables; if compromised, an attacker could exfiltrate the entire SQLite database including all health history.

4. **Telegram WebApp Signature Validation** - The app validates Telegram WebApp init data signatures; a vulnerability here could allow authentication bypass.

5. **SQL Injection via Dynamic Query Construction** - While parameterized queries are used in most places, some dynamic query construction exists in the store layer that warrants review.

The system benefits from single-tenant isolation (no cross-tenant attack surface) and read-only MCP design (no write access via AI). The most likely threat vectors are credential theft (secrets in environment/CI) and OAuth configuration errors.

---

## Scope and Assumptions

### In-Scope Paths

- `cmd/bot/` - Main application entry point (bot + web server + scheduler)
- `cmd/mcptool/` - MCP server entry point
- `internal/server/` - HTTP handlers and authentication middleware
- `internal/bot/` - Telegram bot command and callback handlers
- `internal/mcp/` - MCP server and OAuth token validation
- `internal/store/` - Database access layer
- `internal/notifier/` - Notification system (Telegram, WebPush)
- `web/static/js/` - Frontend JavaScript (offline-capable PWA)
- Docker deployment and environment configuration

### Out-of-Scope

- `cmd/installer/` - Installation wizard (one-time setup tool, not runtime)
- `cmd/importer/`, `cmd/bpimporter/` - Data import CLI tools
- Test files (`*_test.go`, `tests/` directory)
- CI/CD workflows and build tooling
- `internal/scheduler/` - Internal scheduling logic (no external inputs)
- `internal/rxnorm/`, `internal/openfoodfacts_api.go` - External API clients (trusted third parties)

### Explicit Assumptions

1. **Single-user deployment**: Only one `ALLOWED_USER_ID` is configured; no multi-tenant data access control within the application itself.
2. **Telegram WebView + Standard Browser**: The web interface is accessed both from Telegram's WebView and regular browsers via OIDC login.
3. **MCP server actively used**: The MCP server (`mcptool`) is deployed and actively used by Claude and OpenAI for AI-powered health insights.
4. **Litestream enabled to R2**: Database replication is enabled to Cloudflare R2; R2 access keys are in environment variables.
5. **No additional WAF**: Deployment is behind Traefik with only the application's built-in rate limiting (`rateLimitMiddleware`).
6. **External Mi Band webhook disabled**: `EXTERNAL_WORKOUT_API_KEY` is not configured; `/api/workout/external` endpoint returns unauthorized.
7. **Operator manages secrets**: Secrets are stored in environment variables/Docker compose; no centralized secrets manager.

### Open Questions

- **R2 bucket access restrictions**: Are Litestream R2 credentials scoped to a single bucket, or do they have broader access?
- **Pocket-ID trust model**: Is Pocket-ID a self-hosted instance controlled by the same operator, or a third-party service?
- **Traefik auth**: Is there any additional authentication at the Traefik level (e.g., Basic Auth) before requests reach the application?

---

## System Model

### Primary Components

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         User Access Layer                              │
│  ┌─────────────────┐          ┌─────────────────┐                   │
│  │ Telegram Client │          │ Web Browser     │                   │
│  │ (Chat + Mini   │          │ (OIDC Login)   │                   │
│  │   App WebView)  │          │                 │                   │
│  └────────┬────────┘          └────────┬────────┘                   │
└───────────┼──────────────────────────┼─────────────────────────────────┘
            │                          │
            │  TG API/InitData          │  OIDC Flow
            │  (Signature Validated)     │  (JWT + Session)
            │                          │
            ▼                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Main Application Server                            │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  HTTP Server (mux + middleware stack)                             │  │
│  │  - AuthMiddleware (Telegram WebApp + OIDC Session)              │  │
│  │  - rateLimitMiddleware (IP-based, in-memory)                    │  │
│  │  - securityHeadersMiddleware                                     │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│           │                    │                    │                      │
│  ┌────────▼────────┐   ┌───▼────────┐   ┌───▼──────────┐        │
│  │ API Handlers    │   │ Bot Logic  │   │ Scheduler    │        │
│  │ (Read/Write)   │   │ (Commands  │   │ (Notifications│        │
│  │                │   │  + Callbacks)│  │  + Reminders) │        │
│  └────────┬───────┘   └────┬───────┘   └──────┬───────┘        │
│           │                 │                    │                      │
│           └─────────────────┴────────────────────┘                      │
│                              │                                      │
│                    ┌─────────▼─────────┐                              │
│                    │  SQLite Database  │                              │
│                    │  (mediates +     │                              │
│                    │   migrations)     │                              │
│                    └───────────────────┘                              │
└─────────────────────────────────────────────────────────────────────────────┘
            │
            │ Litestream Replication (Streaming WAL)
            ▼
┌─────────────────────────┐
│  Cloudflare R2 / S3  │  (Backup + Potential Exfiltration Target)
└─────────────────────────┘


┌─────────────────────────────────────────────────────────────────────────────┐
│                         MCP Server (mcptool)                            │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  HTTP Server with OAuth Middleware                                  │  │
│  │  - JWT validation (JWKS from Pocket-ID)                           │  │
│  │  - Subject allowlist (MCP_ALLOWED_SUBJECT)                          │  │
│  │  - Audience validation (MCP_SERVER_URL + Client IDs)                │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│           │                                                            │
│    ┌──────▼────────────────────────────────────────────────┐             │
│    │  MCP Tools (Read-Only Health Data Access)              │             │
│    │  - Blood Pressure, Weight, Medication Intake         │             │
│    │  - Workout History, Sleep Logs, Food Intake           │             │
│    │  - Vitals (Heart, SpO2, Stress), Step History     │             │
│    └──────┬────────────────────────────────────────────────┘             │
│           │                                                            │
│           ▼                                                            │
│    ┌──────────────────┐                                                │
│    │  SQLite DB       │  (Same database as main app, read-only)        │
│    │  (read-only)     │                                                │
│    └──────────────────┘                                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Data Flows and Trust Boundaries

**Internet → Application Server**

- **Data types**: Telegram Bot API updates, HTTP requests (JSON, form data)
- **Channel**: HTTPS (via Traefik reverse proxy)
- **Security guarantees**: TLS encryption, TCP connection to Traefik
- **Validation**: Rate limiting (IP-based, in-memory), request body size limits (1MB max), Telegram WebApp signature validation, OIDC session cookie validation

**Telegram Client → Bot Command/Callback Handlers**

- **Data types**: User messages, callback query data, inline button presses
- **Channel**: Telegram Bot API (HTTPS)
- **Security guarantees**: TLS, Telegram platform validation
- **Validation**: `ALLOWED_USER_ID` check (user ID from Telegram update), command parsing (regex-based), callback data format validation
- **Evidence**: `internal/bot/bot.go:47-48` (allowedUserID check), `internal/bot/handlers.go`

**Web Browser → API Endpoints**

- **Data types**: JSON payloads (health data, settings), query parameters
- **Channel**: HTTPS (via Traefik)
- **Security guarantees**: TLS, same-site cookies
- **Validation**:
  - Telegram WebApp: HMAC-SHA256 signature verification (`internal/server/auth.go:40-111`)
  - OIDC: JWT validation via Pocket-ID JWKS (`internal/mcp/oauth.go:134-215`)
  - Session cookies: Signed with `SESSION_SECRET`, 30-day expiration
  - Body size limits: `http.MaxBytesReader(w, r.Body, 1<<20)` (1MB)
- **Evidence**: `internal/server/auth.go:180-233` (AuthMiddleware), `internal/server/server.go:535-538` (body size limits)

**MCP Client (Claude/OpenAI) → MCP Server**

- **Data types**: Bearer tokens (JWT), MCP protocol messages (JSON-RPC)
- **Channel**: HTTPS (SSE for events, POST for messages)
- **Security guarantees**: TLS, JWT signature validation
- **Validation**:
  - JWT signature verification using RSA public keys from JWKS
  - Audience claim validation (must match `MCP_SERVER_URL` or `POCKET_ID_CLIENT_ID`)
  - Subject allowlist check (`MCP_ALLOWED_SUBJECT`, optional)
  - Expiration enforcement (`jwt.WithExpirationRequired()`)
- **Evidence**: `internal/mcp/oauth.go:76-116` (Middleware), `internal/mcp/oauth.go:184-207` (audience validation)

**Application → SQLite Database**

- **Data types**: Health metrics, medications, workouts, settings
- **Channel**: Local file system
- **Security guarantees**: File system permissions (OS-level)
- **Validation**: Parameterized queries (prepared statements), type safety via Go structs, foreign key constraints
- **Evidence**: `internal/store/store.go` (database initialization with foreign keys)

**Application → Litestream → Cloudflare R2**

- **Data types**: WAL files (SQLite write-ahead logs)
- **Channel**: HTTPS (S3-compatible API)
- **Security guarantees**: TLS, S3 signature-based authentication
- **Validation**: Litestream manages WAL integrity, R2 enforces bucket-level access control
- **Evidence**: Docker Compose configuration (R2 credentials via environment variables)

---

## Assets and Security Objectives

| Asset | Why it matters | Security objective |
|--------|----------------|-------------------|
| **Health data database** (SQLite: meds.db) | Contains sensitive personal health information: medications, blood pressure, weight, sleep, food intake, workout history. Potential privacy harm if exfiltrated. | **Confidentiality**: Prevent unauthorized read access.<br>**Integrity**: Prevent tampering with historical health records.<br>**Availability**: Ensure database is accessible for health tracking. |
| **Telegram Bot Token** (`TELEGRAM_BOT_TOKEN`) | Authenticates the bot to Telegram API. If leaked, attacker could impersonate the bot, read/modify health data via chat commands, and send malicious messages. | **Confidentiality**: Prevent token exposure.<br>**Integrity**: Ensure only the legitimate bot instance uses this token. |
| **Session Secret** (`SESSION_SECRET`) | Signs OIDC session cookies. If leaked or weak, attacker could forge session tokens and bypass OIDC authentication to access the web interface. | **Confidentiality**: Prevent secret exposure.<br>**Integrity**: Ensure only server-signed sessions are accepted. |
| **R2/S3 Access Keys** (`LITESTREAM_ACCESS_KEY_ID`, `LITESTREAM_SECRET_ACCESS_KEY`) | Credentials for Cloudflare R2 (or S3) backup storage. If leaked, attacker could exfiltrate the entire database or delete backups. | **Confidentiality**: Prevent credential exposure.<br>**Integrity**: Ensure only Litestream can write/read backups. |
| **OIDC Client Secret** (`POCKET_ID_CLIENT_SECRET`) | Secret for Pocket-ID OAuth client used by MCP server. If leaked, attacker could obtain tokens for the OAuth client and access MCP server. | **Confidentiality**: Prevent secret exposure.<br>**Integrity**: Ensure only legitimate MCP server uses these credentials. |
| **External Workout API Key** (`EXTERNAL_WORKOUT_API_KEY`) | Pre-shared key for Mi Band webhook. Currently disabled, but if enabled and leaked, attacker could inject fake workout data. | **Confidentiality**: Prevent key exposure.<br>**Integrity**: Prevent unauthorized workout data injection. |
| **VAPID Keys** (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`) | Web push notification keys. If private key is leaked, attacker could send malicious push notifications. | **Confidentiality**: Prevent private key exposure.<br>**Integrity**: Ensure only server can sign push payloads. |
| **MCP Audit Secret** (`MCP_AUDIT_SECRET`) | Shared secret for audit logging between MCP server and main app. If leaked, attacker could forge audit events. | **Confidentiality**: Prevent secret exposure.<br>**Integrity**: Ensure audit log authenticity. |
| **User session cookies** (`auth_session`) | OIDC session cookies provide web access. If stolen (via XSS or network eavesdropping), attacker gains full access. | **Confidentiality**: Prevent cookie theft.<br>**Integrity**: Ensure cookies are signed and HttpOnly. |
| **Telegram WebApp init data** (`X-Telegram-Init-Data`) | Contains user ID, auth date, and HMAC signature. If attacker can forge this, they can bypass Telegram authentication. | **Integrity**: Ensure signature validation is correct.<br>**Authenticity**: Prevent init data forgery. |

---

## Attacker Model

### Capabilities

**Remote internet attacker** (most realistic threat):
- Can send arbitrary HTTP requests to the application (internet-exposed via Traefik)
- Can intercept and modify requests if TLS termination occurs before the application (unlikely with Traefik)
- Can exploit vulnerabilities in the application code (XSS, auth bypass, SQLi, etc.)
- Has knowledge of the application's public endpoints and protocol
- Can obtain leaked secrets from environment variables, logs, or CI/CD
- Can interact with Telegram Bot API if they have the bot token
- Can attempt OAuth token theft or reuse
- Can scan for open ports and common vulnerabilities

**Compromised user device**:
- Has access to the user's browser storage (IndexedDB, localStorage, cookies)
- Can execute JavaScript in the Telegram WebView context
- Can read the user's Telegram WebApp init data
- Can capture OAuth tokens or session cookies
- Can modify outgoing requests (via browser extensions or malware)

**Insider/Infrastructure attacker** (lower likelihood but high impact):
- Has access to the server hosting the application
- Can read environment variables and files on the server
- Can access the SQLite database directly (file system)
- Can intercept network traffic on the server
- Can modify the application code or database

### Non-Capabilities

**Remote attacker cannot**:
- Access the SQLite database file directly (file system is not exposed)
- Access other users' data (single-tenant application)
- Execute arbitrary code on the server unless there's an RCE vulnerability
- Access the application without valid Telegram credentials or OIDC token
- Modify the application code unless they have server access

**Assuming single-user deployment**:
- Cross-tenant data access is not possible (no multi-tenancy)
- Horizontal privilege escalation is not applicable

---

## Entry Points and Attack Surfaces

| Surface | How reached | Trust boundary | Notes | Evidence |
|---------|--------------|-----------------|---------|-----------|
| **Telegram Bot API webhook** | Telegram servers push updates to `/` endpoint (or configured webhook) | Telegram Bot API → Bot Command/Callback Handlers | Validated by `ALLOWED_USER_ID` check. Parses user commands and callback data. | `internal/bot/bot.go:47-48` |
| **HTTP API endpoints** (`/api/*`) | Web browser or HTTP client via Traefik | Unauthenticated network → Authenticated API middleware | Protected by `AuthMiddleware` (Telegram WebApp or OIDC session). Most endpoints require authentication. | `internal/server/server.go:350-486` |
| **OIDC login endpoint** (`/auth/oidc/login`) | Web browser → OIDC provider (Pocket-ID) → callback | Browser → OIDC flow → Session cookie | Redirects to Pocket-ID, validates callback, issues session cookie. Rate limited (10 req/min). | `internal/server/server.go:343-344` |
| **OIDC callback endpoint** (`/auth/oidc/callback`) | OIDC provider (Pocket-ID) | OIDC provider → Application | Validates OAuth state, exchanges code for token, extracts user email, creates session. Rate limited. | `internal/server/server.go:344` |
| **Telegram Login Widget callback** (`/auth/telegram/callback`) | Web browser via Telegram Login Widget JS | Browser → Telegram signature validation | Validates Telegram Login Widget signature, creates session cookie. Rate limited. | `internal/server/server.go:348`, `internal/server/auth.go:124-178` |
| **MCP endpoint** (`/mcp`) | Claude Desktop / OpenAI clients via SSE/HTTP | Unauthenticated network → OAuth-validated MCP server | Protected by OAuth JWT validation (Pocket-ID JWKS). Read-only tools only. | `internal/mcp/mcp.go:397-403` |
| **MCP OAuth metadata** (`/.well-known/oauth-protected-resource`) | MCP client discovery | Public endpoint | Returns OAuth Protected Resource Metadata (RFC 9728). No authentication required. | `internal/mcp/oauth.go:62-74` |
| **External workout webhook** (`/api/workout/external`) | Mi Notify / external webhook service | External API key → Application | Protected by `EXTERNAL_WORKOUT_API_KEY` Bearer token. Currently disabled in deployment. | `internal/server/external_workout_handlers.go:29-53` |
| **Static files** (`/static/*`, `/`) | Web browser | Public endpoint | Serves PWA frontend (HTML, JS, CSS). No authentication required for static files. | `internal/server/server.go:318-322` |
| **Service Worker** (`/static/sw.js`) | Web browser (PWA) | Public endpoint | Service Worker handles offline requests and background sync. | `internal/server/server.go:312` |
| **Health check** (`/health`) | Monitoring / load balancer | Public endpoint | Returns "ok" for health monitoring. | `internal/mcp/mcp.go:406-411` |

---

## Top Abuse Paths

### Abuse Path 1: MCP OAuth Token Bypass → Health Data Exfiltration
**Attacker goal**: Gain unauthorized read access to health data via MCP server without valid OIDC token.
**Impact**: Confidentiality breach of all health history (BP, weight, medications, workouts, sleep, food).

**Steps**:
1. Attacker discovers MCP server endpoint (e.g., `/mcp` or `.well-known/oauth-protected-resource`).
2. Attacker attempts to bypass JWT validation by finding a vulnerability in `validateToken()` (e.g., JWKS cache poisoning, alg confusion, or audience validation bypass).
3. Attacker sends malicious JWT or exploits validation bypass to call MCP tools (`get_blood_pressure`, `get_medication_intake`, etc.).
4. Attacker exfiltrates health data up to 90 days of history (enforced by `MaxQueryDays`).
5. Attacker gains insight into user's medications, health conditions, and lifestyle patterns.

**Affected assets**: Health data database (SQLite), personal health information.

---

### Abuse Path 2: Session Secret Leakage → Web Interface Takeover
**Attacker goal**: Forge valid session cookies to bypass OIDC authentication and access the web interface.
**Impact**: Full access to health data via web interface, ability to modify medications, logs, and settings.

**Steps**:
1. Attacker obtains `SESSION_SECRET` from environment variables (e.g., via compromised server, leaked .env file, or log exposure).
2. Attacker constructs a forged `auth_session` cookie using the secret and any user email (matching `OIDC_ADMIN_EMAIL` or bypassing if not configured).
3. Attacker sends requests to `/api/*` endpoints with the forged cookie in `Cookie` header.
4. `AuthMiddleware` validates the cookie using `verifySessionToken()` (uses HMAC-SHA256 with the secret) and grants access.
5. Attacker now has full API access: read/write medications, logs, workouts, settings.
6. Attacker can also use the forged session to access OIDC-protected endpoints if `OIDC_ADMIN_EMAIL` is not enforced.

**Affected assets**: Health data database, user session cookies, web interface.

---

### Abuse Path 3: Telegram WebApp Signature Forgery → Chat Interface Access
**Attacker goal**: Bypass Telegram WebApp authentication by forging valid init data.
**Impact**: Access to web interface without being the actual Telegram user.

**Steps**:
1. Attacker obtains `TELEGRAM_BOT_TOKEN` (e.g., from leaked environment variable).
2. Attacker constructs forged Telegram WebApp init data with any `user.id` (including the legitimate `ALLOWED_USER_ID`).
3. Attacker calculates the correct HMAC-SHA256 hash using the bot token and the forged data.
4. Attacker sends requests to `/api/*` with `X-Telegram-Init-Data` header containing the forged payload.
5. `ValidateWebAppData()` validates the signature using the leaked token and accepts the request.
6. Attacker gains full API access as the legitimate user.

**Affected assets**: Health data database, Telegram Bot API.

---

### Abuse Path 4: Litestream R2 Credential Theft → Database Exfiltration
**Attacker goal**: Obtain R2/S3 access keys to exfiltrate the entire SQLite database from backups.
**Impact**: Complete health data history exfiltration, potential availability impact if backups are deleted.

**Steps**:
1. Attacker obtains `LITESTREAM_ACCESS_KEY_ID` and `LITESTREAM_SECRET_ACCESS_KEY` (e.g., from leaked Docker Compose file or environment variables).
2. Attacker uses R2/S3 API to list objects in the backup bucket.
3. Attacker downloads the replicated SQLite WAL files or snapshots.
4. Attacker reconstructs the database from WAL files or directly accesses downloaded snapshots.
5. Attacker has complete offline access to all historical health data.

**Affected assets**: Health data database (backups), R2/S3 credentials.

---

### Abuse Path 5: XSS in Web Interface → Session Cookie Theft
**Attacker goal**: Exploit XSS vulnerability to steal the `auth_session` cookie.
**Impact**: Full web interface takeover via stolen session.

**Steps**:
1. Attacker discovers XSS vulnerability in the web interface (e.g., in medication names, workout notes, or user-controlled content).
2. Attacker injects malicious JavaScript that reads `document.cookie` or `localStorage`.
3. Legitimate user visits the affected page, triggering the malicious script.
4. Script steals the `auth_session` cookie (if not `HttpOnly`) or `localStorage` data.
5. Attacker sends the stolen cookie to their server and uses it to authenticate.
6. Attacker gains full API access as the user.

**Affected assets**: User session cookies, health data database.

---

### Abuse Path 6: SQL Injection via Dynamic Queries → Database Compromise
**Attacker goal**: Inject malicious SQL to read/write arbitrary database data.
**Impact**: Data exfiltration, integrity compromise (modify health records), potential RCE if SQLite allows it.

**Steps**:
1. Attacker identifies an API endpoint that constructs dynamic SQL queries (not fully parameterized).
2. Attacker crafts malicious input that injects SQL syntax (e.g., in search fields, medication names, or other user-controlled parameters).
3. The vulnerable query executes the injected SQL, allowing the attacker to:
   - Read other tables (e.g., `push_subscriptions`, settings)
   - Modify health records (false BP readings, medication logs)
   - Extract database schema and data
4. Attacker exfiltrates sensitive data or corrupts the database.

**Affected assets**: Health data database, application integrity.

---

### Abuse Path 7: OAuth Audience/Subject Bypass → MCP Access
**Attacker goal**: Obtain a valid OAuth token from Pocket-ID and access MCP server without being the authorized user.
**Impact**: Unauthorized read access to health data via MCP tools.

**Steps**:
1. Attacker registers their own OAuth client with Pocket-ID (if the operator's Pocket-ID allows self-registration or if attacker compromises an existing client).
2. Attacker obtains a valid JWT token for their client.
3. Attacker crafts a token where the `aud` claim matches the MCP server's allowed audience (`MCP_SERVER_URL` or `POCKET_ID_CLIENT_ID`).
4. If `MCP_ALLOWED_SUBJECT` is empty (or attacker's subject matches), the MCP server accepts the token.
5. Attacker uses the token to call MCP tools and exfiltrate health data.

**Affected assets**: Health data database (via MCP).

---

### Abuse Path 8: Rate Limiting Bypass → DoS or Brute Force
**Attacker goal**: Bypass in-memory rate limiting to perform brute force attacks or DoS.
**Impact**: Availability impact or credential guessing.

**Steps**:
1. Attacker spoofs IP addresses via X-Forwarded-For header (since `AUTH_TRUST_PROXY=true` is default).
2. Attacker bypasses IP-based rate limiting by cycling through fake IPs.
3. Attacker performs brute force on endpoints (e.g., guessing API keys, OAuth tokens, or session secrets).
4. Alternatively, attacker floods the application with requests, causing resource exhaustion.

**Affected assets**: Application availability, rate limiting mechanism.

---

### Abuse Path 9: Web Push Subscription Hijacking
**Attacker goal**: Register a malicious push subscription endpoint to intercept push notifications.
**Impact**: Privacy leak via notification metadata (medication reminders, workout alerts).

**Steps**:
1. Attacker obtains a valid session cookie (via any of the above methods).
2. Attacker calls `/api/webpush/subscribe` with a malicious `endpoint` controlled by the attacker.
3. Server sends push notifications to the attacker's endpoint.
4. Attacker receives medication reminders, workout notifications, and other health-related alerts.
5. Attacker infers health patterns from notification content.

**Affected assets**: Web push subscriptions, user privacy.

---

### Abuse Path 10: External Workout API Key Theft → Fake Data Injection
**Attacker goal**: Inject fraudulent workout data by stealing the external API key.
**Impact**: Data integrity compromise (false health records), misleading statistics.

**Steps**:
1. Attacker obtains `EXTERNAL_WORKOUT_API_KEY` (e.g., from environment leak).
2. Attacker sends POST requests to `/api/workout/external` with the Bearer token.
3. Attacker injects fake workout data (e.g.,伪造的运动记录, calorie counts, GPS data).
4. Server accepts the data and stores it in the database.
5. User's health statistics and trends become corrupted.

**Affected assets**: Workout data, database integrity.

---

## Threat Model Table

| Threat ID | Threat source | Prerequisites | Threat action | Impact | Impacted assets | Existing controls (evidence) | Gaps | Recommended mitigations | Detection ideas | Likelihood | Impact severity | Priority |
|-----------|--------------|----------------|----------------|---------|-----------------|-------------------------------|--------|------------------------|-----------------|------------|----------------|------------|
| **TM-001** | OAuth token validation bypass in MCP server | Vulnerability in JWT validation logic or JWKS cache poisoning | Attacker forges or reuses JWT to bypass MCP OAuth middleware | Health data exfiltration via MCP read-only tools | Health data database | JWT signature validation with RSA public keys (`internal/mcp/oauth.go:155-161`), JWKS caching with TTL, audience validation (`internal/mcp/oauth.go:184-207`), subject allowlist check (`internal/mcp/oauth.go:118-131`), expiration enforcement (`jwt.WithExpirationRequired()`) | No issuer claim validation explicitly enforced, JWKS fetch doesn't validate HTTPS certificate chain (uses default HTTP client), no nonce/replay protection | Enforce issuer claim validation in `validateToken()`, add explicit HTTPS certificate validation for JWKS fetch, consider adding nonce-based replay protection | Log failed token validations with subject/audience details, alert on repeated JWKS fetch failures | **Low** | **High** | **Medium** |
| **TM-002** | Session secret leakage or weak secret generation | `SESSION_SECRET` exposed in environment/logs, or secret is predictable/short | Attacker forges session cookie using HMAC-SHA256 with the secret | Web interface takeover, full API access | Session secret, user session cookies, health data database | Session cookies are `HttpOnly`, `Secure`, `SameSite=Lax` (`internal/server/auth.go:791-797`), 30-day expiration (`internal/server/auth.go:794`), session token verified with HMAC (`internal/server/auth.go:187`) | No explicit validation that `SESSION_SECRET` is minimum entropy/length, no rotation mechanism, no audit logging for session creation/validation | Generate `SESSION_SECRET` with minimum 32 bytes of cryptographically secure random data if not provided, implement session rotation (e.g., re-issue on sensitive actions), log all session validation attempts with IP/timestamp | Alert on session validation failures from new IP addresses, monitor for multiple active sessions | **Low** | **High** | **Medium** |
| **TM-003** | Telegram Bot Token exposure | `TELEGRAM_BOT_TOKEN` leaked or stolen | Attacker uses bot token to impersonate the bot via Telegram Bot API | Chat interface access, message injection, data exfiltration via bot commands | Telegram Bot Token, health data database, Telegram Bot API | Token used for WebApp signature validation (`internal/server/auth.go:71-73`), token used by bot client (`internal/bot/bot.go:48`), `ALLOWED_USER_ID` check (`internal/bot/bot.go:47-48`) | No rate limiting on bot webhook at Telegram level, no additional secret for webhook verification, token not rotated regularly | Rotate bot token periodically, implement Telegram webhook secret verification if supported, add rate limiting per command at bot level | Monitor for unexpected message volumes, alert on commands from non-allowed users (if bypass occurs) | **Low** | **High** | **Medium** |
| **TM-004** | Litestream R2/S3 credential theft | R2/S3 access keys exposed in environment or backups | Attacker uses credentials to download/delete database backups from R2/S3 | Complete database exfiltration, backup availability compromise | R2/S3 access keys, database backups (WAL files) | Credentials stored in environment variables, not in code, Litestream uses S3 signature-based auth | No explicit credential scoping to single bucket (depends on R2 setup), no MFA on R2 access, no audit logging for R2 access | Scope credentials to single R2 bucket with least privilege, enable R2 access logs/alerting, use temporary credentials if supported, encrypt backups at rest | Alert on unexpected R2 access patterns, monitor for backup deletion, validate backup integrity regularly | **Low** | **High** | **Medium** |
| **TM-005** | XSS in user-controlled content (medication names, workout notes, etc.) | Application reflects unsanitized user input in HTML/JS context | Attacker injects malicious JavaScript to steal session cookies or IndexedDB data | Session cookie theft, user privacy, health data database | Session cookies, IndexedDB, frontend JavaScript | Content Security Policy with restrictive sources (`internal/server/server.go:303`), no explicit HTML rendering of user input (JSON API), HttpOnly cookies | Potential XSS in medication names/workout notes if displayed without escaping, CSP allows `script-src 'self' https://telegram.org` which could be exploited via Telegram domain, no Content-Security-Policy-Report-Only for testing | Ensure all user-controlled content is HTML-escaped when rendered, tighten CSP to remove `https://telegram.org` if not needed, implement CSP reporting, audit all `innerHTML` usage in frontend | CSP violation reports,异常的HTTP请求模式，前端错误日志 | **Low** | **High** | **Medium** |
| **TM-006** | SQL injection via dynamic query construction | Parameterized queries not used consistently, string concatenation in SQL | Attacker injects SQL to read/write arbitrary database data | Database compromise, data exfiltration, integrity corruption | Health data database, application integrity | Most queries use parameterized statements via `database/sql`, request body size limits (`internal/server/server.go:535`), input validation for numeric fields | Some dynamic query patterns may exist (need code review), no explicit SQL injection testing in CI, no ORM with built-in sanitization | Audit all SQL query construction for dynamic patterns, enforce use of parameterized queries, add SQL injection testing to test suite | Database query error logs,异常的查询模式，slow query anomalies | **Low** | **High** | **High** |
| **TM-007** | Telegram WebApp init data forgery | Bot token leaked, or HMAC collision found | Attacker forges init data with valid signature to bypass authentication | Web interface access without being the actual Telegram user | Telegram Bot Token, WebApp init data, health data database | HMAC-SHA256 signature validation (`internal/server/auth.go:75-76`), auth_date expiration (24 hours) (`internal/server/auth.go:99-101`), `ALLOWED_USER_ID` check (`internal/server/auth.go:223-226`) | No additional secret beyond bot token (single secret), no nonce/CSRF token in init data, auth_date only checked for expiration not for replay | Implement additional secret for WebApp validation (e.g., use a different HMAC key), add nonce mechanism, shorten auth_date window, consider adding CSRF tokens | Alert on failed WebApp validations with same user ID from different IPs, monitor for replay attacks | **Low** | **High** | **Medium** |
| **TM-008** | OAuth audience/subject bypass | `MCP_ALLOWED_SUBJECT` empty, attacker has valid Pocket-ID token | Attacker uses legitimate Pocket-ID token (from their own account) to access MCP server | Unauthorized health data access via MCP | Health data database, MCP OAuth tokens | Audience validation (`internal/mcp/oauth.go:184-207`), subject allowlist (`internal/mcp/oauth.go:118-131`) | Subject allowlist is optional (can be empty), no explicit issuer validation, audience accepts `POCKET_ID_CLIENT_ID` which may be discoverable | Require `MCP_ALLOWED_SUBJECT` to be set for production, add issuer claim validation, consider adding client-specific secrets per OAuth client | Log all MCP access with subject/audience, alert on access from unexpected subjects | **Low** | **High** | **Medium** |
| **TM-009** | Rate limiting bypass via IP spoofing | `AUTH_TRUST_PROXY=true` default, attacker controls `X-Forwarded-For` header | Attacker bypasses IP-based rate limiting by spoofing IPs | DoS, brute force on auth endpoints, API key guessing | Rate limiting mechanism, application availability | In-memory rate limiter with configurable limits (`internal/server/server.go:72-138`), rate limiting applied to auth endpoints (`internal/server/server.go:340-342`) | Trust proxy by default (`AUTH_TRUST_PROXY=true`), no token-based rate limiting, no CAPTCHA for sensitive endpoints, rate limiter is per-IP (not per-user) | Disable `AUTH_TRUST_PROXY` unless necessary behind trusted proxy, implement token-based rate limiting using session cookies, add CAPTCHA for auth endpoints, consider using Redis for distributed rate limiting | Alert on rate limit violations from single IP, monitor for rapid IP cycling, spike detection | **Medium** | **Medium** | **Medium** |
| **TM-010** | OIDC session fixation or session hijacking | Attacker steals session cookie or sets a pre-determined session ID | Attacker uses stolen or pre-determined session cookie to authenticate | Web interface takeover, health data access | Session cookies, OIDC session tokens | Session cookies are `HttpOnly` and `Secure` (`internal/server/auth.go:796`), new session issued on callback (`internal/server/auth.go`), 30-day expiration | No explicit session invalidation on password reset (not applicable for OIDC), no session binding to IP/user agent, no concurrent session limit | Implement session binding to IP/User-Agent, limit concurrent sessions, add session invalidation endpoint, consider shortening session duration | Alert on session usage from different IPs/UA than creation, monitor for multiple active sessions | **Low** | **Medium** | **Low** |
| **TM-011** | Web push subscription hijacking | Attacker has valid session cookie | Attacker registers malicious push endpoint to intercept notifications | Privacy leak via notification metadata, notification content exposure | Web push subscriptions, user privacy | Subscription requires authentication (`internal/server/server.go:826`), push notifications signed with VAPID private key | No validation of push endpoint ownership, no rate limiting on subscription creation, no revocation mechanism | Implement endpoint verification (challenge-response), rate limit subscription creation, add subscription audit log, implement subscription expiration/revocation | Alert on multiple subscriptions for same user, monitor for subscription to suspicious endpoints | **Low** | **Low** | **Low** |
| **TM-012** | External workout API key theft (if enabled) | `EXTERNAL_WORKOUT_API_KEY` exposed | Attacker injects fake workout data | Data integrity compromise, corrupted health statistics | Workout data, database integrity, external API key | API key authentication with constant-time comparison (`internal/server/external_workout_handlers.go:46`), request body size limits (`internal/server/external_workout_handlers.go:62`), duplicate detection (`internal/server/external_workout_handlers.go:108-124`) | Currently disabled (no mitigation needed), if enabled: no rate limiting on webhook, no signature verification beyond API key, no source validation | If enabling webhook: add rate limiting, implement request signing (e.g., HMAC with shared secret), validate source IP, add audit logging | Alert on webhook errors, monitor for duplicate injection attempts, anomaly detection on workout patterns | **Very Low** | **Medium** | **Low** |
| **TM-013** | R2 backup deletion or tampering | R2 credentials compromised or misconfigured | Attacker deletes or modifies backup files | Backup availability loss, data recovery failure | R2/S3 access keys, database backups | R2/S3 signature-based authentication | No explicit backup integrity verification, no versioning on R2 objects, no backup deletion alerts | Enable R2 bucket versioning, implement backup integrity checks (hash verification), set up deletion alerts, consider multi-region replication | Alert on backup deletion, monitor for backup size changes, validate backup restoration regularly | **Low** | **High** | **Medium** |
| **TM-014** | XSS via Telegram Bot messages (markdown/HTML entities) | Bot sends user-controlled content in messages | Attacker injects malicious links/JavaScript in bot messages | User phishing, credential theft, session hijacking | Telegram Bot API, bot message rendering | Telegram Bot API has built-in HTML/Markdown sanitization | Bot may send medication names or notes that contain malicious links, no explicit link sanitization on bot side | Sanitize user-controlled content before sending in bot messages, use safe link rendering, warn users about external links | Monitor for reported malicious bot messages, user feedback on suspicious content | **Very Low** | **Low** | **Low** |
| **TM-015** | Time-based race condition in medication confirmation | Two concurrent requests to confirm same intake | Double-decrement of inventory or duplicate confirmation | Inventory count corruption, inaccurate medication tracking | Medication inventory, intake logs | SQL `ErrNoRows` check for race condition (`internal/server/server.go:922-923`, `967-970`), inventory decrement only after confirmation | Race condition handled gracefully but not logged as expected, potential for confusing user experience | Log race condition occurrences for monitoring, consider adding idempotency keys for confirmation operations | Monitor for inventory anomalies, alert on negative inventory counts | **Low** | **Medium** | **Low** |
| **TM-016** | Offline write queue corruption (IndexedDB) | Attacker compromises user device or XSS | Attacker modifies offline write queue in IndexedDB | Data integrity compromise on sync, malicious health data injection | IndexedDB, offline write queue, sync mechanism | Sync validates on server side (schema constraints), offline writes limited to BP/weight/medication confirmation | No integrity validation of IndexedDB data on client side, no rollback mechanism for failed sync, no detection of malicious queue modification | Implement IndexedDB integrity checks, add rollback for failed syncs, validate offline writes on client before queueing | Monitor sync error rates, alert on unexpected data patterns from sync | **Very Low** | **Low** | **Low** |

---

## Criticality Calibration

For **this single-user health tracking application**, the severity levels are defined as:

### **Critical**
- Pre-authentication remote code execution (RCE) in the application server
- Complete database exfiltration via authentication bypass (e.g., SQL injection, OAuth bypass)
- Loss of all health data with no recovery (database + backup deletion)
- Examples:
  - SQL injection vulnerability allowing arbitrary data exfiltration
  - MCP OAuth validation bypass granting read access to all health data
  - R2 backup deletion combined with database compromise

### **High**
- Authentication bypass allowing access to another user's data (not applicable for single-user, but still applicable for impersonation)
- Secret exposure leading to full system compromise (e.g., `SESSION_SECRET`, `TELEGRAM_BOT_TOKEN`)
- OAuth token theft or session hijacking
- Examples:
  - Session secret leakage allowing forged session cookies
  - Telegram Bot Token exposure allowing bot impersonation
  - Litestream R2 credentials allowing database exfiltration from backups

### **Medium**
- Partial data exposure (e.g., limited to specific data types or time ranges)
- Integrity compromise affecting a subset of data (e.g., fake workout data injection)
- DoS affecting availability of the application
- Examples:
  - XSS in web interface leading to session cookie theft
  - Rate limiting bypass enabling brute force attacks
  - External API key theft allowing fake data injection

### **Low**
- Information leaks with minimal privacy impact (e.g., notification metadata)
- Noisy DoS with easy mitigation (e.g., spam flood from single IP)
- Low-sensitivity data exposure (e.g., public configuration)
- Examples:
  - Web push subscription hijacking revealing notification content
  - Time-based race conditions in medication confirmation
  - Offline write queue corruption requiring manual resolution

---

## Focus Paths for Security Review

| Path | Why it matters | Related Threat IDs |
|-------|----------------|---------------------|
| `internal/server/auth.go` | Contains Telegram WebApp signature validation, OIDC session management, and Telegram Login Widget validation. Critical for authentication security. | TM-003, TM-007, TM-010 |
| `internal/mcp/oauth.go` | Implements OAuth JWT validation for MCP server. Vulnerabilities here could allow unauthorized health data access via MCP tools. | TM-001, TM-008 |
| `internal/store/*.go` | Database access layer with SQL queries. SQL injection vulnerabilities would have high impact. | TM-006 |
| `internal/server/external_workout_handlers.go` | External webhook endpoint (currently disabled). If enabled, needs review for API key validation and input sanitization. | TM-012 |
| `internal/server/server.go` | HTTP server initialization, middleware stack, and request handling. Security headers and rate limiting are configured here. | TM-005, TM-009 |
| `web/static/js/core/api.js` | Frontend API client that handles authentication headers and error handling. XSS vulnerabilities in the frontend could expose session data. | TM-005 |
| `web/static/js/sync.js` | Offline write queue and sync manager. Integrity of offline data is important for data consistency. | TM-016 |
| `internal/server/oidc_handlers.go` | OIDC login and callback handling. Session creation and OAuth flow security are critical. | TM-002, TM-010 |
| `internal/bot/bot.go` | Bot command and callback handlers. Validates `ALLOWED_USER_ID` and processes user input. | TM-003, TM-014 |
| `internal/bot/handlers.go` | Bot command implementations. User-controlled content may be sent in bot messages. | TM-014 |
| `internal/server/security_headers.go` (if exists) or security headers in `server.go` | Security headers (CSP, HSTS, etc.) mitigate XSS and other web vulnerabilities. | TM-005 |
| `cmd/bot/main.go` | Application entry point. Environment variable loading and secret initialization happen here. | TM-002, TM-003, TM-004 |
| `cmd/mcptool/main.go` | MCP server entry point. Configuration loading and OAuth setup are critical. | TM-001, TM-008 |
| `internal/notifier/webpush.go` | Web push notification implementation. VAPID key management and subscription security are important. | TM-011 |
| `internal/server/medication_handlers.go` | Medication-related API endpoints. Medication names and notes are user-controlled and may be reflected. | TM-005, TM-015 |
| `internal/server/workout_handlers.go` | Workout-related API endpoints. Workout data injection and integrity are concerns. | TM-012 |
| `internal/server/bp_handlers.go` | Blood pressure API endpoints. Health data input validation is critical. | TM-006 |
| `internal/server/weight_handlers.go` | Weight API endpoints. Health data input validation is critical. | TM-006 |
| `internal/server/food_handlers.go` | Food intake API endpoints. Data from Open Food Facts API needs validation. | TM-006 |
| `internal/store/store.go` | Database initialization and migrations. Schema integrity and foreign key enforcement are important. | TM-006 |

---

## Notes on Use

### Assumptions Validated by User
- Single-user deployment (confirmed)
- External Mi Band webhook disabled (confirmed)
- MCP server actively used by Claude and OpenAI (confirmed)
- Litestream enabled to R2 (confirmed)
- Deployment behind Traefik with no additional WAF (confirmed)
- Web interface accessed from both Telegram WebView and standard browsers (confirmed)

### Deployment Considerations
- The application is designed for self-hosted personal use. Multi-tenant deployments would require significant security changes (row-level security, tenant isolation, etc.).
- The MCP server is read-only by design, which mitigates the impact of OAuth token bypass (attacker cannot modify data, only read).
- Rate limiting is in-memory and per-IP. For production deployments with Traefik, consider implementing distributed rate limiting (e.g., Redis-based).
- The use of `AUTH_TRUST_PROXY=true` is necessary behind Traefik but increases the attack surface for IP spoofing. Consider additional measures (token-based rate limiting, CAPTCHA).

### Priority Recommendations (Short-Term)
1. **Require `MCP_ALLOWED_SUBJECT`**: Ensure the MCP server restricts access to a specific subject. Empty allowlist is insecure for production.
2. **Audit SQL query construction**: Review all SQL queries in `internal/store/` for dynamic patterns. Ensure parameterized queries are used consistently.
3. **Implement issuer claim validation**: Add explicit issuer validation in `validateToken()` to prevent token misuse from other OAuth providers.
4. **Add session monitoring**: Log session creation, validation, and usage with IP and User-Agent. Alert on suspicious patterns.

### Priority Recommendations (Medium-Term)
1. **Add CSP reporting**: Implement Content-Security-Policy-Report-Only to detect XSS attempts before they become vulnerabilities.
2. **Implement backup integrity checks**: Verify R2 backup integrity periodically (hash checks, restoration tests).
3. **Add rate limiting token**: Use session cookies instead of IP for rate limiting to prevent IP spoofing bypass.
4. **Shorten session duration**: Consider reducing OIDC session duration from 30 days to 7-14 days for better security.

### Priority Recommendations (Long-Term)
1. **Implement distributed rate limiting**: Use Redis or similar for production-grade rate limiting.
2. **Add MFA to OIDC**: If Pocket-ID supports it, require MFA for sensitive operations.
3. **Implement secret rotation**: Automate rotation of `SESSION_SECRET`, `TELEGRAM_BOT_TOKEN`, and other secrets.
4. **Add audit logging**: Implement comprehensive audit logging for all authentication, data access, and configuration changes.
