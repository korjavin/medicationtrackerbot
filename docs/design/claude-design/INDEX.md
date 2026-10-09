# Claude Design mirror — App UI kit v2

Read-only mirror of the approved redesign. Source: Claude Design project `medtrackerbot`
(`bcedc9b7-2339-487d-9822-f69bb7a86608`), path `ui_kits/app-v2/`. Approved by the owner 2026-10-09,
including the 5-tab navigation. Inputs: [../CAPABILITIES.md](../CAPABILITIES.md), [../UX-AUDIT.md](../UX-AUDIT.md) (option B).

Open `ui_kits/app-v2/index.html` in a browser; every page is static HTML.

## What ships vs what doesn't

| File | Ship? | Shipped in |
|------|-------|------------|
| `tokens.css`, `components.css`, `icons.js` | Yes — the `wg-*` kit. Port into `web/static/css` / `web/static/js` under existing token/architecture guards. | `tokens.css` → the first `:root` of `web/static/css/styles.css`; `components.css` → `web/static/css/components.css` (port deltas in its header); `icons.js` → `web/static/js/components/wg-icons.js` (epic med-xso6) |
| `kit.css`, `kit.js` | No — board/phone-frame presentation only. `kit.js` also shows the tab-bar markup v2 expects. | — (tab bar: `web/static/js/components/wg-bottom-nav.js`) |
| `*.html` | Spec only. Screen ids (T1, F4, M2, W1, P1, S4…) are referenced by beads. | — (screens: see the table below) |

## Kit rules (from `ui_kits/app-v2/README.md`)

1. One sun-filled control per view; selection = raised teal + sun text; `.wg-seg--accent` only for a mode switch in a sheet.
2. Forms: Cancel/Save in sheet header / page bar. Flows: primary in `.wg-sheet__foot`, docked above the keyboard (`.wg-scrim--kb`).
3. Tap row = edit; `.wg-swipe` reveals Edit/Delete; overflow menu is the pointer/keyboard fallback. Row deletes undo from a toast; record/account deletes go through `.wg-dialog`.
4. Status only via ok / warn / danger / stale / pending tokens. No emoji. Negative stock = "Out · N over".
5. No inline styles except `--p` (percent) and `--n` (count).
6. Hit targets ≥ 44px; set rows 56px.
7. No native dialogs, checkboxes, selects, date or file inputs as the visible control.

## Screen → spec → current code

| Surface | Spec | Current code |
|---------|------|--------------|
| Navigation (5 tabs: Today · Food · Meds · Train · Health; gear → Settings) | `navigation.html` | `web/static/js/components/wg-bottom-nav.js`, `features/app-nav.js`, `features/tab-controller.js`, `web/static/index.html` app bars |
| Today (Next up, Log sheet, Goal Line, call bar, tz card, first-run/offline/skeleton) | `screens-today.html` T1–T6 | `features/today.js`, `today-loader.js`, `elevenlabs-call.js`, `tz-plan-banner.js`, `brief.js` |
| Journey (pushed page) | `screens-today.html` J1–J2 | `features/journey.js` |
| Food log, Add sheet, Describe, AI review, manual | `screens-food.html` F1–F8 | `features/food/`, `food-photo-summary.js` |
| Meds schedule, take sheet, stock, editor page | `screens-meds.html` M1–M6 | `features/meds.js`, `meds-history.js`, `medication-utils.js` |
| Workout session takeover, Plan/Day/Exercise pages | `screens-workouts.html` W1–W3, P1–P3 | `features/workout/` |
| Settings home, Features, Backup, Devices & connectors | `screens-settings.html` S1–S5 | `features/settings.js`, `features/settings/`, cloud shell pages in `web/cloud/` |
| Health (BP / Weight / Vitals segments; section id `health` stays) | `navigation.html` | `features/bp.js`, `weight.js`, `health.js`, `live-hr.js` |
| Primitives (buttons, chips, rows, sheets, dialog, toast, empty, skeleton) | `foundations.html`, `components.html` | `web/static/js/components/`, `web/static/css/components.css`, `styles.css`, `dialog.css`, `core/utils.js` safe* dialogs |
