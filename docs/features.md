# Feature Implementation Patterns

## Today Dashboard

Read-only landing surface (`web/static/js/features/today.js`, `window.TodayDashboard`). Default first tab for new users and existing users on upgrade (tab_order migration prepends `today`). Opt-out is currently dev-only: `localStorage['today_opt_out'] = '1'`.

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
| `nextWorkout` | SWR `workout_next` cache | `workouts` |
| `sleepLastNight` | SWR `health_overview.sleep_stats_7d` (most recent) | `health` |

`loadToday()` (app.js) reads these caches via `ApiCache.getWithMeta` for `settings_bundle`, `next_intake`, `bp`, `weight`, `workout_next`, `health_overview`, and today's food key (`food_YYYY-MM-DD_day`).

**Data sources**: no new backend endpoints in Phase 1 — everything reads from `/api/bootstrap` and the existing SWR caches in `data-store.js`. A Phase 2 `GET /api/today` server-side aggregate is deferred.

**Live updates**: `TodayDashboard.subscribe()` re-renders on `BOOTSTRAP_UPDATED` `postMessage` from the SW (skipped in the subscriber; the app-level handler already reloads the current tab) and on `online` / `offline` window events and `datastore:changed` CustomEvent. `isOfflineStale({ online, cacheTimestamp, now })` toggles the dashboard's offline banner when cached data exceeds 1h while offline.

**Trend arrows**: 7-day trend computed from two SWR-cached anchors (oldest within the 7-day window and most recent). Fewer than 2 usable samples → status becomes `missing`. A `flat` direction (delta within ~0.5% of the anchor magnitude) renders `7d flat` without a signed number.

## Medication Tracking

- **Smart Sorting**: Scheduled Soon (>14h) → Recently Taken → As-Needed → Archived
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
- **Export**: CSV

## Weight Tracking

- **Trend**: exponential moving average for smooth visualization
- **Export**: CSV in Libra format (compatible with Libra app)
- **Reminders**: weekly if no weight logged

## Food Tracking

- **Manual logging**: web UI (Open Food Facts search) and multi-item "Meals" templates with aggregated macros
- **`/food` Telegram command**: natural-language meal logging via AI. The AI splits complex meals into atomic items (one row per distinct food/ingredient) and normalizes dish names to common English terms regardless of input language (e.g., Russian "куриная грудка с рисом" → two items named "chicken breast" and "rice"). Each item becomes its own `food_log` row sharing the same `eaten_at` timestamp. The bot replies with a per-item breakdown plus an aggregate total. On partial failure, remaining items still persist and the reply reports "Logged N of M items".

## Workout Tracking

- **Hierarchy**: Groups → Variants → Exercises
- **Rotation**: automatic A/B/C/D progression (e.g., PPL, PHUL splits)
- **Scheduling**: configurable days of week, notification advance time (default 15 min)
- **Snooze**: 1-hour or 2-hour options
- **Logging**: exercise-by-exercise with sets, reps, weight
- **Weight/Reps Propagation**: when a user logs or edits exercise weight/reps/sets in a pending/notified/in-progress session, the new values propagate back to the `workout_exercises` schedule definition (best-effort, errors logged but don't fail the request). Only applies to exercises belonging to the session's variant — user-added and ad-hoc session exercises are excluded.
- **Prompt Batching**: at most 3 exercise prompts shown at once; remaining queued in-memory (`pendingExercises` map on Bot struct) and sent one-at-a-time as user completes/skips

### Stats API (`/api/workout/stats`)

Returns `active_weeks` (count of weeks with at least one completed session) and `total_sessions` (sum of completed and skipped). Does **not** return streak or total volume metrics.

## MCP Server

- **Purpose**: read-only access to health data for AI assistants (Claude)
- **Transport**: Streamable HTTP (2025-03-26 spec) via `mcp.NewStreamableHTTPHandler`
- **Authentication**: OAuth via Pocket-ID
- **Tools**: 13 granular tools (`get_blood_pressure`, `get_weight`, `get_medication_intake`, …) + 2 composite analysis tools
- **Composite Tools**:
  - `analyze_cardiovascular` — BP + meds + sleep + HR + SpO2 + notes
  - `analyze_fitness` — workouts + steps + nutrition totals + weight + notes
- **Context Notes**: all read tools automatically include diary notes from the queried date range. Pass `exclude_notes=true` to suppress.
- **Configuration**: separate from main bot, runs on different port

See [mcp-deployment.md](mcp-deployment.md) for deployment details.
