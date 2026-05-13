# Go Code Review (2026-05-13)

Cross-cutting review of the Go backend (~44K lines non-test across 312 files).
Reviewed packages: `internal/store`, `internal/domain`, `internal/server`,
`internal/bot`, `internal/scheduler`, `internal/mcp`, `internal/notifier`,
`internal/ai`, `internal/rxnorm`, `internal/webpush`, `internal/workout`,
`cmd/bot`.

The findings are grouped by theme, ranked by severity within each theme, and
every claim cites a specific file:line. The companion refactor plan for the
biggest single item (the `store.Store` god object) lives at
[plans/2026-05-13-split-store-package.md](plans/2026-05-13-split-store-package.md).

## Contents

1. [Architecture: messenger pluggability](#1-architecture-messenger-pluggability)
2. [Store package as god object](#2-store-package-as-god-object)
3. [Timestamp storage inconsistency](#3-timestamp-storage-inconsistency)
4. [Scheduler concurrency & timezone bugs](#4-scheduler-concurrency--timezone-bugs)
5. [Bot violates "thin channel" rule](#5-bot-violates-thin-channel-rule)
6. [Fat HTTP handler files](#6-fat-http-handler-files)
7. [Missing panic-recovery middleware](#7-missing-panic-recovery-middleware)
8. [Context propagation gaps](#8-context-propagation-gaps)
9. [External clients: inconsistent resilience](#9-external-clients-inconsistent-resilience)
10. [Domain service inconsistencies](#10-domain-service-inconsistencies)
11. [Reminder checker duplication](#11-reminder-checker-duplication)
12. [Silent error swallowing](#12-silent-error-swallowing)
13. [MCP executor sandbox limits](#13-mcp-executor-sandbox-limits)
14. [Lower-priority items](#14-lower-priority-items)

---

## 1. Architecture: messenger pluggability

**Stated goal:** Telegram should be one of many possible messenger adapters
(WhatsApp, Matrix, Apple Messages) or absent entirely (web-only). Disabling
Telegram should never break unrelated features.

### What is already good

- **`notifier.Notifier` interface is messenger-agnostic.** Defined at
  `internal/notifier/notifier.go:31-40` as `Send` / `Delete` /
  `CloseNotification`. Two implementations ship today: `Telegram`
  (`internal/notifier/telegram.go`) and `WebPush`
  (`internal/notifier/webpush.go`). The scheduler iterates a `[]Notifier`
  slice (`internal/scheduler/helpers.go:20`) and dispatches to all
  registered notifiers. Adding a WhatsApp / Matrix notifier is a single new
  file plus one wiring line in `cmd/bot/main.go`.

- **Bot is conditional at startup.** `cmd/bot/main.go:34-36, 153-159,
  164-169, 171-173`: if `TELEGRAM_BOT_TOKEN` is empty the bot is never
  constructed, never registered as a notifier, never started. Log lines
  read `"Running in web-only mode"` and `"Scheduler started (web push
  only, no Telegram notifications)"`. This path works today.

- **Bot package is properly isolated.** A grep for `tgbotapi`, `BotAPI`,
  or imports of `internal/bot` from anywhere outside `internal/bot/`
  returns zero hits. No server / scheduler / domain / MCP code reaches
  into the bot.

- **MCP server is Telegram-free.** Pure HTTP, generic `userID int64`
  parameters. Could serve any other frontend tomorrow.

- **Photo food logging is transport-agnostic.** Telegram (`internal/bot/photo_food.go`)
  and web (`internal/server/food_handlers.go:173-283`) both route through
  the same `FoodAIService.ParseMealPhoto()`.

### Where the coupling actually lives — identity

The blocker for true messenger-pluggability is **the user identity model**,
not the transport layer.

- The HTTP auth context object is `TelegramUser`
  (`internal/server/auth.go:25-30`). Roughly 50 handlers extract identity
  as `r.Context().Value(UserCtxKey).(*TelegramUser).ID`.
- `allowedUserID` (a single Telegram chat ID `int64`) is set in
  `cmd/bot/main.go:63` and is the only seat. OIDC / Google login
  (`internal/server/oauth.go`, `internal/server/google_auth.go`) exists but
  still maps incoming users to that same `allowedUserID`
  (`auth.go:197`) — i.e. OAuth is a way to enter a Telegram-shaped seat,
  not a separate identity.
- Every user-scoped table uses `user_id INTEGER` semantically meaning
  "Telegram user ID": `intake_log.user_id` (`internal/store/store.go:100`),
  `push_subscriptions.user_id`
  (`internal/store/migrations/014_add_push_subscriptions.sql:4`),
  `blood_pressure_readings`, `weight_logs`, `workout_sessions`, `food_log`,
  `diary_notes`, etc. There is **no `users` table and no
  `messenger_accounts` mapping table**.

This means even with a clean Notifier seam on the *output* side, there is
no place to put a WhatsApp-only user on the *input* side — every row needs
a Telegram int64 as its scoping key.

### Where the coupling lives — input asymmetry

Some features only work via one channel:

| Feature                              | Telegram         | Web                       |
|--------------------------------------|------------------|---------------------------|
| Sleep import (Apple Health JSON)     | `/sleep_import`  | no UI                     |
| TZ-from-geolocation                  | `/tz` (location) | manual TZ form only       |
| Inline-button intake confirmation    | yes              | polling / manual forms    |
| OIDC / Google sign-in                | no               | yes                       |
| Barcode scanning                     | no               | yes                       |
| Real-time workout session stream     | no               | SSE                       |

For "disabling Telegram does not break things" to be a true statement,
sleep import and a non-geolocation TZ flow need web equivalents.

### Recommended sequencing

1. **Identity refactor** — introduce `users(id TEXT PRIMARY KEY, …)` and
   `messenger_accounts(user_id FK, messenger_type, messenger_id,
   UNIQUE(messenger_type, messenger_id))`. Backfill: one user per existing
   `allowedUserID`, one `messenger_accounts` row mapping
   `telegram → allowedUserID`. Rename `TelegramUser` → `AuthUser`. ~1-2
   weeks done carefully with backfill tests.
2. **Web fallbacks** for sleep import and TZ selection. Days.
3. **Adapter implementations** (WhatsApp / Matrix / etc.) become trivial
   once 1 is done — each is one `Notifier` implementation plus a thin
   inbound webhook handler that resolves `messenger_id` → `user_id`.

---

## 2. Store package as god object

`internal/store/store.go` is **3,336 lines with 125 `*Store` methods**;
the package as a whole defines **167 methods on `Store`** across
`store.go`, `changes.go`, `vitals.go`, `miband_workouts.go`,
`bp_reminders.go`, `weight_reminders.go`. One struct, one `*sql.DB` field
(`internal/store/store.go:45-47`), every concern mixed in.

Method list mixes:
- Medication CRUD (`CreateMedication`, `UpdateMedication`,
  `ListMedications`, `CanDeleteMedication` — store.go:282-330 et al.)
- Intake log (`CreateIntake`, `ConfirmIntake`, `SnoozeIntake`,
  `GetIntakeHistory`, `BatchGetIntakesBySchedule`)
- Blood pressure (`CreateBloodPressureReading`, `GetBPDailyWeightedStats`,
  `SetBPGoal`)
- Weight (`CreateWeightLog`, `GetWeightLogs`, `SetWeightGoal`,
  `GetHighestWeightRecord`)
- Workout / mi-band (`miband_workouts.go`)
- Reminder state (`GetBPReminderState`, `SnoozeBPReminder`,
  `DontBugMeBPReminder` and their weight equivalents)
- Food (`CreateFoodLog`, `SearchFoodProducts`, `UpsertFoodProduct`,
  `SetFoodTargets`)
- Diary (`CreateDiaryNote`, `ListDiaryNotes`)
- Settings (`getSettingsBool`, `setSettingsBool`, plus per-feature
  `Get/Set*Enabled`)
- Auth (`CreateAPIToken`, `FindAPITokenByHash`, `TryUseLoginHash`)
- Timezone transition plans (`CreateTZTransitionPlan`,
  `MarkStepConsumed`, `RejectTZTransitionPlanAndRevertTimezone`)
- Push subscriptions (`CreatePushSubscription`, `DisablePushSubscription`)

The narrowing-interface pattern is already partially in place on the
consumer side: `internal/server/store_interfaces.go` (227 lines, ~10
per-feature interfaces) and `internal/bot/store_interfaces.go` (95
lines). The implementation has not been split to match.

**Effect on the rest of the codebase:**

- CLAUDE.md mandates the domain service pattern — but with one `Store`
  type the boundary it is supposed to protect is permeable: any
  refactor that adds a method anywhere also touches the same file.
- Tests bring up the full database for every concern. The bench/test
  files in `internal/store/` total 56K+ lines.
- New contributors cannot tell which methods belong to which feature
  without grepping by prefix.

Full split plan in
[plans/2026-05-13-split-store-package.md](plans/2026-05-13-split-store-package.md).

---

## 3. Timestamp storage inconsistency

CLAUDE.md mandates: *"any new dose-like timestamp column … must be
stored as `INTEGER` unix-seconds-UTC, not `DATETIME` text"*, with the
intake_log work (migrations 057-062 under
`internal/store/migrations/`) as the canonical pattern. The convention
is enforced for `intake_log` by
`internal/store/intake_log_time_columns_test.go`.

Active violations still on `DATETIME` (text):

- `bp_reminder_state.snoozed_until` and `bp_reminder_state.dont_remind_until`
- `blood_pressure_readings.measured_at`
- `weight_readings.measured_at`
- `food_log_entries.eaten_at`
- `workout_sessions.started_at` / `completed_at` / `snoozed_until`
- `exercise_logs.logged_at`
- Most `created_at` / `updated_at` columns project-wide

The intake_log work was triggered by an actual production incident
(see header of
[plans/20260508-simplify-medication-scheduling-utc-and-pre-materialized-steps.md](plans/20260508-simplify-medication-scheduling-utc-and-pre-materialized-steps.md)).
Other tables remain exposed to the same TZ-equality bug class.

Most urgent of these: anything used in SQL equality, dedupe, or
"have we already logged this instant?" lookups. `food_log_entries.eaten_at`
and `workout_sessions.started_at` are the most likely next regressions.

---

## 4. Scheduler concurrency & timezone bugs

### 4.1 `LowStockChecker` ignores user timezone (HIGH)

`internal/scheduler/low_stock.go:21-29` checks `now.Hour() != 11`
against server-local time, then uses `time.Now().Location()` for the
date guard at line 34. Every other checker (medication, BP, weight,
workout) correctly loads the user's stored timezone and applies it
before deciding whether to fire. For a user in `America/Los_Angeles`
this fires at 11 AM server time, not 11 AM PT — i.e. it fires three to
eight hours late depending on the server's location.

For a health-reminders app the off-by-timezone bug is more serious than
it looks on a code review checklist.

### 4.2 `LowStockChecker.lastCheck` data race (HIGH)

Same file, `internal/scheduler/low_stock.go:34-49`. The `lastCheck` field
is read on line 33 and written on line 48 with no lock. If `Check()` is
ever called concurrently (and the scheduler does spawn goroutines per
tick), two threads can both pass the date guard and double-notify.

Both bugs are in the same checker because it diverged from the pattern
that every other checker followed.

### 4.3 `NotifyHelper` spawns unbounded goroutines (MEDIUM)

`internal/scheduler/helpers.go:20-32`:

```go
for _, nr := range h.notifiers {
    go func(nr notifier.Notifier) { … }(nr)
}
```

No per-notifier timeout, no bounded worker pool, no wait group, no
shutdown coordination. If Telegram or the push provider hangs, goroutines
accumulate forever. Workouts call `c.Notify(context.Background(), …)` at
`workout.go:123, 385, 518, 581` — passing `Background()` means even a
configured per-request timeout cannot cancel the inner send.

### 4.4 DST transitions are not tested (LOW-MEDIUM)

`medication_tz_test.go` and `workout_crosstz_test.go` cover cross-TZ
moves but no test crosses a DST boundary. For a 2:30 AM US/Eastern
reminder, spring-forward should skip the slot and fall-back should not
double-fire. `time.LoadLocation()` handles this correctly, so the *code*
is probably right, but the *invariant* is undefended.

---

## 5. Bot violates "thin channel" rule

CLAUDE.md states the bot is "a thin channel layer only" and all business
logic belongs in `internal/domain/*`. In practice:

- `internal/bot/bot.go:143-150` reads feature flags directly via
  `b.meds.GetMedicationEnabled(ctx)` etc. Bot is calling the
  store-shaped interface, not a domain service.
- `internal/bot/bot.go:656, 1013, 1042, 1075, 1581+` — at least 10
  more direct `b.meds.*` (store) calls.
- `internal/bot/workout_callbacks.go:45-51` mixes store and domain
  calls in one callback: `b.workouts.GetWorkoutSession(...)` followed
  by `b.workoutSvc.StartSession(...)`.

The HTTP server is closer to the rule, but inconsistent within itself —
see §10.5 below.

Side-effect: bot conversational state lives in in-memory maps on the bot
struct (`internal/bot/bot.go:55-66`: `workoutMessages`,
`pendingExercises`, `awaitingLocationChatID`). Every process restart
loses in-flight conversations.

---

## 6. Fat HTTP handler files

Sizes:

- `internal/server/workout_handlers.go` — **1,842 lines**
- `internal/server/food_handlers.go` — **1,039 lines**
- `internal/server/medication_handlers.go` — **834 lines**
- `internal/bot/bot.go` — **1,945 lines** (channel layer for one feature
  per file would be more idiomatic)

These mix HTTP I/O, validation, business logic and error formatting
inline. Each handler can do half a dozen DB calls before delegating to a
service. Splitting them is mechanical once the domain services are
where the logic actually lives — but today, much of the logic is
in-handler, so the split has to happen alongside service extraction.

---

## 7. Missing panic-recovery middleware

`internal/server/server.go` does not wrap handlers in a recover-and-log
middleware. `cmd/bot/main.go:279` calls `Server.ListenAndServe()` with no
process-level recovery either. Any nil deref or out-of-bounds in any
handler crashes the entire binary (server + scheduler + bot).

This is ~20 lines of middleware and is one of the highest-ROI changes in
the repo:

```go
func panicRecover(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        defer func() {
            if rec := recover(); rec != nil {
                slog.Error("panic recovered",
                    "error", rec,
                    "path", r.URL.Path,
                    "stack", string(debug.Stack()))
                http.Error(w, "internal error", http.StatusInternalServerError)
            }
        }()
        next.ServeHTTP(w, r)
    })
}
```

---

## 8. Context propagation gaps

68 instances of `context.Background()` or
`context.WithTimeout(context.Background(), …)` inside HTTP handlers.
Examples:

- `internal/server/food_handlers.go:228` creates a 15s timeout from
  `Background()` instead of `r.Context()`; the same file has 13 more
  business-logic calls (lines 310-843) using `Background()`.
- `internal/server/google_auth.go:161` — `oauthConfig.Exchange(context.Background(), code)`
  ignores the request deadline.
- `internal/server/settings_handlers.go` — bulk timezone operations on
  `Background()`.
- `internal/scheduler/workout.go` — four `c.Notify(context.Background(), …)`
  / `c.DeleteNotification(context.Background(), …)` (see §4.3).

`MedicationService` methods do not take `context.Context` at all
(`internal/domain/medication.go:104-346`), so even if handlers passed
the request context properly, it would be dropped at the service
boundary. `NotesService` (`internal/domain/notes.go:64`) does take ctx —
so this is mid-refactor inconsistency, not a deliberate decision.

Why this matters: client disconnect does not cancel server work, per-request
timeouts do not propagate to the DB driver or to outbound HTTP, and the
codebase becomes harder to test because mocked clocks/cancels can't
plumb through.

---

## 9. External clients: inconsistent resilience

Five external integrations, five different policies:

| Client                                              | Timeout                  | Retry        | Circuit / fallback        |
|-----------------------------------------------------|--------------------------|--------------|---------------------------|
| `internal/ai/openai.go`                             | 90s                      | none         | none                      |
| `internal/rxnorm/client.go`                         | 10s                      | none; `searchApproximate` swallows errors and returns `""` at lines 93-95 | none |
| `internal/webpush/webpush.go`                       | **none — uses default `&http.Client{}`** | none | 410 Gone disables sub (lines 349-354); other errors crash the whole batch (line 279) |
| Google OAuth (`internal/server/google_auth.go`)     | fresh `&http.Client{}` per call | none | none |
| ElevenLabs (`internal/server/elevenlabs_handlers.go`) | `http.DefaultClient`     | none         | none                      |
| OpenFoodFacts (`internal/store/openfoodfacts_api.go`) | fresh `&http.Client{}` per call | none | none |

Plus several MCP-internal clients with 10s / 15s / 60s timeouts (each
created fresh per call). Connection pooling is mostly lost.

`webpush` with no timeout is the most operationally risky — a single
slow push endpoint can stall the dispatch loop.

---

## 10. Domain service inconsistencies

### 10.1 `ReminderService` is a pass-through (HIGH for cleanup)

`internal/domain/reminder.go:34-52`. Four one-line methods forwarding
verbatim to the store:

```go
func (s *reminderService) SnoozeBPReminder(userID int64) error {
    return s.store.SnoozeBPReminder(userID)
}
```

This is ceremony with no business logic. Either delete it (callers go to
the store interface directly) or push real logic into it.

### 10.2 `MedicationService` lacks `context.Context` (MEDIUM)

`internal/domain/medication.go:104-346`. Compare to
`internal/domain/notes.go:64` which does take ctx. Two patterns
co-exist; pick one.

### 10.3 Webpush coupled to concrete `*store.Store` (MEDIUM)

`internal/webpush/webpush.go:25-43`:

```go
type Service struct {
    store *store.Store
    …
}
```

It only uses `GetPushSubscriptions` and `DisablePushSubscription`, so a
narrow interface is trivial. Today this forces the whole store to be
buildable to test webpush.

### 10.4 Timezone logic scattered (MEDIUM)

- `internal/domain/medication.go:299, 337` uses `time.Now()` with no
  user-TZ context. A "scheduled at 9 AM" decision in the wrong zone is a
  user-visible bug.
- `internal/workout/service.go:138-145` lazily fetches user TZ per
  operation, falls back silently to UTC on error. No cache.
- `internal/domain/export.go:37-40` formats CSV timestamps without zone
  info — ambiguous for non-UTC users.

A `UserClock` provider injected into domain services (returning
`NowUTC()` and `Location() *time.Location`) would centralize this.

### 10.5 Server handler logic vs service delegation inconsistency

`internal/server/medication_handlers.go:48` calls
`s.meds.SnoozeIntake(req.IntakeID, snoozeUntil)` — store directly.
`internal/server/medication_handlers.go:79` calls
`s.medSvc.SkipIntake(req.IntakeID)` — domain service. Same logical
operation family, two different code paths, and the skip path collects
reminders (lines 162-165) while the snooze path doesn't.

### 10.6 AI client has no rate / budget controls

`internal/ai/openai.go:136-157, 285-308` defines meal and activity
schemas inline. Each `ParseMealFromDescription` / `ParseActivityFromDescription`
call is unbounded. No token counting, no per-user budget, no rate limit.
For a self-hosted single-user deployment this is acceptable; if the
product opens up multi-user it becomes a financial vector.

---

## 11. Reminder checker duplication

Five parallel checker implementations under `internal/scheduler/`:

- `medication.go` (`MedicationChecker`)
- `bp_reminders.go` (`BPReminderChecker`)
- `weight_reminders.go` (`WeightReminderChecker`)
- `workout.go` (`WorkoutChecker`)
- `low_stock.go` (`LowStockChecker`)

The TZ-loading boilerplate (10 lines) appears verbatim in `bp_reminders.go:49-59`
and `weight_reminders.go` and was *omitted* in `low_stock.go` — which
is why §4.1 happened. A `BaseChecker` (or a `Schedule` description type
fed into one engine) would have caught the bug at design time and would
make adding the sixth metric a single struct definition.

Hardcoded thresholds with no operator override:

- `low_stock.go:28` — 11:00 AM window
- `bp_reminders.go:106, 126` — 12h min gap, ±1h window
- `weight_reminders.go:100, 120` — 7-day min gap, ±2h window
- `workout.go:110, 319, 331` — 90 min stale, 3h re-notify, 6h auto-skip

---

## 12. Silent error swallowing

Pattern: `_ = something.That.Can.Fail(…)`. Examples:

- `internal/server/weight_handlers.go` — `_ = s.weight.ClearWeightReminderNotificationMessage(userID)` (3×)
- `internal/server/bp_handlers.go` — `_ = s.bp.ClearBPReminderNotificationMessage(userID)` (3×)
- `internal/server/food_handlers.go` — `_ = s.food.UpsertFoodProduct(context.Background(), p)` (3×)
- `internal/server/changes_handlers.go` — `_ = json.NewEncoder(w).Encode(...)`, `_, _ = fmt.Fprint(...)`
- `internal/store/store.go:3143` — `_, _ = s.db.Exec(…DELETE FROM used_login_hashes…)`

For most of these, "log at warn level and continue" is the right
behaviour — silently dropping the error masks storage issues until the
next outage.

`internal/store/bp_reminders.go:345-362` and `:429-445` also miss
`defer rows.Close()` after a successful `QueryContext` — the loop is
guarded but the normal-exit path leaks rows.

---

## 13. MCP executor sandbox limits

`internal/mcp/executor/service.go:938-955` spawns Python subprocesses via
`exec.CommandContext` for the `mcp_execute` tool. Defences in place:

- Token / origin validation in `/call` (line 776)
- 2 MB stdin payload cap (line 59)
- 15s wall-clock backstop (lines 526-531)
- Allowed-op enforcement at the proxy

Missing:

- Resource limits (no cgroup / `setrlimit`; subprocess can fork
  unbounded children, allocate unlimited RAM)
- UID / GID isolation — runs as the parent service user
- Process group separation — `SIGKILL` of a hung tree relies on the
  child's cooperation, no `setpgid`

Self-hosted single-tenant: probably acceptable. Multi-tenant or
internet-exposed: not acceptable as-is.

Registry ergonomics: adding an MCP operation today touches 3-4 files
(`registry/operations_*.go`, `DefaultOperations()` at `registry.go:307-314`,
backend endpoint, tests). A manifest or fluent builder would cut the
ceremony.

---

## 14. Lower-priority items

- **No scheduler observability.** No per-checker run count, no
  `last_fired_at` table, no Prometheus gauges. On-call cannot answer
  "did the 9 AM medication reminder fire today?" from logs alone.
- **Error response format inconsistency.** Handlers mix `http.Error`
  plaintext, ad-hoc `{"error": …}` JSON, and silent encode failures
  (`internal/server/medication_handlers.go:106-107`). A single
  `respondError(w, status, code, msg)` helper would unify this and is
  a precondition for any structured error contract on the API.
- **JSON encode errors swallowed.** Same handler file:
  `if err := json.NewEncoder(w).Encode(…); err != nil { slog.Error(…) }`
  — but the client has already received 200 OK headers, so it sees a
  half-encoded body. Acceptable trade-off but worth knowing.
- **No `http.MaxBytesReader` on most POST handlers.** ~54 of ~200
  handler files use it. DoS via huge JSON payloads is open today.
- **HTTP client churn.** ~6 packages create fresh `&http.Client{}` per
  call; connection pooling is lost. A small `httpx` package with
  shared clients (one short-timeout for internal calls, one for
  external) would fix this in a few hours.
- **No CSRF token validation on state-mutating routes.** Security
  headers exist (`internal/server/server.go:358-376` — CSP, HSTS,
  X-Frame-Options) but POST/PUT/DELETE on the same-origin SPA are
  defended by `SameSite` cookies only.
- **MCP registry boilerplate** (see §13).
- **Method-naming inconsistency** across domain services: `Create…` vs
  `Add…`, `Get…` vs `Fetch…` vs `Find…`. Cosmetic but real.
- **No `Clock` interface.** `time.Now()` called directly across
  handlers and domain services. One place uses it correctly:
  `internal/scheduler/bp_reminders.go` has an injectable `now` field.

---

## Recommended priority order

For "Telegram-optional" as the north star:

1. **Add panic-recovery middleware** (hours; prevents tomorrow's outage)
2. **Identity refactor** — `users` + `messenger_accounts` tables (§1)
3. **Web fallbacks for bot-only features** (§1)
4. **`LowStockChecker` TZ + race fix** (§4.1, §4.2) — hours
5. **DATETIME → INTEGER unix-seconds** for remaining columns (§3)
6. **Split `store.Store`** — see [plans/2026-05-13-split-store-package.md](plans/2026-05-13-split-store-package.md)
7. **Generic reminder-checker base** (§11)

Items 4 and 7 can be done together — fixing the bug while extracting the
base class costs only marginally more than fixing it twice.
