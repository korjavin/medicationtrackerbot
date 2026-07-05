# C2b: Cloud-Mode Medications — Schedule Engine, Intake State Machine, TZ Handling, Reminders

## Overview

Second of the C2 sequence (after C2a). Ports the medications domain — the
app's core feature and the largest hard-logic port — to the C1 pattern:
`web/domain/` modules + apishim routes + vault records, plus client-computed
reminders uploaded through the C0c blind push relay.

Deliberate simplifications vs the server implementation (each is a design
decision, not an omission — see Technical Details for rationale):

1. **No pre-materialized intake rows for future doses.** The server's
   scheduler writes PENDING rows at fire time; the client instead computes
   dose targets on the fly (fire + forecast) from the ported pure
   `PlanDoses`, and materializes an intake record only when a dose becomes
   due or the user acts on it. Deterministic record ids
   (`intake-<medId>-<slotUnix>`) make multi-device materialization
   collision-free: two devices creating "the same" due intake write the
   same record, and LWW merges them.
2. **TZ transition plans become one vault record, not machinery.** The pure
   planner (`GeneratePlan` + shift-policy math) is ported; an approved plan
   persists as a single `tzplan` record whose steps the forecast unions in
   until they're all past. The server's 7-status lifecycle, `steps_json`
   pre-materialization into intake_log, the three SQL suppression gates,
   OldTZ-pinning, and idempotency hashing are all multi-user/multi-transport
   machinery a single-user client doesn't need.
3. **Inventory changes live next to the status flip.** The server's split
   ("store doesn't decrement, the HTTP handler does") is a transport
   artifact; the JS domain does both in one place, same net semantics:
   confirm/log-past decrement, cancel undoes, skip/delete don't.
4. **RxNorm goes direct-from-browser** (decided): drug-name search +
   interaction check against the public RxNav API at save time, warning
   returned in the create/update response exactly like the server does.
   Nothing persisted beyond `rxcui`/`normalized_name` on the med record.
5. **Reminders = compute-and-upload.** The push relay is done (C0c);
   the client computes a horizon of `{fire_at_unix, ct}` entries from the
   forecast (+ re-remind rules) and PUTs the replace-all schedule after
   every intake mutation and on unlock. The SW payload is just
   `{title, body}`.

BP/weight reminder computation (preferred-hour rules) is explicitly NOT in
C2b — same infrastructure, trivial rules, deferred to a later slice so this
plan stays meds-shaped.

## Context (from discovery — file:line refs are the port sources)

- **Schedule model**: `medications.schedule` TEXT — legacy bare `"HH:MM"`
  or JSON `{type: daily|weekly|as_needed, days:[0..6], times:["HH:MM"]}`;
  parser `ValidSchedule` → `ScheduleConfig` (`internal/store/medication/repo.go:47-86`).
  Unique `(name,dosage)` → 409 on conflict.
- **The keystone**: `internal/domain/medplan/medplan.go` — pure
  `PlanDoses(Inputs{Medications, UserLoc, Now, Window})`: `Window==0` fire
  mode (targets at-or-before now), `Window>0` forecast mode (targets in
  `(now, now+window]`); course-window filtering (start/end date,
  created-at), weekly day filter, output sorted by (ScheduledAt, MedID).
  Port near-verbatim.
- **Intake statuses**: PENDING/TAKEN/SKIPPED (+MISSED defined, unused by
  UI flows). Full op table with handler-added semantics in the deep-dive:
  confirm (single + batch confirm-schedule with revert-unchecked path,
  `internal/server/server.go:1445,1548-1569`), skip (no inventory), log-past
  (insert TAKEN + decrement, `internal/domain/medication.go:190`), bulk
  `intakes/update` with per-row `{updated, failed, failures[]}`
  (`medication_handlers.go:459`), cancel TAKEN→PENDING + increment
  (`medication.go:287`), delete-future-PENDING-only (`medication.go:299`),
  snooze default 10min, trigger-next-intake earliest-cluster
  confirm-or-create (`medication_handlers.go:626`), next-intake 12h
  forecast + 10min clustering (`settings_handlers.go:104`).
- **Idempotency guard to preserve**: confirm ops treat "already confirmed"
  as skip-the-decrement — the double-decrement guard. Client equivalent:
  check record status before flipping; LWW covers the cross-device race.
- **Inventory**: nullable `inventory_count` on the med (NULL = untracked);
  restock is transactional add + `Restock` row; low-stock =
  doses/day from schedule → days-of-stock vs threshold (default 7) or
  must-last-until end-date (`repo.go:345-434`). Best-effort by design.
- **TZ engine**: pure planner `internal/domain/tzreschedule/engine.go:48`
  (`GeneratePlan`: offsetDelta, east/westbound, per-med steps) +
  `policy.go` caps (flexible = one step; medium ≤3h/dose; strict ≤2h/dose;
  min/max dose-interval constraints). Suggestion logic
  (`tzsuggestion/service.go`): prompt when detected≠stored, minus
  dismissals. Banner UI `web/static/js/features/tz-plan-banner.js` expects
  `GET /api/tz-plan/current` → `{plan, steps}` with snake_case steps
  (`medication_id, step_number, scheduled_at, note`), actionable on
  PENDING_APPROVAL/NOTIFIED, buttons POST `/api/tz-plan/{id}/approve|reject`.
- **Reminder rules to reproduce** (`internal/scheduler/medication.go`,
  `medication_reminder.go`): fire exactly at slot time (no lead/quiet
  hours); dedup by exact slot or ±MinDoseInterval band; re-remind PENDING
  when snooze expired or >1h past schedule, then advance snooze +1h.
- **Push contract (done in C0c)**: `web/cloud/js/push.js:96 pushSchedule(ctx,
  reminders)` — encrypts `{title, body}` per entry under NK, PUT
  `/api/push/schedule {entries:[{fire_at_unix, ct}]}` replace-all (cap
  2000/4KB); `web/cloud/sw.js` decrypts and shows title/body only.
- **RxNav endpoints** (`internal/rxnorm/client.go:37,89,119`):
  `rxnav.nlm.nih.gov/REST/rxcui.json?name=`, `approximateTerm.json`,
  `rxcui/<id>/properties.json`, and interaction list at
  `lhncbc.nlm.nih.gov/RxNav/APIs/api/interaction/list.json?rxcuis=a+b`.
  Warning string format: `"Interaction between A and B: <desc>"`, first +
  `"(+N more)"`. UI shows `res.warning` as an alert on save
  (`features/meds.js:1155,1234`).
- **Route surface** (§8 of the deep-dive): 18 med routes + 3 tz routes the
  UI calls — the shim route table for this plan.

## Development Approach

- **Testing approach**: NO unit tests. They blow up the codebase for no value here.
  - add an integration test ONLY when it covers a real boundary (API contract, data migration, cross-component flow) and gives a guarantee manual checking can't
  - contract mechanism (C1 pattern): existing meds + meds-history Vitest suites under the shim harness
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: if a task adds an integration test, it must pass before starting the next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- **CRITICAL: bot-mode must not regress.** No changes to `internal/*`;
  `web/static` edits guard-only; `pnpm test` + `go test ./...` (both tags)
  green after every task.

## Testing Strategy

- **Unit tests**: none. Do not add unit tests.
- **Integration tests**: shim-mode runs of the existing meds/meds-history
  feature suites (create/edit/archive, confirm/skip/log-past/cancel/
  delete-intake, restock, history, next-intake widget, tz banner); a seeded
  scenario asserting the reminder horizon recompute (intake confirm →
  replace-all schedule shrinks); RxNav calls faked at the fetch boundary in
  tests.
- **E2E tests**: none.

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix

## Implementation Steps

### Task 1: Schedule engine — `web/domain/medschedule.js`

- [x] port `ValidSchedule`/`ScheduleConfig` parsing (legacy `"HH:MM"` +
      JSON forms) and `PlanDoses` fire+forecast (pure; inputs: meds array,
      IANA timeZone, nowMs, windowMs) — semantics per
      `internal/domain/medplan/medplan.go` incl. course-window and
      created-at filtering, weekly day filter, output ordering
- [x] port doses/day + low-stock math (`repo.go:345-434`): daysOfStock,
      must-last-until-end-date rule, default threshold 7
- [x] pure module, no ports needed beyond arguments (purity guard applies)

### Task 2: Medication records + CRUD — `web/domain/medications.js`

- [x] record types: `medication` (server field names: name, dosage,
      schedule, supplement, start_date, end_date, rxcui, normalized_name,
      inventory_count, tz_shift_policy, archived, created_at),
      `intake` (medication_id, scheduled_at, taken_at, status, snoozed_until,
      source), `restock` (medication_id, quantity, note, restocked_at)
- [x] `createMedicationsDomain({records, now, timeZone, rxnorm})` — rxnorm
      injected as a port (browser impl does real fetches; tests inject a fake)
- [x] med create/update/delete/list mirroring handler shapes incl. the
      `(name,dosage)` uniqueness → 409-equivalent error, archive cleanup of
      pending intakes, and the `warning` field from the rxnorm port
- [x] restock (add + record row, `{status, quantity_added, inventory_count}`),
      restock list, low-stock list with `days_remaining`

### Task 3: Intake state machine

- [x] **deterministic intake ids**: scheduled intakes use
      `recordId = 'intake-<medId>-<slotUnix>'`; manual log-past intakes use
      a random UUID (no slot). This is the multi-device dedup mechanism —
      document it in the module header
- [x] due-dose materialization: on domain init and on a minute-ish timer in
      the shim layer (timer lives in the shim, NOT in web/domain), run
      fire-mode PlanDoses and write PENDING intake records for due slots
      (dedup: deterministic id + ±min-dose-interval band check per
      `HasIntakeNearScheduledTime` semantics)
- [x] ops with exact server semantics (op table in Context): confirm /
      confirm-schedule (incl. revert-unchecked-TAKEN path) / skip /
      log-past / bulk update (`{updated, failed, failures[]}`) / cancel /
      delete-future / snooze / trigger-next-intake (earliest cluster,
      10min) / next-intake (12h forecast + clustering, 204-equivalent when
      none); inventory decrement/increment inline with each status flip,
      with the already-confirmed idempotency guard
- [x] history: `GET /api/history?days&med_id` equivalent over intake
      records, newest-first, same row shape

### Task 4: TZ handling — suggestion, plan preview, one-record plans

- [ ] port `GeneratePlan` + `policy.go` shift caps to
      `web/domain/tzplan.js` (pure: old/new tz, meds, recent intakes →
      steps with per-med step numbers and notes)
- [ ] suggestion flow: device tz ≠ stored `settings.timezone` (C2a record)
      and not dismissed → the existing banner path; dismissal persists (C1
      already stubs `dismissed_tz_suggestion` — make it a real record field)
- [ ] plan lifecycle, minimal: on accepting a tz change that needs steps,
      create ONE `tzplan` record `{old_tz, new_tz, status:
      PENDING_APPROVAL, steps:[...], created_at}`; banner reads it via
      `GET /api/tz-plan/current` (shim maps to the record, snake_case step
      shape the banner expects); approve → status APPROVED (+ settings.timezone
      updated); reject → status REJECTED + timezone reverted
- [ ] forecast/fire integration: while a plan is APPROVED with future
      steps, PlanDoses callers union the plan's due steps in and suppress
      the same-med normal targets for stepped slots (the ONE suppression
      rule kept from the server's three gates); plan flips to COMPLETED
      when no future steps remain
- [ ] flexible-policy tz change (whole shift at once) needs no plan — just
      update the timezone and let recomputation handle it (matches server
      behavior where flexible yields a single step; verify equivalence and
      note any deviation here with ➕)

### Task 5: Reminders — compute and upload to the blind relay

Prerequisite: `docs/plans/2026-07-05-cloud-c2-push-vapid-per-account.md` (per-account
VAPID keys + working push delivery) must be deployed before this task — the
relay is otherwise unconfigured/disabled in a real deployment.

- [ ] `web/domain/reminders.js`: pure horizon computation — given meds,
      pending intakes, timeZone, now: emit `{fire_at_unix, text}` for (a)
      each forecast dose slot in the next 7 days, (b) re-reminds for
      currently-PENDING intakes per server rules (snooze expiry, or +1h
      past schedule, advancing +1h), capped well under the 2000-entry relay
      limit; text = the server's notification body format (med names +
      dose count)
- [ ] shim layer: recompute + `pushSchedule(ctx, entries)` (replace-all)
      on unlock and after every intake/med/tzplan mutation, debounced;
      reuse `web/cloud/js/push.js` as-is
- [ ] med reminder enable/disable: `GET/POST /api/*/reminder` shims backed
      by a `medreminderpref` singleton record; when disabled, upload an
      empty med portion of the schedule (BP/weight reminder stubs stay
      as-is from C1)

### Task 6: RxNorm direct-from-browser

- [ ] `web/cloud/js/rxnorm.js` (browser impl of the rxnorm port): the three
      RxNav lookups + interaction list, exact URLs from
      `internal/rxnorm/client.go`; graceful empty results on any failure
      (never block a med save on RxNav being down); verify CORS on the two
      hosts early — if either blocks browser calls, fall back to skipping
      that call and note it here with ⚠️ (do NOT proxy through the cloud
      server; that would leak drug names to the operator)
- [ ] warning assembly identical to the server (first interaction +
      `"(+N more)"`) so `meds.js`'s alert path works unchanged

### Task 7: Shim wiring + feature flip

- [ ] route table for all 18 med routes + 3 tz routes (Context §route
      surface); remove overlapping stubs; flip `medications` feature flag
      (and whatever flag gates the Today next-intake widget) on
- [ ] Today integration: `next-intake` + `trigger-next-intake` drive the
      Today card; verify the full Today fan-out has no new unmapped-route
      warns for meds

### Task 8: Shim-mode contract runs

- [ ] meds suite: CRUD, archive, restock, inventory, warning alert (fake
      rxnorm port), 409 duplicate
- [ ] meds-history suite: history filters, confirm/skip/log-past/cancel/
      delete/bulk-update flows incl. inventory side effects and
      idempotent double-confirm
- [ ] tz banner: seeded `tzplan` record renders, approve/reject round-trip
- [ ] reminder horizon: confirm-intake shrinks the uploaded schedule
      (assert via a captured pushSchedule fake)

### Task 9: Verify acceptance criteria

- [ ] all flows work in cloud mode end-to-end in the shim harness; due-dose
      materialization produces deterministic ids (two domain instances over
      the same store converge)
- [ ] `pnpm test` fully green (old + new); `go build ./... && go build
      -tags mobile ./...` and `go test -count=1 ./...` green
- [ ] run linters — all issues fixed

### Task 10: [Final] Update documentation

- [ ] `docs/cloud-mode.md`: C2b status; document record types
      (`medication`, `intake` w/ deterministic ids, `restock`, `tzplan`,
      `medreminderpref`); document the simplifications (no pre-
      materialization, one-record tz plans, inventory-with-flip) and the
      reminder compute-and-upload loop; **add the metadata-leakage row:
      drug-name queries → RxNav (NIH), from the client IP, same class as
      food-DB search**
- [ ] `CLAUDE.md`: cloud index row update if needed
- [ ] update the C2 sequence note in the C2a plan's Overview if scope shifted

## Technical Details

- **Why deterministic intake ids are safe**: the record body for a given
  slot is derived from the same med + slot on every device; concurrent
  materialization writes identical-id records and LWW picks one — no dupes,
  no divergence. Manual intakes (log-past) have no natural slot, hence
  random ids.
- **Why one-record tz plans are safe**: steps are always derivable from
  the plan record; the forecast unions them at read time, so nothing needs
  pre-writing into intakes. The single kept suppression rule (stepped slot
  hides same-med normal target) replaces the server's three SQL gates
  because orphan-step and cancelled-plan states can't exist when the steps
  live inside the plan record itself. Gradual (medium/strict) shifts
  persist across restarts because the record persists.
- **Reminder fidelity limits**: re-reminds depend on live intake state, so
  a device that's been closed for days can't refresh the uploaded schedule;
  the horizon uploaded at last-close still fires (encrypted, blind). This
  matches the design's "reminders fire even when no client is open"
  property; staleness self-heals on next unlock. The C0c stale-sync warning
  push already covers the pathological case.
- **Clock/timezone**: all slot math in the device tz (C1-accepted
  deviation); `fire_at_unix` is absolute UTC seconds so relay firing is
  tz-independent.
- **RxNav CORS is the one external unknown** — Task 6 verifies it first
  and degrades gracefully; interactions are ephemeral (never persisted) so
  degradation loses an alert, not data.

## Post-Completion

*No checkboxes — informational.*

**Manual verification on the rig**: create a real med with a daily
schedule; watch the due slot materialize; confirm → inventory decrements →
uploaded push schedule shrinks (`cloud admin inspect` shows the scheduled
queue); receive an actual push at the next slot with the app closed;
change the phone's timezone → suggestion banner → plan preview with a
medium-policy med → approve → forecast shows stepped times; add the same
med on the second device → 409-equivalent duplicate error.

**Deferred by design**: BP/weight reminder computation (later slice);
MISSED-status automation; Telegram intake actions (C3b); low-stock
*notifications* (list works; pushing it into the reminder horizon is a
one-liner to add when wanted).
