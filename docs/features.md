# Feature Implementation Patterns

## Today Dashboard

Read-only landing surface (`web/static/js/features/today.js`, `window.TodayDashboard`). The unconditional home view on every cold start — `features/bootstrap.js` always calls `switchTab('today')` after auth. Section views (BP, Weight, Meds, Workouts, Food, Health (labelled "Vitals" in the bottom nav), Settings) are reached via the bottom nav, card deep-links, or URL hash / `tgWebAppStartParam`.

**DOM skeleton** (`#today-content` render order, via `features/today.js`):

1. `.wg-today-shortcuts` — 3-tile row: Log food / Add BP / Add weight. Each tile opens the **existing** styled modal directly (`window.showAddFoodModal` / `window.showBPRecordModal` / `window.showWeightModal`) rather than navigating to the feature screen.
2. `.wg-today-metrics` — 2-tile grid: BP tile (value + unit + status tag + sparkline, deeplinks to `bp`) and Weight tile (kg + delta tag + sparkline, deeplinks to `weight`). No SpO2 or HR tiles on Today.
3. `.wg-fuel-card.wg-today-food` — clickable food card: mono kcal display + "% of target" + 4 `WGMacroBar` rows (Energy / Protein / Carbs / Fat).
4. `.wg-today-wo-sleep` — 2-tile grid: Workout (name + group/time) and Sleep (duration + range).
5. `.wg-today-meds` — plain card (no sun-yellow background banner): header row with icon tile + "Next · HH:MM · in X" label + "Take" gloss-sun button that opens `#med-confirm-modal`; divider; vertical list of upcoming meds (sun-dot + name).

**Aggregation contract** — `aggregateToday(bootstrap, swrCaches, now)` is pure and synchronous; `Date.now()` is injected for testability. Returns a flat object where each field is `{ value, deeplink, status }`. Status values:

- `ok` — data present and fresh
- `missing` — feature enabled, no data yet
- `stale` — cached data older than its freshness threshold (BP: 24h, weight: 7d, sleep: 2d; the 1h `FRESHNESS_MS` constant only gates the offline-banner trigger via `isOfflineStale`)
- `overdue` — scheduled event passed without action (5-min grace period for `nextMed`)
- `disabled` — feature disabled; renderer omits the card entirely

**Fields and deep-link targets**:

| Field | Source | Deeplink |
|-------|--------|----------|
| `greeting` | local hour (good morning/afternoon/evening/night) | — |
| `nextMed` | `bootstrap.next_intake` | `meds` |
| `bpLatest`, `bpTrend7d` | `bootstrap.bp.readings` (7-day anchors) | `bp` |
| `weightLatest`, `weightTrend7d` | `bootstrap.weight.logs` (7-day anchors) | `weight` |
| `caloriesToday`, `caloriesTarget` | SWR `food_today` cache + `settings_bundle` food_targets | `food` |
| `macrosToday`, `macrosTarget` | SWR `food_today` cache + `settings_bundle` food_targets | `food` |
| `nextWorkout` | SWR `workout_next` cache | `workouts` |
| `sleepLastNight` | SWR `health_overview.sleep_stats_7d` (most recent) | `health` |

`loadToday()` (app.js) reads these caches via `ApiCache.getWithMeta` for `settings_bundle`, `next_intake`, `bp`, `weight`, `workout_next`, `health_overview`, and today's food key (`food_YYYY-MM-DD_day`).

**Data sources**: no new backend endpoints in Phase 1 — everything reads from `/api/bootstrap` and the existing SWR caches in `data-store.js`. A Phase 2 `GET /api/today` server-side aggregate is deferred.

**Live updates**: `TodayDashboard.subscribe()` re-renders on `BOOTSTRAP_UPDATED` `postMessage` from the SW (skipped in the subscriber; the app-level handler already reloads the current tab) and on `online` / `offline` window events and `datastore:changed` CustomEvent. `isOfflineStale({ online, cacheTimestamp, now })` toggles the dashboard's offline banner when cached data exceeds 1h while offline.

**Trend arrows**: 7-day trend computed from two SWR-cached anchors (oldest within the 7-day window and most recent). Fewer than 2 usable samples → status becomes `missing`. A `flat` direction (delta within ~0.5% of the anchor magnitude) renders `7d flat` without a signed number.

## Medication Tracking

- **Sub-tabs**: History (default — day-grouped intake log with med + day-range filters and offline/rejected badges), Schedule (hour-grouped dose list with next-action card on top), Inventory (per-medication stock with low-stock alerts and Refill button that posts to `/api/medications/{id}/restock`). The "+ Add" medication button (`#add-btn`, `.wg-toolbar-btn .wg-toolbar-btn--primary`) lives inside a `.wg-meds-schedule-header` wrapper at the top of the Schedule tab only (round-2 Task 7) — it is hidden on History and Inventory. Sub-tab state persists under `mt-meds-subtab` in `sessionStorage` (default `history`, round-2 Task 4); legacy `localStorage` values are purged on module load. On the History tab, the "Next scheduled intake" pane (`.wg-meds-next-intake-card` with a `.wg-toolbar-btn--primary` "Take Now" CTA, round-2 Task 8) renders as the first block above the MEDICATION / RANGE filter row.
- **Schedule order**: hour-of-next-dose buckets (each under a `HH:MM · in Xh Ym` section label, earliest first) → `Scheduled` fallback for entries with no computable next dose → `As needed` → `Archived`. Entries within a bucket are sorted by next-dose time (fallback buckets by most-recent intake).
- **Archiving & Deleting**: active medications can be archived; archived medications can be permanently deleted only if they have no intake history
- **Schedule Types**: Daily, Weekly, As-Needed with optional Start/End dates
- **Duplicate Prevention**: HTTP 409 on creation when name (case-insensitive) + dosage matches an existing medication (including archived)
- **Drug Interactions**: automatic checking via RxNorm API when adding/unarchiving
- **Notifications**: Telegram alerts with scheduled time and dosage; hourly retry if not confirmed
- **Timezone Shift Policy** (`tz_shift_policy`): per-medication field controlling how doses are rescheduled when the user's timezone changes. Values: `flexible` (default — shift immediately in one step), `medium` (gradual, max 3h per dose), `strict` (very gradual, max 2h per step). When a timezone change is detected and an active plan is approved, the scheduler uses the plan's transition steps instead of normal schedule times until all steps are consumed.

## Blood Pressure Tracking

- **Classification**: ISH 2020 guidelines (configurable for age <65)
- **Target**: <130/80 mmHg
- **Tracking**: 2–3x daily recommended
- **Statistics**: daily-weighted averaging — each day with readings gets equal weight regardless of measurement count (prevents frequency bias). Day boundaries use the user's stored timezone (falls back to UTC).
- **UI layout**: the "+ Log" BP button renders **inline** with the range selector (14d / 30d / 60d, **default `14d`**) inside `.wg-bp-range-selector__track`, not as a floating FAB. `#add-bp-btn` is a `.wg-toolbar-btn .wg-toolbar-btn--primary` pill (round-2 Task 5) that re-renders with the range selector. The initial fetch still hits `/api/bp?days=60` so 30- and 60-day averages stay available client-side; active-range filtering happens in `filterReadingsByRange`. The chart emits numeric y-axis mmHg ticks ({60, 80, 100, 120, 140, 160, 180} ladder, clamped to range) and x-axis date ticks; the `bp-current-card` top summary pane was removed in round-2 Task 2.
- **Export**: CSV

## Weight Tracking

- **UI layout** (Wandergeek Phase 6; round-2 Task 12): `#weight-view` opens with the optional goal card (hidden when no goal is set, progress bar when shown), followed by the range-selector row. The range-selector row is a flex track containing the `7d / 30d / 90d / All` pills (persisted via `mt-weight-range`, default `30d`) plus the `+ Log` button (`#add-weight-btn`, `.wg-toolbar-btn .wg-toolbar-btn--primary`) pinned to the right. Below the selector: the `WGWeightChart` panel — whose card surface, guide lines, and axis ticks consume the shared `--wg-chart-*` tokens so it stays visually flush with the BP chart (round-2 Task 13). The chart renders numeric y-axis kg ticks, first/last x-axis date ticks, a dashed `GOAL · {value} kg` horizontal line, a "plan trajectory" line from the first actual log to the goal at the last data point, the actual-weight spline, and a dashed 14-point regression "trend" line. A chart legend (Actual / Plan / Goal) mounts in `#weight-chart-legend` below the chart. A goal-prognosis card (`#weight-prognosis-card`) shows `Time to goal` ("in N days" when the trend points toward the goal and is ≥0.05 kg/week, "At goal" within 0.05 kg of the goal, or "—" when trend is flat or points away) and `Trend` as ±N.N kg/week with a good/bad/flat variant class. All numeric outputs are NaN/Infinity-guarded and fall back to "—". A day-grouped history list sits at the bottom; there is no bottom CTA. The previous "Latest" current-weight pane (`.wg-weight-header-row` + `.wg-weight-current-card`) was removed in round-2 Task 12; the chart is the first visual after the goal card.
- **Edit modal**: kg/lb unit toggle (replaces the paper-era drag ruler). Editing an existing entry deletes the original and POSTs the replacement because the backend has no PATCH route for `/api/weight`.
- **Unit preference**: each user has a preferred weight unit (`kg` or `lb`) stored on the singleton `settings` table (column `weight_unit_preference`, default `kg`). Storage is always in kg; the preference only affects input default and display in the web app and bot replies. The preference is bumped to whichever unit the user last chose: submitting the modal in lb, sending `/weight 150lb`, or flipping the Settings segmented control all PATCH `/api/settings/weight-unit`. The bot's `/weight` command parses trailing `kg` / `lb` / `lbs` / `pound(s)` (case-insensitive); a bare number uses the saved preference. The reply confirms in the user's unit with kg in parentheses (e.g. `Weight recorded: 154.3 lb (70.0 kg)`). The MCP contract is unaffected — `get_weight` and `analyze_fitness` always return `_kg`-suffixed fields regardless of preference.
- **Trend**: exponential moving average for smooth visualization
- **Export**: CSV in Libra format (compatible with Libra app)
- **Reminders**: weekly if no weight logged

## Food Tracking

- **UI layout**: no outer sub-tab strip. `#food-view` opens directly on the daily log — the day navigator sits at the top with an inline `#add-food-inline-btn` sun-gloss "+ Add" pill; below it, the macros card (`#food-macros-card`) carries an in-card Daily / Weekly segmented toggle. Daily shows today's totals; Weekly shows the 7-day total plus an "avg N kcal/day · 7d" subtitle. The meal list stays daily regardless of the toggle. My Meals and Food DB live behind a collapsible `#food-library-view` reachable via the "Meals · Food DB" entry under the meal list. Round-2 Task 3 removed the sticky `.wg-food-cta-dock` at the bottom of `#food-log-tab`; the inline header `+ Add` is now the sole Add-food entry point.
- **Manual logging**: web UI (Open Food Facts search) and multi-item "Meals" templates with aggregated macros
- **Barcode**: `#food-modal` supports barcode auto-lookup (type into `#food-barcode`) and camera scanning via `#food-scanner-modal` (`#food-scan-btn` opens the camera, "Use Photo" decodes a picked image)
- **`/food` Telegram command**: natural-language meal logging via AI. The AI splits complex meals into atomic items (one row per distinct food/ingredient) and normalizes dish names to common English terms regardless of input language (e.g., Russian "куриная грудка с рисом" → two items named "chicken breast" and "rice"). Each item becomes its own `food_log` row sharing the same `eaten_at` timestamp. The bot replies with a per-item breakdown plus an aggregate total. On partial failure, remaining items still persist and the reply reports "Logged N of M items".
- **MCP agent workflow (search-first reuse)**: agents using `mcp_execute` should call `food.products.search` (or `food.products.frequent` for the user's most-logged items) before `food.log.create` and pass the matching `product_id` so reused meals roll up under the same `food_products` row. When only `name` is provided, both the modern `/api/food/log` handler and the legacy HMAC `/api/mcp-food-log` endpoint upsert a `food_products` entry by `(user_id, name)` and bump its `usage_count`. The `food.log.create` response carries `{status, id, product_id, name}`, where `product_id` is the resolved or freshly-upserted product id (null only when no name was provided). The `food` topic in `mcp_help` and the `python/examples/food_log.py` example both demonstrate this contract.

## Workout Tracking

- **UI layout** (Wandergeek Phase 7; round-2 Tasks 6/10/11): four sub-tabs (History / Groups / Exercises / Stats) persisted via `mt-workouts-subtab` (default `history`); History surfaces a day-grouped session list with per-row view/edit/delete actions, Groups and Exercises sub-tabs render as `.wg-card` lists. The Exercises tab carries a `.wg-workouts-exercises-header` row with a "Library" label on the left and the `#add-exercise-library-btn` sun-gloss pill on the right (the full-width bottom "+ Add exercise" CTA was removed in round-2 Task 6). Stats renders a 7d/30d/90d/All range selector (persisted via `mt-workouts-stats-range`) driving a single-series `WGWorkoutChart` sessions-per-week trend with numeric y-axis ticks and 4 date ticks across the visible window; a `.wg-workouts-stats__legend` chip row ("Sessions · per week") sits below the chart so future multi-series charts slot into the same legend. Stats also shows a 2×2 stat-tile grid (Active Weeks / 30-Day Sessions / Done / Skipped) and a Top Exercises list. The "+ Start" ad-hoc workout button (`#start-adhoc-workout-btn`, `.wg-toolbar-btn .wg-toolbar-btn--primary`, round-2 Task 10) renders **inline** with the sub-tab strip (right-aligned), not below the history list. The "Ready to start" / "Next workout" card (`.wg-workouts-next-card`) uses the shared elevated-teal-card recipe with `.wg-toolbar-btn--primary` action (Start Workout / Continue / Cancel Skip) and `.wg-toolbar-btn--secondary` outlines (Skip / Stop / Next Variant); no emoji prefixes in labels or kickers. Exercise rows inside the Edit Variant modal (`.wg-workouts-exercise-row`) carry a token-only dark-surface recipe (round-2 Task 11).
- **Hierarchy**: Groups → Variants → Exercises
- **Rotation**: automatic A/B/C/D progression (e.g., PPL, PHUL splits)
- **Scheduling**: configurable days of week, notification advance time (default 15 min)
- **Scheduled ad-hoc workouts (MCP-only creation)**: a one-off workout for a future date/time can be created via the `workouts.sessions.schedule` MCP operation (`POST /api/workout/sessions/schedule`). The operation takes `scheduled_date` (YYYY-MM-DD), `scheduled_time` (HH:MM, 24h), and an `exercises[]` list with `target_sets`, `target_reps_min`, optional `target_reps_max` / `target_weight_kg`, and either a library `exercise_id` or a free-form `exercise_name`. The result is a pending session with `group_id = -1` / `variant_id = -1` and one pending `workout_exercise_logs` row per planned exercise. The scheduler notifies the user at the scheduled local time (no rotation, no cross-TZ cooldown); execution at workout time reuses the standard `workouts.sessions.start` and `workouts.sessions.logs.update` flow, finalized with `workouts.sessions.status` (`status="completed"`) — without that final status flip the session row stays `in_progress` and the scheduler treats it as stale (notifies after 90 min, auto-skips after 4 h). There is no web UI for creation; cancellation is via `workouts.sessions.delete`. Editing a scheduled session and recurring scheduled ad-hoc are out of scope.
- **Snooze**: 1-hour or 2-hour options
- **Logging**: exercise-by-exercise with sets, reps, weight
- **Weight/Reps Propagation**: when a user logs or edits exercise weight/reps/sets in a pending/notified/in-progress session, the new values propagate back to the `workout_exercises` schedule definition (best-effort, errors logged but don't fail the request). Only applies to exercises belonging to the session's variant — user-added and ad-hoc session exercises are excluded.
- **Prompt Batching**: at most 3 exercise prompts shown at once; remaining queued in-memory (`pendingExercises` map on Bot struct) and sent one-at-a-time as user completes/skips

### Stats API (`/api/workout/stats`)

Returns `active_weeks` (count of weeks with at least one completed session) and `total_sessions` (sum of completed and skipped). Does **not** return streak or total volume metrics.

## Diary Notes

- **Backing table**: `diary_notes` (id, user_id, content, created_at, tag). The `tag` column is nullable — legacy rows stay NULL and the column was added by migration `054_add_diary_notes_tag.sql`.
- **Tag enum**: one of `SLEEP | STRESS | HR | SPO2 | STEPS | NOTE`, or NULL. The domain service (`internal/domain/notes.go` — `NotesService`) normalizes the tag on the way in: incoming values are upper-cased and matched against the 6-value enum; anything else is coerced to NULL so the handler returns `201` with the sanitized record rather than a `400`.
- **Frontend composer** (`#health-notes-tab`): `.wg-card.wg-health-notes-compose` with a "New note" mono label on the left and a horizontally-scrollable 6-chip radiogroup on the right (`SLEEP / STRESS / HR / SPO2 / STEPS / NOTE`). The active chip carries `.wg-tag--sun`; tapping the active chip again deselects it. Below the header sits a textarea + footer row with a live char count and a `.wg-gloss--sun` "+ Add note" button (disabled when empty). Submit POSTs `{content, tag}` to `/api/notes` (the `tag` field is omitted when no chip is selected), prepends the new row to the list, and clears the composer.
- **List rendering**: each note row shows a `.wg-tag--high.wg-health-notes-row__tag` pill with the tag label when `note.tag` is one of the 6 enum values; NULL and unknown values render no pill. Round-2 Task 5 made the tag pills clickable: tapping a row's chip filters the notes list to only rows carrying that tag and marks the chip `.wg-health-notes-row__tag--active`; tapping the active chip again clears the filter. Filter state is module-local (not persisted) and repaints from the in-memory `_notesAll` cache without refetching. Create/delete invalidates via `DataStore.invalidateTags(['health-notes'])` so Today tiles and other listeners refresh without reload.
- **Edit**: the legacy `#note-modal` still opens from a list row for editing an existing note's content (tag editing is not exposed in the edit modal yet — only the inline composer creates tagged rows).
- **Bot**: `/note` command (`internal/bot/note_commands.go`) routes through the domain service with `tag = nil` — the bot surface has no tag picker.

## MCP Server

- **Purpose**: AI-assistant access to health data, including scripted multi-step workflows
- **Transport**: Streamable HTTP (2025-03-26 spec) via `mcp.NewStreamableHTTPHandler`; legacy SSE at `/sse`
- **Authentication**: OAuth via Pocket-ID, plus long-lived `mcp_*` API tokens for non-interactive clients
- **Recommended path**: `mcp_help` (discover operations) + `mcp_execute` (run a sandboxed Python script that calls those operations through a local proxy). The helper exposes only `medtracker.api.call` / `output`; the runner env passed to the script is scrubbed of authority secrets and outbound network knobs. In the long-term `mcp-runner` side-container deployment those become enforced boundaries; in the MVP in-process executor they are operational shields and not full sandboxing — see the [MVP gap note](mcp-python-executor.md#known-mvp-gap-in-process-executor-isolation). Modes: `read_only` (default) and `write` (requires non-empty `intent`).
- **Granular tools (kept, not deprecated)**: `get_blood_pressure`, `get_weight`, `get_medication_intake`, `get_workout_history`, `get_sleep_logs`, `get_food_intake`, `get_step_history`, `get_diary_notes`, plus vitals and health-overview tools. `log_food_intake` and `workout_log` cover the write path for clients without script execution.
- **Composite analysis tools (kept for now)**:
  - `analyze_cardiovascular` — BP + meds + sleep + HR + SpO2 + notes
  - `analyze_fitness` — workouts + steps + nutrition totals + weight + notes
  - No new `analyze_*` tools are planned; cross-domain analyses are expected to move to `mcp_execute` scripts. The two existing ones will be downgraded to compatibility shims once the registry fully covers their inputs.
- **Context Notes**: all granular read tools automatically include diary notes from the queried date range. Pass `exclude_notes=true` to suppress.
- **Configuration**: separate from main bot, runs on a different port; the executor side spawns a sandboxed runner subprocess (see [mcp-deployment.md](mcp-deployment.md#python-executor-service))

See [mcp-deployment.md](mcp-deployment.md) for deployment details and [docs/mcp-python-executor.md](mcp-python-executor.md) for the executor architecture decision record.
