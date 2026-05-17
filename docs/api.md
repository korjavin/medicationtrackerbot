# API Endpoints

## Health Data

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/bootstrap` | All initial data in one request. Includes a `medications` array (same shape as `GET /api/medications?archived=true`) so the frontend can hydrate the meds list and Today tile without a follow-up round-trip; consumers seed both `DataStore` and Dexie via this field — see [frontend.md → Local-First Read Resilience](frontend.md#local-first-read-resilience). |
| GET | `/api/medications` | List medications |
| POST | `/api/medications` | Create medication |
| PATCH | `/api/medications/:id` | Update medication |
| POST | `/api/medications/confirm-schedule` | Confirm dose intake |
| POST | `/api/medications/log-past` | Log a past intake (returns full `IntakeLog`; routed through `MedicationService.LogMedicationAt`) |
| POST | `/api/medications/{id}/restock` | Record a restock (increments `inventory_count`, returns updated medication) |
| GET | `/api/medications/{id}/restocks` | List restock history for a medication (newest first) |
| GET | `/api/history` | Intake history (filter by `days`, `med_id`) |
| GET | `/api/medications/next-intake` | Next scheduled dose |
| GET | `/api/bp` | BP readings |
| POST | `/api/bp` | Log BP reading |
| GET | `/api/bp/stats` | BP statistics |
| GET | `/api/bp/goal` | BP goal |
| POST | `/api/bp/goal` | Set BP goal |
| GET | `/api/weight` | Weight logs |
| POST | `/api/weight` | Log weight |
| GET | `/api/weight/goal` | Weight goal |
| POST | `/api/weight/goal` | Set weight goal |
| GET | `/api/food/log` | Food log entries |
| POST | `/api/food/log` | Log food |
| GET | `/api/food/search` | Search Open Food Facts |
| GET | `/api/food/targets` | Nutrition targets |
| POST | `/api/food/targets` | Set nutrition targets |
| GET | `/api/sleep` | Sleep logs |
| POST | `/api/sleep` | Log sleep |
| GET | `/api/notes` | List diary notes (each row includes `tag` — one of `SLEEP \| STRESS \| HR \| SPO2 \| STEPS \| NOTE`, or omitted when NULL) |
| POST | `/api/notes` | Create diary note (accepts `{content, tag?}`; invalid tags are sanitized to NULL and returned in the `201` response, not rejected) |
| DELETE | `/api/notes/{id}` | Delete diary note |

## Workouts

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/workout/groups` | List workout groups |
| POST | `/api/workout/groups/create` | Create group |
| PUT | `/api/workout/groups/update` | Update group |
| GET | `/api/workout/variants` | List variants |
| POST | `/api/workout/variants/create` | Create variant |
| GET | `/api/workout/exercises` | List exercises |
| POST | `/api/workout/exercises/create` | Create exercise |
| PUT | `/api/workout/exercises/update` | Update exercise |
| DELETE | `/api/workout/exercises/delete` | Delete exercise |
| GET | `/api/workout/sessions` | Session history |
| GET | `/api/workout/sessions/details` | Session details with logs |
| POST | `/api/workout/sessions/schedule` | Schedule a one-off ad-hoc workout for a future date/time with a pre-selected exercise list. Body: `{scheduled_date: "YYYY-MM-DD", scheduled_time: "HH:MM", exercises: [{exercise_id?, exercise_name?, target_sets, target_reps_min, target_reps_max?, target_weight_kg?}, …]}`. Each exercise must supply either `exercise_id` (library id; must belong to the caller — name is filled in from the library row) or a free-form `exercise_name`. The session is created with `group_id = -1`, `variant_id = -1`, `status = "pending"` and one pending `workout_exercise_logs` row per planned exercise; the scheduler notifies at `scheduled_date + scheduled_time` in the user's TZ. Pending placeholder logs auto-promote to `status = "completed"` when the user later POSTs to `/api/workout/sessions/logs/update` with `sets_completed >= 1` (or supplies an explicit `status`). MCP-only — no web UI for creation. |
| GET | `/api/workout/stats` | 30-day statistics |
| GET | `/api/workout/rotation/state` | Current rotation position |
| POST | `/api/workout/rotation/initialize` | Initialize rotation |

## System

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/changes` | Change events since cursor (polling fallback — used when SSE is unavailable or after 3 consecutive `/api/changes/stream` errors within 30s). |
| GET | `/api/changes/stream` | Server-Sent Events stream of change cursors (primary cross-client sync transport). Auth via `?initData=…` query param since EventSource cannot set custom headers. Fans out from the process-wide `ChangeBroker` — connected clients see writes from any device (or MCP) within ~50ms. See [architecture.md → Cross-client change broadcast](architecture.md#cross-client-change-broadcast-sse--polling-fallback), [technical-decisions.md → Why SSE is primary](technical-decisions.md), and [sse-traefik.md](sse-traefik.md) for the required Traefik configuration. |
| GET | `/auth/status` | Check if session is authenticated (returns `{"authenticated": bool}`) |
| GET | `/api/settings` | User settings bundle. Returns the same shape `/api/bootstrap` embeds under `settings`. Response: `{timezone, server_time, server_timezone, weight_unit_preference, features, food_targets, bp_reminder_status, weight_reminder_status, tab_order?}`. `features` is the same map as `/api/init` / bootstrap (`food, bp, weight, medication, workout, health`). `bp_reminder_status` / `weight_reminder_status` are `null` when the request has no authenticated user. `tab_order` is omitted (not `null`) when unset so clients preserve their local fallback. The frontend's `loadSettings()` SWR fetcher always reads `timezone`, `server_time`, `server_timezone`, and `weight_unit_preference` from this endpoint; it additionally consumes `features`, `food_targets`, `bp_reminder_status`, and `weight_reminder_status` as fallbacks when the matching granular endpoint (`/api/settings/features`, `/api/food/settings/targets`, `/api/bp/reminder/status`, `/api/weight/reminder/status`) returns `null` (e.g., transient 5xx / offline). The consolidated bundle is the canonical source for future single-round-trip refreshes, so any change here must keep these slices populated. |
| POST | `/api/settings` | Update settings (accepts optional `timezone` IANA name; 400 on invalid values) |
| PATCH | `/api/settings/weight-unit` | Set the user's preferred weight unit. Accepts `{"unit":"kg"\|"lb"}`; 400 on any other value. Storage of weight logs is always kg — this only affects the input default and rendered unit in the web app and bot. The preference is also returned by `/api/bootstrap` under `settings.weight_unit_preference` (defaults to `"kg"` for new users). |
| POST | `/api/push/subscribe` | Register push subscription |
| POST | `/api/push/unsubscribe` | Remove push subscription |
| GET | `/auth/oidc/login` | OIDC login redirect |
| GET | `/auth/oidc/callback` | OIDC callback |
| GET | `/auth/google/login` | Google login redirect |
| GET | `/auth/google/callback` | Google callback |
| GET/POST | `/auth/telegram/callback` | Telegram Login Widget auth (GET: redirect flow, 302; POST: JSON callback) |
| GET | `/api/elevenlabs/signed-url` | Returns a signed conversation URL for the ElevenLabs convai widget on the Today screen. Requires `ELEVENLABS_API_KEY` + `ELEVENLABS_AGENT_ID`; 503 if either is unset. |

## MCP Bridge

These endpoints are called only by the MCP server process (`cmd/mcptool`) over the internal Docker network. Each request must carry an HMAC-SHA256 signature in `X-Signature` (hex-encoded) derived from `MCP_AUDIT_SECRET` over the raw request body. The MCP read tools query SQLite directly, but write tools route through these endpoints so the bot's domain services own all mutating writes (audit fan-out, validation, attribution).

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/mcp-audit` | Audit notification fan-out (Telegram message on tool use) |
| POST | `/api/mcp-food-log` | Log food intake on behalf of an MCP write tool |
| POST | `/api/mcp-workout-log` | Workout log dispatcher: `operation` ∈ {`log`, `get`, `delete_exercise`}. Performs fuzzy exercise-name resolution and defaults inference; idempotent upsert on `(session_id, resolved_name)`. Returns HTTP 200 with per-exercise statuses on partial success — only auth/transport errors return non-2xx. See `workout_log` tool's `operation: "help"` for the full protocol. |
| POST | `/internal/mcp/bridge` | HMAC-protected bridge for the MCP Python executor (`mcp_execute`). Body: `{operation_id, params?, body?}`; the operation must exist in the registry. Executes the underlying API route as the configured `ALLOWED_USER_ID`; identity cannot be spoofed. Response envelope: `{status, body, headers_subset, duration_ms, truncated?}`. Request body capped at 1 MB; response bodies truncated past 10 MB. See `internal/mcp/registry/` for the operation allowlist and [mcp-deployment.md](mcp-deployment.md#python-executor-service) for the full executor architecture. |
