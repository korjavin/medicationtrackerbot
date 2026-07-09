# User-Mintable Invites for Cloud Mode (med-eas.1)

## Overview
- Any signed-in cloud user can mint an invite for a friend from their own account subdomain (e.g. `fuzzy-newt-xi7jqn.cloud.myhealthbot.ai`) — no admin CLI, no visit to the base domain.
- New endpoint `POST /api/invite` (session-authed, served on the account subdomain like every other `/api/*` route — no proxying needed, the router already host-routes these).
- Rate limit: max 100 invites per account per rolling 30 days, enforced by counting rows in the DB (no in-memory limiter — must survive restarts).
- Settings UI gets a cloud-only "Invite a friend" row that mints and shows the claim URL + QR code + copy button.

## Context (from discovery)
- `internal/cloudserver/provision.go` — `Provision()` already does everything (subdomain allocation, claim token, VAPID keys, expiry sweep). `Invite.ClaimURL(baseDomain)` builds the fragment-carried claim link. Today it is called only from the admin CLI (`cmd/cloud/admin.go invite`).
- `internal/cloudserver/session.go` — `RequireSession` middleware puts `Session{AccountID, CredentialID}` in the request context; every account-scoped API (`device.go`, `sync.go`, `push.go`, `telegram.go`) follows the same `RegisterRoutes(mux)` + `RequireSession` pattern.
- `internal/cloudstore/migrations/001_init.sql` — `accounts` table has no provenance column; latest migration is `009_telegram.sql`.
- `cmd/cloud/main.go` — `cfg.baseDomain` and `cfg.claimTTL` (default 14d) are available where the API mux is wired (~line 186-222).
- Frontend pattern: `web/static/js/features/settings.js` reveals cloud-only blocks (`.wg-settings-cloud-devices`, `.wg-settings-notifications-cloud`) when `window.MedTrackerCloud.ctx` exists, and dynamic-imports cloud modules by absolute path (`import('/js/push.js')`). QR generator is vendored at `web/cloud/vendor/qrcode.mjs` (served at `/vendor/qrcode.mjs` on subdomains; used by `signup.js` + `transfer.js` via `qr.createSvgTag(4)`).
- `internal/cloudserver/rate_limit.go` is an in-memory per-IP limiter for auth ceremonies — NOT suitable for a monthly quota (resets on restart); the DB count is the limiter.
- MCP coverage guard (`internal/server/mcp_coverage_exempt.go`) applies only to the bot server mux, not `cmd/cloud` — no exemption entry needed.

## Design decisions
- **Rate limit = count of accounts created by this account in the last 30 days.** New nullable column `accounts.created_by_account_id` (NULL for admin-CLI invites). `SweepExpiredClaims` deleting an expired unclaimed invite frees quota — that matches the intent ("100 *users* per month", not 100 clicks). ponytail: quota can be gamed by letting invites expire; tighten to an append-only mint log only if abuse ever materializes.
- **Server builds the claim URL** (it has `baseDomain`); response is `{subdomain, claim_url, expires_at}`. Token travels only in the JSON response / URL fragment, never stored in cleartext — same property as the CLI path.
- **QR rendered client-side** from the vendored `qrcode.mjs` — no new dependency, no server-side image generation.

## Development Approach
- **Testing approach**: NO unit tests. They blow up the codebase for no value here.
  - add an integration test ONLY when it covers a real boundary (API contract, data migration, cross-component flow) and gives a guarantee manual checking can't
  - if no integration test adds a real guarantee, the task has NO test items — that is correct and expected
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: if a task adds an integration test, it must pass before starting the next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- Maintain backward compatibility (admin CLI `invite` keeps working, existing accounts get NULL creator)

## Testing Strategy
- **Unit tests**: none.
- **Integration tests**: Go handler test for the `/api/invite` contract (auth, success shape, 429 at quota); Vitest case in the settings feature suite for the invite row/modal (repo rule 8: integration-first through `tests/helpers/frontend-harness.js`).
- **E2E tests**: none (no existing e2e suite).

## Progress Tracking
- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope

## Implementation Steps

### Task 1: Store — invite provenance + quota count
- [x] add `internal/cloudstore/migrations/010_invite_provenance.sql`: `ALTER TABLE accounts ADD COLUMN created_by_account_id TEXT` + index on `(created_by_account_id, created_at_unix)`
- [x] extend `cloudstore.Repo.CreateAccount` with a `createdBy string` param (empty → stored NULL); ➕ no `Account` struct field / scan-site change — nothing reads the column back, `CountAccountsCreatedBy` is the only consumer (add the field when a reader appears)
- [x] add `cloudstore.Repo.CountAccountsCreatedBy(ctx, accountID string, since time.Time) (int, error)`
- [x] update all `CreateAccount` callers (`Provision`, tests) to pass `""`

### Task 2: Provision plumbing
- [x] add `createdBy string` param to `cloudserver.Provision` (threaded into `CreateAccount`); admin CLI passes `""`
- [x] update `provisionStore` interface + existing provision tests accordingly; ➕ interface already carried `createdBy` from Task 1, so only the `Provision` signature + call sites changed; no fake `provisionStore` exists (tests use the real repo)

### Task 3: `POST /api/invite` endpoint
- [x] create `internal/cloudserver/invite.go`: `InviteAPI{store, sessionSecret, baseDomain, claimTTL}` with `RegisterRoutes(mux)` registering `POST /api/invite` behind `RequireSession` (follow `device.go` shape)
- [x] handler: read `Session.AccountID` from context; `CountAccountsCreatedBy(accountID, now-30d)`; if ≥ 100 → `429` with JSON error incl. quota info; else `Provision(..., accountID)` and respond `{subdomain, claim_url, expires_at}` (claim_url via `Invite.ClaimURL(baseDomain)`)
- [x] hardcode the limit as `const inviteMonthlyQuota = 100` — ponytail: env-var knob only if someone actually asks
- [x] wire `InviteAPI` into the api mux in `cmd/cloud/main.go` (pass `cfg.baseDomain`, `cfg.claimTTL`)
- [x] integration test `internal/cloudserver/invite_test.go`: no session → 401; with session → 200 + claim_url matches `https://<sub>.<base>/#claim=<hex>` and account row has creator set; seed quota-many creations → 429; ➕ provenance asserted via `CountAccountsCreatedBy` (no `Account` reader field exists, per Task 1)

### Task 4: Settings UI — invite row + claim modal with QR
- [x] add a hidden `.wg-settings-cloud-invite` row ("Invite a friend") to the settings markup, revealed in cloud mode next to the existing `.wg-settings-cloud-devices` reveal in `web/static/js/features/settings.js`
- [x] on tap: `POST /api/invite`; on 429 show a friendly "monthly invite limit reached" toast; on success open a modal showing the claim URL (copy button) + QR SVG; ➕ the fetch is a plain `fetch()`, not `apiCall()` — the cloud apiCall shim 404s any route it doesn't own; ➕ the QR import goes through a bare `loadQrcodeModule()` global (same test seam as `loadCloudPushModule`)
- [x] styling via existing `--wg-*` tokens / classes only (repo rule 3); ➕ `kit-qr` is shell-only CSS, and `.wg-modal` needs no per-modal CSS (see `wg-backend-logs-modal`), so the invite modal ships with zero new CSS
- [x] Vitest: extend the settings feature suite — cloud ctx present → row visible, tap → mocked 200 renders modal with claim URL + QR svg; mocked 429 → limit toast; no cloud ctx → row hidden

### Task 5: Verify acceptance criteria
- [x] verify: mint works from an account subdomain session, quota enforced at 100/30d, admin CLI invite unaffected, QR + copy shown — covered by `TestInviteAPI_Contract` (401 / 200 + claim-URL regex + provenance / 429), `cmd/cloud/admin.go:92` still passing `""` to `Provision`, and the three settings-suite cases (row hidden outside cloud, mint → modal with claim URL + QR svg, 429 → limit toast)
- [x] `go test ./...` passes
- [x] `pnpm test` passes (278 files, 2967 tests; needed `pnpm install` first in a fresh worktree)
- [x] run linters if configured (`go vet ./...`) — clean

### Task 6: [Final] Update documentation
- [ ] add "User-mintable invites" subsection to `docs/cloud-mode.md` (endpoint, quota semantics, provenance column)
- [ ] mention the new endpoint in `docs/api.md` if cloud endpoints are catalogued there

## Technical Details
- Response shape: `{"subdomain": "sunny-vole-abc123", "claim_url": "https://sunny-vole-abc123.<base>/#claim=<64-hex>", "expires_at": "<RFC3339>"}`
- Quota window: rolling `now - 30*24h`, compared against `accounts.created_at_unix` of rows with `created_by_account_id = ?`
- 429 body: `{"error": "invite limit reached", "limit": 100, "window_days": 30}`
- Migration is additive only (rule 2: never modify existing migrations)

## Post-Completion
**Manual verification**:
- On the deployed cloud instance: sign in on a personal subdomain, mint an invite from Settings, scan the QR with a phone, complete the passkey claim flow end-to-end
- Confirm an admin-CLI invite still prints URL + terminal QR and has NULL creator

**External system updates**:
- None — no new env vars, no infra changes; migration runs automatically on deploy
