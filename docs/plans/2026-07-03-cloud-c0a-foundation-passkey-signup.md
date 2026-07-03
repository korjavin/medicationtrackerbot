# Cloud C0a — service foundation + passkey signup/unlock

First of three sequential plans implementing phase C0 of [docs/cloud-mode.md](../cloud-mode.md). Normative crypto spec: [docs/cloud-crypto.md](../cloud-crypto.md) — all formats, HKDF info strings, and ceremony semantics come from there; this plan references, never redefines them. Follow-ups: `2026-07-03-cloud-c0b-device-lifecycle.md`, `2026-07-03-cloud-c0c-sync-push-relay.md`.

## Overview

New binary `cmd/cloud`: a zero-knowledge cloud service (accounts, WebAuthn/passkey auth, DEK envelopes, static shell hosting) on per-user wildcard subdomains. End state of this plan, demoable on a real phone: operator mints an invite (`cloud admin invite`) → user follows the personal claim-link → lands on `https://<petname>.<base-domain>/#claim=…` → creates passkey (WebAuthn PRF) → client generates DEK, wraps it into an envelope, uploads → Emergency Kit (recovery code) → later, unlock: passkey assertion + PRF → download envelope → unwrap DEK → "vault unlocked" state.

The server stores only: WebAuthn public keys, envelopes (ciphertext), a recovery verifier hash. No key material, no plaintext — see the trust model in docs/cloud-mode.md.

## Context (from discovery)

- `internal/store/db`: `Open(path)` (WAL, busy_timeout, modernc.org/sqlite) and `Migrate(fsys fs.FS, dir string)` are fully parameterizable — reuse directly for `cloud.db` with a new migrations embed.
- **Gotcha**: do NOT import `internal/store` from cloud code — its blank import of `internal/store/migrations` registers a Go migration into goose's process-global registry, which would then apply against `cloud.db`. Import only `internal/store/db`.
- Binary skeleton pattern: `cmd/bot/main_server.go` (env-driven, no flags; slog TextHandler to stderr; `signal.NotifyContext` + 10s `Shutdown`). Copy `cmd/bot/http_server.go`'s `newHTTPServer`.
- Session pattern: stateless HMAC tokens (`internal/server/google_auth.go` `createSessionToken`/`verifySessionToken`), cookie `HttpOnly/Secure/SameSite=Lax`. Copy the `SESSION_SECRET` length≥32 + Shannon-entropy≥3.5 validation from `cmd/bot/main_server.go:84-105`.
- No WebAuthn dep in go.mod — add `github.com/go-webauthn/webauthn` (server verifies ceremonies only; all key derivation is client-side WebCrypto per spec). Add `github.com/descope/virtualwebauthn` (test-only) for the integration test.
- Static embedding: new `web/cloud/` dir, embedded unconditionally (`//go:embed all:...` + `http.FileServerFS`) — no build tag, no `SetStaticFS` indirection (single source).
- Vitest scans only `web/static/js/tests/**` — `web/cloud/` is invisible to the main app's architecture guards (intended: different app). Add one `include` glob to `vitest.config.mjs` for `web/cloud/js/tests/**/*.test.js`.
- The MCP coverage guard (`TestMCPCoverage_...`) applies to `internal/server`'s mux only — `cmd/cloud` has its own mux; the guard does not apply here. Do not add cloud routes to the registry or exempt list.
- Dockerfile builds binaries in one `RUN go build` line — append `cloud`. Compose: clone the `mcp` service block pattern.

## Development Approach

- **Testing approach**: NO unit tests. They blow up the codebase for no value here.
  - add an integration test ONLY when it covers a real boundary (API contract, data migration, cross-component flow) and gives a guarantee manual checking can't
  - if no integration test adds a real guarantee, the task has NO test items — that is correct and expected
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: if a task adds an integration test, it must pass before starting the next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- Maintain backward compatibility (server/mobile builds untouched; `go build ./...` and `go build -tags mobile ./...` must keep passing)

## Testing Strategy

- **Unit tests**: none. Do not add unit tests.
- **Integration tests**: three real boundaries in this plan — (1) WebAuthn registration/assertion contract against the real `go-webauthn` verification path (via `virtualwebauthn` fake authenticator), (2) invite/claim/envelope HTTP contract over a real `cloudstore` SQLite DB, (3) client envelope crypto against the byte formats in docs/cloud-crypto.md (Vitest + Node WebCrypto — guards cross-version format stability, which manual testing can't).
- **E2E tests**: none (no existing e2e suite).

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope
- Keep plan in sync with actual work done

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): code, migrations, embedded shell, compose/Dockerfile edits, the three integration tests
- **Post-Completion** (no checkboxes): wildcard DNS record + Traefik DNS-01 resolver (external infra), real-device passkey verification

## Implementation Steps

### Task 1: `internal/cloudstore` package + migrations

- [ ] create `internal/cloudstore/` with `Repo` struct holding `*storedb.DB`, `New(*storedb.DB) (*Repo, error)` that runs its own migrations via `d.Migrate(embedFS, "migrations")` (own `//go:embed migrations/*.sql`; import only `internal/store/db`, never `internal/store`)
- [ ] migration `001_init.sql`: `accounts(id TEXT PK, subdomain TEXT UNIQUE NOT NULL, created_at_unix INTEGER NOT NULL, claim_token_hash BLOB, claim_expires_unix INTEGER, loss_ack_unix INTEGER)`, `credentials(id BLOB PK, account_id TEXT NOT NULL, public_key BLOB NOT NULL, transports TEXT, sign_count INTEGER, created_at_unix INTEGER NOT NULL, last_asserted_at_unix INTEGER)`, `envelopes(account_id TEXT NOT NULL, credential_ref TEXT NOT NULL, v INTEGER NOT NULL, nonce BLOB NOT NULL, ct BLOB NOT NULL, mac BLOB, PRIMARY KEY(account_id, credential_ref))`, `recovery_auth(account_id TEXT PK, verifier_hash BLOB NOT NULL, failed_attempts INTEGER NOT NULL DEFAULT 0, window_start_unix INTEGER)` — no invites table: **an invite IS a pre-provisioned unclaimed account** (claim token + expiry live on `accounts`)
- [ ] repo methods: `CreateAccount`, `AccountBySubdomain`, `ConsumeClaimToken`, `ResetClaim`, `ListAccounts`, `DeleteAccount`, `SetLossAck`, `AddCredential`, `CredentialsByAccount`, `TouchCredential`, `PutEnvelope`, `GetEnvelope`, `ListEnvelopes`, `SetRecoveryVerifier` — all with `context.Context`, unix-seconds ints per repo time convention
- [ ] integration test: open temp DB → migrate → account+credential+envelope roundtrip (guards migration + repo contract)

### Task 2: `cmd/cloud` binary skeleton

- [ ] `cmd/cloud/main.go`: slog TextHandler to stderr; local env loader (no flags) reading `CLOUD_DB_PATH` (default `cloud.db`), `PORT` (default 8080), `CLOUD_BASE_DOMAIN` (required, e.g. `app.example.com`), `SESSION_SECRET` (copy length+entropy validation from `cmd/bot/main_server.go`), `CLOUD_CLAIM_TTL` (invite claim-link validity, default 14 days)
- [ ] copy `newHTTPServer` helper; graceful shutdown via `signal.NotifyContext` + 10s timeout (mirror `cmd/bot/main_server.go` select loop)
- [ ] `GET /healthz` liveness endpoint
- [ ] `go build ./...` and `go vet ./...` pass with the new binary

### Task 3: wildcard host routing + embedded shell serving

- [ ] `web/cloud/` static dir (shell skeleton: `index.html`, `signup.html`, `css/`, `js/`) embedded via a new `web/cloud/embed.go` (`package cloudweb`, unconditional `//go:embed`, served with `http.FileServerFS`)
- [ ] host-routing middleware in `internal/cloudserver/` (new package holding all HTTP handlers): exact `CLOUD_BASE_DOMAIN` host → static landing/education page (no signup surface — registration is admin-CLI-only); `<sub>.CLOUD_BASE_DOMAIN` → account shell + account-scoped API (middleware resolves the account from the Host label, 404 page for unknown subdomains); strip an optional port from Host for dev
- [ ] dev note in code + docs: `*.localhost` subdomains are secure contexts and resolve without DNS — `CLOUD_BASE_DOMAIN=localhost` gives a full local dev loop including passkeys on desktop
- [ ] integration test: httptest with `Host` header variants (base, known sub, unknown sub) — guards the routing contract

### Task 4: account provisioning — admin invitations (the only registration door)

- [ ] provisioning helper: generate `account_id` (128-bit random, base32) and subdomain `<adjective>-<animal>-<6 base32 chars>` from small embedded wordlists, retry on UNIQUE collision; store account with a hashed one-time **claim token** (32 random bytes, `CLOUD_CLAIM_TTL`) and produce the claim URL `https://<sub>.<base>/#claim=<token>` (fragment — never hits server logs)
- [ ] admin CLI subcommands (argv[1] dispatch in main.go): `cloud admin invite` (pre-provision; print claim URL + terminal QR), `cloud admin list` (subdomain, claimed?, created, last-asserted — no PII), `cloud admin reset-claim <subdomain>` (new claim token for an unclaimed account), `cloud admin revoke <subdomain>` (delete unclaimed account), `cloud admin delete <subdomain>` (delete account + all rows, confirm prompt)
- [ ] lazy expiry: unclaimed accounts past `claim_expires_unix` are rejected at claim time and swept opportunistically on provisioning calls
- [ ] integration test: invite→claim single-use; expired claim rejected; reset-claim invalidates the old token — guards the provisioning contract

### Task 5: WebAuthn registration ceremony (server)

- [ ] add `github.com/go-webauthn/webauthn` dep; construct a per-request `webauthn.WebAuthn` with `RPID`/`RPOrigins` derived from the account subdomain host (per-user RP ID per docs/cloud-crypto.md)
- [ ] `POST /api/webauthn/register/begin` + `/finish` on the subdomain host: begin requires a valid claim token (first credential — the account is unclaimed until then; later credentials in plan C0b reuse this handler behind a session); options: `residentKey=required`, `userVerification=required`, `extensions: {prf: {}}`, attestation `none`
- [ ] challenge/`SessionData` store: in-memory map keyed by random id in a short-lived cookie, 5-min TTL, single process (`ponytail:` restart mid-ceremony = user retries)
- [ ] `finish` persists the credential, invalidates the claim token, and issues an HMAC session cookie (Task 6's token, minted here so the client can immediately upload envelopes)
- [ ] integration test with `virtualwebauthn`: full begin→finish registration against the real verification path, then reject: bad origin, replayed challenge — guards the ceremony contract

### Task 6: WebAuthn login + sessions

- [ ] HMAC session token (copy `createSessionToken`/`verifySessionToken` shape from `internal/server/google_auth.go`, payload = `account_id|credential_id|ts`, 30-day TTL) set as `HttpOnly Secure SameSite=Lax` cookie scoped to the subdomain origin; auth middleware for all account-scoped `/api/*` routes
- [ ] `POST /api/webauthn/login/begin` (subdomain host, unauthenticated): returns assertion options with `allowCredentials` = account's credential ids (client adds the PRF eval — server never sees PRF outputs, which travel only in `clientExtensionResults` client-side)
- [ ] `POST /api/webauthn/login/finish`: verify assertion, update `last_asserted_at_unix` + sign_count, issue session cookie
- [ ] integration test with `virtualwebauthn`: login begin→finish issues a session that passes the auth middleware — guards the auth contract

### Task 7: envelope API + recovery material at signup

- [ ] `PUT /api/envelopes/{credential_ref}` (session auth): body `{v, nonce, ct, mac}`, upsert; `credential_ref` is base64url credential id or literal `recovery`; enforce sane size caps
- [ ] `GET /api/envelopes/{credential_ref}` and `GET /api/envelopes` (session auth) — list returns refs + `mac` so clients can run the envelope audit (verification is client-side, plan C0b)
- [ ] `PUT /api/recovery-verifier` (session auth): stores `SHA-256(verifier)` in `recovery_auth` (redemption endpoint is plan C0b; the material must exist from day one so kits generated now work later)
- [ ] integration test: envelope put/get/list + verifier set over a signup→register→session flow — guards the storage contract end-to-end

### Task 8: client crypto module (`web/cloud/js/crypto.js`)

- [ ] implement suite v1 exactly per docs/cloud-crypto.md "Exact formats": length-prefixed field encoding, `salt_kek` constant, `KEK = HKDF(PRF, salt=account_id, info="mt/v1/kek"‖credential_id)`, envelope AES-256-GCM with the specified AAD, recovery-code generation (160-bit Crockford base32 + checksum group) with `KEK_rec`/`verifier` derivations, envelope-audit MAC (`K_mac`)
- [ ] pure WebCrypto (`crypto.subtle`), no dependencies; every exported function takes/returns `Uint8Array`/plain objects (no DOM)
- [ ] add `web/cloud/js/tests/**/*.test.js` glob to `vitest.config.mjs` `include`
- [ ] Vitest integration test (Node WebCrypto): envelope wrap→unwrap roundtrip, tamper detection (flip ct/aad byte → throws), HKDF domain separation (`KEK_rec` ≠ `verifier` for same code), recovery-code checksum — guards format-spec compliance across future edits

### Task 9: client signup flow (`web/cloud/js/signup.js` + shell pages)

- [ ] claim entry: the wizard boots from `#claim=<token>` on the subdomain host (the user arrives via the invite link/QR); the base-host landing page is static education with an "invitations only — contact the operator" note
- [ ] subdomain shell: reads claim fragment → `create()` passkey (options from register/begin) → **immediate `get()` on the new credential for PRF output** (never trust PRF-at-creation, per spec) → generate DEK → wrap → `PUT` envelope
- [ ] PRF feature-detect: if `prf.enabled` is false after create, delete nothing server-side yet — show the unsupported-authenticator error state with guidance (hardware key / another device) and abort before any envelope exists
- [ ] loss-protection education step (before the kit, per docs/cloud-mode.md Onboarding): plain-language "we cannot recover your data"; offer passkey-sync check / add-second-device-later / Emergency Kit; skippable only via an explicit acknowledgment checkbox recorded server-side (`POST /api/loss-ack` → `accounts.loss_ack_unix`) so the stateless wizard never re-nags
- [ ] Emergency Kit screen: generate recovery code client-side, derive + upload `envelope_rec` and verifier, render printable kit (URL + account id + code + QR of all three), explicit "I saved it" gate before entering the app shell
- [ ] wizard steps are **derived from observable state** (credential exists? loss ack set? `display-mode: standalone`?), not a stored step counter — survives the iOS Safari→installed-PWA storage split (docs/cloud-mode.md Onboarding)
- [ ] QR rendering: vendor a single tiny MIT QR-encoder JS into `web/cloud/vendor/` (no build step, no CDN)

### Task 10: client unlock flow (`web/cloud/js/unlock.js`)

- [ ] cold unlock: login/begin → `get()` with `allowCredentials` + top-level `prf.eval = salt_kek` → send assertion to finish (session) → fetch own envelope → derive KEK → unwrap DEK → render "vault unlocked" state (shows account + device list placeholder; real data arrives in C0c)
- [ ] warm unlock per spec "LDK" section: generate a non-extractable AES CryptoKey (LDK) stored in IndexedDB, cache DEK wrapped under it; on next launch unwrap silently, fall back to cold unlock when absent
- [ ] locked/unlocked UI states + explicit "Lock" action (drops in-memory DEK + LDK cache)

### Task 11: build + deploy wiring

- [ ] add `cloud` to the Dockerfile `go build` line (CGO_ENABLED=0 as-is)
Two-layer deployment: a static infra layer run once on the host with plain `docker compose`, and the app stack managed by Portainer gitops (deploy-branch + redeploy webhook — the repo's existing pattern).
- [ ] new **`docker-compose.infra.cloud.yml`** (static layer, run once on the fresh server, NOT managed by Portainer): two services + an attachable named network (`proxy`) that the app stack joins as external:
  - `traefik`: official image, configured entirely via command-line flags (no traefik.yml): entrypoints 80/443 with HTTP→HTTPS redirect, docker provider (`exposedByDefault=false`), DNS-01 resolver `--certificatesresolvers.wildcard.acme.dnschallenge.provider=${DNS_PROVIDER:-cloudflare}`, `--certificatesresolvers.wildcard.acme.email=${ACME_EMAIL}`, acme.json on a named volume; provider credentials (e.g. `CF_DNS_API_TOKEN`) passed through from `.env` — lego reads them from the container env, so other providers work by swapping two env vars
  - `portainer`: portainer-ce with `/var/run/docker.sock` mounted + data volume, exposed via a Traefik label on `portainer.${CLOUD_BASE_DOMAIN}` (covered by the wildcard cert — no extra DNS or cert work)
- [ ] ship `.env.infra.cloud.example` next to it: `CLOUD_BASE_DOMAIN`, `ACME_EMAIL`, `CF_DNS_API_TOKEN` (comment: scoped Cloudflare token, Zone → DNS → Edit, single zone), optional `DNS_PROVIDER`
- [ ] new **`docker-compose.cloud.yml`** (app stack, deployed as a Portainer gitops stack from this repo's `deploy` branch): single `cloud` service — same image as the bot (Dockerfile gains `cmd/cloud` on the build line), command runs the `cloud` binary, env (`CLOUD_BASE_DOMAIN`, `SESSION_SECRET`, `CLOUD_DB_PATH` on a named volume) supplied as Portainer stack env vars, Traefik labels using ``HostRegexp(`^.+\.${CLOUD_BASE_DOMAIN}$`)`` + exact base-domain rule, `tls.domains[0].main=${CLOUD_BASE_DOMAIN}` / `sans=*.${CLOUD_BASE_DOMAIN}`, resolver `wildcard`, external network `proxy`
- [ ] `.github/workflows/deploy.yml`: add `docker-compose.cloud.yml` to the image-tag `sed` in the "Update and commit docker-compose.yml" step so the deploy branch pins both compose files; the webhook loop already handles multiple URLs via the multiline `PORTAINER_REDEPLOY_HOOK` secret — no workflow change needed there (operator adds the cloud stack's webhook URL to the secret, Post-Completion)
- [ ] new `docs/cloud-deployment.md` (self-hosted cloud guide): (1) point `<base>` + `*.<base>` DNS records at the server — grey-cloud/DNS-only on Cloudflare, (2) copy `.env.infra.cloud.example` → `.env`, fill it, `docker compose -f docker-compose.infra.cloud.yml up -d`, (3) open `portainer.<base>`, create the gitops stack from this repo (`deploy` branch, `docker-compose.cloud.yml`), set stack env vars (`CLOUD_BASE_DOMAIN`, `SESSION_SECRET`), enable the redeploy webhook, (4) `docker exec` into the cloud container → `cloud admin invite`. Note the alternative for operators who don't want gitops: `docker compose -f docker-compose.cloud.yml up -d` directly against the same external network works too

### Task 12: Verify acceptance criteria

- [ ] full local walkthrough works with `CLOUD_BASE_DOMAIN=localhost`: `cloud admin invite` → open claim link → passkey (desktop platform authenticator) → envelope uploaded → kit shown → lock → unlock via passkey
- [ ] verify server never receives key material: grep handlers for any field that could carry DEK/PRF/code plaintext; envelopes/verifier are the only key-adjacent payloads and are ciphertext/hash
- [ ] `go test ./...`, `go build ./...`, `go build -tags mobile ./...`, `pnpm test` all pass
- [ ] run linter — all issues fixed

### Task 13: [Final] Update documentation

- [ ] CLAUDE.md: add `cloud` to the cmd/ list, `internal/cloudstore` + `internal/cloudserver` + `web/cloud/` to Code Layout, `docs/cloud-deployment.md` to the docs index
- [ ] docs/cloud-mode.md + docs/cloud-crypto.md: update status lines (C0a implemented; note any spec deviations discovered — e.g. server-assigned subdomain/account_id, which is a deliberate clarification: only key material must be client-generated)
- [ ] docs/environment.md: new `CLOUD_*` env vars

## Technical Details

- **Endpoints (base host)**: `GET /` static landing page only — registration is admin-CLI-only, no signup API exists. **(subdomain host)**: shell + `POST /api/webauthn/register/{begin,finish}`, `POST /api/webauthn/login/{begin,finish}`, `PUT|GET /api/envelopes/...`, `PUT /api/recovery-verifier`, `POST /api/loss-ack`, `GET /healthz`.
- **Claim token**: server stores `SHA-256(token)`; single use; gates first-credential registration so a guessed fresh subdomain cannot be hijacked. Travels only in the URL fragment.
- **Per-request RP**: `webauthn.New(&webauthn.Config{RPID: host, RPOrigins: ["https://"+host]})` per subdomain request — cheap, no cache needed initially.
- **No plaintext anywhere server-side**: envelopes `{v, nonce, ct, mac}` opaque; verifier stored hashed; PRF outputs never transmitted (client must not include `clientExtensionResults.prf` in what it posts to finish — strip before send).
- **`ponytail:` in-memory challenge store and rate limiter** — single-process service; move to the DB only if the service ever needs horizontal scale.

## Post-Completion

**External infra (operator, not agent)**:
- Provision the server: DNS records `<base>` + `*.<base>` at Cloudflare pointed at it — set the wildcard record to **DNS only (grey cloud)**, not proxied: Cloudflare's proxy only covers `*.<apex>` wildcards on free plans, and proxying would terminate TLS at Cloudflare with their cert instead of the origin's wildcard
- Mint the scoped Cloudflare API token (Zone → DNS → Edit, single zone), fill `.env`, `docker compose -f docker-compose.infra.cloud.yml up -d` — verify the wildcard cert issues on first request and that individual subdomains stay out of CT logs
- In Portainer (`portainer.<base>`): create the gitops stack from the `deploy` branch (`docker-compose.cloud.yml`), set stack env vars, enable the redeploy webhook, and append the webhook URL as a new line in the `PORTAINER_REDEPLOY_HOOK` GitHub secret

**Manual verification**:
- Real-device passkey walkthrough on iPhone (Face ID) and Android (fingerprint): signup, kit, lock/unlock — confirms PRF support on actual hardware (the load-bearing assumption; if a device lacks PRF, the error state from Task 9 must render, not a crash)
- Confirm the printable Emergency Kit renders/QR-scans correctly on paper
