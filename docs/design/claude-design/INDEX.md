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
   - (2026-10-23, med-tugv) When a card awaits a decision (Today's tz-plan card, T2), its confirm action is the view's one primary; everything else drops to secondary until the decision is made.
2. Forms: Cancel/Save in sheet header / page bar. Flows: primary in `.wg-sheet__foot`, docked above the keyboard (`.wg-scrim--kb`).
3. Tap row = edit; `.wg-swipe` reveals Edit/Delete; overflow menu is the pointer/keyboard fallback. Row deletes undo from a toast; record/account deletes go through `.wg-dialog`.
4. Status only via ok / warn / danger / stale / pending tokens. No emoji. Negative stock = "Out · N over".
5. No inline styles except `--p` (percent) and `--n` (count).
6. Hit targets ≥ 44px; set rows 56px.
7. No native dialogs, checkboxes, selects, date or file inputs as the visible control.
8. (v2.1) A flow's Continue lives only in `.wg-pagefoot` / `.wg-shell__foot`; persistent chrome (`.wg-exitbar`) sits at the top in normal flow and never floats over content.

## Screen → spec → current code

| Surface | Spec | Current code |
|---------|------|--------------|
| Navigation (5 tabs: Today · Food · Meds · Train · Health; gear → Settings) | `navigation.html` | `web/static/js/components/wg-bottom-nav.js`, `features/app-nav.js`, `features/tab-controller.js`, `web/static/index.html` app bars |
| Today (Next up, Log sheet, Goal Line, call bar, tz card, first-run/offline/skeleton) | `screens-today.html` T1–T6, T3b (Log sheet with five food paths, med-jp7z) | `features/today.js`, `today-loader.js`, `elevenlabs-call.js`, `tz-plan-banner.js`, `brief.js` |
| Journey (pushed page) | `screens-today.html` J1–J2 | `features/journey.js` |
| Food log, Add sheet, Describe, AI review, manual | `screens-food.html` F1–F8 | `features/food/`, `food-photo-summary.js` |
| Meds schedule, take sheet, stock, editor page | `screens-meds.html` M1–M6 | `features/meds.js`, `meds-history.js`, `medication-utils.js` |
| Workout session takeover, Plan/Day/Exercise pages | `screens-workouts.html` W1–W3, P1–P3 | `features/workout/` |
| Session equipment swap (plates-strip swap button, no-strip state, picker sheet; bead med-j6pn, brief `docs/design/briefs/session-equipment-swap.md`) | `screens-workouts.html` W4, W4b | `features/workout/sessions.js` (plates strip), `features/workout/equipment.js` (inventory, editor) |
| Settings home, Features, Backup, Devices & connectors | `screens-settings.html` S1–S5 | `features/settings.js`, `features/settings/`, cloud shell pages in `web/cloud/` |
| Health (BP / Weight / Vitals segments; section id `health` stays) | `navigation.html` | `features/bp.js`, `weight.js`, `health.js`, `live-hr.js` |
| Trackers (Today tiles, log sheet, create/edit + templates, history + strength; epic med-1vy5, brief `docs/design/briefs/trackers.md`) | `screens-trackers.html` TR1, TR1b, TR2, TR3 | `web/domain/trackers.js` (domain); `features/today.js` (card, log sheet, editor + templates, manage sheet, history page) |
| Native shell screens, iOS + Android (first run, local intro, app lock, load error, ceremony exit bar, splash hand-off) + **native token mirror** table — one design, both platforms (beads med-nt9p.41, med-w6gx.25; brief `docs/design/briefs/native-shells-and-local.md`) | `screens-native.html` N1–N6 | iOS `ios/App/App.swift` (`FirstRunView`, `LocalIntroView`, `LockView`, `LoadErrorView`), `ios/App/Shell.swift`; Android `android/app/.../MainActivity.kt` (`buildFirstRun`, `buildLocalIntro`, `buildLock`, `buildError`), splash/theme resources |
| Onboarding vault safety (loss protection + Emergency Kit on one page, first Today, notification ask in context) (med-1uuq, med-i0fj, med-1ikf, med-fhil) | `screens-onboarding.html` O1–O3 | `web/cloud/` unlock/signup wizard (loss-ack + kit steps), onboarding wizard (`WGFirstRun`), `features/meds.js` schedule editor, `features/today.js` |
| Local mode & account lifecycle (Settings home local/cloud, Backup/Move/Erase, Reminders & notifications, Account & privacy) | `screens-settings.html` S6–S9 | `features/settings.js`, `features/settings/` pages |
| Destructive / confirm dialog family (erase, delete account, merge-or-replace, replace records, move to cloud) | `screens-settings.html` D1 | `core/utils.js` safe* dialogs, `web/static/css/dialog.css` |
| AI free trial (Today card, Settings entry, consent iOS/Android) | `screens-today.html` A1 | `features/today.js`, AI & integrations settings page, trial consent flow |
| Primitives (buttons, chips, rows, sheets, dialog, toast, empty, skeleton) | `foundations.html`, `components.html` | `web/static/js/components/`, `web/static/css/components.css`, `styles.css`, `dialog.css`, `core/utils.js` safe* dialogs |
| Onboarding v3 — "just open it and use it": store install starts local with no choice screen (W1 module picker, W2 AI trial offer, W3 first Today, W4 protect-your-data nudge, W5 Sync & backup card/page + Emergency Kit offer), invite landing page (L1–L3: phone / expired / desktop QR / "Installed? Tap to continue"), incoming invite on an installed app (P3, incl. Android install-referrer first launch), "Have an invite?" sheet (F1). **Supersedes N1, N2 and the signup placement of O1.** Brief `docs/design/briefs/onboarding-v3.md` | `screens-onboarding-v3.html` W1–W5, L1–L3, P3, F1 | iOS `ios/App/App.swift` (`FirstRunView`, `LocalIntroView`), Android `MainActivity.kt` (`buildFirstRun`, `buildLocalIntro`), `web/cloud/` unlock/claim shell, `web/static` first-run (`WGFirstRun`), Settings home, `internal/cloudserver` (invite landing, AASA/assetlinks) |

## Changelog

- 2026-10-20 — **Onboarding v3, approved 2026-10-20**: `screens-onboarding-v3.html` (W1–W5, L1–L3, P3, F1), brief `docs/design/briefs/onboarding-v3.md`. No new shipped components; presentation-only additions in `kit.css` (`kit-desk`, `kit-safari`, `kit-chrome`, `kit-url`, `kit-paste`). Settings home slot ① becomes **Sync & backup**; the local-mode "Move to a cloud account" row folds into turning on sync. Designer's review added: nudge triggers at 20 records or 7 days, whichever first (×=remind in 14 days, stops after 2nd dismissal); W2 trial offer shows only if Food was picked; W1 Skip = all modules on; keep one plain "the server can't read it" line; L1 copies a short invite code so iOS F1 (system paste control, no prompt) recovers a lost hand-off; new states: used/expired invite (L1 · expired), invite into an account with records (D1 merge/replace after sign-in), invite while syncing to another account (needs a "Switch account?" D1 dialog — not drawn), Android without install referrer falls back to F1. Open product question: store users can't turn on sync without an invite (self-serve sign-up / request-an-invite undecided). Also: F4 Add sheet gains the Library tile (4 actions). `tokens.css` kept at the repo version (`--wg-sun-ink`, code-side addition).
- 2026-10-20 — **v2.1, approved 2026-10-20**: native shells N1–N6 (+ native token mirror), onboarding O1–O3, Settings S6–S9, dialog family D1, AI trial A1; brief `docs/design/briefs/native-shells-and-local.md`, inputs `../CAPABILITIES.md` ("Since the 2026-10 kit (v2)"). New components in `components.css`/`components.html` (v2.1 section): `wg-mark`, `wg-shell`, `wg-pagefoot`, `wg-exitbar`, `wg-or`, `wg-inputrow`, `wg-note`, `wg-facts`, `wg-olist`, `wg-disc`, `wg-kv`, `wg-qr`, `wg-fname`, `wg-notif`; `.wg-dialog__facts/__confirm/__icon--info`, `.wg-pagebar--long`. Light-theme draft removed from the kit (app stays dark-only). Designer answers to the brief's open questions: Android native screens always dark (theme pinned, no DayNight); lock screen shows the app mark, never the account name; "I saved it" without a download keeps a Settings reminder until the kit is saved.

- 2026-10-10 — **W1 revision, approved 2026-10-10**: Finish moves to the session top bar and the footer keeps Previous/Next (med-t5s6); one-tap RPE 6–10 chips on the active set and on the just-ticked set until rated, with "RPE n" shown in done rows (med-5wgd). New frame W1b; new layout rule `.wg-set__rpe-picks` in `components.css`. W2/W3 now draw Finish in the top bar too.
