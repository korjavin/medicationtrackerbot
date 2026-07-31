# Legacy bot-mode vs cloud-mode feature parity

Cloud mode (`cmd/cloud`, `internal/cloudserver`, `web/cloud`) is the primary production surface; bot/server mode (`cmd/bot`, `internal/server`, `web/static`) is **legacy maintenance**. This matrix is retained as historical audit material and as a reference when a bot feature still needs a deliberate cloud decision. It is not a mandate to keep chasing feature parity.

**Direction is one-way: bot → cloud.** As of 2026-07-17 the goal "bot mode should have everything cloud has" is dropped. We bring bot features into cloud; we do **not** backport cloud-only features into bot. A "reverse gap" (cloud has it, bot doesn't) is therefore **intentional, not a gap to close**. A change that would *force* new bot-server code to land a cloud feature is a red flag (cloud→bot coupling) — prefer a cloud-only path instead.

**How to read it.** Cloud is a *blind relay*: the server never sees plaintext, all domain logic runs client-side (`web/domain/*`, `web/cloud/js/*`) over an encrypted vault + oplog sync. So "unrouted in cloud" is only a gap if the capability isn't re-implemented client-side. Many bot `/api/*` routes are intentionally unrouted in cloud because the same feature is served browser-direct (BYO key → provider), via `CloudVault`, or via the in-tab MCP dispatcher.

Generated 2026-07-17 from a four-surface audit (HTTP routes · MCP+AI/voice · frontend mode-gates · ingestion/reminders/export). Update the row and its evidence when a gap is closed.

## Legend

- **parity** — same capability in both modes (transport may differ: server `/api` vs browser-direct/`CloudVault`/apiCall-shim).
- **gap** — bot has it, cloud user loses it; a follow-up bead tracks the fix.
- **intentional divergence** — deliberately different by design (zero-knowledge model, Telegram-native auth, native-only device APIs, server-side Python runtime). Not a defect.

---

## HTTP route surface

Bot: `internal/server/server.go`. Cloud router: `web/cloud/js/apishim.js` `createApiRouter` (fall-through = hard 404).

### Medications / BP / weight / food / workouts / vitals / diary / TZ / settings — parity

All core CRUD + domain reads/writes route in cloud: meds & intake (`server.go:812-824,862-864,918-919` ↔ `apishim.js:393-457`), BP (`server.go:827-840` ↔ `apishim.js:256-265,765-804`), weight (`server.go:847-859` ↔ `apishim.js:267-278,770-789`), food logs/products/stats (`server.go:924-947` ↔ `apishim.js:476-521`), workouts incl. sessions/rotation/logs/stats (`server.go:867-904` ↔ `apishim.js:540-659`), vitals/diary/tz/settings (`server.go:948-973` ↔ `apishim.js:239-469`). **parity.**

### Route-surface — accepted divergences (product decision 2026-07-17: not needed in cloud)

| capability | bot | cloud | status |
|---|---|---|---|
| Mi-band GPS detail | `GET /api/workout/miband/{id}/gps` `server.go:908` | cloud miband regex end-anchored (`apishim.js:665`) → 404 | intentional divergence — GPS is never sealed into the cloud vault (`vitals_import_api.go`), so a cloud GPS detail view has no data to show. Not wanted. |

> BP/weight per-metric CSV export was removed entirely (bot + cloud) on 2026-07-24 — dead code (no button wired), superseded by the full-vault `CloudVault` / `GET /api/export`. No longer a parity gap.

### Route-surface intentional divergences

| capability | rationale |
|---|---|
| BP CSV import (`/api/bp/import`), food `settings/status\|toggle` | bot-only routes, no shared-UI caller in cloud; food enablement rides `/api/settings/features` |
| `changes` / `changes/stream` SSE (`server.go:940-941`) | cloud syncs via encrypted oplog (`sync.js`), no SSE |
| full-vault export/import (`server.go:843-844`) | E2E crypto forbids plaintext to server → `CloudVault.exportAll/importAll` browser-side (`cloud-boot.js:107-116`) |
| elevenlabs signed-url/upload-file (`server.go:968-969`) | browser-direct `CloudElevenLabs` with BYO vault key (`apishim.js:885`) |
| webpush + reminders/upcoming (`server.go:913-917,819`) | blind push relay: horizon computed client-side, uploaded encrypted (`push.js`, `web/domain/reminders.js`) |
| MCP plumbing (`server.go:1001-1005`) | in-tab `CloudMCPDispatcher` + relay responder (`mcp-responder.js`) |
| auth (`/auth/status`, OIDC, Telegram callback `server.go:775-781`) | cloud auth = vault-unlock + WebAuthn device claim (`unlock.js`/`claim.js`/`signup.js`); Telegram login UI forbidden in cloud (CLAUDE.md rule 11) |

---

## MCP + AI / voice / vision

| capability | bot | cloud | status |
|---|---|---|---|
| `mcp_help` / `mcp_call` / operation registry | `internal/mcp/`, `registry/` | `mcp-responder.js`, generated `mcp-catalog.generated.js` | parity |
| `mcp_execute` (server-side Python runner) | `internal/mcp/execute.go`, `executor/` | throws `-32601` by design (`mcp-responder.js:579`) | intentional divergence — zero-knowledge: no server-side plaintext to run a script against |
| Composite analysis (`analyze_cardiovascular`, `analyze_fitness`) | `internal/mcp/cardiovascular.go:427`, `fitness.go:443` | `web/domain/analysis.js`, cloud-only ops in `mcp-catalog.cloud-extra.js`, routes in `apishim.js` | **parity** (Path B, cloud-only — no bot change). Ported client-side: a pure `analysis.js` reproduces the Go aggregation over vault data; two ops (`health.analyze_cardiovascular`/`health.analyze_fitness`) are added via a **cloud-only catalog seam** (`CLOUD_EXTRA` merged into the responder's `CATALOG` at import, leaving the drift-guarded generated file untouched) and served by `GET /api/health/{cardiovascular,fitness}-analysis` in `createApiRouter`. Discoverable via `mcp_help`, callable via `mcp_call` — cloud's substitute for the `mcp_execute` it can't deliver. |
| AI meal parse (text) | `internal/ai/openai.go:175` | `aiclient.js:308` | parity (browser-direct BYO) |
| AI meal parse (photo/vision) | `internal/ai/openai.go:439` | `aiclient.js:341` | parity (photo never crosses `/api`) |
| Food barcode lookup | `internal/store/food/openfoodfacts_api.go` | browser-direct/trial-proxy (`fooddb.js`) | parity |
| ElevenLabs signed-URL + voice | `elevenlabs_handlers.go:62` | browser-direct `elevenlabs-signed-url.js:14` | parity |
| ElevenLabs in-call **"Send photo"** | `elevenlabs_handlers.go:131` | browser-direct `uploadFile`; both render sites un-guarded | parity (med-eas.55, merged #649) |
| Gamification AI narration | none | `gamification-narrator.js` | **intentional divergence (cloud-only)** — reverse gap; not backported to bot per the one-way bot→cloud direction. |

---

## Ingestion

| capability | bot | cloud | status |
|---|---|---|---|
| Mi Band / `.nxk` vitals import | Telegram doc upload `internal/bot/sleep_import.go:23` | `POST /api/vitals/import` `vitals_import_api.go:41` (shared `internal/domain/nxk` parser) | parity (divergent entry point; GPS never sealed in cloud) |
| External workout webhook feed | `POST /api/workout/external` `server.go:1001` (HMAC/key-gated) | none | intentional divergence — product decision 2026-07-17: not needed in cloud |
| Apple Health med import / BP CSV import (offline) | `cmd/importer`, `cmd/bpimporter` (direct-DB CLIs) | structurally impossible (blind server) | intentional divergence |

---

## Reminders / notifications

Cloud computes the reminder horizon client-side (`web/domain/reminders.js` `buildHorizon`) and uploads it via the blind push relay (`push.js` → `internal/cloudserver/push.go`); both modes support `webpush` + `telegram` channels. The `web/static` PushManager is gated off in cloud (`bootstrap.js:198`) because cloud runs its own SW push path — **not** a gap.

| kind | bot | cloud | status |
|---|---|---|---|
| Medication dose + re-remind | `internal/scheduler/medication*.go` | `reminders.js:165,185` | parity |
| BP reminder | `scheduler/bp_reminders.go` | `reminders.js:191-207` | parity |
| Weight reminder | `scheduler/weight_reminders.go` | `reminders.js:212-229` | parity |
| TZ-shifted dose times | `scheduler/tz_plan_notifier.go` | `reminders.js:56` | parity |
| Low-stock reminder push | `scheduler/low_stock.go` | `reminders.js` `low_stock` kind (`web/domain/reminders.js`, reuses `medschedule.js` `listLowOnStock`) | parity (med-eas.57) — **minor divergence**: cloud reuses the medication-reminder enable gate (no separate pref), so turning med reminders off silences low-stock too; the bot fires it independent of that toggle |
| Weekly digest | `scheduler/weekly_digest.go` | `digest` kind via `computeReminderEntries` (`reminders.js`) + `formatWeeklyDigest`/`nextWeeklyDigestFireUnix` (`web/domain/reminders.js`); Settings toggle un-hidden | parity (med-eas.58) — **content freshness caveat**: the bot recomputes the review at Sunday 19:00 fire time; cloud snapshots it at recompute time and forward-schedules, so a mid-week-only user can receive a digest up to a week stale (blind-relay limitation, self-heals for active users) |
| Workout-session reminder | `scheduler/workout.go` | `workout` kind in horizon, gated on the `workout` feature flag (`web/domain/reminders.js`, mirroring the bot's `GetWorkoutEnabled`) | parity (med-eas.59) — **primary fire only**: the interactive re-notify(+3h)/auto-skip(+6h)/snooze/stale-90min state machine is intentionally not reproduced over the blind relay (server-observed session state a blind relay can't see; same accepted limitation as medication re-reminders) |
| **TZ-plan progress notifications** (non-dose) | `scheduler/tz_plan_notifier.go` | appears absent | **gap (verify/scope)** → bead |

---

## Drug-interaction checks & export/import

| capability | bot | cloud | status |
|---|---|---|---|
| RxNorm normalize + interaction check | server-side `internal/rxnorm/`, `medication_handlers.go:269,404` | client-side over blind proxy `rxnav_proxy.go:56`, `web/cloud/js/rxnorm.js:73` | parity (divergent impl). Caveat both modes: NLM decommissioned the public interaction-list endpoint (`rxnorm.js:11`) — warnings may not surface upstream. |
| Full-vault export | `GET /api/export` `vault_export.go:25` | `CloudVault.exportAll` `cloud-boot.js:108` (shared `web/domain/vault.js`) | parity (C2e) |
| Full-vault import | `POST /api/import` `vault_import.go:38` | `CloudVault.importAll` `cloud-boot.js:116` | parity (C2e) |

---

## Open real gaps (follow-up beads, discovered-from med-eas.54)

Retained after product triage 2026-07-17 (beads under the `med-eas` epic, discovered-from `med-eas.54`):

1. ~~**med-eas.56** (P2) — Composite MCP `analyze_*` → client-side cloud implementation; cloud's substitute for the unavailable `mcp_execute`.~~ **Closed** — shipped via Path B (cloud-only catalog seam, no bot/Go); see the composite-analysis parity row above.
2. ~~**med-eas.57** (P3) — Low-stock reminder never pushed in cloud.~~ **Closed** — `low_stock` horizon kind shipped (see table above).
3. ~~**med-eas.58** (P3) — Weekly-digest toggle has no cloud producer.~~ **Closed** — `digest` producer + un-hidden toggle shipped.
4. ~~**med-eas.59** (P3) — Workout-session reminders absent from cloud horizon.~~ **Closed** — `workout` horizon kind shipped (primary fire only).
5. ~~**med-eas.60** (P3) — TZ-plan progress notifications.~~ **Closed — covered:** the bot's only tz-plan progress notification (the approval prompt) is already surfaced in cloud via the in-app `TZPlanBanner` (Apply/Cancel), tested by `cloud.shim-contract.tz-plan.test.js`; step-advance/completion pushes don't exist in the bot. Nothing to port.

Cut at triage (reclassified as intentional divergence, no bead): BP/weight CSV export, mi-band GPS detail, external workout webhook feed.

Closed: **med-eas.55** (ElevenLabs "Send photo") — shipped, merged #649 (both render sites un-guarded).

Reverse (cloud-only): gamification AI narration — **intentional, not backported** to bot (one-way bot→cloud direction).
