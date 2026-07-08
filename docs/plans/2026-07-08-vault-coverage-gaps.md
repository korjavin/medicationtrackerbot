# Vault v1 coverage gaps — reminder state, gamification, tz plan history, API tokens + secrets toggle

## Overview

PR #482 shipped the C2e vault (`docs/vault-format.md`, `GET /api/export` + `POST /api/import`, cloud-side `web/domain/vault.js`). Its skip list deferred five things. A post-merge audit against `internal/store/migrations/` + `internal/seeddemo/wipe.go` shows four of them are real gaps for the stated goal — **the vault is the seamless server-migration mechanism** — and one is a false alarm.

Goal of this plan: close the four gaps so `export → new server → import` reproduces the user's install, and add a UI toggle so the secret-bearing parts can be left out when the file is meant to be shared or stored casually.

Locked decisions (user-confirmed 2026-07-08):

1. **`bp_reminder_state` / `weight_reminder_state` go into the vault.** They are `WipeUserTx`-deleted (`internal/seeddemo/wipe.go:73-74`) but never exported — today a replace-import silently resets the BP/weight reminder enabled flag, snooze, don't-remind-until and preferred hour. `med_reminder_pref` is already in the vault; these are the missing siblings.
2. **Gamification goes into the vault** — `gamification_targets` (user-editable via `PUT /api/gamification/targets`), `gamification_ledger`, `gamification_state`. Currently neither exported *nor* wiped, so a restore both loses HP/level/streak/targets and can leave a previous user's state in place. They must also be added to `WipeUserTx`.
3. **All tz transition plans, not just the current one.** `exportTZ` exports only `GetLatestActiveOrPendingTransitionPlan()`, while the wipe deletes every `tz_transition_plans` row — past plans are needed for history analysis. `tz.transition_plan` (object|null) becomes `tz.transition_plans` (array, oldest first).
4. **`api_tokens` goes into the vault**, so a server move doesn't force the user to re-mint MCP/API tokens. Only `token_hash` exists (plaintext is unrecoverable) — exporting the hash is exactly what makes existing tokens keep working on the new server.
5. **A secrets toggle.** The vault UI grows a checkbox, **checked by default**: *"Include API keys and external provider settings"*. When unchecked, `settings.integrations` and `api_tokens` are omitted from the export. On import, an **absent** integrations/api_tokens block leaves the target's existing values untouched (no wipe); a **present** block replaces them. This is the only import path in the vault that is not pure replace-semantics, and it is deliberate — a secrets-free vault must not silently unconfigure the destination.
6. **`workout_schedule_snapshots` stays skipped.** Verified write-only: `CreateGroupSnapshot` is called from `workout_handlers.go:77,130`; `ListGroupSnapshots` (`internal/store/workout/repo.go:1451`) has **zero callers** — no handler, no MCP op, no bot command, no frontend. Nothing can read the data, so nothing is lost. Document it as intentionally skipped in `docs/vault-format.md` with that reasoning rather than carrying it.
7. **Format stays `version: 1`.** v1 is introduced by the still-unmerged PR #482; nothing in the wild has exported it. No compat shim, no v2 bump.

## Context (discovery — read before writing code)

- **Format + structs**: `internal/server/vault_format.go` (one struct set shared by exporter and importer). Export: `internal/server/vault_export.go` (`buildVault` + per-domain `exportX`). Import: `internal/server/vault_import.go` (`importVault` = `seeddemo.WipeUserTx` → per-domain `importX`, all in one tx, raw INSERTs for exact-field/explicit-ID fidelity).
- **Wipe manifest**: `internal/seeddemo/wipe.go` — `WipeUserTx` is the authoritative "what belongs to one user" list. Anything added to the vault that is *not* in the wipe set will double up on import; anything wiped but not exported is the data-loss bug this plan fixes. **Keep the two lists in sync.**
- **Cloud side**: `web/domain/vault.js` (`exportAll` / `importAll`, `VAULT_MANAGED_TYPES`). Cloud stores per-record rows in an IndexedDB `records` store keyed by `recordId`; `importAll` replaces only vault-managed types so device/crypto state (`nk`, `voiceprovisioning`) survives.
  - Cloud **has** `bpreminderpref` / `weightreminderpref` singleton records (`web/domain/reminders.js:20-23`, bodies `{enabled, preferred_reminder_hour}`), currently NOT vault-managed. These become vault-managed and map onto the new `settings.bp_reminder` / `settings.weight_reminder` blocks. Cloud has no notion of `snoozed_until` / `dont_remind_until` — the importer must write those fields onto the record body verbatim so the export reads them back (round-trip fidelity), the same "passthrough field" trick the repo already uses.
  - Cloud has **no** gamification, **no** api_tokens, and only a single `tzplan-current`. Carry these as passthrough records purely for backup fidelity, exactly like `tzhistory` (`web/domain/vault.js:36,59,228,388`) — one record type, verbatim body, never read by any cloud feature.
- **Secrets gate seam**: bot `GET /api/export` handler in `vault_export.go`; cloud export is invoked from the shared Settings → Import/Export section (`web/static/js/features/settings/` — find the module Task 6 of the prior plan added). Bot side: query param `include_secrets` (absent or `1` → include; `0` → omit). Cloud side: an options arg on `exportAll`.
- **Schema of the new tables** (from `internal/store/migrations/`):
  - `api_tokens(id, name, token_hash UNIQUE, created_at DATETIME, last_used_at DATETIME)` — no `user_id` (bot is single-user, same as `medications` / `timezone_history`).
  - `bp_reminder_state` / `weight_reminder_state`: `(user_id PK, enabled, snoozed_until, dont_remind_until, last_notification_sent_at, notification_message_id, preferred_reminder_hour, created_at, updated_at)`. Export **only** `enabled`, `snoozed_until`, `dont_remind_until`, `preferred_reminder_hour` — the rest is scheduler/Telegram transient state (`last_notification_sent_at`, `notification_message_id`) or row metadata.
  - `gamification_targets(id, user_id, metric_key, low_val, high_val, falloff, mode, updated_at_unix, UNIQUE(user_id, metric_key))` — drop `id` (leaf; `metric_key` is the natural key).
  - `gamification_ledger(id, user_id, day_unix, ring, source_metric, kind, hp, detail, created_at_unix, UNIQUE(user_id,day_unix,ring,source_metric,kind))` — drop `id` (leaf).
  - `gamification_state(user_id PK, lifetime_hp, level, current_streak, longest_streak, freezes, insight_tier, last_scored_day_unix, backfilled_at_unix, updated_at_unix)` — singleton per user.
  - `tz_transition_plans(id, old_tz, new_tz, created_at_unix, status, steps_json, inputs_json, plan_hash, approved_at_unix, user_action, notified_at_unix)`; steps live in `steps_json` (the `tz_transition_steps` table is written via `CreateTransitionPlanWithSteps` — check whether it needs carrying too, and if it does, carry it nested under its plan).
- **Time storage rule (CLAUDE.md + `store_time_invariants_test.go`)**: unix-seconds INTEGER columns read back via `storedb.UnixToTime`. Wire form in the vault is always RFC3339 unless the format doc says otherwise. **Never bind a raw `time.Time` to a DATETIME column** — use the existing `rfc3339` / `nullTimeRFC` helpers in `vault_import.go` (see the modernc driver gotcha comment there).
- **MCP coverage guard**: no new HTTP routes here (the secrets toggle is a query param on the existing `GET /api/export`), so `mcpCoverageExempt` needs no change. Confirm by running `go test ./internal/server -run TestMCPCoverage`.
- **Frontend rules**: no hardcoded colors / inline `.style.`; the checkbox uses existing `wg-settings-row` idiom + design tokens.

## Development Approach

- **CRITICAL: every table added to the vault must be in `WipeUserTx`, and every table in `WipeUserTx` must be in the vault or in the documented skip list.** Add a Go test that pins this both ways against the two lists — that guard is the whole point of this plan, and it's what would have caught the original omission. `push_subscriptions`, `intake_reminders`, `change_events`, `miband_gps_tracks` (nested under miband), `workout_schedule_snapshots` are the allowed skip-list entries and each needs a Reason string.
- **CRITICAL: the golden fixture is the cross-runtime contract.** `tests/fixtures/vault-v1.json` gains the new blocks with ≥2 rows wherever a list is exported (two gamification targets, two ledger rows, two tz plans, two api tokens) so a dropped row fails both `TestVaultImportRoundTrip` (Go) and `cloud.vault-roundtrip.test.js` (Vitest). Regenerate `tests/fixtures/vault-v1-botexport.json` with `GEN_BOTEXPORT=1 TZ=UTC go test ./internal/server -run TestGenerateBotExportFixture`.
- **CRITICAL: run the Go suite under `TZ=UTC`.** See the `modernc-timetime-string-tz-gotcha` memory: a raw `time.Time` bound to a DATETIME column passes at `TZ+0200` and fails in UTC CI.
- Additive only. No migrations, no existing handler/store-method changes. The bot's live behavior must not move.
- Secrets-omitted export must still be a *valid* vault: `settings.integrations` absent (not `{}` with empty strings — those two are distinguishable and only the absent form means "leave alone"), `api_tokens` absent. Use pointer/`omitempty` fields.
- Keep it small: raw SQL in export/import mirroring the existing per-domain functions. No new store repos, no new domain services, no interfaces.

## Testing Strategy

- **Go integration** (`internal/server/vault_*_test.go`):
  - Extend `TestVaultImportRoundTrip` — the enriched fixture covers it for free once the new blocks are in the fixture.
  - `TestVaultWipeAndExportAgree`: reflect/scan the `WipeUserTx` table list against a declared vault-coverage list + skip list with Reasons; fail on drift in either direction.
  - `TestVaultExportSecretsOmitted`: `GET /api/export?include_secrets=0` → no `api_tokens`, no `settings.integrations`; `=1` and absent → both present.
  - `TestVaultImportPreservesSecretsWhenAbsent`: seed integrations keys + an api token, import a secrets-free vault, assert both survive; then import a secrets-bearing vault, assert both are replaced.
  - `TestVaultImportReminderState` / gamification / multi-plan tz: assert every row survives (two-row lists, oldest and newest both present).
- **Vitest** (`web/static/js/tests/cloud.vault-roundtrip.test.js`): the fixture deep-equal already covers the new blocks; add the passthrough recordId assertions (`gamification`, `apitokens`, `tzplanhistory-*`, `bpreminderpref`) and one `include_secrets: false` export case.
- **Frontend** (owning feature suite, per CLAUDE.md rule 8 — extend the existing vault/settings suite, do not add a new `*-branches` file): checkbox default-checked; unchecked → export payload omits the two blocks.
- **Manual E2E** (the actual goal): export from one instance with secrets on, import into a fresh DB, confirm reminders/gamification/tz history/API tokens all present and a previously-minted API token still authenticates.

## Progress Tracking

- `[ ]` not started · `[x]` done · ➕ added during implementation · ⚠️ deviation, explain inline

## Implementation Steps

### Task 1: Format + docs + fixture for the four new blocks

- [x] `internal/server/vault_format.go`: add `VaultReminderState` (`enabled`, `preferred_reminder_hour`, `snoozed_until` *|null*, `dont_remind_until` *|null*) referenced from `VaultSettings` as `bp_reminder` / `weight_reminder` (pointers, `omitempty`); `VaultGamification{Targets []VaultGamTarget; Ledger []VaultGamLedgerEntry; State *VaultGamState}` as a new top-level `data.gamification`; `APITokens []VaultAPIToken` as top-level `data.api_tokens` (pointer-slice or `omitempty` so "absent" is representable); change `VaultTZ.TransitionPlan *VaultTZPlan` → `TransitionPlans []VaultTZPlan` (oldest first) and give `VaultTZPlan` the fields it currently drops (`plan_hash`, `inputs_json`, `user_action`, `notified_at`).
- [x] Make `VaultIntegrations` pointer-optional on `VaultSettings` so a secrets-free export omits it and the importer can tell absent from empty. ⚠️ `importSettings` keeps the pre-pointer "write blanks" behavior behind a `TODO(task 4)` nil-guard so the tree compiles; the real absent-semantics land in Task 4.
- [x] `docs/vault-format.md`: document all four new blocks, the `include_secrets` toggle and its asymmetric (non-replace) import semantics, and move `workout_schedule_snapshots` into an explicit "intentionally skipped, with reason" list (write-only table, `ListGroupSnapshots` has no callers).
- [x] `tests/fixtures/vault-v1.json`: add the new blocks with ≥2 rows per list, `tz.transition_plans` with one `COMPLETED` + one `PENDING_APPROVAL` plan, one reminder block with a non-null `snoozed_until` and one with nulls.
- [x] Verify: `TZ=UTC go test ./internal/server -run TestVaultFixtureRoundTrips` (struct set ↔ fixture identity). ✅ passes. ⚠️ `TestVaultImportRoundTrip` and `cloud.vault-roundtrip.test.js` are now red by design — the enriched fixture carries blocks the exporter/importer (Tasks 2–4) and `web/domain/vault.js` (Task 6) do not yet handle. They go green in those tasks.

### Task 2: Bot-mode export of the new blocks

- [x] `vault_export.go`: `exportReminderState` (both tables), `exportGamification` (targets + ledger + state), `exportAPITokens`, and rewrite `exportTZ`'s plan section to read **all** `tz_transition_plans` rows ordered by `created_at_unix ASC` (raw SQL, no cutoff — mirror the `exportMiBand` precedent). ⚠️ No nested `tz_transition_steps` to carry: migration 069 dropped that table; `steps_json` is the only home for steps.
- [x] `buildVault` takes an `includeSecrets bool`; the handler reads `include_secrets` from the query (absent → true, `0`/`false` → false) and skips `exportAPITokens` + leaves `Settings.Integrations` nil when false.
- [x] Test: `TestVaultExportSecretsOmitted` + extend `TestVaultExportHandler` to cover the new domain walks against a migrated DB. ✅ `TZ=UTC go test ./internal/server` — only `TestVaultImportRoundTrip` red, by design until Tasks 3–4 land the import side.

### Task 3: Bot-mode import of the new blocks + wipe-set sync

- [x] `internal/seeddemo/wipe.go`: add `gamification_targets`, `gamification_ledger`, `gamification_state` to the user-scoped delete list. (`api_tokens` is NOT wiped — see Task 4.)
- [x] `vault_import.go`: `importReminderState`, `importGamification`, all-plans `importTZ` (now also carries `plan_hash`, `inputs_json`, `user_action`, `notified_at_unix`). Use `rfc3339` / `nullTimeRFC` for every DATETIME bind and raw unix ints for the `*_unix` columns.
- [x] Test: `TestVaultImportReminderStateGamificationAndTZPlans` (two-row lists survive; oldest+newest tz plan keep every field). ⚠️ `TZ=UTC go test ./internal/server` — `TestVaultImportRoundTrip` still red on exactly one block, `api_tokens` (every other block verified byte-identical); it goes green in Task 4 with `importAPITokens`.

### Task 4: API tokens + the secrets toggle's import semantics

- [x] `importAPITokens`: when `data.api_tokens` is **absent**, do nothing (existing tokens survive). When **present**, `DELETE FROM api_tokens` then insert every row (`name`, `token_hash`, `created_at`, `last_used_at`) — replace semantics scoped to the block. Same rule for `settings.integrations`: absent → skip the provider-key columns in the `UPDATE settings`. ⚠️ Implemented as a **split**, not COALESCE-with-nil: the provider keys move to a second `UPDATE settings` that only runs when `Integrations != nil`. COALESCE can't express "leave alone" here because an intentionally-cleared key is the empty string, not NULL.
- [x] Test: `TestVaultImportPreservesSecretsWhenAbsent` (both directions). ✅ `TZ=UTC go test ./internal/server` fully green — `TestVaultImportRoundTrip`, red since Task 1 on the `api_tokens` block, now passes.

### Task 5: The wipe/vault agreement guard

- [ ] `internal/server/vault_coverage_test.go`: a declared `vaultCovered` set + `vaultSkipped` map (table → Reason), asserted against the table list `WipeUserTx` actually deletes from. Export the wipe manifest from `seeddemo` (a `var WipedTables []string` next to the existing lists, or a small accessor) rather than re-typing it. Fail with the exact missing table name in either direction.
- [ ] Skip-list Reasons: `push_subscriptions` (device-bound), `intake_reminders` (Telegram message ids), `change_events` (SSE tag stream), `miband_gps_tracks` (nested under `workouts.miband[].gps`), `workout_schedule_snapshots` (write-only; `ListGroupSnapshots` has no callers), `weight_goals`/etc. (already covered — these belong in `vaultCovered`).

### Task 6: Cloud-side parity (`web/domain/vault.js`)

- [ ] `exportAll(records, { includeSecrets = true })`: emit `settings.bp_reminder` / `weight_reminder` from the `bpreminderpref` / `weightreminderpref` records (verbatim body, so importer-written `snoozed_until` etc. round-trip); emit `gamification` / `api_tokens` from passthrough records; emit `tz.transition_plans` from `tzplan-current` + `tzplanhistory-*`. When `includeSecrets` is false, omit `settings.integrations` and `api_tokens`.
- [ ] `importAll`: write the reminder pref records (preserving the bot-only fields on the body), passthrough `gamification` / `apitokens` singletons, `tzplanhistory-<idx>` per non-current plan, and keep the active/pending plan at `tzplan-current`. Add every new type to `VAULT_MANAGED_TYPES` **except** the ones that must survive a replace; when `api_tokens` is absent from the vault, do not delete the existing `apitokens` record (mirror the bot's asymmetric rule).
- [ ] Update the record-inventory comment block at the top of the module.
- [ ] Test: `cloud.vault-roundtrip.test.js` deep-equal against the enriched fixture + new recordId assertions + a `includeSecrets: false` case.

### Task 7: Settings UI checkbox

- [ ] Add a `wg-settings-row` checkbox to the Import/Export section — label *"Include API keys and external provider settings"*, checked by default, helper text noting the file will contain secrets and should be passphrase-encrypted.
- [ ] Bot mode: append `?include_secrets=0` when unchecked. Cloud mode: pass `{ includeSecrets: false }` into `exportAll`.
- [ ] Test: extend the existing vault/settings feature suite (no new `*-branches` file).

### Task 8: Docs

- [ ] `docs/api.md`: `GET /api/export?include_secrets=0|1`.
- [ ] `docs/features.md` + `docs/cloud-mode.md`: the vault now carries reminder prefs, gamification, full tz-plan history and API tokens; the toggle and its non-replace import semantics; the one intentionally-skipped table and why.
- [ ] Regenerate `tests/fixtures/vault-v1-botexport.json`.
