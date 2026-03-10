# Move Backend to slog Structured Logs and Update Go to 1.26.1

## Overview
Replace the standard `log` package with Go's built-in `slog` structured logging across all Go files. Set up a default slog TextHandler at startup. Update Go version to 1.26.1 in go.mod, Dockerfile, and all GitHub Actions workflows.

## Context
- Files involved: go.mod, Dockerfile, 5 workflow files, 43 .go files using "log" package
- Existing pattern: stdlib `log` package only, no external logging library
- slog is stdlib since Go 1.21, no new dependencies needed
- Current versions: go.mod=1.24.0, Dockerfile=1.24, workflows=1.22/1.26 (mixed)

## Development Approach
- **Testing approach**: Regular (run existing tests after each task to verify no breakage)
- Each task covers one logical group of files
- log.Fatal → slog.Error + os.Exit(1); log.Printf → slog.Info/Warn/Error based on context
- Use slog.SetDefault() in main() to configure text handler for all packages
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Update Go version to 1.26.1

**Files:**
- Modify: `go.mod`
- Modify: `Dockerfile`
- Modify: `.github/workflows/deploy.yml`
- Modify: `.github/workflows/golangci-lint.yml`
- Modify: `.github/workflows/go-licenses-audit.yml`
- Modify: `.github/workflows/go-dependency-check.yml`

- [ ] Update `go.mod`: change `go 1.24.0` to `go 1.26.1`
- [ ] Run `go mod tidy` to update go.sum
- [ ] Update `Dockerfile`: change `golang:1.24-alpine` to `golang:1.26.1-alpine`
- [ ] Update `.github/workflows/deploy.yml`: change `go-version: '1.22'` to `'1.26.1'`
- [ ] Update `.github/workflows/golangci-lint.yml`: change `go-version: '1.26'` to `'1.26.1'`
- [ ] Update `.github/workflows/go-licenses-audit.yml`: change `go-version: '1.22'` to `'1.26.1'`
- [ ] Update `.github/workflows/go-dependency-check.yml`: change `go-version: '1.22'` to `'1.26.1'`
- [ ] Run `go test ./...` to confirm nothing broke

### Task 2: Set up slog in main entry points (cmd/)

**Files:**
- Modify: `cmd/bot/main.go`
- Modify: `cmd/mcptool/main.go`
- Modify: `cmd/importer/main.go`
- Modify: `cmd/bpimporter/main.go`
- Modify: `cmd/openfoodfacts/main.go`
- Modify: `cmd/genvapid/main.go`

- [ ] In `cmd/bot/main.go`: add slog.SetDefault with NewTextHandler(os.Stderr) at top of main(), replace all log.* calls with slog.*
- [ ] In `cmd/mcptool/main.go`: same — replace log.SetFlags and all log.* calls
- [ ] Replace log.* calls in remaining cmd/ tool files
- [ ] Mapping: log.Fatal/Fatalf → slog.Error + os.Exit(1); log.Printf → slog.Info/Warn/Error; log.Println → slog.Info
- [ ] Run `go test ./...`

### Task 3: Migrate internal/scheduler/ (6 files)

**Files:**
- Modify: `internal/scheduler/scheduler.go`
- Modify: `internal/scheduler/medication.go`
- Modify: `internal/scheduler/medication_reminder.go`
- Modify: `internal/scheduler/workout.go`
- Modify: `internal/scheduler/bp_reminders.go`
- Modify: `internal/scheduler/weight_reminders.go`
- Modify: `internal/scheduler/low_stock.go`
- Modify: `internal/scheduler/helpers.go`

- [ ] Replace all `"log"` imports with `"log/slog"` in each file
- [ ] Replace log.Printf/Println/Fatal calls with slog.Info/Warn/Error
- [ ] Use structured key-value pairs for errors: slog.Error("msg", "error", err)
- [ ] Run `go test ./internal/scheduler/...`

### Task 4: Migrate internal/bot/ (7 files)

**Files:**
- Modify: `internal/bot/bot.go`
- Modify: `internal/bot/workout_callbacks.go`
- Modify: `internal/bot/workout_commands.go`
- Modify: `internal/bot/workout.go`
- Modify: `internal/bot/workout_adhoc.go`
- Modify: `internal/bot/weight_callbacks.go`
- Modify: `internal/bot/bp_callbacks.go`
- Modify: `internal/bot/sleep_import.go`
- Modify: `internal/bot/workout_add_exercise.go`

- [ ] Replace all `"log"` imports with `"log/slog"` in each file
- [ ] Replace log.* calls with slog.* equivalents
- [ ] Run `go test ./internal/bot/...`

### Task 5: Migrate internal/server/ (10 files)

**Files:**
- Modify: `internal/server/server.go`
- Modify: `internal/server/auth.go`
- Modify: `internal/server/google_auth.go`
- Modify: `internal/server/bp_handlers.go`
- Modify: `internal/server/weight_handlers.go`
- Modify: `internal/server/workout_handlers.go`
- Modify: `internal/server/workout_adhoc_handlers.go`
- Modify: `internal/server/medication_handlers.go`
- Modify: `internal/server/food_handlers.go`
- Modify: `internal/server/settings_handlers.go`
- Modify: `internal/server/miband_handlers.go`
- Modify: `internal/server/changes_handlers.go`
- Modify: `internal/server/cancel_intake_handler.go`

- [ ] Replace all `"log"` imports with `"log/slog"` in each file
- [ ] Replace log.* calls with slog.* equivalents
- [ ] For request handlers, include relevant context in log fields (e.g. "error", err)
- [ ] Run `go test ./internal/server/...`

### Task 6: Migrate remaining internal packages

**Files:**
- Modify: `internal/domain/medication.go`
- Modify: `internal/domain/sleepimport.go`
- Modify: `internal/workout/service.go`
- Modify: `internal/webpush/webpush.go`
- Modify: `internal/mcp/mcp.go`
- Modify: `internal/mcp/oauth.go`
- Modify: `internal/mcp/tools.go`

- [ ] Replace all `"log"` imports with `"log/slog"` in each file
- [ ] Replace log.* calls with slog.* equivalents
- [ ] Run `go test ./internal/...`

### Task 7: Verify acceptance criteria

- [ ] Run full test suite: `go test ./...`
- [ ] Build successfully: `go build ./cmd/bot` and `go build ./cmd/mcptool`
- [ ] Verify no remaining `"log"` imports (except log/slog): `grep -r '"log"' --include="*.go" .`
- [ ] Run linter: `golangci-lint run` (if available)

### Task 8: Update documentation

- [ ] Update CLAUDE.md if logging patterns section warrants a note
- [ ] Move this plan to `docs/plans/completed/`
