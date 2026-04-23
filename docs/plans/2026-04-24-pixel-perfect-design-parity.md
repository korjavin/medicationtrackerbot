# Pixel-Perfect Design Parity with Anthropic Mockup

## Design reference bundle — READ THIS FIRST (AGENT)

The mockup is at **`.local/design-reference/`** in the local working copy. This path is **git-ignored** and must stay that way — the bundle contains personal medical data (real medication names, BP/weight logs, screenshots of a production user's data).

**Use it read-only**:
- Read `project/Medtracker.html`, `project/screens.jsx`, `project/components.jsx`, `project/settings.jsx`, `project/styles.css`, `project/tokens.css` for structural / visual reference while implementing each task.
- Skim `chats/chat1.md` through `chats/chat7.md` for the "why" behind each design decision — they are the design iterations between the user and the Claude Design assistant.
- `project/uploads/` contains screenshots of our own prod app (the user's critique targets); open them only if you need to see what the mockup was reacting to.

**Never**:
- Commit any file under `.local/`.
- Paste fixture data (med names, BP numbers, weight values, food names) from `project/data.js` into our codebase — it is synthetic-ish but reflects real patient patterns. Use generic test fixtures we already have in `web/static/js/tests/`.
- Copy the uploaded screenshots into `docs/` or anywhere that ends up tracked.

If `.local/design-reference/` is missing on the machine you are running on, stop and ask the user to restore it — do not try to refetch the Claude Design URL (the bundle arrives as gzipped tar and requires decompression).

## Overview
Bring the web frontend into pixel-perfect alignment with the Anthropic-exported Claude Design mockup (`Medtracker.html` + `screens.jsx` + `settings.jsx` + `styles.css`). The mockup is the **source of truth** for layout, typography, button placement, and visual hierarchy across every screen.

Six themes from the user's request:
1. **Refactor Today/home page** — 3 shortcut tiles (Log food / Add BP / Add weight) + 2-tile metric grid (BP + Weight only) + food macro card + workout/sleep row + meds card at bottom (no sun-yellow highlight). Each shortcut tile opens the corresponding **existing styled modal directly** (not a screen navigation), per the design's `Medtracker.html:75` behaviour. The meds-card "Take" button opens `#med-confirm-modal`.
2. **Refactor Food section** — drop outer tab bar; move Daily/Weekly into macros card; move +Add inline with day navigator.
3. **Tag for notes (new feature)** — 6-chip tag selector in the composer (SLEEP / STRESS / HR / SPO2 / STEPS / NOTE); tag pill on each listed note. Backend schema change.
4. **Moving buttons** — Primary +Add/+Log/+Take/+Start moves inline with tab strip or day nav on every feature screen (BP, Food, Meds, Workouts, Weight). No FAB, no bottom CTA dock.
5. **Titles and navigation** — Remove all `section-header-mount` renders; every screen sits directly on the teal stage; bottom nav active pill is the sole screen indicator.
6. **Bottom nav** — Reorder and rename per mockup: row 1 Today/BP/Food/Meds; row 2 **Vitals**/Workouts/Weight/Settings. Internal id stays `health` (don't rename the route to avoid breaking deeplinks); only the label changes to "Vitals".

## Context (from discovery)
**Design mockup** (read in full): `.local/design-reference/project/` — `Medtracker.html`, `screens.jsx` (1709 lines, all screen components), `settings.jsx`, `components.jsx` (icons + charts + BottomNav), `styles.css`, `tokens.css`, `data.js` (synthetic fixtures, not consumed).

**Current frontend**:
- `web/static/index.html` (1406 lines) — static shell with `view`-class divs per screen and `section-header-mount` divs that inject Wandergeek headers.
- `web/static/css/styles.css` (8809 lines) — Wandergeek tokens + per-feature styles.
- `web/static/js/features/` — `today.js`, `bp.js`, `food.js`, `meds.js`, `weight.js`, `workout.js`, `health.js`, `settings.js` (one per screen; render into the `view` divs).
- `web/static/js/components/` — `section-header.js`, `wg-bottom-nav.js`, chart primitives, `wg-settings.js`, `mt-elements.js`.

**Key discrepancies catalogued**:
- `index.html:45,114,124,136,186,267,295` — 7 `section-header-mount` elements; all must be removed (or kept as empty placeholders only for sticky-positioning fallback if styles depend on them).
- `index.html:115` — BP: `<button id="add-bp-btn" class="wg-fab ...">+ Record BP</button>` is a FAB.
- `index.html:130` — Weight: `#add-weight-btn` sits at the bottom of the list.
- `index.html:70` — Meds: `#add-btn` sits below the schedule list.
- `index.html:151` — Workouts: `#start-adhoc-workout-btn` uses old `.btn` classes, not inline.
- `index.html:187-191` — Food has a "Day | Week" pipe text-link row.
- `index.html:194-198` — Food has outer `.wg-food-subtabs` with 3 tabs; design removes this.
- `index.html:281-290` — Health Notes composer has only textarea + Save button; design has tag chips + char count + "+ Add note".
- `js/components/wg-bottom-nav.js:22-31` — `DEFAULT_ITEMS` order is today / bp / food / meds / weight / workouts / health / settings. Design wants today / bp / food / meds (row 1), hr(Vitals) / workouts / weight / settings (row 2). Mainly the 'health' slot needs to move to position 5 and its label changed to "Vitals".
- `js/features/food.js:4` — `FOOD_SUBTAB_OPTIONS = ['log','meals','fooddb']`; design collapses to single view.
- `js/features/meds.js:14` — default subtab is `'schedule'`; design wants `'history'` first.

**Modals already in place** — verified in `index.html`. Do NOT rebuild these; only audit against the mockup for small deltas (header eyebrow copy, button widths, input padding):
- `#food-modal` (line 845, class `wg-food-modal`) — has Weight(g) + Barcode row, Food name, Macros per-100g section, Carbs/Protein/Fat row, Total calories, Date & time, Cancel / Save entry — already matches the design layout in `screens.jsx:402-486`. One minor delta: current has an extra "Values are per 100g" checkbox (line 922-925) that the mockup omits; keep it (functional) but de-emphasise styling if it misaligns.
- `#food-scanner-modal` (line 953) — camera video + "Use Photo" + "Close". Used by the Scan button in `#food-modal`. **Must keep working across the food refactor.**
- `#food-product-modal` (line 966), `#food-save-meal-modal` (line 1013) — Food DB / my-meals flows; may get re-homed when the outer Food tabs are dropped in Task 4, but markup itself stays.
- `#med-modal` (line 1032, class `wg-meds-modal`), `#med-confirm-modal` (line 1318) — medication edit + take-confirm.
- `#bp-modal` (line 1180), `#weight-modal` (line 1232, class `wg-weight-modal`), `#note-modal` (line 1287, class `wg-health-modal`) — already wg-modal styled.
- Workout modals (group / variant / exercise / library / miband / session / add-exercise / start) — out of scope for this plan except for confirming the +Start button rewiring.

**Barcode scan flow** — IDs the planned food refactor must leave intact:
- `#food-barcode` (input), `#food-scan-btn` (button), `#food-scanner-modal`, `#food-scanner-video`, `#food-scanner-use-photo-btn`, `#food-scanner-close-btn`, `#food-scanner-status`.
- Event bindings: `js/features/food.js:151` (`openFoodScannerModal`), `:150` (`onFoodBarcodeChange`), `:160-161` (photo/close). The Task 4 changes touch the outer food-view layout and the macros card only — the modal markup and these binds are NOT modified.

**Today shortcut → modal call sites** (enumerated for Task 3):
- **Log food** → the existing `showFoodModal({isNew:true})` / equivalent — grep `js/features/food.js` for the opener that the current "+ Add" food button uses (`bindClick` in `bindFoodControls`). Reuse the exact same opener.
- **Add BP** → the opener wired to `#add-bp-btn` today (`js/features/bp.js`, search for `showAddBpModal` or similar). Reuse.
- **Add weight** → the opener wired to `#add-weight-btn` today (`js/features/weight.js`). Reuse.
- None of these require new modal code.

**Backend** (for notes tagging, task 6):
- `internal/store/` — note storage lives in a migration (search for `notes` in `internal/store/migrations/`). Need a new migration to add `tag` column (nullable, default null; existing rows get null).
- `internal/server/` — notes GET/POST handlers need to accept and return `tag`.
- `internal/domain/` — if a notes domain service exists, extend it; otherwise follow the domain-service pattern.

## Development Approach
- **Testing approach**: Regular (code first, tests after). Rationale: most of this work is DOM/CSS rearrangement — tests exist as architecture-level guards (`tests/architecture.*.test.js`) and per-feature unit/characterization tests; keeping them passing is enough. TDD for the notes-tag backend change (migration + store method + handler) because that touches data model.
- Complete each task fully before moving to the next.
- Small focused changes; run `go test ./...` + `pnpm test` after each task.
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task.
  - Frontend: update characterization/jsdom tests (`web/static/js/tests/` via Vitest) when DOM structure changes.
  - Backend: unit tests for store methods, handlers, migrations.
  - Architecture tests (`tests/architecture.*.test.js`) must stay green — they enforce the no-inline-styles / no-hardcoded-colors / globals-allowlist rules.
- **CRITICAL: all tests must pass before starting next task**.
- **CRITICAL: update this plan file when scope changes**.
- Maintain backward compatibility for URL routes (keep `health` as the `view` id and storage key; label swap only).
- Keep CSS-token discipline: no new hardcoded hex values; every new rule uses `--wg-*` tokens already defined in `tokens.css` or `styles.css:root`. See CLAUDE.md Critical Rule #3.

## Testing Strategy
- **Unit tests** (required every task): Vitest/jsdom for DOM structure; Go tests for backend.
- **Architecture tests**: `tests/architecture.globals.test.js`, `tests/architecture.no-inline-styles.test.js`, `tests/architecture.no-hardcoded-colors.test.js` — must stay green across every task.
- **E2E**: project uses Playwright specs under `tests/e2e/` (if present) — check and update screen-level snapshots for today/food/health when layout changes land.
- **Manual check after each UI-touching task**: `go run ./cmd/bot`, open the mini-app in browser (dev server mode), verify the screen matches the mockup at 390 px. Cannot claim UI task done without this.

## Progress Tracking
- Mark completed items with `[x]` as soon as done.
- Add new tasks with ➕ prefix.
- Document blockers with ⚠️.
- Update plan on scope drift.

## What Goes Where
- **Implementation Steps** (checkboxes): code + tests + docs changes inside this repo.
- **Post-Completion** (no checkboxes): manual design comparison, Telegram Mini App smoke, deployment.

## Implementation Steps

### Task 1: Remove section headers from every screen
Rationale: Design shows no top title on any screen. All 7 `section-header-mount` divs render titles + back buttons that the mockup doesn't have.
- [ ] Remove the 7 `<div class="section-header-mount" data-title="…">` elements from `web/static/index.html` at lines 45, 114, 124, 136, 186, 267, 295.
- [ ] Delete `web/static/js/components/section-header.js` and its `<script>` tag in `index.html:1367` — it has no remaining callers.
- [ ] Remove any CSS rules in `web/static/css/styles.css` that target `.section-header` / `.wg-app-header` only (grep for them; keep rules that are shared with other primitives).
- [ ] Remove/update characterization tests in `web/static/js/tests/` that assert on `.section-header` / `.wg-app-header` DOM presence.
- [ ] Update `tests/architecture.*.test.js` to drop any assertions about the section-header component.
- [ ] Run `pnpm test` and `go test ./...` — all green before next task.

### Task 2: Reorder & relabel bottom nav (row 1: Today/BP/Food/Meds — row 2: Vitals/Workouts/Weight/Settings)
- [ ] In `web/static/js/components/wg-bottom-nav.js`, reorder `DEFAULT_ITEMS` at lines 22-31 to: today, bp, food, meds, **health (label:"Vitals")**, workouts, weight, settings.
- [ ] Keep the internal id as `'health'` (route + storage key stability); only change the `label` to `'Vitals'`.
- [ ] Verify `colsFor(8)` still yields 4 (two rows of 4). No code change expected.
- [ ] Update any feature-flag filter callers that build a subset of `DEFAULT_ITEMS` to preserve the new ordering.
- [ ] Update the Vitest test for wg-bottom-nav (look under `web/static/js/tests/`) to expect the new order & the "Vitals" label.
- [ ] Run tests.

### Task 3: Today page refactor — shortcut row + metric grid + food card + workout/sleep + meds at bottom
Rationale: Biggest visual change. Design `screens.jsx:6-112` is the exact spec.
- [ ] In `web/static/js/features/today.js`, rewrite the render path to emit the following DOM order into `#today-content`:
  1. 3-tile shortcut row (grid 1fr 1fr 1fr, gap 8px): **Log food** (icon apple) → opens food modal; **Add BP** (icon heart) → opens BP modal; **Add weight** (icon scale) → opens weight modal.
  2. 2-tile metric grid: BP tile (value/unit/status tag/sparkline, deeplinks to bp) + Weight tile (kg/delta tag/sparkline, deeplinks to weight). **Drop SpO2 and HR tiles.**
  3. Food card (clickable → food): big kcal/target mono display + % of target + 4 MiniBars (Energy / Protein / Carbs / Fat) with value/target/unit labels.
  4. Workout + Sleep row (grid 1fr 1fr): "Workout" label + name + group/time; "Sleep" label + duration + range.
  5. Meds card at **bottom**: header row (icon tile + "Next · HH:MM · in X" label + "Take" gloss-sun button); divider; vertical list of meds each with sun-dot + name + dose. **No sun-yellow background banner — plain card surface.**
- [ ] Remove greetings block, "Good afternoon", streak card, SpO2 / HR tiles if they still exist in current code.
- [ ] Wire shortcut tiles to open **existing** modals directly. Reuse whichever function `#add-bp-btn`, `#add-weight-btn`, and the current food "+Add" button already call — do NOT create new openers. Grep `js/features/bp.js`, `js/features/weight.js`, `js/features/food.js` for those handlers. Opening from Today must produce the same modal state as opening from the feature screen.
- [ ] Add/extend CSS in `web/static/css/styles.css` using existing `--wg-*` tokens for the shortcut-tile material (reuse `.wg-card` / `.wg-gloss` patterns; **no new hardcoded colors**).
- [ ] Update `today.js`'s unit tests (aggregation contract tests) — `aggregateToday()` should still return the cells for bp/weight/meds/food/workout/sleep; only the renderer changes.
- [ ] Add jsdom tests that assert: shortcut row has 3 buttons with correct icons; metric grid has exactly BP + Weight; meds card renders at the bottom.
- [ ] Run tests; manual browser check at 390 px.

### Task 4: Food screen refactor — drop outer tabs, move Daily/Weekly into macros card, move +Add inline
Rationale: Design `screens.jsx:262-382` and the user's explicit requests. Outer tabs hide features — propose path below.
- [ ] Decide scope with user (implemented as default: hide outer tabs, keep My Meals & Food DB accessible via a new small entry point on the food screen, e.g. a "Meals · Food DB" ghost-link row under the day navigator). ⚠️ This deviates slightly from the mockup (the mockup doesn't show meals/fooddb at all) — confirm before shipping.
- [ ] In `web/static/index.html`:
  - Remove the `#food-stats-period-container` "Day | Week" pipe row (lines 187-191).
  - Remove the `.wg-food-subtabs` outer tabs (lines 194-198).
  - Move the day-navigator row to the top of `#food-view` (lines 201-211) and append an inline "+Add" gloss-sun button inside it (right of the next-day chevron).
  - Inside the macros card (`#food-macros-card`, lines 216-228), add a Daily/Weekly segmented pill toggle (match the in-card design in `screens.jsx:313-329`): inset track, 2 pill buttons, sun-gradient active state.
  - Move `#food-meals-tab` and `#food-fooddb-tab` contents to a separate secondary route (reachable via the new entry point) OR hide them entirely if the user agrees.
- [ ] In `web/static/js/features/food.js`:
  - Remove `FOOD_SUBTAB_*` constants + `switchFoodTab` + the tab-group bind at lines 165-169.
  - Add Daily/Weekly toggle logic: recompute totals and targets (×7 for Weekly), re-render the macro bars; show "avg N kcal/day · 7d" subtitle only in weekly mode.
  - Keep the per-meal "Snack · HH:MM" section label using the **daily** (not weekly) total.
  - Keep `renderFoodDayNavIcons()` working with the new inline +Add button.
- [ ] Update CSS: remove rules for `.wg-food-subtabs*` and `.food-stats-period-*` (or keep the base class and change only the markup). Add in-card toggle styles under `.wg-food-macros-card` using tokens.
- [ ] **Barcode-scan regression guard**: confirm `#food-modal` markup (line 845+ of `index.html`) and all barcode IDs (`#food-barcode`, `#food-scan-btn`, `#food-scanner-modal`, `#food-scanner-video`, `#food-scanner-use-photo-btn`, `#food-scanner-close-btn`) are untouched. Open the food modal, type a barcode → should trigger auto-lookup; press Scan → scanner modal opens with camera; "Use Photo" still decodes a picked image.
- [ ] Update Vitest characterization tests for food DOM.
- [ ] Run tests; manual browser check.

### Task 4b: Modal visual audit against mockup
Rationale: All primary modals already exist and are Wandergeek-styled. Audit them side-by-side with the mockup and patch small visual deltas only; do not rebuild.
- [ ] `#food-modal` vs `screens.jsx:402-486` — verify eyebrow "New entry"/"Edit entry" toggle, title "Food" (mono 18 px), Weight(g)+Barcode row ratio (1:2), Carbs/Protein/Fat row, Total calories (18 px input), Cancel/Save button ratio (1:2). The "Values are per 100g" checkbox stays (functional delta); style compactly.
- [ ] `#bp-modal` vs `screens.jsx:1638-1708` — eyebrow "New entry" + title "Blood pressure", Date & time row, Systolic / Diastolic / Pulse 3-col row (20 px font each), Notes textarea, Cancel/Save 1:2.
- [ ] `#weight-modal` vs `screens.jsx:1135-1208` — eyebrow + "Weight" title, Date & time, Weight input (20 px) + kg/lb segmented toggle (sun-gradient active), Notes textarea, Cancel/Save 1:2.
- [ ] `#med-confirm-modal` (Take meds) vs `screens.jsx:637-704` — "Time for meds" caps eyebrow in sun, "Scheduled HH:MM" mono 22 px title, N medications subline, checkbox-style rows (green highlight when selected, dark inset when not, green check icon), "Snooze 10m" + "Skip" buttons row, "Confirm selected" full-width sun button.
- [ ] `#med-modal` (edit med) — this one is not in the mockup; keep current Wandergeek styling as-is, just ensure the input insets / action buttons match the shared modal vocabulary.
- [ ] `#note-modal` — may be unused after Task 7 (composer is inline); if unused, hide or remove. If kept for editing notes, align with the shared modal vocabulary.
- [ ] Patch only via CSS (no inline styles, no new hex colors — use `--wg-*` tokens).
- [ ] Update Vitest modal characterization tests if structure shifted.
- [ ] Run tests; manual open/close of each modal.

### Task 5: Button-placement sweep — inline top-right on BP, Meds, Weight, Workouts
Rationale: Design puts primary action inline with the tab strip or day navigator, right-aligned. Current FAB / bottom CTAs violate this.
- [ ] **BP** (`index.html:115` + `js/features/bp.js`):
  - Remove `#add-bp-btn.wg-fab` floating button.
  - Render a new `#add-bp-btn` inside the `#bp-range-selector` row (14d / 30d / 60d tabs), right-aligned, styled as `wg-gloss wg-gloss--sun` with a + icon and "Log" label. Match `screens.jsx:210-212`.
- [ ] **Meds** (`index.html:70` + `js/features/meds.js`):
  - Remove `#add-btn` from the bottom of the schedule tab.
  - Render a new `#add-btn` (keep the id) inside the subtabs strip at `index.html:51-55`, right-aligned next to the tabs, `wg-gloss--sun` with a + icon and "Add" label.
  - Also change default subtab from `'schedule'` to `'history'` in `js/features/meds.js:14` to match the design order. Swap the `data-tab` active state in the HTML so History carries `.wg-gloss--sun` by default.
- [ ] **Weight** (`index.html:130-132` + `js/features/weight.js`):
  - Remove the bottom `#add-weight-btn`.
  - Render a new header row at the top of `#weight-view`: left side shows "LATEST" caps label + big mono 32px weight + "kg" + delta; right side is the new inline `#add-weight-btn` `wg-gloss--sun` "+ Log" button. Match `screens.jsx:1066-1083`.
  - Move the `#weight-range-selector` below the chart (or hide it — design doesn't show one; decide based on whether it is currently used and the user's preference).
- [ ] **Workouts** (`index.html:151` + `js/features/workout.js`):
  - Remove `#start-adhoc-workout-btn` ad-hoc button from the history tab.
  - Render a new `#start-adhoc-workout-btn` inline with the subtabs strip (line 139-144), right-aligned, `wg-gloss--sun` with + icon + "Start" label.
- [ ] Update CSS: remove `.wg-fab`-specific positioning rules if no other caller uses them; grep first.
- [ ] Update characterization tests for each feature's DOM.
- [ ] Run tests; browser check at 390 px.

### Task 6: Notes tagging — backend (migration + store + handler + domain)
Rationale: New column in the notes table, new API contract. Do TDD here because it touches the data model.
- [ ] Identify the notes table/store in `internal/store/` (grep for `health_notes` / `notes`). Add a new goose migration in `internal/store/migrations/` that adds a nullable `tag TEXT` column with default null.
- [ ] Add store methods (or extend existing) to accept/return `Tag` field. Write unit tests first (TDD) covering: create with tag, create without tag, update tag, list returns tag.
- [ ] Extend/create a domain service in `internal/domain/` (per the mandatory service pattern) — e.g. `HealthNotesService` with `CreateNote(ctx, userID, text, tag)` and `ListNotes(ctx, userID, limit)`. Write service-layer tests first.
- [ ] Update HTTP handler in `internal/server/` to accept `tag` in POST body (validate against the 6-value enum: `SLEEP|STRESS|HR|SPO2|STEPS|NOTE`, or `null`) and to include `tag` in GET responses.
- [ ] Update any bot callback that touches notes (grep `internal/bot/*notes*`) — bot must also call the new domain service.
- [ ] Run `go test ./...` — green before moving on.

### Task 7: Notes tagging — frontend composer with tag chips
- [ ] In `web/static/index.html` (`#health-notes-tab`, lines 280-291), replace the compose block with:
  - Wrapper card (`.wg-card` + `.wg-health-notes-compose`) containing:
    - Header row: "New note" mono label (left) + horizontally-scrollable tag-chip strip (right) with 6 buttons SLEEP / STRESS / HR / SPO2 / STEPS / NOTE; active chip carries `.wg-tag--sun` (define in CSS using existing sun-yellow tokens).
    - Textarea (`#notes-textarea`) with placeholder "How are you feeling? What did you notice?".
    - Footer row: char-count span (`{N} chars` / `empty`) left + `#notes-save-btn` `wg-gloss--sun` "+ Add note" right.
- [ ] In `web/static/js/features/health.js`:
  - Track composer state (`text`, `selectedTag`) in a scoped object.
  - On chip click, update active class + state.
  - On submit, POST to the notes endpoint with `{text, tag}`; on success, clear composer, prepend to list.
  - In the notes list render, add a tag pill (from the current `.wg-tag` family, coloured by tag) above or beside the timestamp, matching `screens.jsx:1427-1434`.
- [ ] Update CSS for `.wg-tag--sun` (active chip) + the new composer layout using only `--wg-*` tokens.
- [ ] Add jsdom tests: chip selection state, submit payload includes tag, list row shows tag pill.
- [ ] Run tests; manual check in browser.

### Task 8: Typography & spacing pixel-match sweep
Rationale: Several small discrepancies may still exist (font sizes, paddings, letter-spacings). Design uses JetBrains Mono for displays, Space Grotesk for UI, exact pixel sizes.
- [ ] Walk through each screen next to the mockup at 390 px and note residual deltas: card padding (design uses 10-14 px), section-label padding (12/4/6 compact), typography sizes in the macros card (30 px kcal), metric grid font sizes (20 px mono).
- [ ] Patch only via CSS utility classes / existing tokens; no inline styles; no new hex colors.
- [ ] Run architecture tests — they enforce these invariants.

### Task 9: Verify acceptance criteria
- [ ] Each screen visually matches the mockup at 390 px (manual).
- [ ] No `section-header-mount` renders anywhere.
- [ ] Bottom nav order + "Vitals" label correct.
- [ ] Today page shows 3 shortcut tiles + 2 metric tiles (no SpO2/HR) + food card + workout/sleep row + meds card at bottom.
- [ ] Food page has no outer tabs, no "Day | Week" pipe, Daily/Weekly in-card toggle works, +Add inline with day nav.
- [ ] BP, Meds, Weight, Workouts all have their primary action button inline (no FAB, no bottom CTA).
- [ ] Notes composer has 6-chip tag selector and the tag persists through save → list render.
- [ ] **Barcode scan & search unchanged**: open `#food-modal` → type a barcode → auto-lookup fires; press Scan → `#food-scanner-modal` opens with camera; "Use Photo" decodes a picked image; typing in Food name still triggers autocomplete.
- [ ] Each pre-existing styled modal (`#food-modal`, `#bp-modal`, `#weight-modal`, `#med-modal`, `#med-confirm-modal`) opens, saves, and closes without regression; Today shortcuts open the same modal states as the feature screens do.
- [ ] All unit + architecture + jsdom tests pass.
- [ ] `go test ./...` green.
- [ ] Linter clean.
- [ ] Deeplinks still work (old `/today`, `/health`, `/food` routes resolve).

### Task 10: Update documentation
- [ ] Update `CLAUDE.md` Critical Rule #6 ("The bottom nav is the canonical navigation") — it already says the disabled features are filtered before mount; confirm phrasing still matches after the reorder.
- [ ] Update `docs/frontend.md` navigation section to reflect the new row 1 / row 2 split and the "Vitals" label.
- [ ] Update `docs/features.md` Today / Food / Health sections for the structural refactors.
- [ ] Update `docs/api.md` for the new `tag` field on notes endpoints.
- [ ] No screenshots unless requested.

## Technical Details

### Bottom-nav canonical order (final)
```
row 1: today, bp, food, meds
row 2: health(label="Vitals"), workouts, weight, settings
```
Internal ids unchanged (`health`, not `hr`) to preserve deeplinks & localStorage keys.

### Today DOM skeleton (target)
```html
<div id="today-content">
  <div class="wg-today-shortcuts">[3 ShortcutTile]</div>
  <div class="wg-today-metrics">[BP tile][Weight tile]</div>
  <button class="wg-card wg-today-food">[food summary + 4 MiniBars]</button>
  <div class="wg-today-wo-sleep">[Workout card][Sleep card]</div>
  <div class="wg-card wg-today-meds">[header row][divider][meds list]</div>
</div>
```

### Food macros card Daily/Weekly toggle (inside the card)
```
[ Daily total | Weekly total ]   (inset pill strip, sun-gradient active)
   1,250          8,750
   (68% target)    (av 1,250 kcal/day · 7d)
```

### Notes tag enum (frontend ↔ backend)
```
SLEEP | STRESS | HR | SPO2 | STEPS | NOTE
```
Backend stores NULL when the client omits the tag or sends an invalid value (handler maps invalid → NULL and returns 200 with the sanitized record, not a 400).

## Post-Completion
*Manual / external items — no checkboxes.*

**Manual verification**:
- Open the Mini App through the Telegram bot on a real iPhone (notch/island visible) and step through every screen. Compare to the mockup.
- Confirm offline banners still render above the new today shortcut row.
- Confirm tag-chip horizontal scroll works on narrow (≤360 px) devices.

**External system updates**:
- None. Pure app-internal refactor + one backward-compatible DB migration.

**Deployment**:
- Standard GitHub-Actions → Portainer rebuild. Confirm the goose migration runs on deploy (logs in Portainer).
- Bump cache-buster timestamps for the touched JS files so SW serves fresh code.
