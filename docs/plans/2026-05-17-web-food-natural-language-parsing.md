# Web add-food modal: natural-language meal parsing

## Overview

Bring the Telegram bot's `/food <description>` LLM parsing capability to the web add-food modal so users can log meals by typing "200g grilled chicken with a cup of rice" instead of filling weight + per-100g macros by hand.

**Problem**: The web modal forces the user to know (or look up) per-100g carbs/protein/fat/calories for every food, which is the chore the bot's AI flow already eliminated. Two parallel UX paths (rich web vs minimalist bot) for the same intake.

**Solution**: Reuse the existing `domain.FoodAIService.ParseMealDescription` (already wired into the server at `server.go:55,318` for the photo path) behind a new `POST /api/food/log/from-description` endpoint that mirrors `handleCreateFoodLogFromPhoto` (`food_handlers.go:155`). In the modal, a "Parse with AI" checkbox repurposes the `#food-name` field as a multi-line meal description; on submit the frontend calls the new endpoint and receives the list of created logs (parse-and-save in one shot, matching the bot). On success, the existing `showFoodPhotoSummary` summary card (`web/static/js/features/food-photo-summary.js:96`) renders the parsed items with an Undo affordance — the same UX users already get from the photo flow.

**Integration**: Pure additive. The current manual entry path is unchanged. The new endpoint plugs into the same MCP registry pattern as the photo endpoint.

## Context (from discovery)

Files involved:
- `internal/bot/food_commands.go:74-166` — reference `/food` text flow (parse-and-save, no confirm step)
- `internal/domain/food_ai.go:13-16` — `FoodAIService.ParseMealDescription(ctx, desc) []FoodLog`
- `internal/server/server.go:55,318,662` — `s.foodAI` field, setter, photo route registration
- `internal/server/food_handlers.go:155-243` — `handleCreateFoodLogFromPhoto` (template for the new text handler)
- `internal/server/food_handlers_test.go:31,717` — `stubFoodAI` test double, photo handler test
- `internal/mcp/registry/operations_food.go` — registry entries (need `food.log.from_description`)
- `web/static/index.html:987-1080` — `#food-modal` markup (`#food-name`, `#food-weight`, macro inputs, `#food-modal-save-btn`)
- `web/static/js/features/food/log.js:370-400` — `saveFoodLog()` submit handler
- `web/static/js/features/food/photo.js:206-314` — reference end-to-end client flow (POST → `showFoodPhotoSummary` → per-item undo with retry)
- `web/static/js/features/food-photo-summary.js:96` — `showFoodPhotoSummary({ items, onUndo, autoDismissMs })` — generic summary card, reusable for the text flow as-is
- `cmd/bot/main.go` and `cmd/mcptool/main.go` — confirm `SetFoodAIService` is already called (it is, for photo)

Related patterns:
- Photo handler (`handleCreateFoodLogFromPhoto`) is the canonical parse-and-save HTTP pattern. New handler should be structurally identical: parse → loop and `CreateFoodLog` each item → return `{count, logs}`.
- `stubFoodAI` in tests already implements `ParseMealPhoto`; just extend it for `ParseMealDescription`.
- The summary card is already API-generic (no photo-specific assumptions in its props); reuse the function directly rather than forking it. The undo helper (`undoFoodPhotoLog` in `photo.js:259`) is photo-named but generic in behavior — extract it to a shared module so the text flow doesn't depend on `photo.js` loading.

Dependencies: `OPENAI_API_KEY` (existing env; no new config needed — same `FoodAIService` instance).

## Development Approach

- **Testing approach**: Regular (code first, then tests). Backend handler is a near-clone of an existing tested handler; tests model after `food_handlers_test.go:717`.
- Complete each task fully before moving on. Tests in the same task as the code they cover.
- Backend handler must hold to `domain.FoodAIService` interface — no leaks of `*ai.ParsedMeal` into the handler signature.
- Frontend: no inline `.style.` assignments; toggle visibility via a CSS class on a wrapper element (per CLAUDE.md rule 3). Reuse existing `wg-food-modal__*` tokens.
- Keep manual entry path untouched — the checkbox is opt-in. Pre-existing tests for `POST /api/food/log` must stay green.

## Testing Strategy

- **Unit tests (Go)**: new handler success + failure paths via `httptest`, using `stubFoodAI` extended with `ParseMealDescription`. Cover: happy path with multiple items, AI returns empty list (422-ish or 200 with `count:0` — match photo handler's choice), `s.foodAI == nil` (501), AI error (502 or 5xx per photo handler convention), bad JSON (400).
- **Unit tests (Vitest)**: modal behavior — checkbox toggles description mode (assert classes, not styles), submit calls new endpoint when checked vs current endpoint when unchecked, multi-item response triggers correct number of optimistic local writes via the existing sync path.
- **MCP coverage**: new route must register in `operations_food.go`; CI guard `TestMCPCoverage_AllRoutesEitherRegisteredOrExempt` will fail otherwise.

## Progress Tracking

- Mark `[x]` immediately on completion.
- New tasks discovered → `➕` prefix.
- Blockers → `⚠️` prefix.

## Implementation Steps

### Task 1: Backend handler `handleCreateFoodLogFromDescription`

- [x] Add `handleCreateFoodLogFromDescription` in `internal/server/food_handlers.go`, modeled after `handleCreateFoodLogFromPhoto` (line 155): accept `POST /api/food/log/from-description` with JSON body `{"description": string, "eaten_at": optional ISO-8601}`; require `s.foodAI != nil`; call `s.foodAI.ParseMealDescription(ctx, body.Description)`; on success, loop the returned `[]FoodLog`, persist each via the existing food store the photo handler uses, and return `{"count": N, "logs": [...]}`. Reuse error/status code conventions from the photo handler (503 if no AI, 502 on parse error, 422 on empty result, 400 on bad body).
- [x] Register route in `internal/server/server.go` next to the existing `apiMux.HandleFunc("POST /api/food/log/from-photo", ...)` at line 662: `apiMux.HandleFunc("POST /api/food/log/from-description", s.handleCreateFoodLogFromDescription)`.
- [x] Extend `stubFoodAI` in `internal/server/food_handlers_test.go` with a `ParseMealDescription` method + a configurable return slice/err, matching the existing photo pattern.
- [x] Write tests in `food_handlers_test.go`: happy path (2 parsed items → 200 + correct `count` + logs persisted), empty AI result (422), `foodAI == nil` (503), AI error path (502), malformed JSON body (400), missing description (400).
- [x] `go test ./internal/server/...` and `go test ./internal/domain/...` — handler-scope tests pass. The `TestMCPCoverage_AllRoutesEitherRegisteredOrExempt` guard fails as expected and is the gating signal for Task 2.

### Task 2: MCP registry entry

- [x] Add a new `Operation` in `internal/mcp/registry/operations_food.go` for `food.log.from_description` (POST `/api/food/log/from-description`), with description and input schema matching the handler body. Keep parity with how `food.log.from_photo` (or the existing food.log entries) is described.
- [x] Run `go test ./internal/server/... -run TestMCPCoverage` to confirm the coverage guard is satisfied without adding to `mcp_coverage_exempt.go`.
- [x] Run `go test ./internal/mcp/...` — must pass before task 3.

### Task 3: Extract shared undo helper

- [x] Move `undoFoodPhotoLog` from `web/static/js/features/food/photo.js:259` into a new shared module (e.g. `web/static/js/features/food/ai-undo.js`) and rename it `undoFoodAIItems`. Keep the existing `window.FoodPhoto.undo` symbol as a thin re-export so photo.js callers and existing tests stay green.
- [x] Add a script-tag entry for the new module in `web/static/index.html` loaded before `photo.js` (the load-order doc lives in `docs/frontend.md` — keep it consistent).
- [x] Unit-test the extracted helper directly: success path (all DELETEs OK → summary marked undone, cache invalidated), partial failure (some DELETEs fail → retry summary shown with remaining items), all DELETEs fail (error toast). Reuse fixtures from `web/static/js/tests/food.upload-photo.test.js`.
- [x] Run existing `food.upload-photo.test.js` and `food-photo-summary.test.js` — must stay green (regression guard for the rename).
- [x] `pnpm test` — must pass before task 4. (Only pre-existing TZ-environment-dependent failure in `health.dexie-hydration.test.js` remains; confirmed via `git stash` that it fails identically on the unmodified branch.)

### Task 4: Frontend modal — "Parse with AI" mode

- [x] In `web/static/index.html` `#food-modal` (around line 987-1080): add a checkbox `<input type="checkbox" id="food-parse-ai">` with label "Parse my meal from a description" near the top of the body, plus a wrapper class (e.g. `wg-food-modal--ai-mode`) toggled on the modal root.
- [x] In `web/static/css/` food-modal stylesheet, add `.wg-food-modal--ai-mode` rules that: hide weight/barcode/macros/per-100g rows, change the `#food-name` label to read "Describe your meal" (use a `data-ai-label` attribute or a sibling label element rather than DOM swapping), and expand the input to a multi-line affordance (textarea-like sizing). No inline styles.
- [x] In `web/static/js/features/food/log.js` `saveFoodLog()` (line ~370): branch on `#food-parse-ai.checked`. If checked: POST `{description: nameField.value, eaten_at}` to `/api/food/log/from-description`; on success, call `showFoodPhotoSummary({ items: response.logs, onUndo: () => undoFoodAIItems(response.logs, summaryHandle) })` mirroring the photo flow at `photo.js:231-251`. If unchecked: existing behavior unchanged.
- [x] Invalidate the same caches the photo flow does (`cachedFetch` keys for food log / today summary) after a successful AI parse — copy the invalidation lines from `photo.js` rather than re-deriving them.
- [x] Wire checkbox change handler to toggle the wrapper class and clear/reset macro/weight values when entering AI mode so they aren't persisted from a prior open.
- [x] Ensure the existing autocomplete on `#food-name` is suppressed when AI mode is active (do not call the search endpoint with a long meal description).
- [x] No new `window.*` globals (per CLAUDE.md rule 4).
- [x] Run `pnpm test` — must pass before task 5. (Only the pre-existing TZ-environment-dependent failure in `health.dexie-hydration.test.js` remains; same failure observed before any Task 4 changes, see Task 3 progress note.)

### Task 5: Frontend tests

- [x] Vitest: extend the food modal integration suite (the existing `web/static/js/tests/food.*.test.js` that covers the modal — pick the closest feature file rather than creating a new `*-branches` file, per CLAUDE.md rule 8). Cover: checkbox off → POSTs to `/api/food/log` (current behavior, regression guard); checkbox on → POSTs to `/api/food/log/from-description` with the description body; multi-item response causes the expected number of UI rows / cache writes; checkbox toggle clears stale macro/weight values.
- [x] Vitest: after a successful AI parse, the summary card appears with the parsed items (assert via `showFoodPhotoSummary` test seam — fixture pattern in `food-photo-summary.test.js`).
- [x] Vitest: clicking Undo on that card triggers `undoFoodAIItems`, which fires the expected DELETE `/api/food/log/:id` calls per item and dismisses the summary on success.
- [x] Vitest: partial undo failure surfaces the retry affordance (mirror the photo undo retry test).
- [x] Vitest: assert the AI-mode wrapper toggles a CSS class (no inline `.style.` checks).
- [x] Run `pnpm test` — must pass before task 6. (Only the pre-existing TZ-environment-dependent failure in `health.dexie-hydration.test.js` remains; same failure observed before any Task 5 changes, see Task 3 / Task 4 progress notes.)

### Task 6: Verify acceptance criteria

- [x] Manual smoke in `go run ./cmd/bot`: open modal, check "Parse with AI", type "200g grilled chicken and a cup of rice", hit Save, confirm the summary card appears with two items, Undo removes them and updates the day total. (skipped — not automatable; covered by Vitest integration suite in Task 5)
- [x] Verify the manual entry path still works unchanged (regression). (skipped — not automatable; regression covered by existing `food.*.test.js` suites which remain green)
- [x] Verify the photo upload path still shows its summary card + undo (regression for the extraction in Task 3). (skipped — not automatable; `food.upload-photo.test.js` + `food-photo-summary.test.js` remain green)
- [x] `go test ./...` — full backend suite. (all packages pass)
- [x] `pnpm test` — full frontend suite. (204/205 files pass; only the pre-existing TZ-environment-dependent failure in `health.dexie-hydration.test.js` remains — same failure observed on master, not caused by this branch)
- [x] Lint: `go vet ./...` and whatever the frontend project runs. (`go vet ./...` clean; architecture/lint Vitest suites pass)
- [x] Re-read the new code with CLAUDE.md rules 1, 3, 4, 5, 8 in hand — fix any drift. (no drift: handler uses `domain.FoodAIService` interface; no new `.style.` in `ai-undo.js` (the 2 `.style.` lines in `log.js` are pre-existing from 2026-05-14); architecture globals/inline-styles tests pass; `slog.Error` used with contextual args; new Vitest coverage extends feature files, not coverage-driven `*-branches`)

### Task 7: Documentation

- [ ] Add a short line in `docs/features.md` under the Food section noting the new "Parse with AI" web option mirrors the bot `/food` command.
- [ ] No changes to `docs/api.md` if the project's convention is for MCP registry entries to be the source of truth for new endpoints; otherwise add the route there.

## Technical Details

**New endpoint**

```
POST /api/food/log/from-description
Content-Type: application/json

{
  "description": "200g grilled chicken with a cup of rice",
  "eaten_at": "2026-05-17T13:00:00Z"   // optional, defaults to now
}

200 OK
{
  "count": 2,
  "logs": [
    { "id": 123, "name": "Grilled chicken breast", "weight": 200, ... },
    { "id": 124, "name": "White rice (cooked)",    "weight": 158, ... }
  ]
}
```

**Status codes** (mirror photo handler):
- 400 — empty description or malformed body
- 401 — unauthenticated (standard middleware)
- 501 — AI service not configured (`s.foodAI == nil`)
- 502 / 500 — AI parse failure

**Frontend state**:
- Checkbox `#food-parse-ai` (default off)
- When on: `.wg-food-modal--ai-mode` on modal root → CSS hides macros/weight/barcode/per-100g; label for `#food-name` switches to "Describe your meal"; save button posts to new endpoint
- When off: identical to today

**Why reuse `#food-name` instead of a separate textarea**: matches the user's stated preference, keeps the modal layout stable, and avoids introducing a new field that has to be reset/cleared across open cycles.

## Post-Completion

**Manual verification**:
- Test on a real Telegram Mini App device — confirm the multi-line input is usable on iOS keyboard (the existing modal already has mobile-keyboard tuning; verify nothing regresses).
- Test with an `OPENAI_API_KEY` that's missing/invalid to confirm the 501/502 error renders a friendly modal-level message rather than a silent failure.
- Confirm parsed items respect the user's current timezone (the `eaten_at` default-to-now path should use the same UTC normalization as `POST /api/food/log`).

**External / deployment**:
- No new env vars. Production needs `OPENAI_API_KEY` set (already a prerequisite for photo parsing).
- MCP clients calling `food.log.from_description` will gain it after the registry update ships.
