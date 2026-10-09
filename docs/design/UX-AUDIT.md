# UX audit — design re-sync (2026-10)

Input for the Claude Design redesign. The original look is the Wandergeek handoff (`docs/design/DESIGN.md`, Claude Design project `medtrackerbot`). Since then the app gained Journey/Goal Line, workout depth (plans, per-set logging, equipment, stats), food DB/photo/scan, meds inventory, Vitals notes, targets, AI integrations, and the cloud vault (devices, connectors, backup). Almost none of that was designed — it was built screen by screen. Full inventory: `CAPABILITIES.md`. Screenshots: `current/screenshots/` (real data, mobile, `NN-<screen>.png`).

## Pain points

**P1 — No shared primitives.** Three button families coexist: Wandergeek gloss, old Bootstrap (`btn btn-sm`: blue "Weigh in" on Goal Line, white list buttons in Journey "This week"), and plain cloud-shell buttons. Modal headers exist under ~20 class names. Row actions are sometimes square icon buttons (BP, Food log, Workouts), sometimes emoji ✏️🗑 (Food DB, Meds schedule). Status uses emoji (✅ Taken, ⚠️ Low stock). Shots 01, 02, 06, 08, 32.

**P2 — Today is a wall.** Seven quick-action tiles take the first screen, then BP/Weight tiles, then the Goal Line as ~10 lines of prose, then kcal, workout/sleep, next meds at the very bottom (and "41m3 medications" — missing space). The most time-sensitive thing (meds due, workout today) is last. Shots 01, 31.

**P3 — Goal Line / Journey read as text dumps.** Numbers are sentences ("0.0 of 23.4 kg since you set the goal · next marker 132.4 kg"), the progress bar is empty-looking, and the weekly plan choice is a stack of unstyled buttons. The spine of gamification has no visual form. Shots 01, 02.

**P4 — Modal on modal.** Workout session, plan editor and med editor are modals carrying whole apps. Edit Plan → Edit Day → Edit Exercise stacks three sheets with three Cancel/Save headers (16, 17). The med editor is ~15 fields in one sheet (09). A stale "Add exercise" modal stays over the Equipment tab after leaving the session — a bug (21).

**P5 — Set logging is cramped.** Each set row is four tiny boxed inputs (Weight / Reps / RPE / Type) plus a floating "×"; STATUS renders like an input; "Not yet logged — edit to include" is unclear; the plate calculator line is unreadable. This is the screen used mid-workout with sweaty hands. Shots 14, 15, 19, 20.

**P6 — Food entry is form-first.** "Add food" opens a manual macro form (C / P / F placeholders, an unlabeled checkbox for "parse from description", a stray "values are per 100g" checkbox). Search DB / scan / photo / describe — the fast paths — are separate buttons outside the modal. Long names truncate in the log. Shots 04, 05, 06.

**P7 — Settings outgrew its layout.** 13 "Feature: …" toggles in one list, Integrations card nested inside the Integrations group, a raw blue "more info" link, native file inputs for backup and Mi Band import, two separate "Save Targets" buttons, Mi Band import hidden in Backup instead of Vitals. Shots 25–28, 36–39.

**P8 — Cloud pages are a different app.** Devices and Connectors use system font, flat layout, every button the same yellow (Revoke = Back = Disconnect), no app chrome or bottom nav. Shots 29, 30.

**P9 — States and semantics.** Negative stock shown as "-17 LEFT"; BP "High-normal · stale" vs "Normal" chips are inconsistent with Vitals/Weight; missing empty states (BP list, Weight list, Meds schedule); sync pending/failed tags only on some lists; Vitals sleep chart HR labels overlap. Shots 03, 08, 10.

**What works and should stay:** the Wandergeek palette and type (dark teal, sun-yellow primary, JetBrains Mono numerals), BP chart and range pills, Vitals overview tiles, Upcoming meds list (33), Workouts Stats balance bars (23), the 8-slot bottom nav.

## Options

**A — Polish.** Define the missing primitives (button hierarchy, one modal/sheet header, list row with actions, status chip, empty state, toast, section/group), replace emoji with icons, fix the bugs. IA unchanged. Cheapest; leaves P2–P6 structurally the same.

**B — Polish + rework the heavy flows (chosen).** A, plus:
- Today reorganized around *now*: "Next up" (meds due → Take, workout today → Start) first, compact vitals strip, Goal Line as a visual card; quick-log actions collapse into one row or a "+" sheet.
- Goal Line / Journey get a real visual language (progress track with markers, weekly scorecard, plan choice as selectable chips).
- Workout session becomes a full-screen focused takeover (own top bar, progress, big set rows with previous values ghosted, tap-to-complete set, rest timer slot); the plan editor becomes pushed pages (Plan → Day → Exercise) instead of stacked modals.
- Food "+" opens a single sheet: search / scan / photo / describe first, manual entry as fallback.
- Med editor split into sections (basics, schedule, inventory, advanced).
- Settings becomes a grouped list → subpages (Features, Targets, AI & integrations, Devices & connectors, Backup & import, Account & privacy); cloud pages adopt the app chrome.

**C — B + navigation change.** Collapse the 8 slots to 5 (e.g. Today / Log / Meds / Progress / Me) with a global "+". The fixed-nav rule was revoked by the owner (2026-10-09), so navigation is open.

## Ask for Claude Design (option B)

Deliver an **App UI kit v2** in the `medtrackerbot` project, mobile-first 390×844, dark only:
1. Foundations: keep Wandergeek tokens; add semantic tokens for status (ok / warn / danger / stale / pending-sync) and a button hierarchy (primary / secondary / ghost / destructive / icon).
2. Components: sheet/modal header, pushed sub-page header, list row with trailing actions (and a swipe or overflow alternative to two square buttons), status chip, empty state, toast, confirm dialog, segmented control, settings row (toggle / value / chevron), file picker, set row.
3. Screens with real-ish data and their empty/loading/offline states: Today, Journey, Food log + add sheet, Meds (schedule, take, edit), Workout session takeover, Plan editor pages, Settings home + 2 subpages, Devices/Connectors inside the shell.
4. Constraints: vanilla JS + CSS classes on `--wg-*` tokens (no framework, no inline styles), icons not emoji, no native browser dialogs, action buttons reachable above the mobile keyboard. Navigation is not frozen: propose a better structure than the 8-slot two-row bottom nav if one exists (show it next to the current one), keeping every section reachable.
