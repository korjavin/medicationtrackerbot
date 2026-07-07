# Cloud Telegram: BYO + Start-over reachable from the pending page

## Overview
Fix bd med-eas.32 (P1 bug). In cloud mode, after a user provisions a managed child bot the account enters the `pending` state (a `tg_pending` row exists, bot not yet bound). Binding depends on a single manager-webhook `managed_bot_created` update from Telegram. If that update is lost (e.g. a 404 during a redeploy — observed on cloud.myhealthbot.ai: `getWebhookInfo` showed `last_error 'Wrong response from the webhook: 404 Not Found'`, `pending_update_count 0`), Telegram does **not** re-send it. The child bot exists but is never bound, and the pending page (`renderCreateBot` in `web/cloud/js/telegram.js`) shows **only** the deep-link button — no BYO token field, no "start over". So the always-works BYO fallback is unreachable exactly when the managed path failed; the only escape today is waiting out the 1h pending TTL.

**Fix:** on the pending page, always surface (a) the existing BYO token form and (b) a "Start over" control that clears the pending row so status returns to the consent/none screen. Both reachable without waiting for the TTL.

## Context (from discovery)
- `web/cloud/js/telegram.js`: `render()` `case 'pending'` (~line 97) → `renderCreateBot(status.deep_link, status.suggested_username)`. `renderCreateBot` (~line 183) currently renders **only** the deep-link `<a>` button. The BYO form markup lives on the consent/none screen (~lines 128-142) and `submitBYO()` (~line 198) POSTs `/api/telegram/byo`. Top-of-file comment mandates: DEK-bearing shell, dynamic values written via `textContent` / `.href` only, never string-interpolated into markup.
- `internal/cloudserver/telegram.go`: `RegisterAPIRoutes` (~line 85) wires `POST /provision`, `GET /status`, `GET /diag`, `POST /byo`, `POST /skip`, `POST /test`, `DELETE /api/telegram`. `Status` (~line 132) derives state: `BotByAccount` success → `linked` (LinkedAt set) or `bot_created`; on `sql.ErrNoRows` → `pending` (when `PendingUsernameByAccount` returns a username) / `skipped` / `none`.
- **BYO already works from pending unchanged**: `BYO` (~line 404) `UpsertBot`s directly using the pasted token's own bot id; it neither reads nor consumes the pending row. Because `Status` checks the bot row *before* the pending branch, a leftover `tg_pending` row after a successful BYO is harmless (bot wins). So the frontend only needs to expose the existing form + `submitBYO` on the pending page — no BYO backend change.
- `internal/cloudstore/tg.go`: has `CreatePending`, `ConsumePendingByUsername` (by username, with `RETURNING`), `PendingAccountByUsername`, `PendingUsernameByAccount`. **No delete-by-account method exists** — "Start over" needs a new `DeletePendingByAccount`.
- Tests: `internal/cloudserver/telegram_test.go` exercises provision/byo/test/delete/status via a `doReq` helper. Frontend suite: `web/cloud/js/tests/telegram.test.js` (run through `vitest.config.mjs`, which includes `web/cloud/js/tests/**`).

## Development Approach
- **Testing approach**: NO unit tests. Integration tests only where they guard a real boundary.
  - Backend: one integration case (provision → pending → reset → status `none`) guards the new endpoint + store method contract — include it.
  - Frontend: extend the existing telegram vitest suite to assert the pending page now renders the BYO form + Start-over control and that Start-over calls `/api/telegram/reset` then returns to the consent/none view — this guards the actual bug (unreachable fallback), so include it.
- Complete each task fully before the next. Small, focused changes. Maintain backward compatibility (deep-link button stays; managed path unchanged).

## Testing Strategy
- **Unit tests**: none.
- **Integration tests**: backend reset-flow case in `telegram_test.go`; frontend pending-page case in `web/cloud/js/tests/telegram.test.js`. Both guard the fix.
- **E2E tests**: none (no e2e suite for this flow).

## Progress Tracking
- Mark completed items `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix; blockers with ⚠️ prefix.
- Keep this plan in sync with actual work.

## Implementation Steps

### Task 1: Add DeletePendingByAccount store method
- [x] in `internal/cloudstore/tg.go`, add `func (r *Repo) DeletePendingByAccount(ctx context.Context, accountID string) error` running `DELETE FROM tg_pending WHERE account_id = ?` (idempotent — deleting zero rows is success, not an error)
- [x] place it next to the other pending helpers (`ConsumePendingByUsername` / `PendingUsernameByAccount`) and match their error-wrapping style

### Task 2: Add POST /api/telegram/reset handler
- [x] in `internal/cloudserver/telegram.go`, add `func (t *TelegramAPI) Reset(w http.ResponseWriter, r *http.Request)`: require session (mirror the `SessionFromContext` guard used by sibling handlers), call `t.store.DeletePendingByAccount(ctx, sess.AccountID)`, on error `slog.Error` + 500, on success `writeJSON(w, http.StatusOK, map[string]bool{"reset": true})`
- [x] wire the route in `RegisterAPIRoutes`: `mux.Handle("POST /api/telegram/reset", RequireSession(t.store, t.sessionSecret, http.HandlerFunc(t.Reset)))`
- [x] confirm reset only clears the pending row and does not touch a `bot`/`tg_skipped` row (so it is a no-op-safe "start over" from the pending state); after reset, `Status` returns `none` (test also asserts a sibling account's bound bot is untouched)
- [x] add reset to the MCP coverage exemption list — verified: no MCP coverage guard exists for cloudserver routes (grep for mcpCoverageExempt/mcp_coverage in internal/cloudserver is empty), skipped per plan condition
- [x] integration test in `internal/cloudserver/telegram_test.go`: provision → assert status `pending` → `POST /api/telegram/reset` (200) → assert status `none` (extends TestTelegramProvisioningStateMachine's already-pending second account)

### Task 3: Surface BYO + Start-over on the pending page
- [x] in `web/cloud/js/telegram.js`, extend `renderCreateBot(deepLink, suggested)` so the pending page renders, below the existing "Open Telegram" deep-link button: the same BYO token form used on the consent screen (reuse the identical `#tg-byo-token` input + `#tg-byo-submit` button markup) inside a `<details>` "Advanced: use your own bot token" disclosure, plus a "Start over" button (`#tg-reset`)
- [x] wire the BYO submit on this page to the existing `submitBYO()` (same handler that posts `/api/telegram/byo`); do not duplicate the submit logic
- [x] add a `resetPending()` helper: `await apiJSON('/api/telegram/reset', { method: 'POST' })` then re-render to the consent/none view (call `render()` with a fresh `/api/telegram/status`, or `render({ enabled: true, state: 'none' })`) so the user lands back on the initial screen; wire `#tg-reset` click to `resetPending().catch(showError)`
- [x] keep the DEK-shell contract: any dynamic value (deep link, suggested username) set via `.href` / `textContent`, never interpolated into the HTML string (follow the existing pattern in this function)
- [x] add a short line of copy on the pending page noting that if Telegram didn't finish linking automatically, they can paste the bot's token (BYO) or start over — no waiting required

### Task 4: Extend frontend telegram test for the pending page
- [ ] in `web/cloud/js/tests/telegram.test.js`, add a case rendering the `pending` state and asserting the BYO form (`#tg-byo-token`, `#tg-byo-submit`) and Start-over control (`#tg-reset`) are present alongside the deep-link button
- [ ] add a case asserting a Start-over click POSTs `/api/telegram/reset` and the view returns to the consent/none screen (mock `apiJSON`/fetch the way the existing suite does)

### Task 5: Verify acceptance criteria
- [ ] verify: from `pending`, pasting a valid token via BYO links the bot (status → `linked`/`bot_created`), and Start-over clears pending (status → `none`) — both without waiting for the TTL
- [ ] verify the managed deep-link path and the consent-screen BYO/skip flows are unchanged
- [ ] run `go test ./internal/cloudserver/... ./internal/cloudstore/...` — must pass
- [ ] run `pnpm test` (or the scoped cloud vitest run) — must pass
- [ ] run `go vet ./...` and `golangci-lint run` — fix all issues

### Task 6: [Final] Update documentation
- [ ] document `POST /api/telegram/reset` in `docs/api.md` (cloud-only section, next to the other `/api/telegram/*` routes)
- [ ] add a short note to `docs/cloud-mode.md` (Telegram linking) that the pending page always exposes BYO + Start-over so a lost `managed_bot_created` update never strands the account

## Technical Details
- New store method: `DELETE FROM tg_pending WHERE account_id = ?`, idempotent.
- New route: `POST /api/telegram/reset` (session-authed) → `{"reset": true}`.
- State transitions: `pending` --reset--> `none`; `pending` --BYO(token)--> `bot_created`/`linked` (bot row wins over the leftover pending row in `Status`).
- No migration (uses existing `tg_pending` table). No change to the managed manager-webhook bind path.

## Post-Completion
**Manual verification:**
- On a cloud instance, provision a managed bot, simulate the lost bind (or just stay on the pending page), then confirm both BYO (paste the created bot's token from @BotFather) and Start-over complete without waiting out the 1h TTL.

**External system updates:**
- None. Pure in-repo change; deploys as part of the normal cloud image.
