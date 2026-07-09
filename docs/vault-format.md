# Vault format v1 — full-user export/import (C2e)

The canonical, no-lock-in backup format. One file holds **one user, all domains**,
exportable and importable in **both** runtimes (bot mode + cloud mode). A
gzipped JSON file on disk (optionally `.age`-encrypted, see
[cloud-mode.md](cloud-mode.md)) is always the exit door.

## On-disk shapes

The UI writes `medtracker-vault-<date>.json.gz`, or `.json.gz.age` when a
passphrase is given. **gzip happens before encryption** — age ciphertext is
high-entropy and doesn't compress, so the other order saves nothing. Read either
one with standard tools:

```sh
gunzip -c medtracker-vault-2026-07-08.json.gz | jq .
age -d medtracker-vault-2026-07-08.json.gz.age | gunzip | jq .
```

Compression is not cosmetic: a two-year vault is 21 MB of pretty-printed JSON
and **0.7 MB gzipped** (30x; the per-sample vitals streams and mi-band GPS
tracks dominate the volume and compress extremely well). `POST /api/import` caps
the body at 64 MB, so a large backup is only restorable *because* it's
compressed — the browser gzips the upload too (`Content-Encoding: gzip`), and
the server inflates it under a separate 1 GB ceiling so a small body can't be a
decompression bomb.

Import sniffs magic bytes rather than the filename, so all four shapes work and
pre-compression backups keep importing: `.json`, `.json.gz`, `.json.age`,
`.json.gz.age`.

`GET /api/export` also serves the response `Content-Encoding: gzip` to any
client that accepts it. That is transport only — `fetch` transparently
decompresses it, and the browser compresses again for the file.

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
  (RFC3339|null), `source` (`schedule`|`tz_step`), plus `tz_plan_id` (number|absent →
  `tz.transition_plans[].id`) and `tz_step_number` (number|absent), set only when
  `source` is `tz_step` — such a dose that loses its plan link is permanently invisible
  to every medication read. No stored `id`: scheduled intakes
  re-mint deterministically as `intake-<medId>-<slotUnixSeconds>` on cloud import
  (a non-`schedule` source is appended — `intake-<medId>-<slot>-tz_step` — since both
  legitimately share one slot);
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
  "goals": [ { goal } ],
  "unit_pref": "kg" | "lb" | null
}
```

- **log** (leaf, no `id`) — `measured_at` (RFC3339), `weight` (num), `body_fat`
  (num|null), `muscle_mass` (num|null), `notes` (str). `weight_trend` is **derived**
  (rolling average) — omitted.
- **goals** (leaf, no `id`) — the full append-only goal history, **oldest first**.
  Each: `target_weight` (num), `target_date` (`YYYY-MM-DD`), `set_at` (RFC3339),
  `start_weight` (num|null). The newest row is the current goal; bot-mode import
  rebuilds the legacy singleton `settings.weight_goal{,_date}` columns from it.

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
  `spo2_avg` (num), `pause_ms` (ms), `source` (str). The bot exporter also emits `gps`
  (array | null) — each point `point_index` (int), `ts_ms` (**milliseconds**), `latitude`,
  `longitude`, `altitude` (num), `is_pause` (bool) — but **cloud import drops it** (see the
  skip list), so a cloud re-export omits it. The wire `start_time`/`end_time` RFC3339
  strings are **derived** from `source_start_ms` + `tz_offset` and omitted; the format
  stores the raw ms + offset.

### `vitals`

Flat per-sample arrays — the format hides the cloud day-batching (see
[Vitals day-batching](#vitals-day-batching)).

> **Cloud import downsamples old samples.** `vaultToRecords` collapses
> `heart`/`spo2`/`stress` samples older than **60 days** to one per UTC hour,
> `value` = round(mean). The shape is unchanged, so nothing downstream cares. The
> cloud UI only ever renders hourly buckets over a 7d/30d window, so beyond that
> window per-minute resolution is carried only to be discarded — on a real 3-year
> archive it was 105 MiB, 57% of the vault. 60d leaves a month of margin on the
> 30d window. Two losses, both invisible: a bucket's min/max collapse to its mean
> (only surfaced inside the still-raw 30d window), and a stress sample's `info`
> label is dropped. The transform is idempotent, so re-importing a cloud export
> never drifts.

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
  `value` (num), optional `type` (int sample-kind discriminator, omitted when 0), and
  optional `info` (str). Storage is unix-seconds INTEGER server-side;
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
  "transition_plans": [ { plan } ]
}
```

- **transition_plans** — **every** `tz_transition_plans` row, **oldest first** (not just
  the active/pending one): the wipe deletes them all, and past plans feed history
  analysis. Each plan: `id` (number|absent — preserved verbatim on import so
  `intake.tz_plan_id` keeps resolving; cloud-native plans carry none and get a fresh id),
  `old_tz` (IANA), `new_tz` (IANA), `status`
  (`PENDING_APPROVAL`|`APPROVED`|`REJECTED`|`COMPLETED`), `created_at` (RFC3339),
  `approved_at` (RFC3339|absent), `notified_at` (RFC3339|absent), `plan_hash` (str),
  `inputs_json` (str — the raw stored JSON blob, passed through unparsed),
  `user_action` (str|absent), `steps` (array of `{medication_id (num → medication.id),
  step_number (int), scheduled_at (RFC3339), note (str)}`, plus optional `med_name`
  (str) and `total_steps` (int) — the cloud body carries them, the bot wire re-derives
  them, so both are tolerated-optional). The cloud stored body keeps camelCase +
  `scheduledAtMs` (ms epoch); the format uses the snake_case + RFC3339 wire form the
  tz-plan API emits (`uiTZPlanStep`: `plan_id`/`medication_id`/`step_number`/
  `scheduled_at`/`note`), and cloud import/export converts at the boundary. On cloud
  import the newest active/pending plan lands at `tzplan-current`; the rest are carried
  as `tzplanhistory-<idx>` passthrough records.

### `settings`

```json
"settings": {
  "timezone": "Europe/Berlin",
  "dismissed_tz_suggestion": "",
  "features": { "food": false, "bp": true, ... },
  "tab_order": ["bp","weight","food","health","workouts","meds"],
  "food_targets": { "calories": int, "carbs": int, "protein": int, "fat": int } | null,
  "integrations": { integrations },          // absent when include_secrets=0
  "med_reminder_pref": { "enabled": bool } | null,
  "bp_reminder": { reminder_state } | null,
  "weight_reminder": { reminder_state } | null
}
```

- **features** — object map of feature-flag booleans (`food`, `bp`, `weight`,
  `medication`, `workout`, `health`, `gamification`, `weekly_digest`, …). Mirrors the
  `features` singleton `flags`.
- **med_reminder_pref** — cloud-only singleton (`{enabled}`). The bot runtime has no
  medication-reminder preference row, so bot exports omit it and bot import ignores it;
  cloud round-trips it.
- **bp_reminder** / **weight_reminder** — the user-set half of the
  `bp_reminder_state` / `weight_reminder_state` rows: `enabled` (bool),
  `preferred_reminder_hour` (int 0–23), `snoozed_until` (RFC3339|null),
  `dont_remind_until` (RFC3339|null). The transient scheduler/Telegram columns
  (`last_notification_sent_at`, `notification_message_id`) and the row metadata are
  **not** carried. Cloud has only `{enabled, preferred_reminder_hour}` in its
  `bpreminderpref` / `weightreminderpref` records; the other two fields ride along on
  the record body as passthrough so a bot→cloud→bot loop is lossless.
- **integrations** — the user's own provider keys, stored **unmasked**:
  `openai: {api_key, url, model, vision_api_key, vision_url, vision_model}`,
  `food: {api_key, url, domain}`, `elevenlabs: {api_key, agent_id}`. This makes the
  backup **secret-bearing** — the export UI nudges toward a passphrase. Cloud-side
  these are read module-to-module (never across the `/api` shim); bot-side the export
  runs over the authed session where the server already holds them. **Omitted entirely**
  when the export is taken with secrets off (see [The secrets toggle](#the-secrets-toggle)).

`food_targets` is the single canonical slot for the food target singleton (the `food`
domain block carries only logs + products).

### `gamification`

```json
"gamification": {
  "targets": [ { target } ],
  "ledger":  [ { ledger_entry } ],
  "state":   { state } | null
}
```

Cloud mode has no gamification engine; it carries the whole block verbatim as a
passthrough record (like `tzhistory`) purely for backup fidelity.

- **target** (leaf, no `id`; `metric_key` is the natural key) — `metric_key` (str),
  `low_val`, `high_val`, `falloff` (num|null), `mode` (str|null), `updated_at` (RFC3339).
  Only metrics the user overrode have a row; the guideline defaults live in code.
- **ledger_entry** (leaf, no `id`) — `day` (RFC3339, always UTC midnight — the stored
  `day_unix`), `ring` (str), `source_metric` (str), `kind` (str), `hp` (int),
  `detail` (str|null), `created_at` (RFC3339). `(day, ring, source_metric, kind)` is the
  natural key (the table's UNIQUE tuple).
- **state** — singleton: `lifetime_hp`, `level`, `current_streak`, `longest_streak`,
  `freezes`, `insight_tier` (int), `last_scored_day` (RFC3339|null), `backfilled_at`
  (RFC3339|null), `updated_at` (RFC3339). Cached/derivable, but only from health data
  the user may no longer have — so it travels.

### `api_tokens`

```json
"api_tokens": [ { "name": str, "token_hash": str, "created_at": RFC3339, "last_used_at": RFC3339|null } ]
```

Absent when the export is taken with secrets off. Only the **hash** exists in the DB
(the plaintext is unrecoverable) — and exporting the hash is exactly what lets an
already-minted MCP/API token keep authenticating after a server move. Cloud mode has no
API tokens and carries the array as a passthrough record.

## The secrets toggle

`GET /api/export?include_secrets=0` (bot) / `exportAll(records, {includeSecrets: false})`
(cloud) omits the two secret-bearing blocks — `settings.integrations` and top-level
`api_tokens` — so the file can be shared or stored casually. Absent (or `1`/`true`) means
include; the export UI's checkbox is **checked by default**. Any other value of the query
param (`no`, `off`, `False`, …) fails closed and omits the blocks — a typo must never leak
provider keys.

With secrets included, both runtimes emit the blocks **even when the account has none**
(`"integrations": {}`, `"api_tokens": []`). Only an *absent* block means "leave the
destination alone", so a restore over an old install can clear stale keys and tokens.

Import semantics for those two blocks are deliberately **not** replace-only, the single
exception to the wipe-then-insert rule:

| Block in file | Import effect |
|---|---|
| absent | target's existing values **left untouched** (no wipe) |
| present | target's values **replaced** by the file's (empty array / empty strings clear them) |

A secrets-free vault must not silently unconfigure the destination's provider keys or
revoke its API tokens. Note that absent and "present but blank" are therefore distinct:
`"integrations": {"openai": {"api_key": "", …}}` **clears** the keys.

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

## Skip list — intentionally never exported

Every table `seeddemo.WipeUserTx` deletes must be either exported (above) or listed
here with a reason. `TestVaultWipeAndExportAgree` pins both directions — a new
user-scoped table that lands in the wipe set and in neither list fails CI, because
"wiped but not exported" is silent data loss on a replace-import.

| Skipped | Reason |
|---|---|
| `push_subscriptions`, cloud `nk` push key | device-bound crypto; a new install re-subscribes |
| `login_nonces` | short-lived auth material |
| `change_events`, per-domain download cursors | SSE/poll sync bookkeeping, rebuilt on demand |
| `intake_reminders` | Telegram message ids, meaningless on another server |
| `miband_gps_tracks` | **bot export carries it** nested under `workouts.miband[].gps`; **cloud import drops it** (`vaultToRecords`). It was 44% of a real vault (~77 MiB / 168 tracks) and no code in either mode renders a route, yet it rode in every cloud snapshot and was structured-cloned on every `records.list()`. Accepted loss: a cloud → bot export no longer carries routes; the bot-mode DB stays the source of truth. |
| `workout_schedule_snapshots` | **write-only table.** `CreateGroupSnapshot` is called from `workout_handlers.go`; `ListGroupSnapshots` (`internal/store/workout/repo.go`) has **zero callers** — no handler, no MCP op, no bot command, no frontend. Nothing can read the data, so carrying it would preserve nothing. |
| cloud-only `voiceprovisioning` | plumbing with no `/api` route |

Also never exported: **derived fields** recomputed on read — bp `category`, weight
`weight_trend`, miband `start_time`/`end_time`, workout schedule materialization.

`api_tokens` and `bp`/`weight` reminder-state were on this list in the first draft of v1
and are now **carried** (see above): the reminder rows hold user-set preferences the wipe
destroys, and the token hashes are what keep a minted token working after a server move.

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
- **Timestamp offsets** — timestamps compare as **instants**, not as text. Bot import
  normalizes every timestamp to UTC before storing it (`2026-07-07T12:00:00+02:00` →
  `2026-07-07T10:00:00Z`), because `modernc.org/sqlite` writes a non-UTC `time.Time`
  in a text form its own reader cannot parse — leaving the row unreadable. The two
  DATE columns (`scheduled_date`, `last_session_date`) carry a *calendar date*, not an
  instant, and are stored as midnight-UTC of the date the file recorded.

## The golden fixture

`tests/fixtures/vault-v1.json` is a small hand-curated vault exercising every domain,
every deterministic-id case (scheduled + manual intake, tz transition plan, workout
scheduled session + rotation), a vitals day-batch boundary (samples spanning two calendar
days), and an integrations key. Both the Go export test and the Vitest cloud round-trip
test pin this one file — any field-name drift on either side fails that side's pin.

Every list-shaped block carries **≥2 rows** on purpose (two gamification targets, two
ledger rows, two api tokens, two tz plans — one `COMPLETED` + one `PENDING_APPROVAL`) so
an exporter that drops all but the newest row fails the pin rather than passing it. The
reminder blocks cover both shapes: `bp_reminder` has a non-null `snoozed_until`,
`weight_reminder` has nulls.
