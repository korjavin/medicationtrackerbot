# Vault format v1 — full-user export/import (C2e)

The canonical, no-lock-in backup format. One file holds **one user, all domains**,
exportable and importable in **both** runtimes (bot mode + cloud mode). A plain
`.json` file on disk (optionally `.json.age`-encrypted, see [cloud-mode.md](cloud-mode.md))
is always the exit door.

This document is the cross-runtime contract. The Go exporter (`GET /api/export`),
the Go importer (`POST /api/import`), and the cloud client (`window.CloudVault`)
all target the shapes below, and both test suites pin the same golden fixture
`tests/fixtures/vault-v1.json` against it.

## Design rule: the format is the API wire shape

Field names and value formats match what each domain's `/api/*` contract already
emits — which is also, verbatim, what the cloud record bodies store (C1/C2
convention). There is no third dialect: the Go exporter is a repo-walk + the same
JSON marshaling the handlers already do; the cloud exporter is a records-walk +
regroup. The only real conversions are at the Go storage boundary (see
[Time formats](#time-formats)).

## Envelope

```json
{
  "format": "medtracker-vault",
  "version": 1,
  "exported_at": "2026-07-08T12:00:00Z",
  "data": { ... }
}
```

- `format` — always the literal `"medtracker-vault"`. Import rejects anything else with 400.
- `version` — integer `1`. Import rejects unknown versions with 400.
- `exported_at` — RFC3339 UTC. Informational only; **not** part of the round-trip equality contract.
- `data` — one key per domain, described below. A domain key may be absent or its
  arrays empty; import treats absent and empty as equivalent.

## Record identity model

Import is **replace-only** (wipe target user, then insert), so leaf-record ids never
have to survive a round-trip — the importer is free to re-mint them.

- **FK-parent records carry a numeric `id`** and are referenced by numeric id:
  `medication`, `food product`, workout `group`/`variant`/`exercise`/`library`,
  workout `session`. On bot this is the DB primary key; on cloud it is preserved as a
  body field alongside the string recordId. References
  (`intake.medication_id`, `foodlog.product_id`, `exercise.variant_id`,
  `exercise_log.session_id`/`exercise_id`, `rotation.group_id`, …) use these numbers.
- **Leaf records omit `id`** — bp readings, weight logs, food logs, diary notes,
  restocks, intakes, exercise logs, miband workouts, sleep/day-stat/sample rows.
  Nothing references them; import mints fresh ids. A file may carry an `id` on a leaf
  record but import ignores it and it is not part of the round-trip equality contract.
- **Deterministic re-mint on cloud import** — a scheduled intake's cloud recordId is
  `intake-<medId>-<slotUnixSeconds>`, a scheduled session's is
  `session-<groupId>-<localDate>`, a rotation's is `rotation-<groupId>` — derived from
  content, so a device that already has that slot converges by LWW instead of double-logging.

## `data` keys

Every timestamp is the wire form the owning domain already uses. Unless a field
is called out as unix-seconds or milliseconds, it is an **RFC3339 string**.
`YYYY-MM-DD` "day" strings are bare local calendar dates, passed through unparsed.

### `medications`

```json
"medications": {
  "items": [ { medication } ],
  "intakes": [ { intake } ],      // flat list across all meds
  "restocks": [ { restock } ]
}
```

- **medication** — `id` (number, FK glue), `name`, `dosage`, `schedule`, `archived`
  (bool), `supplement` (bool), `start_date` (RFC3339|null), `end_date`
  (RFC3339|null), `rxcui` (str), `normalized_name` (str), `inventory_count`
  (num|null), `tz_shift_policy` (`flexible`|`medium`|`strict`), `created_at` (RFC3339).
- **intake** — `medication_id` (number → medication.id), `scheduled_at` (RFC3339),
  `taken_at` (RFC3339|null), `status` (`PENDING`|`TAKEN`|`SKIPPED`), `snoozed_until`
  (RFC3339|null), `source` (`schedule`|`tz_step`). No stored `id`: scheduled intakes
  re-mint deterministically as `intake-<medId>-<slotUnixSeconds>` on cloud import;
  manual intakes (`source` other than schedule / a `taken_at` with no schedule slot)
  re-mint as `intake-manual-<ms>-<rand>` unless the file already carries a cloud
  recordId to preserve.
- **restock** — `medication_id` (number), `quantity` (num), `note` (str), `restocked_at` (RFC3339).

### `bp`

```json
"bp": {
  "readings": [ { reading } ],
  "goal": { "target_systolic": num|null, "target_diastolic": num|null } | null
}
```

- **reading** (leaf, no `id`) — `measured_at` (RFC3339), `systolic` (num), `diastolic`
  (num), `pulse` (num|null), `site` (str), `position` (str), `ignore_calc` (bool),
  `notes` (str), `tag` (str). `category` is **derived** (recomputed on read from
  systolic/diastolic) — omitted from the format; import never trusts it.

### `weight`

```json
"weight": {
  "logs": [ { log } ],
  "goal": { goal } | null,
  "unit_pref": "kg" | "lb" | null
}
```

- **log** (leaf, no `id`) — `measured_at` (RFC3339), `weight` (num), `body_fat`
  (num|null), `muscle_mass` (num|null), `notes` (str). `weight_trend` is **derived**
  (rolling average) — omitted.
- **goal** — `target_weight` (num), `target_date` (`YYYY-MM-DD`), `set_at` (RFC3339),
  `start_weight` (num|null).

### `food`

```json
"food": {
  "logs": [ { log } ],
  "products": [ { product } ]
}
```

Food targets are a settings singleton — see `settings.food_targets`, not repeated here.

- **log** (leaf, no `id`) — `eaten_at` (RFC3339), `name` (str), `weight` (num, grams),
  `calories`, `carbs`, `protein`, `fat` (num), `is_meal` (bool),
  `product_id` (number → product.id | null).
- **product** — `id` (number, FK glue), `name` (str), `barcode` (str|null), `carbs_100g`,
  `protein_100g`, `fat_100g`, `energy_kcal_100g` (num, per-100g), `usage_count` (int),
  `is_meal` (bool), `total_weight_g` (num), `created_at` (RFC3339), `last_used_at` (RFC3339).

### `workouts`

```json
"workouts": {
  "groups": [ { group } ],
  "variants": [ { variant } ],
  "exercises": [ { exercise } ],
  "library": [ { library_entry } ],
  "rotations": [ { rotation } ],
  "sessions": [ { session } ],
  "exercise_logs": [ { exercise_log } ],
  "miband": [ { miband_workout } ]
}
```

Workout entities carry a numeric body `id` (FK glue; `-1` is the ad-hoc sentinel for
`group_id`/`variant_id` on sessions). All dates RFC3339 unless noted.

- **group** — `id`, `user_id`, `name`, `description`, `is_rotating` (bool),
  `days_of_week` (JSON-string array, e.g. `"[1,3,5]"`, default `"[]"`),
  `scheduled_time` (`"HH:MM"`), `notification_advance_minutes` (int), `active` (bool),
  `created_at`, `updated_at`.
- **variant** — `id`, `group_id`, `name`, `rotation_order` (int|null), `description`, `created_at`.
- **exercise** — `id`, `variant_id`, `exercise_name`, `target_sets` (int),
  `target_reps_min` (int), `target_reps_max` (int|null), `target_weight_kg` (num|null),
  `order_index` (int).
- **library_entry** — `id`, `user_id`, `name`, `default_sets` (int),
  `default_reps_min` (int), `default_reps_max` (int|null), `default_weight_kg`
  (num|null), `notes`, `created_at`, `updated_at`.
- **rotation** — `group_id`, `current_variant_id`, `last_session_date` (RFC3339|null),
  `updated_at`. No stored `id`; re-mints deterministically as `rotation-<groupId>`
  (one row per group) on cloud import.
- **session** — `id`, `user_id`, `group_id` (`-1` = ad-hoc), `variant_id` (`-1` ad-hoc),
  `scheduled_date` (RFC3339 carrying the **local** offset, e.g.
  `2026-07-08T00:00:00+02:00` — the date prefix is the local calendar day,
  deliberately not UTC), `scheduled_time` (`"HH:MM"`), `status` (`pending`|`notified`|
  `in_progress`|`pre_skipped`|`completed`|`skipped`), `started_at`, `completed_at`,
  `snoozed_until` (RFC3339|null), `snooze_count` (int), `notification_message_id`
  (num|null), `notes` (str). Scheduled sessions re-mint deterministically as
  `session-<groupId>-<YYYY-MM-DD>` (local date prefix); ad-hoc keep/mint a random id.
- **exercise_log** (leaf, no `id`) — `session_id` (num → session.id), `exercise_id`
  (num → exercise.id), `exercise_name`, `sets_completed` (int|null), `reps_completed`
  (int|null), `weight_kg` (num|null), `status` (`''`|`completed`|`skipped`), `notes`,
  `logged_at` (RFC3339), `source` (`schedule`|`library`).
- **miband_workout** (leaf, no `id`) — `activity_type` (num), `activity_name`, `source_start_ms`
  (**milliseconds** epoch), `source_end_ms` (**milliseconds** epoch), `tz_offset`
  (seconds), `duration_sec`, `distance_m`, `steps`, `calories`, `heart_rate_avg`,
  `spo2_avg` (num), `pause_ms` (ms), `source` (str), and `gps` (array | null). Each GPS
  point: `point_index` (int), `ts_ms` (**milliseconds**), `latitude`, `longitude`,
  `altitude` (num), `is_pause` (bool). The wire `start_time`/`end_time` RFC3339 strings
  are **derived** from `source_start_ms` + `tz_offset` and omitted; the format stores the
  raw ms + offset.

### `vitals`

Flat per-sample arrays — the format hides the cloud day-batching (see
[Vitals day-batching](#vitals-day-batching)).

```json
"vitals": {
  "sleep": [ { sleep_log } ],
  "day_stats": [ { day_stat } ],
  "heart": [ { sample } ],
  "spo2": [ { sample } ],
  "stress": [ { sample } ]
}
```

- **sleep_log** — `start_time` (RFC3339), `end_time` (RFC3339), `timezone_offset` (num),
  `day` (`YYYY-MM-DD`), `light_minutes`, `deep_minutes`, `rem_minutes`,
  `awake_minutes`, `total_minutes`, `turn_over_count`, `heart_rate_avg`, `spo2_avg`
  (num), `user_modified` (bool), `notes` (str).
- **day_stat** — `day` (`YYYY-MM-DD`), `steps`, `calories`, `distance` (num).
- **sample** (heart/spo2/stress) — `date_time` (RFC3339), `tz_offset` (seconds),
  `value` (num), and optional `info` (str). Storage is unix-seconds INTEGER server-side;
  the format uses RFC3339, matching the vitals wire form and the cloud sample body.

### `diary`

```json
"diary": { "notes": [ { note } ] }
```

- **note** (leaf, no `id`) — `content` (str), `tag` (str|null — one of
  `SLEEP`/`STRESS`/`HR`/`SPO2`/`STEPS`/`NOTE`), `created_at` (RFC3339).

### `tz`

```json
"tz": {
  "current": "Europe/Berlin" | null,
  "history": [ { "timezone": str, "changed_at": RFC3339 } ],
  "transition_plan": { plan } | null
}
```

- **transition_plan** — `old_tz` (IANA), `new_tz` (IANA), `status`
  (`PENDING_APPROVAL`|`APPROVED`|`REJECTED`|`COMPLETED`), `created_at` (RFC3339),
  `approved_at` (RFC3339|absent), `steps` (array of `{medication_id (num → medication.id),
  step_number (int), scheduled_at (RFC3339), note (str)}`, plus optional `med_name`
  (str) and `total_steps` (int) — the cloud body carries them, the bot wire re-derives
  them, so both are tolerated-optional). The cloud stored body keeps camelCase +
  `scheduledAtMs` (ms epoch); the format uses the snake_case + RFC3339 wire form the
  tz-plan API emits (`uiTZPlanStep`: `plan_id`/`medication_id`/`step_number`/
  `scheduled_at`/`note`), and cloud import/export converts at the boundary. Singleton on
  import (`tzplan-current`).

### `settings`

```json
"settings": {
  "timezone": "Europe/Berlin",
  "dismissed_tz_suggestion": "",
  "features": { "food": false, "bp": true, ... },
  "tab_order": ["bp","weight","food","health","workouts","meds"],
  "food_targets": { "calories": int, "carbs": int, "protein": int, "fat": int } | null,
  "integrations": { integrations },
  "med_reminder_pref": { "enabled": bool } | null
}
```

- **features** — object map of feature-flag booleans (`food`, `bp`, `weight`,
  `medication`, `workout`, `health`, `gamification`, `weekly_digest`, …). Mirrors the
  `features` singleton `flags`.
- **med_reminder_pref** — cloud-only singleton (`{enabled}`). The bot runtime has no
  medication-reminder preference row, so bot exports omit it and bot import ignores it;
  cloud round-trips it.
- **integrations** — the user's own provider keys, stored **unmasked**:
  `openai: {api_key, url, model, vision_api_key, vision_url, vision_model}`,
  `food: {api_key, url, domain}`, `elevenlabs: {api_key, agent_id}`. This makes the
  backup **secret-bearing** — the export UI nudges toward a passphrase. Cloud-side
  these are read module-to-module (never across the `/api` shim); bot-side the export
  runs over the authed session where the server already holds them.

`food_targets` is the single canonical slot for the food target singleton (the `food`
domain block carries only logs + products).

## Time formats

The format is uniform RFC3339 / `YYYY-MM-DD` on the wire. The **only** storage-boundary
conversions the Go side performs:

| Domain field | Server storage | Vault wire form |
|---|---|---|
| `intake.scheduled_at` / `taken_at` / `snoozed_until` | unix-**seconds** INTEGER | RFC3339 |
| `vitals` sample `date_time` (heart/spo2/stress) | unix-**millis** INTEGER (`time.UnixMilli`) | RFC3339 |
| `weight.goal.set_at` | unix-seconds INTEGER | RFC3339 |
| `miband.source_start_ms` / `source_end_ms` / `gps.ts_ms` | **milliseconds** INTEGER | **milliseconds** (kept as-is) |
| everything else | DATETIME text | RFC3339 passthrough |

## Skip list — never exported

These are device/crypto/derived state and never belong in a portable backup:

- **push subscriptions** and the cloud `nk` push key (device-scoped crypto).
- **API tokens / login nonces** (auth material).
- **`change_events`** and per-domain **download cursors** (sync bookkeeping).
- **bp / weight reminder-state** and **workout schedule snapshots** (scheduler-derived).
- **derived fields** recomputed on read: bp `category`, weight `weight_trend`, miband
  `start_time`/`end_time`, workout schedule materialization.
- **gamification ledger** (derived; the gamification feature is not shipped, so nothing
  to export yet — revisit when it lands).
- cloud-only plumbing with no `/api` route: **voiceprovisioning**.

## Round-trip contract & tolerated normalizations

`bot export → cloud import → cloud export → bot import` (and each single hop) must be
**identity on `data`**, modulo:

- **`exported_at`** — regenerated per export, excluded from equality.
- **Ordering** — arrays compare as sets keyed by identity (id / deterministic key);
  export order is not significant.
- **Absent vs null vs empty** — an absent domain key, an empty array, and (for optional
  scalar fields) absent vs `null` compare equal.
- **Derived fields** — anything in the skip list's "derived" bullet is recomputed, not
  compared. A reader that re-adds `category`/`weight_trend` does not break equality.
- **Deterministic re-minting** — cloud import re-mints scheduled-intake, scheduled-session,
  and rotation recordIds by rule, so a bot-origin file (no recordIds) and its cloud
  round-trip converge to the same ids rather than duplicating.

## The golden fixture

`tests/fixtures/vault-v1.json` is a small hand-curated vault exercising every domain,
every deterministic-id case (scheduled + manual intake, tz transition plan, workout
scheduled session + rotation), a vitals day-batch boundary (samples spanning two calendar
days), and an integrations key. Both the Go export test (Task 2/3) and the Vitest
cloud round-trip test (Task 5) pin this one file — any field-name drift on either side
fails that side's pin.
