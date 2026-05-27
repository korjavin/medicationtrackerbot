# Weight Goal Trajectory: Snapshot Start Point + Goal History Table

## Overview

The weight chart's "plan trajectory" line is supposed to connect where the user committed (start point) → where they want to be by the target date (end point). Today it draws from `(first ever log, first log weight)` → `(last log timestamp, goal weight)` — neither endpoint is derived from `goal_date` or the moment the goal was set. As a result, changing the goal date (with the same goal weight) produces no visible change to the trajectory line. **This is the user's reported bug.**

**Desired semantics** (confirmed with user): the trajectory is a straight line between two snapshots.

- **Start point**: `(goal_set_at, weight_at_goal_set)` — the moment the goal was last saved, and the user's weight at that moment. Re-snapshotted every time `SetGoal` runs.
- **End point**: `(goal_date, goal_weight)` — the current target.

When either the goal weight OR the goal date changes, both endpoints update (start gets a fresh snapshot; end gets the new target). The trajectory becomes a stable visual contract: "this is the path I committed to."

**Additional scope** (confirmed with user): persist every goal that's ever set as **append-only history**, not just the current one. Not displayed in the web UI for now, but accessible via API so the MCP agent can analyze goal evolution retrospectively. This naturally subsumes the snapshot — the latest history row *is* the current goal's snapshot.

## Context (from discovery)

**Files involved**:

- `internal/store/migrations/072_add_weight_goals_history.sql` *(new)*
- `internal/store/weight/repo.go` — `WeightGoal` struct, `GetGoal()`, `SetGoal()`; add `ListGoals()`.
- `internal/store/weight/weight_test.go` — extend with history + snapshot scenarios.
- `internal/server/weight_handlers.go:215-253` — `handleGetWeightGoal`, `WeightGoalResponse`; add `handleListWeightGoals`.
- `internal/server/store_interfaces.go:71` — `SetGoal` interface (signature change).
- `internal/bot/store_interfaces.go:44` + `internal/bot/bot.go:1606` — `SetWeightGoal` consumer.
- `internal/mcp/registry/operations_weight.go` (or `operations_<topic>.go` matching where weight ops live; grep to confirm) — add `weight_goal_history_list` op.
- `internal/server/mcp_coverage_exempt.go` — only touch if we decide the route should be exempt (it shouldn't — it's user-actionable).
- `web/static/js/components/wg-weight-chart.js:81-92, 275-276, 345-359` — `extractGoal` + plan-line geometry.
- `web/static/js/components/wg-weight-chart.test.js` (if present) — chart tests.
- `web/static/js/features/weight.js:706-735` — passes `goalData` to chart; no changes expected here.
- `cmd/seeddemo/` — verify whether the demo seeder writes weight goals; if so, route through new `SetGoal` signature so history accumulates correctly in demo deployments.

**Current behavior**:

- Storage: `settings.weight_goal` (REAL) + `settings.weight_goal_date` (TEXT yyyy-mm-dd) on the **singleton** settings row (id=1). The columns are not user-scoped today — a known quirk noted in the repo doc comment "the per-user weight goal ... stored on the singleton settings row".
- API `/api/weight/goal` returns `{goal, goal_date, highest_weight, highest_date}`.
- Chart's `extractGoal()` extracts ONLY the numeric goal value; discards `goal_date` and everything else.
- Trajectory geometry: `(data[0].date, data[0].weight)` → `(data[last].date, goalValue)` — i.e. "diagonal from first log to last log at goal height". Independent of both `goal_date` and any commitment timestamp.

**Why the bug looks like a no-op**: when the user changes only `goal_date`, neither endpoint of the existing trajectory has any input that changed, so the line literally does not move.

**Design decisions**:

1. **History table is source of truth**: new table `weight_goals` is append-only and per-user. The latest row per user IS the "current goal" — `GetGoal` reads from there. `SetGoal` becomes an INSERT (not an UPDATE).
2. **Legacy settings columns stay (denormalized cache)**: `settings.weight_goal` + `settings.weight_goal_date` continue to be written by `SetGoal` for backwards compat with anything still reading directly from settings (e.g. the legacy code path during deployment / mobile build / older clients). `GetGoal` reads history first, falls back to settings if history is empty for that user.
3. **`SetGoal` snapshots automatically**: callers pass userID + weight + targetDate. `SetGoal` resolves the user's latest weight log internally to populate `start_weight`. If no log exists, `start_weight` is stored as NULL.
4. **Per-user from the start**: the new table has `user_id NOT NULL`. This sidesteps the legacy singleton-row issue for new data without forcing us to migrate the existing column (the legacy columns stay singleton).
5. **No aggressive backfill**: legacy goals on `settings.weight_goal*` are NOT backfilled into history. Reasons: (a) the singleton row doesn't know whose goal it is in a multi-user deployment; (b) the "weight when I committed" is unknowable retroactively. Users get history populated on their next save. The chart falls back to the legacy geometry when no history row exists.
6. **X-axis stays data-anchored**: the chart's X domain still runs `[first visible log, last visible log]` — we do NOT extend it to `goal_date`. Instead, the trajectory line is drawn as the **visible segment** of the line through both snapshot anchors, using slope interpolation at the chart's left/right edges. This way slope changes (when goal_date moves) ARE visible, and the range selector keeps its meaning.
7. **Time storage**: `set_at_unix INTEGER NOT NULL` (UTC unix seconds, per CLAUDE.md rule for dose-like timestamp columns). `target_date` stays TEXT (yyyy-mm-dd) because it's a date-only field. `start_weight` is REAL nullable.
8. **History API is user-actionable** → must be in MCP registry, not exempt. Per CLAUDE.md "Adding a new HTTP route" rule.
9. **No web UI changes for history**: per user, defer the history visualization. The endpoint + MCP op make it analysis-ready.

**Time-invariant test**: `TestDoseTimeColumnsAreInteger` in `internal/store/store_time_invariants_test.go` currently scopes to dose-like columns; verify whether `weight_goals.set_at_unix` needs allowlisting (it likely does NOT, since it's not dose-like, but confirm by reading the test).

**Patterns referenced**:

- Migration style: `internal/store/migrations/009_add_weight_goal.sql` (original goal columns) and a recent INTEGER-unix-seconds column add like `064_add_tz_transition_plans_unix.sql`.
- Per-domain repo conventions: `internal/store/weight/repo.go` already shows the pattern.
- MCP operation registration: per `docs/mcp-coverage.md` and existing ops in `internal/mcp/registry/operations_*.go`.

## Development Approach

- **Testing approach**: Regular (code + tests in same task, tests required to pass before next task).
- Migrations are append-only — never modify `009_add_weight_goal.sql`.
- Backend lands before frontend so the API contract is in place when the chart consumes it.
- The chart keeps a fallback path so users with no history rows yet still see a trajectory.
- Frontend tests use existing integration entry points per CLAUDE.md rule #8 — no new `*-branches` files; chart-unit tests are allowed in `wg-weight-chart.test.js` since web components are explicitly excepted from the integration-first rule.

## Testing Strategy

- **Unit tests**: per task, covering success + error + NULL/missing-snapshot fallback + per-user isolation.
- **Backend**:
  - `internal/store/weight/weight_test.go`: history INSERT on SetGoal, latest-history read on GetGoal, `ListGoals` ordering + limit + per-user isolation, NULL start_weight when no log, fallback to settings when history empty.
  - Handler tests: `/api/weight/goal` response shape (new fields present + omitempty when null) and `/api/weight/goals/history` (returns list, respects auth scope, sorted desc).
  - MCP coverage guard test must remain green: confirm the new route is registered in the registry, not added to exempt.
- **Frontend**:
  - Chart tests: changing only `goal_date` produces a different `<line.wg-weight-chart__plan>` (bug regression); snapshot anchors are honored when present; fallback geometry when absent; goal_date in past doesn't crash; setAt before all data uses interpolation at left edge.
- **No E2E**: project has no Playwright/Cypress; chart suite covers it.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document blockers with ⚠️ prefix.
- Update plan if scope changes.

## What Goes Where

- **Implementation Steps**: code, migrations, tests — automatable.
- **Post-Completion**: smoke-test in the running app to confirm the trajectory visibly redraws when only `goal_date` changes (the user's original reproducer), plus sanity-check the history endpoint via curl / MCP tool.

## Implementation Steps

### Task 1: Migration — create `weight_goals` history table

- [x] create `internal/store/migrations/072_add_weight_goals_history.sql`:

  ```sql
  -- +goose Up
  CREATE TABLE weight_goals (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL,
      set_at_unix     INTEGER NOT NULL,
      target_weight   REAL    NOT NULL,
      target_date     TEXT    NOT NULL,
      start_weight    REAL
  );
  CREATE INDEX idx_weight_goals_user_set_at ON weight_goals(user_id, set_at_unix DESC);

  -- +goose Down
  DROP INDEX IF EXISTS idx_weight_goals_user_set_at;
  DROP TABLE IF EXISTS weight_goals;
  ```

- [x] write a migration smoke test (or assert in an existing migrations test) that the table + index exist after migration runs, and that legacy `settings.weight_goal` data is untouched. (`internal/store/migration_072_test.go` covers schema shape, column types, NOT NULL flags, index presence, legacy goal preservation, and Up/Down/Up round-trip.)
- [x] verify `TestDoseTimeColumnsAreInteger`: read `internal/store/store_time_invariants_test.go` to confirm whether `weight_goals.set_at_unix` needs to be added to the allowlist or is excluded by being non-dose-like. Adjust if required. (Verified: the allowlist scopes to dose-related columns on `intake_log` + `tz_transition_plans` only; `weight_goals.set_at_unix` is not dose-like and is correctly out of scope — no change required.)
- [x] run `go test ./internal/store/...` — must pass before next task. (All store packages pass.)

### Task 2: `WeightGoal` struct + history type + read path

- [x] in `internal/store/weight/repo.go`, extend `WeightGoal` to surface the snapshot fields:
  - `GoalSetAt *time.Time \`json:"goal_set_at,omitempty"\``
  - `GoalStartWeight *float64 \`json:"goal_start_weight,omitempty"\``
- [x] add new `WeightGoalHistory` type (id, user_id, set_at, target_weight, target_date, start_weight). (Also re-exported via `store.WeightGoalHistory` alias.)
- [x] change `GetGoal()` → `GetGoal(ctx, userID)`:
  - read most recent row from `weight_goals WHERE user_id = ? ORDER BY set_at_unix DESC LIMIT 1`.
  - if found, populate all four fields (`Goal`, `GoalDate`, `GoalSetAt`, `GoalStartWeight`).
  - if not found, fall back to legacy `SELECT weight_goal, weight_goal_date FROM settings WHERE id = 1` (snapshot fields stay nil).
  - (Interface signatures and all callers — `server.WeightStore`, `bot.WeightStore`, `storeAdapter`, `weight_handlers.go`, `settings_handlers.go`, `bot.handleGoalCommand` — updated to pass ctx + userID through; mobile build still compiles.)
- [x] add `ListGoals(ctx, userID, limit int)` returning `[]WeightGoalHistory` ordered by `set_at_unix DESC`. A `limit <= 0` returns all rows.
- [x] write tests:
  - `TestGetGoal_ReadsLatestHistoryRow`: insert two rows, assert latest wins.
  - `TestGetGoal_FallsBackToSettingsWhenHistoryEmpty`: existing legacy goal still reads.
  - `TestGetGoal_PerUserIsolation`: user A's goal doesn't leak into user B's GetGoal.
  - `TestListGoals_OrderAndLimit`: descending by set_at_unix, limit honored, per-user scoped.
- [x] run `go test ./internal/store/weight/...` — must pass before next task. (Green; broader `internal/store/... ./internal/server/... ./internal/bot/...` suite also green.)

### Task 3: `SetGoal` → INSERT into history + dual-write to settings

- [x] change `SetGoal(weight float64, targetDate time.Time)` → `SetGoal(ctx, userID int64, weight float64, targetDate time.Time)`:
  - resolve latest weight: `SELECT weight FROM weight_logs WHERE user_id = ? ORDER BY measured_at DESC LIMIT 1`. Use `sql.NullFloat64` (nil if no log).
  - wrap in `db.WithTx` per CLAUDE.md cross-table convention:
    - `INSERT INTO weight_goals (user_id, set_at_unix, target_weight, target_date, start_weight) VALUES (?, ?, ?, ?, ?)` with `time.Now().UTC().Unix()`, the resolved `start_weight`, and `targetDate.Format("2006-01-02")`.
    - `UPDATE settings SET weight_goal = ?, weight_goal_date = ? WHERE id = 1` — preserves the legacy denormalized cache.
- [x] update interfaces and callers (signature change is mechanical):
  - `internal/server/store_interfaces.go:71` — userID added.
  - `internal/bot/store_interfaces.go:44` — ctx + userID added.
  - `internal/server/weight_handlers.go` — no POST goal handler exists in server today; the only setter path is the bot `/goal` command, which has been updated. (Interface signature change is still required so the store satisfies `server.WeightStore`.)
  - `internal/bot/bot.go:1606` — now passes `context.Background(), b.allowedUserID`.
  - `internal/bot/adapter.go:176` — bridge updated to forward ctx + userID.
  - `cmd/seeddemo/`, `cmd/importer/`, other CLI tools — grep confirmed no callers exist; nothing to update.
- [x] write tests:
  - `TestSetGoal_InsertsHistoryRow`: row appears in `weight_goals` with set_at_unix close to now, correct target_weight/target_date, start_weight from the latest log.
  - `TestSetGoal_NullStartWeightWhenNoLog`: no log present → row inserted with NULL start_weight; goal still persists.
  - `TestSetGoal_DualWritesToSettings`: legacy `settings.weight_goal*` columns also reflect the new goal.
  - `TestSetGoal_ResnapshotsOnEverySave`: two saves produce two history rows with distinct set_at_unix; second save's start_weight reflects the log added between saves.
  - `TestSetGoal_TransactionRollback`: drop `settings` table to force the UPDATE inside the tx to fail; assert the history row is rolled back.
  - Existing `TestSetAndGetGoal` updated to new signature; `TestGetGoal_FallsBackToSettingsWhenHistoryEmpty` now seeds the legacy goal via direct SQL since `SetGoal` no longer leaves history empty.
- [x] run `go test ./internal/store/... ./internal/server/... ./internal/bot/...` — all green; server + mobile builds + `go vet` clean.

### Task 4: API — extend `/api/weight/goal` + add `GET /api/weight/goals/history`

- [x] in `internal/server/weight_handlers.go`, extend `WeightGoalResponse` with:
  - `GoalSetAt *time.Time \`json:"goal_set_at,omitempty"\``
  - `GoalStartWeight *float64 \`json:"goal_start_weight,omitempty"\``
- [x] populate from the `WeightGoal` returned by `s.weight.GetGoal(ctx, userID)`.
- [x] add `handleListWeightGoals(w, r)`:
  - reads userID from `UserCtxKey`.
  - parses optional `?limit=N` query param (default 100, capped at 200; values <= 0 / non-numeric fall back to the default).
  - calls `s.weight.ListGoals(ctx, userID, limit)`.
  - returns `{ goals: [...] }` JSON (empty array, never `null`).
- [x] register the route in the server's mux next to `/api/weight/goal`: `GET /api/weight/goals/history`. (To keep `TestMCPCoverage_AllRoutesEitherRegisteredOrExempt` green at the Task 4 boundary, a clearly-marked TEMPORARY exemption was added in `mcp_coverage_exempt.go`. Task 5 moves the route to the MCP registry and removes the temp exemption.)
- [x] write handler tests:
  - `/api/weight/goal` includes `goal_set_at` + `goal_start_weight` when set; omits them when null (legacy-fallback case asserted via direct singleton-settings seed).
  - `/api/weight/goals/history` returns rows sorted desc, respects `?limit`, per-user scoped, and returns `{"goals":[]}` (not `null`) on empty history.
- [x] run `go test ./internal/server/...` — green (full server suite passes; targeted `TestHandleGetWeightGoal*` / `TestHandleListWeightGoals*` / `TestMCPCoverage*` pass).

### Task 5: MCP registry — register `weight_goal_history_list`

- [ ] locate where weight-related operations are registered (grep `internal/mcp/registry/operations_*.go` for "weight" or "/api/weight/").
- [ ] add an `Operation` entry for `GET /api/weight/goals/history`:
  - meaningful `Name` (e.g. `weight_goal_history_list`).
  - description: "List the user's historical weight goals (append-only, sorted newest first). Useful for retrospective analysis of how a user's goals evolved over time."
  - input schema: `{ limit?: number }`.
  - output schema: matches the handler's JSON shape (`{ goals: [{ set_at, target_weight, target_date, start_weight }] }`).
- [ ] confirm `TestMCPCoverage_AllRoutesEitherRegisteredOrExempt` still passes — the new route should be reachable through the registry, not via `mcpCoverageExempt`.
- [ ] write a registry smoke test or rely on the coverage guard test.
- [ ] run `go test ./internal/mcp/... ./internal/server/...` — must pass before next task.

### Task 6: Chart — consume snapshot fields + correct trajectory geometry

- [ ] in `web/static/js/components/wg-weight-chart.js`:
  - replace `extractGoal` (or add a sibling) returning `{ value, date, setAt, startWeight }` (all optional, normalized to numbers/Date or null).
  - accept the existing legacy shapes (`number` or `{goal}` / `{target}`) for backward compatibility — return null snapshot fields.
  - in the plan-trajectory section (lines 345-359), branch:
    - **Snapshot path** (both `setAt` AND `startWeight` are present): compute slope `m = (goalValue - startWeight) / (goalDate - setAt)`. For the visible-window X range `[firstTime, lastTime]`, compute `wL = startWeight + m * (firstTime - setAt)` and `wR = startWeight + m * (lastTime - setAt)`. Draw the plan line from `(xOf(firstTime), yOf(wL))` to `(xOf(lastTime), yOf(wR))`. (`yOf` clamps to chart Y bounds; if the line is partly outside, it clips naturally.)
    - **Fallback path** (snapshot missing): preserve existing geometry — `(data[0].date, data[0].weight)` → `(data.last.date, goalValue)`. Keeps legacy goals rendering.
  - keep `goalValue` extension into `dataMin`/`dataMax` (lines 292-295) so the Y axis still includes the target.
- [ ] grep for `extractGoal` outside the chart file — confirm no other consumer depends on its old return shape.
- [ ] write chart tests (in the chart's existing suite — web components are excepted from the integration-first rule, but place them next to the existing chart tests):
  - **Bug regression**: same logs + same goal weight + different `goal_date` → different `<line.wg-weight-chart__plan>` `y` coordinates.
  - **Snapshot honored**: when `setAt`/`startWeight` present, slope at two sampled X values matches `(goalValue - startWeight)/(goalDate - setAt)`.
  - **Fallback**: when snapshot fields absent, line geometry equals legacy `(first log → goal at last log)`.
  - **Edge: goal_date in the past**: no crash; line drawn with past-date slope.
  - **Edge: setAt before all data**: line origin off-screen-left; visible segment uses interpolation at the left edge.
- [ ] run `pnpm test` (or the project's frontend test command, scoped to `wg-weight-chart`) — must pass before next task.

### Task 7: Verify acceptance criteria

- [ ] `go test ./...` and `pnpm test` both green.
- [ ] verify CLAUDE.md rule #8 compliance: no `*-branches` / `*-edges` / `*-characterization` files added.
- [ ] verify CLAUDE.md MCP coverage rule: `/api/weight/goals/history` is in the registry, not in `mcpCoverageExempt`.
- [ ] verify CLAUDE.md time-storage invariant: `weight_goals.set_at_unix` is INTEGER; allowlist `TestDoseTimeColumnsAreInteger` only if its scope demands it (check before editing).
- [ ] verify CLAUDE.md migration rule: no existing migration was modified.
- [ ] `go vet ./...`, `gofmt`, `pnpm lint` if defined.
- [ ] confirm the API contract is purely additive (new JSON fields use `omitempty`; new endpoint doesn't affect existing routes) so older mobile builds still work.

## Technical Details

**Schema delta**:

```sql
CREATE TABLE weight_goals (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    set_at_unix     INTEGER NOT NULL,
    target_weight   REAL    NOT NULL,
    target_date     TEXT    NOT NULL,
    start_weight    REAL
);
CREATE INDEX idx_weight_goals_user_set_at ON weight_goals(user_id, set_at_unix DESC);
```

**`SetGoal` behavior** (pseudocode):

```go
func (r *Repo) SetGoal(ctx context.Context, userID int64, weight float64, targetDate time.Time) error {
    var startWeight sql.NullFloat64
    err := r.db.QueryRowContext(ctx,
        "SELECT weight FROM weight_logs WHERE user_id = ? ORDER BY measured_at DESC LIMIT 1",
        userID,
    ).Scan(&startWeight)
    if err != nil && err != sql.ErrNoRows {
        return err
    }
    return storedb.WithTx(ctx, r.db, func(tx *sql.Tx) error {
        if _, err := tx.ExecContext(ctx,
            `INSERT INTO weight_goals (user_id, set_at_unix, target_weight, target_date, start_weight)
             VALUES (?, ?, ?, ?, ?)`,
            userID, time.Now().UTC().Unix(), weight, targetDate.Format("2006-01-02"), startWeight,
        ); err != nil {
            return err
        }
        _, err := tx.ExecContext(ctx,
            "UPDATE settings SET weight_goal = ?, weight_goal_date = ? WHERE id = 1",
            weight, targetDate.Format("2006-01-02"),
        )
        return err
    })
}
```

**`GetGoal` behavior** (pseudocode):

```go
func (r *Repo) GetGoal(ctx context.Context, userID int64) (*WeightGoal, error) {
    // Try history first.
    row := r.db.QueryRowContext(ctx,
        `SELECT set_at_unix, target_weight, target_date, start_weight
         FROM weight_goals WHERE user_id = ?
         ORDER BY set_at_unix DESC LIMIT 1`,
        userID,
    )
    var setAt int64
    var target float64
    var targetDate string
    var startWeight sql.NullFloat64
    err := row.Scan(&setAt, &target, &targetDate, &startWeight)
    if err == nil {
        // build WeightGoal with all four fields populated
        ...
        return goal, nil
    }
    if err != sql.ErrNoRows { return nil, err }
    // Fallback: legacy singleton settings.
    return r.getGoalFromSettings()  // existing implementation
}
```

**Trajectory geometry** (chart-side):

Given snapshot anchors `A = (tA, wA)` and `B = (tB, wB)`, slope `m = (wB - wA) / (tB - tA)`. For the chart's visible X domain `[tL, tR]`:
- `wL = wA + m * (tL - tA)`
- `wR = wA + m * (tR - tA)`
- Draw plan line `(xOf(tL), yOf(wL))` → `(xOf(tR), yOf(wR))`.

`yOf` clamps to `[yMin, yMax]`, so partial out-of-bounds clips naturally.

## Post-Completion

**Manual verification** (the user's original reproducer):

1. Set a weight goal with target weight W and target date X.
2. Note the trajectory line's slope on the chart.
3. Change ONLY the target date to X' (later or earlier) — keep target weight W.
4. Confirm the trajectory line's slope visibly changes after save.
5. Repeat for changing only the target weight.
6. Confirm legacy goals (set before the migration, settings-only) still render via the fallback path.

**MCP / API smoke**:

- `curl -H 'Authorization: ...' /api/weight/goals/history?limit=5` returns recent goal history.
- From an MCP-connected agent (e.g. Claude in the MCP client), call the new `weight_goal_history_list` op and confirm it returns the same shape.

**Deployment**:

- Goose runs the migration on startup; no manual step.
- API additions are backwards compatible — old mobile builds continue working.
- Mobile build (`-tags mobile`) uses `LocalUserResolver` (single user). Confirm `SetGoal(ctx, userID, ...)` works correctly there during Task 3 (the resolver provides a stable userID, so history rows accumulate for that one user).

**Future opportunities** (out of scope, but unlocked by this work):

- Web UI to display goal history (timeline view of past commitments + actual outcomes).
- "Goal adherence" metric: did the user hit their previous goals? Computable from history × `weight_logs`.
- MCP agent prompts that reason over a user's goal-setting patterns.
