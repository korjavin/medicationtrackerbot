# C2d: Cloud-Mode Workouts — Groups/Variants/Exercises, Rotation Engine, Sessions, Mi-Band Read Side

## Overview

Fourth C2 slice. Ports the workouts domain — the most *relational* port so
far (7 entity types, a rotation state machine, lazy session
materialization) — to the C1 pattern. Three findings from discovery shape
the design; each gets an explicit decision here rather than being
discovered mid-implementation:

1. **Numeric ids are load-bearing in this frontend.** `sessions.js:559`
   gates update-vs-create on `log.id > 0`; `group_id == -1 /
   variant_id == -1` is the ad-hoc sentinel consumed across modules. C1's
   opaque-string-id assumption fails here. **Decision: cloud workout
   records carry a client-minted numeric `id` in the body** (timestamp-
   derived positive integer), separate from the `recordId`; foreign keys
   store those numeric ids; `-1` sentinels are kept literal. Where a
   record needs multi-device dedup (lazily-created sessions), the
   `recordId` is deterministic (`session-<groupId>-<date>`) and LWW merges
   concurrent creations — the surviving body's numeric id wins and any
   stale id lookup self-heals on next list (documented, accepted).
2. **`getNext` writes on read.** The server's next-workout resolver
   lazily creates the `pending` session so the UI has an id to `/start`,
   and next-variant deletes it. The cloud domain reproduces this through
   the records port (a read that may append an op) — deterministic
   session recordIds make the double-create race harmless.
3. **Three `apiCallDirect` bypasses** (`groups.js:55`, `next-card.js:179`,
   `stats.js:40`, plus `today-loader.js:154`'s `workout_next` SWR fetch)
   skip the `offlineAwareApiCall` seam. **Decision: cloud-boot installs a
   cloud wrapper over `window.apiCallDirect`** routing into the same shim
   dispatch — zero `web/static` edits for this, and the data-store poller
   that also uses `apiCallDirect` is already disabled in cloud mode.

Explicitly out of scope (mirrors the server split): the background
scheduler loop (lazy `getNext` materialization covers a UI-only client),
workout reminders (compute-and-upload pattern exists in C2b; workouts
join it in a later slice — shim keeps returning disabled reminder
shapes), Telegram/notification transport, mi-band GPS route (no UI
caller), and the MCP/bot-only routes (`sessions/schedule`, `rotation/*`,
`exercises/unique`, compat snooze/skip, `external` webhook). The
bot/MCP idempotent log-upsert (`internal/domain/exercise.go`) is NOT the
web path — do not port it; `workout_resolver.go` is the MCP name-matcher,
also not ported.

## Context (from discovery — port sources)

- **Route surface**: groups/variants/exercises/exercise-library CRUD
  (`internal/server/workout_handlers.go`, `workout_crud_handlers.go` —
  query-param style: `?id=`, `/create`, `/update`, `/delete`), sessions
  read (`GET /api/workout/sessions?limit=` → SessionView with computed
  `total_volume`/`exercises_completed`; `/sessions/details?id=` →
  `{session, logs}`; `/sessions/next` → NextWorkout), lifecycle
  (`/{id}/start|snooze|skip|preskip|cancel-preskip|next-variant`,
  `PUT /sessions/status?id=`, `/sessions/adhoc`,
  `DELETE /sessions/delete?id=`), logs
  (`/sessions/logs/create|update`, `DELETE /sessions/logs/delete?id=`),
  `GET /api/workout/stats`, mi-band list/PATCH/DELETE
  (`miband_handlers.go` — PATCH is diff-semantics over exactly
  `{steps, distance_m, duration_sec, calories, heart_rate_avg, spo2_avg}`).
- **Data model** (`internal/store/workout/`, migrations 012/028/031/052):
  groups (`days_of_week` JSON array 0=Sunday, `scheduled_time` "HH:MM",
  `is_rotating`, `active`, `notification_advance_minutes`), variants
  (`rotation_order`), exercises (targets + `order_index`), exercise_library
  (name unique per user, defaults), rotation state (one row per group:
  `current_variant_id`, `last_session_date`), sessions (statuses
  `pending → notified → in_progress → completed|skipped`, plus reversible
  `pre_skipped`; ad-hoc = `group_id=-1, variant_id=-1`), exercise logs
  (`source ∈ schedule|library`, unique `(session_id, exercise_id, source)
  WHERE exercise_id>0` — the cross-table id-collision guard, preserve it),
  miband rows (dedupe key `(user, source_start_ms)`; server renders local
  times from stored tz_offset — reproduce).
- **The engine** (`internal/domain/workout/next.go:60`, three priorities):
  P0 active session today (notified/in_progress, by scheduled_time); P1
  earliest expired-snooze session; P2 two-week scan of active groups in
  the user's tz (weekday match, skip past times, completed/skipped rows
  keep scanning), variant = rotation cursor for rotating groups else
  first variant, **lazily creating the pending session**. Response shape
  incl. `is_today`, conditional `snoozed_until`, ad-hoc exercise count
  from placeholder logs.
- **Rotation** (`repo.go:653 AdvanceRotation`): variants ordered by
  `rotation_order`, circular next, reset-to-0 when cursor invalid;
  advances on **complete and skip** (`service.go tryAdvanceRotation`,
  best-effort, rotating groups only — ad-hoc no-ops) and on
  **next-variant** (`transitions.go:100`: validate not-started + rotating,
  advance, **delete the current pending session**).
- **Status transitions** (`transitions.go:54 SetSessionStatus`): allowed
  {in_progress, completed, skipped} else 400; completed/skipped delegate
  to Complete/SkipSession (hence rotation advance); start also
  `ClearSnooze`; snooze = `snoozed_until + snooze_count++`.
- **Logs, web path** (`internal/domain/workout/exercise_logs.go`):
  validate non-negative; `logged_at` bumps only while placeholder;
  best-effort `PropagateExerciseToSchedule` writes non-zero
  sets/reps/weight back to `workout_exercises` — **skipped for
  source=library**; auto-promote placeholder→completed when
  `sets_completed>=1`.
- **Stats** (`internal/domain/workout/stats.go`, `sessions.go`):
  per-session `total_volume = Σ sets×reps×weight` over completed logs;
  ad-hoc display name = biggest-volume exercise; 30-day totals +
  completion rate; 12-week Monday-bucketed heatmap where
  **`weekly_activity` is `null` when empty (load-bearing for the UI)**;
  `top_exercises` aggregates.
- **Frontend modules**: groups/variants/exercises/library/sessions/
  next-card/history/stats/miband/modals under
  `web/static/js/features/workout/`; the session-detail save is a
  multi-call sequence (PUT status → per-log update-or-create gated on
  `log.id > 0` and `_dirty`).
- **Shim state**: `PORTED_SET` currently `{bp, weight, health, food*}`
  (*after C2c); `workout` clamped off; bootstrap omits the `workout_next`
  cache while clamped.

## Development Approach

- **Testing approach**: NO unit tests. They blow up the codebase for no value here.
  - add an integration test ONLY when it covers a real boundary (API contract, data migration, cross-component flow) and gives a guarantee manual checking can't
  - contract mechanism (C1 pattern): existing workout Vitest suites under the shim harness — the rotation/next engine is exercised through the real UI flows
- Complete each task fully before moving to the next; small focused changes
- **CRITICAL: if a task adds an integration test, it must pass before starting the next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- **CRITICAL: bot-mode must not regress.** No `internal/*` changes;
  `web/static` untouched except (a) `__MEDTRACKER_CLOUD__` guards if a
  call site genuinely can't be served shape-identically (expected: none —
  the `apiCallDirect` wrapper avoids them) — any exception is documented
  here with ➕; `pnpm test` + `go test ./...` (both tags) green after
  every task.

## Testing Strategy

- **Unit tests**: none. Do not add unit tests.
- **Integration tests**: shim-mode runs of the workout feature suites —
  groups/variants/exercises/library CRUD, next-card resolution across the
  three priorities (seeded rotation state), start/snooze/skip/preskip/
  cancel-preskip/next-variant incl. rotation-cursor assertions,
  session-detail multi-call save (update-vs-create id gating), ad-hoc
  flow, stats shapes (incl. `weekly_activity: null` when empty), mi-band
  list/patch/delete. Plus one two-domain-instance convergence case:
  concurrent lazy `getNext` on a shared in-memory store yields one merged
  session record.
- **E2E tests**: none.

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix

## Implementation Steps

### Task 1: Record model + numeric-id strategy

- [x] record types: `workoutgroup`, `workoutvariant`, `workoutexercise`,
      `exerciselibrary`, `workoutsession`, `exerciselog`, `workoutrotation`
      (per-group, deterministic recordId `rotation-<groupId>`), `miband` —
      bodies use server JSON field names verbatim
- [x] shared id helper in `web/domain/` : mint positive numeric ids
      (epoch-ms-derived + per-instance entropy), stored as body `id`;
      foreign keys store numeric ids; `-1` ad-hoc sentinels kept literal;
      lookups resolve "record of type T whose body.id == n" via the
      records port; document the LWW-merge id-self-heal property in the
      module header (`ponytail:` numeric ids exist solely for frontend
      sentinel compatibility — revisit if C2e migration wants stable ids)
- [x] deterministic recordIds where multi-device dedup matters:
      `session-<groupId>-<scheduledDate>` for schedule-materialized
      sessions (ad-hoc sessions get random recordIds — no natural slot)

### Task 2: CRUD domains — groups, variants, exercises, library

- [x] `createWorkoutDomain({records, now, timeZone})` in
      `web/domain/workout.js` (split files if it gets large — same purity
      rules): groups/variants/exercises/library CRUD mirroring handler
      shapes incl. `days_of_week` JSON-array-as-string round-trip,
      library-name uniqueness, and delete cascades the server relies on
      FK/order for (verify handler behavior for group-delete with
      variants — mirror it)

### Task 3: Next-workout + rotation engine

- [ ] port `GetNext` three-priority resolution (P0 active-today, P1
      expired snooze, P2 two-week scan in device tz with rotation-cursor
      variant selection), incl. lazy session creation through the records
      port with the deterministic recordId, completed/skipped-keeps-
      scanning, and the exact `NextWorkout` response shape (`is_today`,
      conditional `snoozed_until`, ad-hoc placeholder-log exercise count)
- [ ] port `AdvanceRotation` (rotation_order-circular, reset-on-invalid)
      + `InitializeRotation`; rotation advances on complete, skip, and
      next-variant (which also deletes the current pending session) —
      all inside the domain ops, best-effort, rotating groups only
- [ ] session lifecycle ops: start (+clear snooze), snooze (+count),
      skip, preskip/cancel-preskip, `SetSessionStatus` validation
      (400-equivalent on bad status, 404-equivalent on missing), ad-hoc
      create (`-1/-1/in_progress/started_at=now`)

### Task 4: Exercise logs + stats

- [ ] logs create/update/delete with the web-path semantics:
      non-negative validation, `logged_at` bump only while placeholder,
      propagate-to-schedule for non-library sources, auto-promote
      placeholder→completed at `sets_completed>=1`, the
      `(session_id, exercise_id, source)` uniqueness guard
- [ ] SessionView list (`total_volume`, `exercises_completed`, ad-hoc
      biggest-volume display name) + SessionDetails
- [ ] stats: 30-day totals/completion rate, 12-week Monday heatmap with
      `weekly_activity: null` when empty, `top_exercises`

### Task 5: Mi-band read/edit side

- [ ] `miband` records (fields per the enriched GET shape incl.
      `source_start_ms` + tz offset for local time rendering); list with
      limit, PATCH diff-semantics over the six editable fields, DELETE →
      tombstone; ingestion has no cloud path (records arrive via C2e
      import) — empty state renders cleanly in history

### Task 6: Shim wiring — routes, `apiCallDirect` wrapper, feature flip

- [ ] route table for all UI-called workout routes (query-param id style
      preserved); MCP/bot-only routes intentionally unmapped (the
      unknown-route warn documents them as not-ported-by-design — add a
      comment in the shim listing them so the warn list stays
      interpretable)
- [ ] cloud-boot installs a `window.apiCallDirect` wrapper routing
      `/api/*` into the same shim dispatch (fixes `groups.js:55`,
      `next-card.js:179`, `stats.js:40`, `today-loader.js:154` with zero
      `web/static` edits); non-`/api` URLs pass through untouched
- [ ] add `workout` to `PORTED_SET`; bootstrap payload gains the
      `workout_next` cache entry; Today's workout card lights up

### Task 7: Shim-mode contract runs

- [ ] the suites listed in Testing Strategy, incl. rotation-cursor
      assertions after complete/skip/next-variant and the
      two-instance lazy-`getNext` convergence case

### Task 8: Verify acceptance criteria

- [ ] full workout UX in the shim harness; unknown-route warns contain
      only the documented MCP-only routes; `pnpm test` fully green;
      `go build ./... && go build -tags mobile ./...` +
      `go test -count=1 ./...` green; linters clean

### Task 9: [Final] Update documentation

- [ ] `docs/cloud-mode.md`: C2d implementation notes — record types, the
      numeric-id strategy + rationale, lazy-materialization-on-read, the
      `apiCallDirect` wrapper, scheduler-loop skip, reminder deferral
- [ ] `CLAUDE.md`: cloud index row update if needed
- [ ] note remaining C2 scope: C2e (exporter + migration import) is now
      the only unported piece; the post-C2d unknown-route warn list on
      the rig is its final input

## Technical Details

- **Why client-minted numeric ids instead of rewriting call sites**: the
  sentinels (`id > 0`, `== -1`) live in bot-mode-shared files; a
  behavior-preserving numeric body-id keeps `web/static` byte-identical,
  which is worth more than id elegance. The ids are presentation-layer
  only — sync identity is always the `recordId`.
- **Lazy creation on read is safe**: deterministic recordId means N
  devices resolving "next" for the same group+date write the same record;
  LWW picks one body; ops are idempotent at the vault level. Next-variant's
  delete writes a tombstone on that same recordId — a device that races
  the delete re-creates deterministically and converges.
- **Scheduler-loop omission is a UX difference, not a data bug**: without
  the background timer, a session appears when the app computes "next"
  rather than at the scheduled tick. For a client-rendered UI these are
  indistinguishable; reminders (the part that genuinely needs a clock
  while closed) are the deferred compute-and-upload slice.
- **`weekly_activity: null` when empty** is a real frontend contract —
  the Go implementation deliberately emits `null` not `[]`; port the
  quirk, don't fix it here.

## Post-Completion

*No checkboxes — informational.*

**Manual verification on the rig**: create a rotating group (Push/Pull/
Legs) with two scheduled days; next-card shows the right variant; complete
a session → rotation advances → next-card shows the following variant;
next-variant button skips the cursor and re-resolves; ad-hoc workout logs
exercises from the library; stats heatmap renders; second device converges
after pull (session ids self-heal). Check the browser console: remaining
unknown-route warns should be only the documented MCP-only routes.

**Deferred by design**: workout reminders (compute-and-upload, joins the
C2b pattern later); mi-band GPS route; the bot/MCP idempotent log-upsert
and name-resolver; the background scheduler loop.
