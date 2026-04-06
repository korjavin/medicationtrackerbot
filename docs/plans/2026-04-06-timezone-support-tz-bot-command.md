---
# Timezone Support with /tz Bot Command

## Overview

Add per-user timezone tracking to the bot. The /tz command requests Telegram location sharing, reverse-geocodes coordinates to a timezone string using the tzf Go library, and records it in a timezone history table. The Mini App auto-detects timezone via the JS Intl API and asks user confirmation before changing ("Are you in Alaska? Do you want to change timezone and adjust notifications?"). Workout, BP, and weight schedulers use the stored timezone; medication scheduling is intentionally excluded from this change (future iteration).

**Medication scheduling note:** Medication notifications are NOT adjusted by user timezone in this iteration. Medication times (e.g., "08:00") continue to fire at that clock time in the system TZ (TZ env var). Changing medication scheduling requires a separate strategy to avoid shortening or lengthening dose intervals — that will be a dedicated follow-up.

## Context

- Files involved:
  - `internal/store/migrations/` — new migration for timezone history table
  - `internal/store/store.go` — new GetCurrentTimezone / RecordTimezone methods
  - `internal/bot/bot.go` — /tz command and location message handler
  - `internal/bot/handlers.go` — location message handling
  - `internal/scheduler/workout.go`, `bp_reminder.go`, `weight_reminder.go` — use user TZ
  - `internal/scheduler/medication.go` — NOT modified in this iteration
  - `internal/server/settings_handlers.go` — expose/accept timezone via API
  - `web/static/features/bootstrap.js` — detect TZ, confirm with user, sync
- Related patterns: settings table single-row pattern, bot command switch pattern
- Dependencies: `github.com/ringsaturn/tzf` (embeds timezone boundary data, no external API calls)

## Development Approach

- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: DB migration and store layer with timezone history

**Files:**
- Create: `internal/store/migrations/043_add_timezone_history.sql`
- Modify: `internal/store/store.go`

- [ ] Create migration 043 that creates a `timezone_history` table: `id INTEGER PRIMARY KEY AUTOINCREMENT`, `timezone TEXT NOT NULL`, `recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP`
- [ ] Add `GetCurrentTimezone() (string, error)` to the store — returns the timezone from the most recent row, or empty string if none
- [ ] Add `RecordTimezone(tz string) error` to the store — inserts a new row
- [ ] Write store tests: record is inserted, most recent entry is returned, empty string on empty table
- [ ] run project test suite - must pass before task 2

### Task 2: Add tzf dependency and geo-to-timezone helper

**Files:**
- Modify: `go.mod`, `go.sum`
- Create: `internal/tzlookup/tzlookup.go`

- [ ] Run `go get github.com/ringsaturn/tzf` to add the dependency
- [ ] Create `internal/tzlookup` package with a single exported function `LookupTimezone(lat, lng float64) (string, error)` wrapping the tzf finder
- [ ] Write a unit test with a known coordinate (e.g. 52.52, 13.40 → Europe/Berlin)
- [ ] run project test suite - must pass before task 3

### Task 3: Bot /tz command and location message handler

**Files:**
- Modify: `internal/bot/bot.go`
- Modify: `internal/bot/handlers.go`

- [ ] Add case "tz" to the command switch: send a message with ReplyKeyboardMarkup containing a KeyboardButton with RequestLocation=true and instructions text
- [ ] In handleMessage, before the IsCommand check, handle `msg.Location != nil`: call LookupTimezone, call store.RecordTimezone, send confirmation message ("Timezone set to Europe/Berlin. Your workout, BP, and weight reminders are now adjusted. Note: medication times are not affected."), remove keyboard with ReplyKeyboardRemove
- [ ] Handle lookup error gracefully — send an error message asking to try again
- [ ] Write bot handler test for /tz command (keyboard sent) and for location message (timezone recorded and confirmed)
- [ ] run project test suite - must pass before task 4

### Task 4: Update non-medication schedulers to use user timezone

**Files:**
- Modify: `internal/scheduler/workout.go`
- Modify: `internal/scheduler/bp_reminder.go`
- Modify: `internal/scheduler/weight_reminder.go`

- [ ] In each of these three schedulers, call store.GetCurrentTimezone() to load the user's timezone on each scheduler tick
- [ ] Load the timezone with `time.LoadLocation(tz)` — fall back to `time.Local` if empty or invalid
- [ ] Replace `time.Now()` calls with `time.Now().In(userLoc)` so all schedule comparisons use the user's clock time
- [ ] Leave `internal/scheduler/medication.go` unchanged — add a comment at the top: `// NOTE: medication scheduling intentionally uses system TZ (time.Local). Timezone-aware medication scheduling requires a separate strategy to avoid shortening/lengthening dose intervals and will be addressed in a future iteration.`
- [ ] Write scheduler tests verifying workout/BP/weight notifications fire in the user's timezone when one is set
- [ ] run project test suite - must pass before task 5

### Task 5: API settings timezone support

**Files:**
- Modify: `internal/server/settings_handlers.go`

- [ ] Include current timezone (from GetCurrentTimezone) in the GET /api/settings response JSON
- [ ] Include current timezone in the /api/bootstrap payload so the Mini App has it on load
- [ ] Accept optional Timezone field in POST /api/settings body; validate with time.LoadLocation (reject invalid IANA names with 400); on valid input call store.RecordTimezone
- [ ] Write HTTP handler tests for GET (timezone returned), POST valid timezone (recorded), POST invalid timezone (400 returned)
- [ ] run project test suite - must pass before task 6

### Task 6: Mini App timezone detection with user confirmation

**Files:**
- Modify: `web/static/features/bootstrap.js`

- [ ] After successful auth in checkAuth(), detect timezone via `Intl.DateTimeFormat().resolvedOptions().timeZone`
- [ ] Compare to timezone from bootstrap payload; if different or empty, show a confirmation dialog: "You appear to be in [Detected TZ]. Change your timezone and adjust notifications?"
- [ ] If user confirms, POST to /api/settings with the detected timezone
- [ ] If user dismisses, do nothing (keep existing timezone)

### Task 7: Verify acceptance criteria

- [ ] run full test suite: `go test ./...`
- [ ] run linter: `go vet ./...`
- [ ] verify workout/BP/weight scheduler fires in correct user timezone
- [ ] verify medication scheduler is unaffected by timezone changes

### Task 8: Update documentation

- [ ] Update CLAUDE.md to note that timezone_history table stores user timezone, overrides TZ env var for workout/BP/weight schedulers only; medication scheduling is explicitly excluded pending a future strategy
- [ ] Move this plan to `docs/plans/completed/`
