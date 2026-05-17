# Telegram setMyCommands on Startup + Feature-Flag Sync

## Overview

Register the bot's slash-command menu programmatically via Telegram's
`setMyCommands` API on startup, and keep the menu in sync with feature
flags by polling the `change_events` table for `settings` changes. After
this change:

1. Fresh deploys auto-populate the slash-command autocomplete — no more
   manual BotFather setup.
2. Toggling a feature off in Settings causes its commands to disappear
   from the Telegram menu within ~5 s; toggling on adds them back.
3. A single canonical `commandSpecs` slice replaces both the hardcoded
   `buildHelpText` blocks and any future BotFather menu — `/help` and the
   Telegram menu render from the same source.

Single-user system, default scope only, no per-language variants.

## Context (from discovery)

- **Library**: `github.com/go-telegram-bot-api/telegram-bot-api/v5 v5.5.1`
  (`go.mod:8`). Use `tgbotapi.NewSetMyCommands(cmds ...BotCommand)` + `Bot.Request(c)`.
- **Bot init**: `cmd/bot/main.go:177` — `bot.New(...)`.
- **Bot polling**: `cmd/bot/main.go:195` — `go tgBot.Start()`.
- **`Bot.Start()`**: `internal/bot/bot.go:239-268` — pre-polling is the
  right hook for the initial registration.
- **22 existing commands** routed in `internal/bot/bot.go:295-453`:
  `/help`, `/log`, `/download`, `/bp`, `/bphistory`, `/bpstats`,
  `/bpgoal`, `/weight`, `/weighthistory`, `/goal`, `/stock`, `/workout`,
  `/startnext`, `/workoutstatus`, `/workouthistory`, `/next`, `/intake`,
  `/food`, `/activity`, `/note`, `/tz`. Plus `/start` (implicit, sent by
  Telegram clients on first chat).
- **Feature flags** (`internal/store/settings/repo.go:87-137`):
  `SetFoodIntakeEnabled`, `SetBloodPressureEnabled`, `SetWeightEnabled`,
  `SetMedicationEnabled`, `SetWorkoutEnabled`, `SetHealthEnabled`. Read
  via the corresponding `Get*Enabled` methods.
- **`/help` source of truth**: `buildHelpText` in
  `internal/bot/bot.go:174` already groups commands into sections gated
  by `featureFlags`. We will refactor it to render from `commandSpecs`.
- **Feature flags loader**: `b.getFeatureFlags(ctx)` already exists
  (`internal/bot/bot.go:294`).
- **change_events trigger**:
  `internal/store/migrations/027_add_change_events.sql:76-78` — every
  `UPDATE settings` inserts `change_events(tag='settings')`. The
  settings repo exposes a `ListChangedTagsSince(cursor)`-style API the
  bot can poll.
- **No existing `setMyCommands` / `SetMyCommands` references** anywhere.
- **Test pattern**: `internal/bot/common_test.go:18-96` — `botTestEnv`
  wraps the bot with a `httptest.Server` intercepting Telegram API calls.
  Existing tests assert on `messageChan` / `requestChan`. We extend the
  mock to capture `setMyCommands` POST bodies.

## Development Approach

- **Testing approach**: Regular (small data slice + two methods + one
  goroutine; write code, then unit tests).
- Complete each task fully before moving to the next.
- **CRITICAL: every task MUST include new/updated tests**.
- **CRITICAL: all tests must pass before starting the next task** — no
  exceptions.
- Run `go test ./internal/bot/...` after each change; run
  `go test ./...` before the final task closes.

## Testing Strategy

- **Unit tests** in `internal/bot/commands_test.go`:
  1. `commandSpecs` covers every case in the `bot.go:295-453` switch
     (assert by iterating the spec list and confirming each name is
     dispatchable).
  2. With all flags enabled, `setMyCommands` POST body contains all 22
     commands + `/start`, names & descriptions round-trip.
  3. With BP disabled, `bp/bphistory/bpstats/bpgoal` are absent from the
     POST body; with workout disabled, the workout block is absent; etc.
     (one table-driven case per feature flag).
  4. Toggling a feature via the settings repo causes the `settings` tag
     to appear in `change_events`; the polling loop picks it up and
     re-POSTs `setMyCommands` with the new filtered list. Use a short
     poll interval in tests (e.g. 20 ms) injected via constructor option.
  5. `setMyCommands` 500-response logs a warn and does NOT block
     `GetUpdatesChan` / message routing.
  6. Polling goroutine exits when the context passed to `Start()` is
     cancelled.
- **`/help` regression**: existing `TestHelpCommand_*` tests in
  `internal/bot/bot_commands_test.go` must still pass after
  `buildHelpText` is rewritten to render from `commandSpecs` — they're
  the regression net for output formatting.
- **No e2e tests** — Telegram bot surface has no Playwright harness.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- ➕ for newly discovered tasks, ⚠️ for blockers.

## Implementation Steps

### Task 1: Define `commandSpecs` (single source of truth)
- [x] create `internal/bot/commands.go` defining:
      ```go
      type commandSpec struct {
          Name        string                // no leading slash
          Description string                // ≤256 chars, used in both menu + /help
          Section     string                // /help grouping header
          EnabledIf   func(featureFlags) bool // nil ⇒ always enabled
      }

      var commandSpecs = []commandSpec{ ... }
      ```
      with one entry per command from `bot.go:295-453` plus `start`
      and `help` (both always enabled). Section labels match the
      current `buildHelpText` headers ("Medication Commands",
      "Blood Pressure & Weight", "Workout", "Food", "Diary",
      "Timezone", etc.).
- [x] add helper `enabledSpecs(flags featureFlags) []commandSpec` that
      filters by `EnabledIf`.
- [x] write `TestCommandSpecs_CoversEveryRoutedCommand` — iterate
      `commandSpecs`, assert each name appears as a case in the message
      router (use a const list of expected names extracted from
      `bot.go`, or simply hard-code the expected count + names).
- [x] write `TestEnabledSpecs_FiltersByFlag` — table-driven, one case
      per feature flag, asserts the expected names appear/disappear.
- [x] `go test ./internal/bot/...` — must pass.

### Task 2: Refactor `buildHelpText` to render from `commandSpecs`
- [x] in `internal/bot/bot.go:174`, rewrite `buildHelpText` to:
      group `enabledSpecs(flags)` by `Section`, preserve section order
      (define an ordered list of sections at the top of `commands.go`),
      and render each line as `/<Name> - <Description>`.
- [x] preserve the existing header line ("**Medication Tracker Bot** -
      configurable tracker…") and any non-command text (footer notes if
      any).
- [x] run existing `TestHelpCommand_*` tests — fix any output drift by
      tweaking descriptions in `commandSpecs` until the tests pass
      verbatim (they are the contract for /help formatting).
- [x] add `TestBuildHelpText_OmitsDisabledSections` if not already
      covered — explicit case: workout flag off → no "Workout" section
      header, no workout commands.
- [x] `go test ./internal/bot/...` — must pass.

### Task 3: Add `registerCommands` and call on startup
- [x] in `internal/bot/commands.go`, add
      `func (b *Bot) registerCommands(ctx context.Context) error`:
      load flags via `b.getFeatureFlags(ctx)`, map
      `enabledSpecs(flags)` to `[]tgbotapi.BotCommand`, build
      `tgbotapi.NewSetMyCommands(cmds...)`, call `b.api.Request(cfg)`.
- [x] in `internal/bot/bot.go` `Start()` (~line 239), call
      `b.registerCommands(ctx)` **before** `GetUpdatesChan`. On error,
      `slog.Warn("failed to register bot commands", "error", err)` and
      continue — do not abort startup.
- [x] write `TestBot_RegisterCommands_PostsEnabledCommands` —
      extend the httptest mock in `common_test.go` to capture
      `/bot<token>/setMyCommands` request bodies; assert with all flags
      on, body matches `commandSpecs`; assert with BP off, BP commands
      are absent.
- [x] write `TestBot_RegisterCommands_FailureDoesNotBlockPolling` —
      mock returns HTTP 500 for `setMyCommands` but `{"ok":true}` for
      `getUpdates`; assert the bot still handles a subsequent `/help`.
- [x] `go test ./internal/bot/...` — must pass.

### Task 4: Poll `change_events` for settings changes
- [ ] add `(b *Bot) watchSettingsChanges(ctx context.Context, interval time.Duration)`:
      track an in-memory `cursor` (start at "now" — initial register
      already happened in Task 3); on each tick, ask the settings repo
      for `ListChangedTagsSince(cursor)`; if `settings` appears,
      call `b.registerCommands(ctx)` (log + swallow errors) and advance
      the cursor.
- [ ] in `Bot` struct, add a `commandsPollInterval time.Duration` field
      defaulting to `5 * time.Second`; allow tests to override via a
      constructor option (e.g. `func WithCommandsPollInterval(d time.Duration) Option`)
      or via direct field write inside the test package.
- [ ] in `Start()`, after the initial `registerCommands`, spawn
      `go b.watchSettingsChanges(ctx, b.commandsPollInterval)`. Goroutine
      exits when `ctx.Done()`.
- [ ] write `TestBot_WatchSettingsChanges_ReregistersOnFlagToggle` —
      use a 20 ms poll interval; start the bot; via the store, call
      `SetBloodPressureEnabled(ctx, false)`; assert a second
      `setMyCommands` POST arrives within ~100 ms with BP commands
      absent.
- [ ] write `TestBot_WatchSettingsChanges_ExitsOnContextCancel` —
      assert no further posts after `cancel()`.
- [ ] `go test ./internal/bot/...` — must pass.

### Task 5: Verify acceptance criteria
- [ ] diff `commandSpecs` against the `bot.go:295-453` switch by hand;
      confirm every routed command has a spec entry and every spec entry
      has a router case.
- [ ] run `go test ./...` — full suite must pass.
- [ ] run `go vet ./...`; if `golangci-lint` is configured for the
      project, run it and fix issues.
- [ ] update `docs/architecture.md` or `docs/features.md` with a one-line
      note: "Bot slash-command menu is registered via setMyCommands on
      startup and re-synced when feature flags change (poll-based)."

## Technical Details

- **`tgbotapi.BotCommand`**: `{Command: "bp", Description: "Log blood pressure (systolic diastolic [pulse])"}`.
  Telegram requires `command` 1–32 chars, lowercase letters/digits/underscore, no leading `/`.
- **Request type**: `NewSetMyCommands(cmds ...BotCommand)` returns
  `SetMyCommandsConfig` with default scope and empty language code —
  exactly what we want.
- **Idempotency**: `setMyCommands` is a full server-side replace.
  Repeated identical calls are cheap and safe.
- **Polling cursor**: in-memory only. On bot restart we re-register
  unconditionally in `Start()`, so a missed event during downtime is
  self-healing.
- **Why polling, not a direct callback**: per design discussion, the
  bot's existing `change_events` infrastructure is reused; no
  cross-component callback wiring between `internal/server` and
  `internal/bot` is needed. Trade-off accepted: up to ~5 s lag between
  flag toggle and menu refresh.
- **`/start`** is always registered (no flag) so first-chat onboarding
  works regardless of which features are enabled.

## Post-Completion

**Manual verification**:
- After deploy, open the bot in Telegram, type `/`, confirm autocomplete
  lists the expected commands with descriptions.
- Toggle workouts OFF in Settings → wait ~5 s → re-open the `/` menu →
  confirm workout commands disappeared. Toggle ON → confirm they
  reappear. Same spot-check for BP and food.
