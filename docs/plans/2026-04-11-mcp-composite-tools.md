# MCP Composite Tools

## Overview
External LLMs connected via MCP never fetch diary notes when doing health analysis, because with 13 separate tools they pick obvious domain-specific ones and miss the context. Notes contain critical information ("started new medication", "traveled to altitude", "high stress at work") that would change the analysis.

**Two changes:**

1. **Add 2 composite analysis tools** that return cross-domain data with notes always included:
   - `analyze_cardiovascular` — BP + medications + sleep + heart rate + SpO2 + diary notes
   - `analyze_fitness` — workouts + steps + daily macro totals (no food names) + weight + diary notes

2. **Inject `context_notes` into all existing tool responses** — every tool includes diary notes from the queried date range by default. LLMs can opt out with `exclude_notes=true`.

All 13 existing tools remain for backward compatibility and granular queries.

**Problem solved:** One call to `analyze_cardiovascular` gives an LLM everything it needs for BP analysis — no more 5 separate tool calls where notes get forgotten.

## Context
- MCP tool definitions: `internal/mcp/tools.go` — all 13 tool handlers
- MCP vitals tools: `internal/mcp/vitals.go` — health overview, vitals_heart/spo2/stress
- MCP server init: `internal/mcp/mcp.go` — tool registration
- Notes store: `internal/store/store.go` — `GetNotes()` / `GetNotesForPeriod()` or similar
- Notes tool: already exists as `get_diary_notes` in `tools.go`
- Audit logging: `internal/mcp/audit.go` — all tool calls are audited
- Feature gates: each domain has enable/disable flags checked before returning data

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- Maintain backward compatibility — no existing tool behavior changes (except adding `context_notes`)

## Testing Strategy
- **Unit tests**: in `internal/mcp/` — test composite tool handlers with mock store
- Test that `context_notes` appears in existing tool responses
- Test that `exclude_notes=true` suppresses notes
- Test that composite tools aggregate data correctly from multiple store queries
- Test feature gate behavior (if BP disabled, cardiovascular tool omits BP section)

## Progress Tracking
- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix

## Implementation Steps

### Task 1: Add notes injection helper
- [ ] Create a helper function `fetchContextNotes(ctx, store, userID, startDate, endDate) []DiaryNote` in `internal/mcp/tools.go` (or a new `notes_helper.go`) that fetches diary notes for a date range
- [ ] Create a helper function `shouldIncludeNotes(params) bool` that checks if `exclude_notes` param is true
- [ ] Define a `ContextNotes` struct (or reuse existing) for the notes array in responses
- [ ] Write test: `fetchContextNotes` returns notes within date range
- [ ] Write test: `shouldIncludeNotes` returns false when `exclude_notes=true`, true otherwise
- [ ] Run `go test ./internal/mcp/...` — must pass before next task

### Task 2: Inject context_notes into existing tool responses
- [ ] Add `exclude_notes` optional boolean parameter to all existing read tools (get_blood_pressure, get_weight, get_medication_intake, get_workout_history, get_sleep_logs, get_food_intake, get_step_history, get_vitals_heart, get_vitals_spo2, get_vitals_stress, get_health_overview)
- [ ] Add `context_notes` field to each tool's response struct (array of `{content, created_at}`)
- [ ] In each tool handler, after the main query, call `fetchContextNotes()` and include in response (unless `exclude_notes=true`)
- [ ] Update tool descriptions to mention: "Includes diary notes from the same period for context. Pass exclude_notes=true to suppress."
- [ ] Do NOT add notes to `get_diary_notes` itself (redundant) or `log_food_intake` (write tool)
- [ ] Write test: get_blood_pressure response includes `context_notes` by default
- [ ] Write test: get_blood_pressure with `exclude_notes=true` omits `context_notes`
- [ ] Run `go test ./internal/mcp/...` — must pass before next task

### Task 3: Add analyze_cardiovascular composite tool
- [ ] Register new tool `analyze_cardiovascular` in `mcp.go`
- [ ] Parameters: `start_date`, `end_date` (same defaults as other tools), `days` as shorthand (e.g., `days=30` → last 30 days)
- [ ] Tool description: "Comprehensive cardiovascular health analysis. Returns blood pressure readings with daily averages, active medications and adherence, sleep duration and quality, heart rate and SpO2 trends, and personal diary notes — all in one call. Use this for any question about blood pressure, heart health, medication effects, or sleep quality."
- [ ] Response structure:
  ```
  AnalyzeCardiovascularResponse {
      period: string
      blood_pressure: { readings: [...], avg_systolic, avg_diastolic, days_measured }
      medications: { active: [...], intake_log: [...], adherence_rate }
      sleep: { logs: [...], avg_duration_minutes, avg_deep_minutes }
      heart_rate: { avg, min, max, readings_count }
      spo2: { avg, min, readings_count }
      diary_notes: [{ content, created_at }]
      warning: optional string
  }
  ```
- [ ] Respect feature gates: if BP is disabled, omit `blood_pressure` section (don't error)
- [ ] Add audit logging for "CardiovascularAnalysis" data type
- [ ] Write test: composite tool returns data from all domains
- [ ] Write test: feature gate disabling BP omits that section but includes others
- [ ] Write test: empty date range returns empty sections, not errors
- [ ] Run `go test ./internal/mcp/...` — must pass before next task

### Task 4: Add analyze_fitness composite tool
- [ ] Register new tool `analyze_fitness` in `mcp.go`
- [ ] Parameters: `start_date`, `end_date`, `days`
- [ ] Tool description: "Comprehensive fitness and nutrition analysis. Returns workout sessions (gym and outdoor), daily step counts, daily calorie/protein/carb/fat totals (food names omitted for privacy), weight trend, and personal diary notes — all in one call. Use this for questions about training, nutrition balance, weight progress, or activity levels."
- [ ] Response structure:
  ```
  AnalyzeFitnessResponse {
      period: string
      workouts: { sessions: [...], total_sessions, completion_rate }
      steps: { daily: [...], avg_daily_steps }
      nutrition: { daily_totals: [{ date, calories, protein_g, carbs_g, fat_g }], avg_daily_calories, avg_daily_protein }
      weight: { logs: [...], current_kg, trend_direction, change_kg }
      diary_notes: [{ content, created_at }]
      warning: optional string
  }
  ```
- [ ] For nutrition: query food logs, aggregate by day, return only totals (no food item names/details)
- [ ] Respect feature gates per domain
- [ ] Add audit logging for "FitnessAnalysis" data type
- [ ] Write test: composite tool returns data from all domains
- [ ] Write test: nutrition daily_totals contains only aggregated numbers, no food names
- [ ] Write test: feature gate disabling food omits nutrition section
- [ ] Run `go test ./internal/mcp/...` — must pass before next task

### Task 5: Verify acceptance criteria
- [ ] Verify all 13 existing tools still work and now include `context_notes`
- [ ] Verify `exclude_notes=true` suppresses notes on all tools
- [ ] Verify `analyze_cardiovascular` returns cross-domain data in one call
- [ ] Verify `analyze_fitness` returns cross-domain data with macro totals (no food names)
- [ ] Verify feature gates work correctly for both composite tools
- [ ] Verify audit logging records events for new tools
- [ ] Run full test suite (`go test ./...`)
- [ ] Run `go vet ./...`

### Task 6: [Final] Update documentation
- [ ] Update CLAUDE.md MCP section with new composite tools
- [ ] Update `.env.mcp.example` if any new config needed
- [ ] Update MCP tool list in README if applicable

## Technical Details

### Composite tool response sizes
Each composite tool does multiple store queries in one handler. Expected response sizes:
- Cardiovascular (30 days): ~60 BP readings + ~90 medication intakes + ~30 sleep logs + HR/SpO2 averages + notes ≈ 5-15KB
- Fitness (30 days): ~15 workout sessions + 30 day stats + 30 daily food totals + ~10 weight logs + notes ≈ 3-10KB

Well within the 1MB request limit and LLM context budgets.

### Notes injection overhead
Diary notes are typically short text entries. For a 90-day range, expect 0-30 notes adding 1-5KB. Minimal overhead on existing tool responses.

### Tool naming convention
- Existing tools: `get_*` (read) and `log_*` (write)
- New tools: `analyze_*` (composite read) — signals "this returns a holistic view"

### Feature gate behavior in composite tools
If a domain's feature gate is disabled:
- That section is `null`/omitted in the response (not an error)
- Other sections still return data
- Warning field mentions which sections were unavailable

## Post-Completion

**Manual verification:**
- Connect to MCP via Claude and ask "How's my cardiovascular health this month?" — verify it calls `analyze_cardiovascular` instead of making 5 separate calls
- Ask "Am I eating enough for my workouts?" — verify `analyze_fitness` is called
- Verify notes appear in responses when asking about any health domain
- Test with Claude.ai MCP integration if available
