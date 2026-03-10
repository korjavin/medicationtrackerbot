# MCP Data Access Audit Notifications

## Overview
After MCP tools serve health data, aggregate requests over a 10-minute window, then send a single notification to the user via Telegram/WebPush summarizing what data types and date ranges were queried. Notifications are snooze-limited to once per 2 hours. Communication between the MCP container and main bot container uses an HTTP endpoint with HMAC-SHA256 authentication.

## Context
- Files involved:
  - `internal/mcp/mcp.go`, `internal/mcp/tools.go`, `internal/mcp/vitals.go` (MCP tool handlers)
  - `internal/server/` (add new audit endpoint handler)
  - `cmd/mcptool/main.go` (wire audit buffer startup)
  - `cmd/bot/main.go` (wire audit handler)
  - `docker-compose.yml`, `.env.mcp.example` (config)
  - `CLAUDE.md` (env var docs)
- Related patterns: scheduler Checker pattern, notifier.Notifier interface, HMAC auth like Telegram initData validation
- Dependencies: none new, uses stdlib crypto/hmac

## Architecture

MCP container side:
- Intercepts tool responses, records (data type, date range)
- Accumulates in a buffer with mutex protection
- Every 10 minutes: flush buffer by POSTing aggregated summary to main bot endpoint
- No-op if no events accumulated, or if audit endpoint not configured

Main bot container side:
- Exposes POST /api/mcp-audit endpoint
- Verifies HMAC-SHA256 signature on request body using shared secret
- Merges overlapping date ranges per data type
- Checks in-memory snooze: if last notification < 2h ago, drop silently
- Sends notification via all configured notifiers (TG + webpush)
- Updates in-memory last-sent timestamp

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: MCP audit buffer (MCP container side)

**Files:**
- Create: `internal/mcp/audit.go`
- Modify: `internal/mcp/tools.go`, `internal/mcp/vitals.go`, `internal/mcp/mcp.go`, `cmd/mcptool/main.go`

- [ ] Define `AuditEvent` struct `{DataType string; StartDate, EndDate time.Time}` and `AuditBuffer` struct with mutex, slice, flush ticker
- [ ] Implement tool-name-to-label mapping: `get_medication_intake`→"Medications", `get_workout_history`→"Workouts", `get_food_intake`→"Food", `get_blood_pressure`→"Blood Pressure", `get_weight`→"Weight", `get_sleep_logs`→"Sleep", `get_step_history`→"Steps", `get_health_overview`/`get_vitals_*`→"Vitals"
- [ ] Implement `AuditBuffer.Record(event AuditEvent)` (mutex-protected append)
- [ ] Implement `AuditBuffer.Flush()`: merge date ranges per data type, build JSON payload, compute HMAC-SHA256 over body using shared secret, POST to audit endpoint with `X-Signature` header, clear buffer
- [ ] Implement `AuditBuffer.Start(ctx)` to run a 10-minute ticker goroutine calling Flush
- [ ] Add audit recording call after each successful tool response in `tools.go` and `vitals.go` (parse date range args that were already extracted, pass to `buffer.Record`)
- [ ] Wire `AuditBuffer` into MCP server startup in `cmd/mcptool/main.go`; read `MCP_AUDIT_ENDPOINT` and `MCP_AUDIT_SECRET` from env; skip if not configured (no-op buffer)
- [ ] Write unit tests for date range merging logic and HMAC payload construction
- [ ] Run `go test ./internal/mcp/...` — must pass before Task 2

### Task 2: Audit notification endpoint (main bot side)

**Files:**
- Create: `internal/server/mcp_audit.go`
- Modify: `internal/server/server.go` (route registration), `cmd/bot/main.go` (pass audit secret + notifiers to server)

- [ ] Define `AuditPayload` struct `{DataTypes []DataTypeSummary; RequestedAt time.Time}` where `DataTypeSummary {Label string; From, To time.Time}`
- [ ] Implement HMAC verification: read raw body, compute HMAC-SHA256 with `MCP_AUDIT_SECRET`, compare to `X-Signature` header using `hmac.Equal`
- [ ] Implement snooze state: Server struct field `lastMCPNotification time.Time`; skip if `time.Since(lastMCPNotification) < 2h`
- [ ] Format notification message: "🔍 MCP queried: Medications (Mar 1–10), Workouts (Mar 5–10)" — use short month format, omit year if same year, collapse same-day range to single date
- [ ] Send via server's notifiers slice (already exists on Server struct)
- [ ] Register `POST /api/mcp-audit` route in server setup
- [ ] Write handler tests using httptest: valid HMAC accepted, invalid HMAC rejected (401), snooze suppresses duplicate notification within 2h, notification text format
- [ ] Run `go test ./internal/server/...` — must pass before Task 3

### Task 3: Configuration wiring

**Files:**
- Modify: `docker-compose.yml`, `.env.mcp.example`, `CLAUDE.md`

- [ ] Add `MCP_AUDIT_ENDPOINT` and `MCP_AUDIT_SECRET` to mcp-server service in `docker-compose.yml` (`MCP_AUDIT_ENDPOINT` defaults to `http://medtracker:8080/api/mcp-audit`)
- [ ] Add `MCP_AUDIT_SECRET` to medtracker service in `docker-compose.yml`
- [ ] Update `.env.mcp.example` with new vars and comments
- [ ] Update `CLAUDE.md` environment variables section

### Task 4: Verify acceptance criteria

- [ ] Manual test: trigger a few MCP tool calls, wait 10 min, verify notification arrives in Telegram/webpush with correct data type labels and date ranges
- [ ] Manual test: trigger more calls within 2h, verify no second notification sent
- [ ] Manual test: leave `MCP_AUDIT_ENDPOINT` unset, verify MCP starts normally with no errors
- [ ] Manual test: send request with wrong HMAC, verify 401 response
- [ ] Run `go test ./...`
- [ ] Run `go vet ./...`

### Task 5: Update documentation

- [ ] Update README.md if user-facing changes needed
- [ ] Move this plan to `docs/plans/completed/`
