# med-eas.72 — Cloud /activity: restore AI activity logging over Telegram

## Overview

Cloud-mode Telegram `/activity 2km bicycle` currently replies "🚧 /activity isn't
available over chat yet". Bot mode supports it: an AI parses free-text into an
activity, then logs a Mi Band manual workout. Restore this in cloud mode by
mirroring the EXISTING `/food` AI-during-drain pattern — the proven template at
`web/cloud/js/inbox-apply.js` (food case, lines 458-482).

The flow, on an UNLOCKED client at drain time (never on the relay, zero-knowledge
like `/food`):
1. `/activity <text>` is sealed raw by the relay.
2. On drain, `tgcommand.js` parses it to `{kind:'activity', text}`.
3. A pure `activityai.js` domain validates the AI-parsed shape (name + exercises
   with duration_minutes) and sums duration.
4. `aiclient.js` runs the direct-from-browser chat-completion with the user's own
   key (mirrors the food parse method).
5. `workout.js` `createMiBand` logs one `miband` record (activity_type 0, source
   'manual', deterministic recordId for re-drain idempotency).
6. The reply is edited to "✅ Logged activity: <name>."

## Context (from discovery)

Files/components involved:
- `web/domain/tgcommand.js` — `/activity` in `NOT_YET` (line 29); add `parseActivity`.
- `web/domain/activityai.js` — NEW pure module (model on `web/domain/foodai.js`).
- `web/cloud/js/aiclient.js` — add `parseActivityFromDescription` (mirror `parseMealFromDescription`, lines 308-339).
- `web/domain/workout.js` — add `createMiBand` (no create exists; only list/update/delete ~2096-2155).
- `web/cloud/js/inbox-apply.js` — add `case 'activity'` in `applyTGCommand` (mirror food case 458-482); build `activityAI` in `createInboxApplier` (where foodAI is built, 670-675); `confirmationText` branch (380-406).
- Tests: `web/cloud/js/tests/inbox-apply.test.js` (integration), NEW `web/domain/tests/activityai.test.js` (pure unit, mirror foodai test posture).

Reference shapes (mirror faithfully for parity):
- Bot AI schema: `internal/ai/openai.go:269-326` — `ActivityData{name, exercises[]{name,sets,reps,weight_kg,duration_minutes,notes}}`, `activity_data` json_schema strict, verbatim system prompt.
- Bot domain: `internal/domain/activity_ai.go` — errors on nil/no-exercises; copies name + exercises.
- Bot command: `internal/bot/activity_commands.go:62-84` — sums `duration_minutes*60`, `startMs=now`, `endMs=start+durationSec*1000`, `MiBandWorkout{ActivityType:0, Source:"manual"}`.
- Miband record shape (authoritative): `web/domain/vitals.js:462-482`.
- Helpers in workout.js: `mintNumericId` (66), `genRecordId` (75), `CLOUD_USER_ID=1` (109), `WORKOUT_RECORD_TYPES.MIBAND='miband'` (47), `toMiBandResponse` (2073).

## Development Approach
- Testing approach: Regular (code first, then tests) — extend existing integration suite.
- Frontend tests are INTEGRATION-FIRST: extend `inbox-apply.test.js` for the activity case. Add ONE pure-unit test for `activityai.js` mirroring foodai's posture. NO `*-branches`/`pin-defect`/`task-N` files.
- Every task ends with tests; all pass before the next task.

## Repo landmines (WILL trip CI)
- `web/domain/*.js` (activityai.js, workout.js, tgcommand.js) are PURE — no `window`/`document`/`fetch`/`indexedDB`/`navigator` (`web/static/js/tests/architecture.domain-purity.test.js`). The AI HTTP call lives ONLY in `web/cloud/js/aiclient.js`. (`new TextEncoder()` is allowed — foodai.js already uses it.)
- Mirror the bot's `ActivityData` schema/prompt VERBATIM so parity holds.
- Deterministic recordId `tg-<eventId>` so a re-drain overwrites, not duplicates. Also derive the numeric `id` deterministically (from `source_start_ms`, which is the stable arrival clock) so re-drain converges — mirror `vitals.js` (`id: prev ? prev.id : source_start_ms`).
- No new `window.*` globals.
- Cloud-primary: do NOT touch bot Go (only READ `activity_commands.go` / `activity_ai.go`). No new HTTP route — drain calls the domain method directly.
- The `no_api_key` / `trial_consent_required` branch in the activity case MUST mirror the food case EXACTLY (answer + ack + return, never wedge the mailbox).
- Do NOT touch `web/static/js/features/workout/*` (another executor owns med-eas.71 there). If forced to, STOP.

## Testing Strategy
- Unit: `web/domain/tests/activityai.test.js` — validation (name/exercises/duration sum, no-exercises throw).
- Integration: `web/cloud/js/tests/inbox-apply.test.js` — activity happy path (logs miband, reply text), bare `/activity` usage hint, no-api-key graceful ack, re-drain no duplicate.
- Architecture: domain-purity, globals, cloud-tokens must stay green.

## Progress Tracking
- Mark completed items `[x]` immediately.
- ➕ newly discovered tasks, ⚠️ blockers.

## Implementation Steps

### Task 1: Route /activity in tgcommand.js
- [x] Remove `'/activity'` from the `NOT_YET` set (web/domain/tgcommand.js:29). (also added to `KNOWN` so the switch reaches it)
- [x] Add `parseActivity(text)` mirroring `parseFood` (lines 89-93): keep the whole free-text remainder; bare `/activity` (empty) → `{ kind:'invalid', command:'/activity', hint:'Usage: /activity 5km morning run' }`; else `{ kind:'activity', command:'/activity', text: description }`.
- [x] Add `case '/activity': return parseActivity(text);` to the `parseCommand` switch.
- [x] Extend the tgcommand parse test (if one exists) or add cases to the owning suite: `/activity 2km bicycle` → kind 'activity' with text; bare `/activity` → kind 'invalid' with hint; assert `/activity` no longer resolves to 'unsupported'.
- [x] Run `npx vitest run` on the tgcommand + inbox-apply suites — must pass before next task.

### Task 2: New pure activityai.js domain module
- [x] Create `web/domain/activityai.js` modeled on `web/domain/foodai.js`. Export `ActivitySystemPrompt` (VERBATIM from internal/ai/openai.go:312-326) and `activitySchema` (VERBATIM JSON-schema shape from openai.go:285-308, JS object form).
- [x] Export `convertParsedActivity(parsed)`: throw `invalid('...','no_activity')` when parsed is nil / missing name; throw `invalid('...','no_exercises')` when `exercises` is empty (mirrors Go's `len(Exercises)==0` error); compute `durationSec = sum(exercise.duration_minutes||0)*60`; return `{ name, exercises, durationSec }`.
- [x] Export `createActivityAIDomain({ aiClient })` returning `parseActivityFromDescription(description)`: trim + empty guard + 4096-byte cap (mirror foodai `MAX_DESCRIPTION_BYTES`), call `aiClient.parseActivityFromDescription(trimmed)`, return `convertParsedActivity(parsed)`.
- [x] Add test (pure unit, mirror foodai test posture): stub aiClient; assert name+durationSec summed across cardio exercises; assert throw on empty exercises; assert throw on empty description. (Placed at `web/static/js/tests/activityai.test.js` — vitest's include glob only covers `web/static/js/tests/**` + `web/cloud/js/tests/**`, so a file under `web/domain/tests/` would never run.)
- [x] Run `npx vitest run` on activityai + domain-purity suites — must pass before next task.

### Task 3: aiclient.js parseActivityFromDescription
- [x] In `web/cloud/js/aiclient.js`, import `ActivitySystemPrompt, activitySchema` from `../../domain/activityai.js`.
- [x] Add `parseActivityFromDescription(description)` inside `createAIClient`, mirroring `parseMealFromDescription` (lines 308-339): same BYO-vs-trial credential/consent plumbing, `response_format` json_schema (`activity_data`, strict, activitySchema), and the response_format-rejection fenced-prompt fallback (fence instruction naming the activity JSON shape: `{"name": string, "exercises": [{"name": string, "sets": number|null, "reps": number|null, "weight_kg": number|null, "duration_minutes": number|null, "notes": string}]}`).
- [x] Add `parseActivityFromDescription` to the returned object (line ~405).
- [x] Verify no domain-purity impact (aiclient.js is under web/cloud, not web/domain — fetch is allowed there).
- [x] Run `npx vitest run` on the cloud suites — must pass before next task.

### Task 4: workout.js createMiBand
- [x] Add `createMiBand({ recordId, activityName, durationSec } = {})` to `createWorkoutDomain` (near listMiBand ~2096). Mirror `internal/bot/activity_commands.go` + `vitals.js:462-482` record shape: `startMs = now()`, `endMs = startMs + (durationSec||0)*1000`; look up an existing active record by recordId to preserve its numeric `id`, else `id = startMs` (deterministic); write a full `miband` record: `activity_type:0`, `activity_name: activityName||''`, `source_start_ms:startMs`, `source_end_ms:endMs`, `duration_sec: durationSec||0`, `distance_m:0, steps:0, calories:0, heart_rate_avg:0, spo2_avg:0, pause_ms:0, tz_offset:0`, `source:'manual'`, `user_id: CLOUD_USER_ID`, `recordId: recordId || genRecordId('miband', startMs)`, `clientTs: startMs`, `deleted:false`. Return `toMiBandResponse(record)`.
- [x] Export `createMiBand` in the domain's returned object (line ~2200).
- [x] Add integration coverage (workout-domain assertion in `cloud.shim-contract.workout-convergence.test.js`): re-calling `createMiBand` with the same recordId overwrites (one record).
- [x] Run `npx vitest run` on workout-related suites — must pass before next task.

### Task 5: inbox-apply.js activity case + wiring + confirmationText
- [x] In `applyTGCommand` params (line 429) add `activityAI` to the destructured domain bundle.
- [x] Add `case 'activity':` after the food case (~482): `try { const parsed = await activityAI.parseActivityFromDescription(intent.text); result = await workout.createMiBand({ recordId, activityName: parsed.name, durationSec: parsed.durationSec }); } catch (e) { if (e && e.code === 'no_api_key') { await reply('🔑 To log an activity by message, add an OpenAI key in Settings → Integrations (or the trial AI is unavailable right now).'); return; } if (e && e.code === 'trial_consent_required') { await reply('🔑 To log an activity by message with the trial AI, allow it first in Settings → Integrations (or add your own OpenAI key).'); return; } throw e; } break;` (mirror food case EXACTLY for the error branches).
- [x] Add `activity` branch to `confirmationText` (~401): `case 'activity': return result && result.activity_name ? \`✅ Logged activity: ${result.activity_name}.\` : '✅ Activity logged.';` (result is the toMiBandResponse). Under generic verbosity the early `return '✅ Recorded.'` still applies.
- [x] In `createInboxApplier`, build an `activityAI` domain alongside `foodAI` (670-675): reuse the same `settings`/`aiClient`; `createActivityAIDomain({ aiClient: createAIClient({ settingsDomain: settings }) })`. Add `activityAI` to the `applyTGCommand` call bundle in the TG_COMMAND branch (~719-730). Allow a test override param `activityAI: activityAIOverride` like `foodAIOverride`.
- [x] Import `createActivityAIDomain` from `../../domain/activityai.js` at top of inbox-apply.js.
- [x] Add integration tests to `inbox-apply.test.js` (extend the applyTGCommand describe block): `/activity 2km bicycle` logs one `miband` record (activity_name from stub, source 'manual', duration summed) with reply matching `/Logged activity:/`; bare `/activity` → usage hint, no record; no-api-key stub → resolves (acked), reply matching `/add an OpenAI key/`, no record; re-drain same eventId → one `miband` record. Add a `stubActivityAIClient` returning `{ name, exercises:[{duration_minutes}] }` and thread `activityAI` through `domainsFor`.
- [x] Run `npx vitest run` on inbox-apply + activityai + tgcommand + architecture (domain-purity, globals, cloud-tokens) — all green before next task.

### Task 6: Verify acceptance criteria
- [x] `/activity 2km bicycle` (drain) logs a Mi Band manual activity named per the AI parse, visible via `workout.listMiBand`, reply "✅ Logged activity: <name>". (verified by inbox-apply.test.js activity happy path)
- [x] Bare `/activity` gives a usage hint, NOT the 🚧 refusal. (inbox-apply.test.js usage-hint case)
- [x] No-API-key → graceful ack (no wedge). (inbox-apply.test.js no-api-key case)
- [x] Re-drain same event → no duplicate. (inbox-apply.test.js re-drain case + workout-convergence createMiBand assertion)
- [x] `web/domain/activityai.js` passes domain-purity; inbox-apply activity case has integration coverage. (architecture.domain-purity green; 86 inbox-apply tests pass)
- [x] Confirm NO Go change was needed (`git status`); if any Go was touched, run `go build ./...` + `go build -tags mobile ./...`. (git status: no .go changes)
- [x] Run the full relevant vitest set green (Node 20): `npx vitest run` on the cloud + domain + architecture suites. (activityai 8, inbox-apply 86, workout-convergence 2, domain-purity 21, globals 1, cloud-tokens 4 — all pass)

## Technical Details

Activity AI JSON shape (mirror openai.go exactly):
```
{ "name": string,
  "exercises": [ { "name": string, "sets": number|null, "reps": number|null,
                   "weight_kg": number|null, "duration_minutes": number|null,
                   "notes": string } ] }
```
Only `name` + summed `duration_minutes` feed the miband record (activity_type 0,
source 'manual'); the rest are parsed for parity but a manual miband row carries
no per-exercise breakdown (same as bot mode's ImportMiBand).

Miband record (authoritative, from vitals.js): recordId, clientTs, deleted, id,
activity_type, activity_name, source_start_ms, source_end_ms, duration_sec,
distance_m, steps, calories, heart_rate_avg, spo2_avg, pause_ms, tz_offset,
source, user_id.

## Post-Completion

**Manual verification** (operator, not automatable here):
- With a real OpenAI key in Settings → Integrations, send `/activity 2km bicycle`
  from Telegram to the cloud child bot; confirm the mi-band/workout history shows
  the logged activity and the reply reads "✅ Logged activity: …".
