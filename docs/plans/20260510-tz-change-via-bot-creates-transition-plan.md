# Timezone change via Telegram bot creates a transition plan (parity with web)

## Overview

When the user changes timezone through the web settings page, the server
captures `oldTZ`, calls `tzPlanner.GenerateIfChanged(oldTZ, newTZ, now)` to
create a `PENDING_APPROVAL` `tz_transition_plan`, then writes the new
timezone — and reverts both on failure. The medication scheduler honours that
plan by preserving `oldTZ` for medication scheduling until the user approves
the stepped transition, so doses don't silently shift by the offset delta.

When the user changes timezone through the Telegram bot (`/tz` → share
location), `internal/bot/tz_commands.go:92` calls
`b.timezone.RecordTimezone(tz)` directly. **No plan is generated.** The
scheduler immediately starts using the new timezone for medications. The
confirmation message — "Note: medication times are not affected" — is then
false on the bot path: medication target wall-clock times shift by the full
offset delta on the next scheduler tick.

This plan:
1. Extracts the web's TZ-update dance (mutex + capture old + generate plan +
   record + revert on failure) into a shared `tzupdate.Service`.
2. Reroutes both `internal/server/settings_handlers.go:handleUpdateSettings`
   and `internal/bot/tz_commands.go:handleLocationMessage` through the
   service, so the medication safety net works for both transports.
3. Rewrites the bot's confirmation message to reflect what actually happens
   (a separate approval prompt will follow when medications are affected).

## Context (from discovery)

Files/components involved:
- `internal/bot/tz_commands.go:46-110` — `handleLocationMessage`, currently
  calls `RecordTimezone` directly (no plan).
- `internal/server/settings_handlers.go:475-553` — `handleUpdateSettings`,
  the reference flow with mutex / GenerateIfChanged / revert dance.
- `internal/server/server.go:79,277` — `tzPlanner` and `SetTZPlanner`
  wiring; `tzUpdateMu` lives on `Server`.
- `internal/domain/tzreschedule/planner.go:27-45` — `PlannerService`
  interface (`GenerateIfChanged`, `CancelActivePlan`).
- `internal/scheduler/tz_plan_notifier.go` — already picks up
  `PENDING_APPROVAL` plans on each scheduler tick and delivers the Telegram
  approve/reject prompt via the existing notifier set. No new delivery code
  needed.
- `internal/bot/tz_plan_callbacks.go` — already handles
  `tz_plan_approve:<id>` / `tz_plan_reject:<id>` callbacks.
- `internal/bot/bot.go:74-114` — `Bot.New` constructor; needs an additional
  param for the new service.
- `cmd/bot/main.go:125,227` — bot construction + `srv.SetTZPlanner(...)`
  wiring; will construct the new service and pass it into both.

Related patterns found:
- Domain-service pattern is mandatory per CLAUDE.md: business logic lives in
  `internal/domain/*`, both transports call it. This refactor *is* the
  pattern.
- Existing settings handler already serializes TZ updates with a mutex and
  reverts on failure; we are pulling that into a service.
- `tz_plan_notifier.go:154-168` already cancels plans when no delivery
  channel exists, so the upfront `len(s.notifiers) > 0` gate in the settings
  handler is a redundant optimization — moving it into the service simplifies
  callers.

Dependencies identified:
- `PlannerService` from `internal/domain/tzreschedule` (no changes needed).
- `tz_plan_notifier`, `tz_plan_callbacks` (no changes needed — they
  generically operate on any `PENDING_APPROVAL` plan, regardless of
  origin).

## Development Approach

- **Testing approach**: TDD (tests first).
- Complete each task fully before moving to the next.
- Make small, focused changes.
- **CRITICAL: every task MUST include new/updated tests** for code changes in
  that task.
- **CRITICAL: all tests must pass before starting next task** — no
  exceptions.
- **CRITICAL: update this plan file when scope changes during
  implementation.**
- Run `go test ./...` after each task.
- Maintain backward compatibility: existing approve/reject callbacks,
  notifier behaviour, and the `tz_transition_plans` table format are
  unchanged.

## Testing Strategy

- **Unit tests**: required for every task.
  - New service: cover happy path, idempotent (oldTZ == newTZ) skip, plan
    generation failure (don't record new TZ), RecordTimezone failure
    (cancel orphan plan + revert to baseline), concurrent updates
    (serialization).
  - Settings handler: existing test suite continues to pass with the
    service-backed flow; one regression test that confirms plan generation
    is still triggered.
  - Bot: location-share now invokes the service; new tests assert
    `GenerateIfChanged` is called and the confirmation message matches the
    plan-created vs no-plan branches.
- **E2E tests**: this project has no Playwright/Cypress suite; UI is
  exercised through unit + integration tests in `internal/server`.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document issues/blockers with ⚠️ prefix.
- Update plan if implementation deviates from original scope.

## What Goes Where

- **Implementation Steps** (`[ ]`): code, tests, doc updates inside this
  repo.
- **Post-Completion** (no checkboxes): manual sanity check on prod, deploy
  verification.

## Implementation Steps

### Task 1: Define `tzupdate.Service` interface + tests
- [ ] write `internal/domain/tzupdate/service_test.go` covering: happy-path
      change (oldTZ != newTZ → planner called, RecordTimezone called, returns
      `planCreated=true`); no-op (oldTZ == newTZ → planner NOT called,
      RecordTimezone NOT called, returns `planCreated=false`); planner
      returns "not created" (oldTZ unresolvable → RecordTimezone still
      called, returns `planCreated=false`); planner error (RecordTimezone
      NOT called, error propagated); RecordTimezone error after plan
      created (planner.CancelActivePlan called, baseline revert attempted);
      concurrent updates serialize (two goroutines, second sees the first's
      newTZ as oldTZ)
- [ ] write `internal/domain/tzupdate/service.go` with `Service` interface
      and `service` struct; depends only on
      `tzreschedule.PlannerService`, a `SettingsStore`-style interface
      (`GetCurrentTimezone`, `RecordTimezone`), and a
      `PlanBaselineStore` (`GetLatestActiveOrPendingTZTransitionPlan` —
      reused from tzreschedule.PlannerStore, the bot store already
      satisfies it)
- [ ] move `tzUpdateMu` from `Server` into the service so cross-transport
      updates serialize through one lock
- [ ] run `go test ./internal/domain/tzupdate/...` — must pass
- [ ] run `go test ./...` to catch any unrelated breakage

### Task 2: Refactor `handleUpdateSettings` to use the service
- [ ] update `internal/server/settings_handlers_test.go` expectations: the
      handler now delegates to `tzupdate.Service`; remove direct
      planner-invocation assertions and replace with service-invocation
      assertions; keep one end-to-end test that exercises the real
      planner + service to prove parity with current behaviour
- [ ] replace `internal/server/settings_handlers.go:489-550` (the entire
      mutex + capture + GenerateIfChanged + RecordTimezone + revert block)
      with `s.tzUpdater.UpdateTimezone(ctx, req.Timezone)`
- [ ] add `tzUpdater tzupdate.Service` field to `Server`; add
      `SetTZUpdater` setter mirroring `SetTZPlanner`
- [ ] remove the now-unused `tzUpdateMu` field from `Server`
- [ ] keep the `len(s.notifiers) > 0` decision inside the service if we
      want to preserve the optimization, OR remove it and rely on
      `tz_plan_notifier`'s "no delivery channel → cancel plan" path —
      ⚠️ decide during Task 1 design: prefer removing the gate (one less
      branch, behaviour is identical because the notifier cancels)
- [ ] run `go test ./internal/server/...` — must pass
- [ ] run `go test ./...` — must pass

### Task 3: Inject `tzupdate.Service` into the bot
- [ ] update bot tests in `internal/bot/tz_commands_test.go` to introduce a
      `mockTZUpdater` (records calls, returns configurable
      `planCreated`/error); update the test fixture in `setupBotTest`
      (likely `bot_test_helpers.go` or similar) to construct the bot with
      the mock
- [ ] add `tzUpdater tzupdate.Service` field to `Bot` struct
- [ ] thread the parameter through `bot.New(...)` — extend the constructor
      signature
- [ ] update `cmd/bot/main.go:125,227` to construct one
      `tzupdate.Service` instance and inject it into both `bot.New` and
      `srv.SetTZUpdater` (single shared mutex across transports)
- [ ] write tests covering: ctor wiring is non-nil; mock is reachable
- [ ] run `go test ./internal/bot/...` and `go build ./...` — must pass

### Task 4: Route `handleLocationMessage` through the service + fix message
- [ ] write/extend tests in `internal/bot/tz_commands_test.go`:
      `TestHandleLocationMessage_PlanCreated_MessageMentionsApprovalPrompt`
      — service returns `planCreated=true`, confirmation message contains
      the new TZ and references the upcoming approval prompt, and does
      NOT contain the old "medication times are not affected" line;
      `TestHandleLocationMessage_NoPlan_MessageDoesNotMentionPrompt` —
      service returns `planCreated=false` (oldTZ == newTZ or unresolvable
      baseline), confirmation message contains only the TZ-set acknowledgement
      and the workout/BP/weight line, with no mention of an approval
      prompt
- [ ] update tests `TestHandleLocationMessage_RecordsTZ` and
      `TestHandleLocationMessage_StoreError` to drive the new
      `tzupdate.Service` mock instead of `mockTimezoneStore`
- [ ] in `internal/bot/tz_commands.go:92`, replace
      `b.timezone.RecordTimezone(tz)` with
      `planCreated, err := b.tzUpdater.UpdateTimezone(ctx, tz)`
- [ ] keep the existing tzlookup error / `time.LoadLocation` validation
      and the `restoreAwaiting` retry behaviour exactly as-is; only the
      persistence call changes
- [ ] rewrite the confirmation message:
      - `planCreated == true`:
        "Timezone set to {tz}. Workout, BP, and weight reminders are
        adjusted. I'll send a separate transition plan for your medication
        times — approve or reject it to control when doses shift."
      - `planCreated == false`:
        "Timezone set to {tz}. Workout, BP, and weight reminders are
        adjusted."
- [ ] drop the `b.timezone TimezoneStore` field if it has no remaining
      callers (verify with grep); otherwise keep it and just stop using
      `RecordTimezone` in this handler
- [ ] run `go test ./internal/bot/...` — must pass

### Task 5: Verify acceptance criteria
- [ ] re-read Overview: bot path creates a `PENDING_APPROVAL` plan, the
      next scheduler tick of `tz_plan_notifier` delivers the existing
      approve/reject prompt over Telegram, `medplan.PlanDoses` preserves
      `oldTZ` until approval — confirm by walking the code paths once more
- [ ] run `go test ./...` (full suite)
- [ ] run `go vet ./...`
- [ ] run `gofmt -l .` (must produce no output) — project enforces gofmt
- [ ] verify no test mentions "medication times are not affected" anywhere
      (`grep -r "medication times are not affected" .`) — the lie is fully
      removed

### Task 6: Update CLAUDE.md / docs if needed
- [ ] check `docs/architecture.md` and `docs/features.md` for any mention
      of the bot `/tz` flow vs web TZ flow — if the doc described them as
      different, update; if not, no change needed
- [ ] do not add a new doc unless a real reader-facing concept emerged

## Technical Details

### `tzupdate.Service` interface (proposed)

```go
package tzupdate

type SettingsStore interface {
    GetCurrentTimezone() (string, error)
    RecordTimezone(tz string) error
}

type PlanBaselineStore interface {
    GetLatestActiveOrPendingTZTransitionPlan() (*store.TZTransitionPlan, error)
}

type Service interface {
    // UpdateTimezone serializes with other in-flight TZ updates, then:
    //   1. Reads the current stored TZ (oldTZ).
    //   2. If oldTZ == newTZ → no-op, returns (false, nil).
    //   3. Captures the active plan's OldTZ as supersededBaseline (in case revert is needed).
    //   4. Calls planner.GenerateIfChanged(oldTZ, newTZ, now).
    //   5. Calls settings.RecordTimezone(newTZ).
    //   6. On RecordTimezone failure: cancel orphan plan, revert TZ to supersededBaseline.
    // Returns planCreated=true when a new plan landed in PENDING_APPROVAL.
    UpdateTimezone(ctx context.Context, newTZ string) (planCreated bool, err error)
}

func NewService(
    settings SettingsStore,
    planBaseline PlanBaselineStore,
    planner tzreschedule.PlannerService,
    now func() time.Time,
) Service
```

### Bot constructor change

`bot.New(token, allowedUserID, s, foodAI, activityAI, tzUpdater)` —
the new last parameter is the shared service. `cmd/bot/main.go` builds
one instance and hands it to both bot and server.

### Confirmation message copy

Removes the deceptive disclaimer. The new copy is honest about the
medication path: "a separate transition plan will be sent" when one was
created, nothing extra when no plan was needed.

### Behavior change for the web path

If we drop the `len(s.notifiers) > 0` gate (recommended), the web path
starts creating plans even when no web push subscription exists. The
existing `tz_plan_notifier` then cancels them on the next tick when no
delivery channel is reachable. Net effect: identical end state, one extra
DB round-trip per "no-subscription TZ change". This is acceptable and
removes a branch.

## Post-Completion

**Manual verification:**
- After deploying, re-run the original repro: send `/tz`, share location.
  Expect (a) confirmation message mentioning the approval prompt, (b) a
  follow-up Telegram message with approve/reject buttons within one
  scheduler tick.
- Approve the plan and confirm the next medication reminder fires at the
  expected wall-clock time in the new TZ; reject it and confirm the
  timezone reverts to the old value.

**External system updates:** none — no consuming projects, no deployment
config changes.
