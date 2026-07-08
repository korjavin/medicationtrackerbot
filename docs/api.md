# API Endpoints

## Health Data

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/bootstrap` | All initial data in one request. Includes a `medications` array (same shape as `GET /api/medications?archived=true`) so the frontend can hydrate the meds list and Today tile without a follow-up round-trip; consumers seed both `DataStore` and Dexie via this field — see [frontend.md → Local-First Read Resilience](frontend.md#local-first-read-resilience). |
| GET | `/api/medications` | List medications |
| POST | `/api/medications` | Create medication |
| PATCH | `/api/medications/:id` | Update medication |
| POST | `/api/medications/confirm-schedule` | Confirm dose intake |
| POST | `/api/medications/log-past` | Log a past intake (returns full `IntakeLog`; routed through `MedicationService.LogMedicationAt`) |
| POST | `/api/medications/{id}/restock` | Record a restock (increments `inventory_count`, returns updated medication) |
| GET | `/api/medications/{id}/restocks` | List restock history for a medication (newest first) |
| GET | `/api/history` | Intake history (filter by `days`, `med_id`) |
| POST | `/api/intakes/update` | Batch-update intake statuses (e.g. un-mark a taken med → `PENDING`). Body: `{updates:[{id, status, taken_at}]}`. Always returns `200` with a per-update outcome body `{updated:<n>, failed:<n>, failures:[{id, reason}]}` — `reason` is one of `"not_found_or_forbidden"`, `"no_row_matched"` (gate/no-op), `"update_error"`. The frontend shows "Updated!" + commits the optimistic flip only when `failed === 0`; otherwise it rolls back the affected rows and surfaces the failed med(s). A legacy empty-body `200` is still treated as success by older clients during a rolling deploy. |
| GET | `/api/medications/next-intake` | Next scheduled dose |
| GET | `/api/bp` | BP readings |
| POST | `/api/bp` | Log BP reading |
| GET | `/api/bp/stats` | BP statistics |
| GET | `/api/bp/goal` | BP goal |
| POST | `/api/bp/goal` | Set BP goal |
| GET | `/api/weight` | Weight logs |
| POST | `/api/weight` | Log weight |
| GET | `/api/weight/goal` | Weight goal |
| POST | `/api/weight/goal` | Set weight goal |
| GET | `/api/food/log` | Food log entries |
| POST | `/api/food/log` | Log food |
| GET | `/api/food/search` | Search Open Food Facts |
| GET | `/api/food/barcode/{barcode}` | Lookup food item by barcode (server-side proxy for Cloud Mode operator default) |
| GET | `/api/food/targets` | Nutrition targets |
| POST | `/api/food/targets` | Set nutrition targets |
| GET | `/api/health/overview` | Aggregate 7d/30d dashboard: per-night sleep phases (`sleep_stats_*`), HR/SpO2/stress histories, step aggregates, and averages. Fixed trailing window. (MCP op `health.overview`.) |
| GET | `/api/health/sleep` | Raw device-imported sleep sessions with phase breakdown (light/deep/REM/awake) + HR/SpO2 averages. Range-queryable via `days` / `from` / `to` / `limit` — use for windows beyond the overview's 30 days. (MCP op `health.sleep.list`.) |
| GET | `/api/notes` | List diary notes (each row includes `tag` — one of `SLEEP \| STRESS \| HR \| SPO2 \| STEPS \| NOTE`, or omitted when NULL) |
| POST | `/api/notes` | Create diary note (accepts `{content, tag?}`; invalid tags are sanitized to NULL and returned in the `201` response, not rejected) |
| DELETE | `/api/notes/{id}` | Delete diary note |

## Workouts

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/workout/groups` | List workout groups |
| POST | `/api/workout/groups/create` | Create group |
| PUT | `/api/workout/groups/update` | Update group |
| GET | `/api/workout/variants` | List variants |
| POST | `/api/workout/variants/create` | Create variant |
| GET | `/api/workout/exercises` | List exercises |
| POST | `/api/workout/exercises/create` | Create exercise |
| PUT | `/api/workout/exercises/update` | Update exercise |
| DELETE | `/api/workout/exercises/delete` | Delete exercise |
| GET | `/api/workout/sessions` | Session history |
| GET | `/api/workout/sessions/details` | Session details with logs |
| POST | `/api/workout/sessions/schedule` | Schedule a one-off ad-hoc workout for a future date/time with a pre-selected exercise list. Body: `{scheduled_date: "YYYY-MM-DD", scheduled_time: "HH:MM", exercises: [{exercise_id?, exercise_name?, target_sets, target_reps_min, target_reps_max?, target_weight_kg?}, …]}`. Each exercise must supply either `exercise_id` (library id; must belong to the caller — name is filled in from the library row) or a free-form `exercise_name`. The session is created with `group_id = -1`, `variant_id = -1`, `status = "pending"` and one pending `workout_exercise_logs` row per planned exercise; the scheduler notifies at `scheduled_date + scheduled_time` in the user's TZ. Pending placeholder logs auto-promote to `status = "completed"` when the user later POSTs to `/api/workout/sessions/logs/update` with `sets_completed >= 1` (or supplies an explicit `status`). MCP-only — no web UI for creation. |
| GET | `/api/workout/stats` | 30-day statistics |
| GET | `/api/workout/rotation/state` | Current rotation position |
| POST | `/api/workout/rotation/initialize` | Initialize rotation |

## Gamification

All routes gate on the `gamification_enabled` flag in the service layer: when off they return HTTP 200 with a `{"enabled": false}`-shaped body (every other field zero/empty), so the frontend renders a disabled state instead of handling an error. Unauthenticated requests get 401 from the apiMux auth middleware. JSON is snake_case (the domain service's natural shape, passed through verbatim). Enabling the feature uses the existing generic toggle `POST /api/settings/features/gamification`, which on a false→true flip runs `EnsureBackfilled` inline so the Journey is populated by the time the toggle returns 200. The summary is also embedded in `/api/bootstrap` under `gamification` (same shape as `/api/gamification/summary`) so the Today rings widget and Journey warm-load offline.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/gamification/summary` | Today + period rings, level, lifetime HP, next-level progress, streak, insight tier. `today_rings`/`period_rings` are always the three daily-lever rings (`bedtime, movement, nourishment`) in canonical order — each is a decision made today, not a delayed body signal (gamification-10 §2.5). Adherence and vitals ledger awards, and the Mind ring's diary awards, still earn lifetime HP but produce no ring. Vitals ledger awards are daily integrity floors (BP reading, weigh-in) plus three *weekly* outcome awards written once on each week's last day (gamification-11): `weight_trend_week` (EMA trend velocity on safe pace toward the goal, or maintenance stability with no goal), `bp_share_week` (30-day in-range share holding/beating the 60-day baseline), `resting_hr_trend_week` (14-day mean vs 60-day baseline delta) — see `GET /api/gamification/gauges` below for the read-model these awards derive from. Each ring carries `sync_pending`: true only for today's `bedtime`/`movement` rings when the ring hasn't closed and no device-synced sample (sleep log / steps) has arrived yet today — "hasn't synced", not "failed". Always `false` on `period_rings` and on `nourishment`. Also carries `health_score` — the 0-100 Oura/Whoop-pattern composite: `{value (0-100, or `null` below `HealthScoreMinContributors` present contributors), contributors:[{key, label, score, weight, missing}] (bp, sleep, resting_hr, weight, adherence), missing:[keys]}`. A contributor is `missing` when its window has no data; the composite renormalizes weights over the present contributors only — a gap dilutes the score, never zeroes it. Windows are 14d recent vs. 60d personal baseline, both trailing the request day (a late import re-enters the math on the next read). Also carries `strengths` — the per-pillar habit-strength EMA (Loop Habit Tracker pattern) that supersedes the weekly streak card as the continuity mechanic: `[{key, label, value (0..1), frequency}]` for `meds` (daily), `movement` (3×/week), `measurement` (daily — any BP/weight/food log that day). A miss lowers strength gradually (13-day half-life); it never resets to 0. Also carries `adherence_alert {active, pdc, missed_doses}` (gamification-10 §6.1) — adherence has no ring and no daily grading, so this is its only nudge: `active` flips true when the trailing 14-day dose-level PDC drops below `AdherenceAlertPDCThreshold` (0.90, stricter than the Health Score's own adherence target), carrying `pdc` and a plain `missed_doses` count for the Today copy; the field is `{active:false}`-shaped (zero `pdc`/`missed_doses`) whenever no doses were expected in the window or PDC is at/above threshold. (MCP op `gamification.summary`.) |
| GET | `/api/gamification/journey` | Embeds `summary` (including `health_score` and `strengths`) plus `hp_history` (sparse ascending series, trailing 90 days), `unlocked_tiers` (L1–L4), and `level_curve`. (MCP op `gamification.journey`.) |
| GET | `/api/gamification/rings` | Slim Today-widget projection: `{enabled, level, today_hp, rings:[{ring, hp, closed, progress, goal, sync_pending}], health_score, adherence_alert}` — per-ring today HP plus `closed` (true when the ring earned a non-floor outcome/consistency award today, not just the honesty floor), `progress` (0..1 fill gauge, 1.0 when closed), `goal` (short imperative subtitle), and `sync_pending` (see `/api/gamification/summary`). Drives the Today "X of 3 rings closed" line + "your move" picker, which skips `sync_pending` rings. `health_score` and `adherence_alert` ride along (same shape as `/api/gamification/summary`'s fields) so the Today tile can show the composite score and the safety-net nudge without a second round-trip. (MCP op `gamification.rings`.) |
| GET | `/api/gamification/targets` | Effective target bands = recommendations merged with user overrides, each flagged `is_custom`/`is_recommended`. Metric keys ∈ `{bp_systolic, bp_diastolic, resting_hr, sleep_hours, steps, bedtime}` — `stress` was dropped and `bedtime` added (gamification-10 §6.4); `bedtime`'s band is minutes of deviation from the user's own trailing bedtime median, not a clock time. (MCP op `gamification.targets.read`.) |
| PUT | `/api/gamification/targets` | Validate + persist target overrides. Body `{targets:[{metric_key, low_val?, high_val?, falloff?, mode?}]}`; a one-sided band keeps the recommended value for the unset side. Returns the refreshed targets view. **400** on an unknown `metric_key`, a negative bound/falloff, or `low_val > high_val`. (MCP op `gamification.targets.set`.) |
| GET | `/api/gamification/insights` | Two independent personal insights, each gated on its own unlocked insight tier (tiers gate depth, never raw data). **Tier-3 sleep→next-morning-BP** (`sleep_bp`): pairs each night's sleep duration (trailing 90 days) with the next morning's first systolic reading before the user's local morning cutoff, buckets nights below the sleep-band floor as "short" vs the rest as "in-band", and compares mean systolic between buckets. Below tier 3 (level 5) the top-level response is `{enabled, locked:true, unlocks_at_level}` with no numbers; at tier 3+ it carries `sleep_bp:{status, short_threshold_hours, delta_systolic?, n_short, n_in_band, needed?, window_days}`. `status` is one of `effect` (difference ≥ the noise floor), `no_effect` (difference under the noise floor — itself a reported finding, not a blank state), or `insufficient_data` (either bucket below the minimum paired-night count; `needed` gives that minimum). **Tier-4 good-day association scan** (`good_day`, gamification-13): over the trailing 90 days, marks each day with ≥1 BP reading and an in-band mean systolic as a "good day" (days with no reading are excluded from the denominator, not counted as bad), then compares the good-day rate on the previous day/bridging-night with vs without each of four fixed candidate behaviors — completed a workout, bedtime in window, steps in band, all doses taken on time. Below tier 4 (level 7) `good_day` carries its own `{locked:true, unlocks_at_level}` independently of `sleep_bp`'s gate (so it can appear locked while `sleep_bp` is already unlocked); at tier 4+ it is `{status, window_days, good_day_definition, findings:[{behavior, rate_with, rate_without, delta_pp, n_with, n_without}], insufficient:[{behavior, n_with, n_without, needed}]}`. A behavior needs ≥10 days in each arm to avoid `insufficient`, and only clears into `findings` when the rate difference is ≥15 percentage points; findings are ordered by `|delta_pp|` and capped at 3. `status` is `effect` (≥1 finding), `no_effect` (all behaviors cleared the data gate but none cleared the noise floor), or `insufficient_data` (no finding cleared and at least one behavior still lacks enough days in an arm) — both are honest terminal results, not errors. `good_day_definition` spells out the user's own band (e.g. "in range = systolic 90–120") so the model is never a black box. No causal language anywhere — copy says a behavior's days were "in range more often", never "because". (MCP op `gamification.insights`.) |
| GET | `/api/gamification/gauges` | Gauge-trend read model (gamification-11 §1-3): the body's delayed/noisy signals as smoothed trends instead of daily grades. `{enabled, weight, bp, resting_hr}`. `weight: {status, trend_weight, velocity_pct_per_week (signed, negative = losing), pace_status ("no_goal"\|"on_pace"\|"too_slow"\|"too_fast"\|"wrong_direction"), acceleration ("speeding_up"\|"holding"\|"slowing"), trend_history}` — an EMA trend line (α=0.10/day) so a single heavy day can't move it; velocity is the smoothed change over the trailing window in %bodyweight/week; `pace_status` compares against the user's goal direction+rate (`no_goal` when none is set — trend-only, no judgment); `acceleration` compares velocity now vs the same window ending one window ago, with a deadband so `holding` is the default; `trend_history` is the last 60 days of the same trend line (oldest first), read-side only (not used by scoring), for the Journey Gauges panel's sparkline. `bp: {status, share_14d, share_30d, baseline_share_60d, count_14d, count_30d, count_60d}` — rolling share (0..1) of readings inside the effective personal band over 14d/30d vs a 60d baseline, with reading counts so the UI can gauge confidence; a couple of bad days barely move a 30-day share. `resting_hr: {status, recent_14d_mean, baseline_60d_mean, delta_from_baseline}` — 14d mean vs the strictly-prior 60d baseline mean (SpO₂ is not part of gauge scoring; its dangerous-reading alert path is unrelated to this endpoint). Each gauge independently reports `status: "insufficient_data"` (only `status` populated, no other fields) below its minimum sample count instead of a distorted number. (MCP op `gamification.gauges`.) |
| GET | `/api/gamification/weekly-review` | Weekly review read model (gamification-12): the cadence gauges are meant to be read at — current ISO week (Mon–Sun, UTC day-keyed, `weekIndex`-consistent — the same UTC-midnight bucketing the streak/gauge-award day keys use across the gamification package) vs the previous week, pure presentation over already-computed data. `{enabled, quiet, week_start, week_end, days_with_any_hp, levers, best_day, strengths, gauges, health_score}`. `levers: [{key, closed_this_week, closed_last_week}]` — per-lever-ring closed-day counts. `best_day: {day_unix, rings_closed}`, omitted when no rings closed this week. `strengths: [{key, label, value_now, value_prior}]` — same habit-strength EMA as `/api/gamification/summary`, now vs 7 days ago. `gauges: {weight, bp, bp_share_30d_prior, resting_hr}` — `weight`/`bp`/`resting_hr` are the same shapes as `/api/gamification/gauges`; `bp_share_30d_prior` is the 30-day share as of a week ago for the delta. `health_score: {now, prior}`, each a `health_score` object (same shape as in `/api/gamification/summary`) anchored at the request day and 7 days earlier. A week with zero HP returns `quiet: true` with the rest of the shape still valid (zeros, not an error) — render it as "a quiet week", never a failure. (MCP op `gamification.weekly_review`.) |

## System

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/changes` | Change events since cursor (polling fallback — used when SSE is unavailable or after 3 consecutive `/api/changes/stream` errors within 30s). |
| GET | `/api/changes/stream` | Server-Sent Events stream of change cursors (primary cross-client sync transport). Auth via `?initData=…` query param since EventSource cannot set custom headers. Fans out from the process-wide `ChangeBroker` — connected clients see writes from any device (or MCP) within ~50ms. See [architecture.md → Cross-client change broadcast](architecture.md#cross-client-change-broadcast-sse--polling-fallback), [technical-decisions.md → Why SSE is primary](technical-decisions.md), and [sse-traefik.md](sse-traefik.md) for the required Traefik configuration. |
| GET | `/auth/status` | Check if session is authenticated (returns `{"authenticated": bool}`) |
| GET | `/api/settings` | User settings bundle. Returns the same shape `/api/bootstrap` embeds under `settings`. Response: `{timezone, server_time, server_timezone, weight_unit_preference, features, food_targets, bp_reminder_status, weight_reminder_status, tab_order?}`. `features` is the same map as `/api/init` / bootstrap (`food, bp, weight, medication, workout, health, gamification`). `bp_reminder_status` / `weight_reminder_status` are `null` when the request has no authenticated user. `tab_order` is omitted (not `null`) when unset so clients preserve their local fallback. The frontend's `loadSettings()` SWR fetcher always reads `timezone`, `server_time`, `server_timezone`, and `weight_unit_preference` from this endpoint; it additionally consumes `features`, `food_targets`, `bp_reminder_status`, and `weight_reminder_status` as fallbacks when the matching granular endpoint (`/api/settings/features`, `/api/food/settings/targets`, `/api/bp/reminder/status`, `/api/weight/reminder/status`) returns `null` (e.g., transient 5xx / offline). The consolidated bundle is the canonical source for future single-round-trip refreshes, so any change here must keep these slices populated. |
| POST | `/api/settings` | Update settings (accepts optional `timezone` IANA name; 400 on invalid values) |
| PATCH | `/api/settings/weight-unit` | Set the user's preferred weight unit. Accepts `{"unit":"kg"\|"lb"}`; 400 on any other value. Storage of weight logs is always kg — this only affects the input default and rendered unit in the web app and bot. The preference is also returned by `/api/bootstrap` under `settings.weight_unit_preference` (defaults to `"kg"` for new users). |
| GET | `/api/export` | Full-vault export (bot/server mode). Walks every domain repo for the authed user and returns the canonical one-user-all-domains JSON (`{"format":"medtracker-vault","version":1,"exported_at":<RFC3339>,"data":{...}}`, see [vault-format.md](vault-format.md)) with `Content-Disposition: attachment; filename=medtracker-vault-<date>.json`. Field names/values match each domain's existing `/api` wire shape. Cloud mode never calls this — its export is fully client-side. |
| POST | `/api/import` | Full-vault import (bot/server mode), **replace-only**. Body is the canonical vault JSON plus `"mode":"replace"`. Validates format/version/mode, then in one transaction wipes the authed user's data (`seeddemo.WipeUserTx`) and inserts every domain (explicit ids for FK glue). All-or-nothing: on any validation failure returns `400 {"ok":false,"errors":[...]}` and touches nothing. Merge mode is a non-goal. Cloud mode never calls this — its import lands one client-side snapshot. |
| POST | `/api/push/subscribe` | Register push subscription |
| POST | `/api/push/unsubscribe` | Remove push subscription |
| GET | `/auth/oidc/login` | OIDC login redirect |
| GET | `/auth/oidc/callback` | OIDC callback |
| GET | `/auth/google/login` | Google login redirect |
| GET | `/auth/google/callback` | Google callback |
| GET/POST | `/auth/telegram/callback` | Telegram Login Widget auth (GET: redirect flow, 302; POST: JSON callback) |
| GET | `/api/elevenlabs/signed-url` | Returns a signed conversation URL for the ElevenLabs convai widget on the Today screen. Requires `ELEVENLABS_API_KEY` + `ELEVENLABS_AGENT_ID`; 503 if either is unset. |

## Cloud Mode Server Proxy (`cmd/cloud` only)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/food/search` | Same-origin proxy for the operator default `CLOUD_FOOD_DB_URL` (bypasses browser CORS requirements) |
| GET | `/api/food/barcode/{barcode}` | Same-origin proxy for the operator default `CLOUD_FOOD_DB_URL` |

## Cloud Mode Telegram (`cmd/cloud` only)

Session-authed endpoints served on the account subdomain by `cmd/cloud` (see [cloud-mode.md → Telegram](cloud-mode.md#telegram-optional-byo-bot-token)). Not present in the server build.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/telegram/provision` | Start managed-bot creation: mints a suggested username, records a 1h-TTL `tg_pending` row, returns the BotFather deep link |
| GET | `/api/telegram/status` | Linking state: `linked` / `bot_created` / `pending` / `skipped` / `none` |
| GET | `/api/telegram/diag` | Manager-webhook diagnostics (`getWebhookInfo` passthrough) |
| POST | `/api/telegram/byo` | Bring-your-own bot token; works from any state including `pending` (the upserted bot row wins over a leftover pending row) |
| POST | `/api/telegram/skip` | Record explicit opt-out |
| POST | `/api/telegram/reset` | Clear the caller's `tg_pending` row so status returns to `none` (idempotent; touches nothing else). The pending page's "Start over" — escape hatch when the managed `managed_bot_created` update was lost, no need to wait out the TTL. Returns `{"reset": true}` |
| POST | `/api/telegram/test` | Send a test notification through the linked bot |
| DELETE | `/api/telegram` | Unlink and delete the bot binding |

## Cloud Trial Proxy (cloud-only, `cmd/cloud`)

Served only by the cloud service on the account subdomain; not present in the bot/server or mobile builds. Both routes require an authenticated account session and share one per-account rate limit (`TRIAL_RATE_PER_MIN`, default 10/min) — on limit: `429 {"error":"trial_rate_limit","retry_after_seconds":60}` + `Retry-After`. When the corresponding `TRIAL_*` envs are unset: `503 {"error":"trial_not_configured"}` and the client degrades to pure BYO. See [cloud-mode.md → Trial provider keys](cloud-mode.md#trial-provider-keys-pooled-metered).

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/trial/openai/chat/completions` | Proxies an OpenAI-compatible chat request to the operator's trial provider. `model` is forced server-side to the trial model (and stripped from the 200 response body); `?vision=1` selects the vision triple; `"stream":true` rejected with 400; body capped at 12 MiB. Any upstream non-200 becomes `502 {"error":"upstream_error"}` — 503/429 stay reserved for not-configured / trial rate limit. |
| GET | `/api/trial/elevenlabs/signed-url` | Server-mints a signed conversation URL for the operator's shared trial ElevenLabs agent; returns `{"signed_url": ...}`. Cloud analogue of `/api/elevenlabs/signed-url`. |

## MCP Bridge

These endpoints are called only by the MCP server process (`cmd/mcptool`) over the internal Docker network. Each request must carry an HMAC-SHA256 signature in `X-Signature` (hex-encoded) derived from `MCP_AUDIT_SECRET` over the raw request body. The MCP read tools query SQLite directly, but write tools route through these endpoints so the bot's domain services own all mutating writes (audit fan-out, validation, attribution).

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/mcp-audit` | Audit notification fan-out (Telegram message on tool use) |
| POST | `/api/mcp-food-log` | Log food intake on behalf of an MCP write tool |
| POST | `/api/mcp-workout-log` | Workout log dispatcher: `operation` ∈ {`log`, `get`, `delete_exercise`}. Performs fuzzy exercise-name resolution and defaults inference; idempotent upsert on `(session_id, resolved_name)`. Returns HTTP 200 with per-exercise statuses on partial success — only auth/transport errors return non-2xx. See `workout_log` tool's `operation: "help"` for the full protocol. |
| POST | `/internal/mcp/bridge` | HMAC-protected bridge for the MCP Python executor (`mcp_execute`). Body: `{operation_id, params?, body?}`; the operation must exist in the registry. Executes the underlying API route as the configured `ALLOWED_USER_ID`; identity cannot be spoofed. Response envelope: `{status, body, headers_subset, duration_ms, truncated?}`. Request body capped at 1 MB; response bodies truncated past 10 MB. See `internal/mcp/registry/` for the operation allowlist and [mcp-deployment.md](mcp-deployment.md#python-executor-service) for the full executor architecture. |
