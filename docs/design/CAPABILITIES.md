# App capabilities snapshot (for the design re-sync)

What the app can do as of 2026-10, organized by surface for a designer. The goal is to bring the UI back in line with the Wandergeek design system ([DESIGN.md](DESIGN.md)). That system started as a Claude Design handoff covering 8 screens: Today, BP, Food, Meds, Workouts, Weight, Vitals and Settings. The handoff also included 4 modals: Food, Take meds, Weight and BP. Its rollout is recorded in [the rewrite plan](../plans/completed/2026-04-20-wandergeek-design-rewrite.md).

The code is the source of truth. File paths are relative to `web/`, and line numbers are approximate.

**Legend:**
- **[H]** means the item was in the handoff (`screens.jsx` / `components.jsx` / `settings.jsx`).
- **[NEW]** means it was added after the handoff and never had a design pass.

## Global frame

- **Bottom nav** [H, deviated]: two rows of 4 gloss tiles, in this order:
  - Row 1: Today, BP, Food, Meds.
  - Row 2: Vitals, Workouts, Weight, Settings.
  - Disabled features are removed from the nav. There is no "More" slot.
  - Code: `static/js/components/wg-bottom-nav.js`.
- **Journey** [NEW] is a full screen that is *not* in the nav. It opens only from the Today Goal Line card.
- **Phone chrome** (status bar, island): the component `static/js/components/wg-phone-chrome.js` exists but nothing uses it.
- **Screen headers**: the handoff had an `AppHeader` (title + date). The shipped app has none. Each screen opens directly on its first toolbar or sub-tab row.
- **Banners and toasts**:
  - Banners live in the sticky `#app-banners` strip (kit `.wg-banner`, med-xso6.5):
  - **Offline banner** `#offline-banner` `.wg-banner--offline`: "Offline · showing saved data. New logs will sync." Code: `static/js/sync.js` `updateOfflineBanner`.
  - **Auth-expired banner** `.wg-banner--warn` with a "Re-authenticate" button. Code: `cloud/js/cloud-boot.js` `surfaceAuthExpired`.
  - **SW update banner** `.wg-banner--info`: "A new version is available. Later / Reload". Code: `cloud/js/update-check.js`.
  - **Toasts**: one `.wg-toast` stack above the tab bar (`SyncManager.showToast`, `safeToast(msg, type, { action })`). Row deletes go through `deleteWithUndo` (`core/utils.js`): optimistic remove + Undo toast, the delete runs when the toast closes.
  - **Legacy sync status bar and debug panel**. Code: `static/js/sync.js`.
- **Dialogs** [NEW]: `safeAlert`, `safeConfirm`, `safePrompt`, `safeChoose` and `safeToast`.
  - Code: `static/js/core/utils.js`, styled by `static/css/dialog.css`.
  - The browser's native dialogs are banned.
  - They are used everywhere for these jobs, which have no dedicated design:
    - validation errors
    - delete confirms
    - the weight-goal input
    - renaming a gym
    - "When did you eat this?"
    - drug-interaction warnings
- **Sync state on rows** [NEW]: rows show Pending/Failed tags (`wg-tag--pending` / `--rejected`).
  - Food, Notes and Workouts build these tags themselves.
  - BP, Weight and Meds do not show them at all.

---

## 1. Today (`static/js/features/today.js`, `today-loader.js`)

**Purpose:** the home screen and the default on every cold start. It is read-mostly: every card links to its section or opens a log modal.

**Render order** (`today.js:1321-1479`):

1. **Call agent card** [NEW] (`elevenlabs-call.js`): the voice agent.
   - The button cycles through "Call agent", "Connecting…", "End call" and "Try again".
   - During a call it shows Mute/Unmute, "Send photo" and a live status line.
   - In cloud mode the **Doctor brief** tile shares this row (2fr/1fr).
2. **Shortcut rows**. The handoff had 3 tiles; the app now has up to 6 in 3 rows:
   - Food row: Log food [H], **Scan food** [NEW], **Photo meal** [NEW].
   - Vitals row: Add BP [H], Add weight [H].
   - Brief row: **Doctor brief** [NEW, cloud].
3. **Metric tiles** [H]: BP (value, status tag Normal/High-normal/Stage 1/High, sparkline) and Weight ("7d ±x" or "7d flat" tag).
4. **Goal Line card** [NEW] (`today.js:1222-1279`). This is the gamification hero; see §11. Tapping it opens Journey.
5. **Fuel card** [H]: kcal, % of target, and 4 mini bars (Energy/Protein/Carbs/Fat).
6. **Workout and Sleep tiles** [H]. Each tile can also show "Not scheduled" or "No sleep data".
7. **Timezone plan card** [NEW] (`tz-plan-banner.js`). It appears only while a timezone change is pending or in progress.
   - Text: "old → new · offset", the steps done, the next shifted dose, and a `<details>` list of steps.
   - Buttons: Apply / Cancel.
8. **Next meds card** [H].
   - Kicker: "Next HH:MM · in X", "Overdue HH:MM" or "No scheduled doses".
   - The button reads Take, Take now or Plan, and opens the Take-meds modal.
   - Below it, a list of meds.

**Floating call pill** [NEW] (`call-indicator.js`): stays above the bottom nav on every tab during a call. It shows status and has Mute, Photo and End call (clay).

**States:**
- **First run**: "Connect to load your day".
- **All features off**: "All features are off — enable one in Settings".
- **Stale or missing data**: shown inside each tile ("· stale", "—", "Log a reading").
- **Loading**: there is no loading state. The screen renders from cache.
- **Refresh**: the screen re-renders every 60 seconds, except during a call.
- **Offline**: there is no offline state specific to Today.

**Modals opened from Today:**
- Take meds [H].
- BP / Weight / Food entry [H].
- **Doctor brief** [NEW] (`brief.js`, `#brief-modal`):
  - Range: 30, 90 or 180 days.
  - 7 section checkboxes: Meds+adherence, BP, Weight, Vitals, Notes, Nutrition, Workouts.
  - A notes picker.
  - Actions: Download and Print.
  - Footer text: "Everything is generated on this device".
  - The printout has its own non-wg classes.
- **Trial-AI consent** [NEW] (`trial-consent.js`): "Not now" / "Allow".

## 2. Blood pressure (`static/js/features/bp.js`, `components/wg-bp-chart.js`)

**Purpose:** log BP readings and read the trend. Classification follows ISH 2020 (target under 130/80), and averages give each day equal weight.

- **Toolbar** [H, changed]: 14d/30d/60d pills plus an inline **"Log"** button (`wg-toolbar-btn--primary`). There is no title.
- **Chart** [H]: systolic and diastolic lines, a normal band, and numeric mmHg and date ticks.
- **Averages** [H]: three cards (14/30/60 days), each showing sys/dia, "mmHg" and "N readings", or "—".
- **History** [H]: grouped by day. Each row shows sys/dia, time, a pulse tag, a category tag and a delete icon.
- **Modal `#bp-modal`** [H, extended]:
  - Fields: datetime, sys, dia, pulse, notes.
  - [NEW] fields: **arm side** select, **position** select.
- **Missing**:
  - Readings cannot be edited.
  - The history list has no empty state.
  - The chart's empty state uses the legacy `.no-data-msg`.
  - The offline cold state is "No cached data — will load when online".
- **Not in the UI**: CSV export.

## 3. Food (`static/js/features/food/*`, `food-photo-summary.js`)

**Purpose:** log meals and track macros against targets.

- **Sub-tabs** [NEW]: **Log** | **Food DB**.
- **Log tab:**
  - **Day navigator** [H]: chevrons, a tappable date and a week display.
    - It now also holds **three** primary buttons: **Add**, **Photo** [NEW] and **Scan** [NEW].
  - **Macros card** [H]: a Daily/Weekly toggle, kcal, % of target, "avg N kcal/day · 7d", and macro bars.
  - **Target progress rows** `#food-target-progress`. These use legacy `.food-target-*` classes and duplicate the macro bars.
  - **Meal list** [H]: grouped by meal. Each row shows name (meals prefixed with 🍽), grams, kcal, P/F, sync tags, and edit/delete.
  - **AI log toast** (`food-photo-summary.js`): the standard toast after an AI photo or text log: "N items logged" + kcal total.
    - **Undo** removes them; the toast then reads "Removed N items". Failures show an error toast with Retry.
    - It closes automatically after about 8 seconds and has a "×" text close button.
- **Food DB tab** [NEW]:
  - Search, sort pills (Most Used / Recently Used / A-Z) and paginated product cards.
  - The cards show "kcal | C | P | F per 100g" and a MEAL badge.
- **Modal `#food-modal`** [H, extended]:
  - Fields: weight in g, barcode + Scan, name with autocomplete, per-100g macros, total kcal, datetime.
  - [NEW] **"Parse my meal from a description"** checkbox. AI mode hides the manual fields and turns the name field into a free-text box.
  - [NEW] product link. [NEW] "Values are per 100g" checkbox.
- **Autocomplete dropdown** [NEW]:
  - Text glyph buttons: ▲ Close, ✎, ✕.
  - 🍱 marks meals.
  - Also: "Load more from OpenFoodFacts", a status line, and "→ View in Products".
- **Barcode scanner** [NEW] (`#food-scanner-modal`): camera video, "Use Photo" and "Close".
- **Edit product** [NEW] (`#food-product-modal`): name, barcode, macros per 100g.
- **Photo flow** [NEW]:
  - A safeConfirm asks "When did you eat this?" (Use now / Use photo time).
  - The button reads "Analyzing…" while the photo is processed.
- **States**:
  - Empty day: "No food logs for this day."
  - Error: "Failed to load food logs."
  - Food DB loading/empty/error states are plain strings.
  - Missing configuration: "Food database not configured. Add one in Settings → Integrations".

## 4. Meds (`static/js/features/meds.js`, `meds-history.js`, `medication-utils.js`)

**Purpose:** a medication schedule with reminders, an intake log and stock tracking.

- **Sub-tabs**: History [H] (default), Schedule [H], **Upcoming** [NEW], Inventory [H].
- **History:**
  - **Next intake card**: "Next scheduled intake", a countdown, the names, and "Take Now".
  - Filters: medication select and 24h/3d/7d select.
  - Day-grouped rows. Status tags use **emoji: "✅ Taken", "⏳ Pending", "❌ Missed"**.
  - Tapping a row opens the confirm modal in edit mode. Un-marking a taken intake is supported.
- **Schedule:**
  - The **Add** button appears on this tab only.
  - Hour buckets ("HH:MM · in Xh Ym"), then Scheduled, As needed, Archived.
  - Each row shows: name, dosage, a **Supplement** tag [NEW], schedule text, **"Rx: normalized name"** [NEW], a date range, an "N left ⚠️" stock tag, "Log", and edit/delete.
  - Scheduling follows the timezone plan [NEW].
- **Upcoming** [NEW]: a read-only 7-day forecast grouped by Today/Tomorrow/weekday.
  - Doses during a timezone transition get a "transition step n/m" tag and a note.
  - Empty: "No scheduled doses in the next 7 days". If no forecast is available, the pane is blank.
- **Inventory** [H]:
  - Each card: big remaining count, "⚠️ Low stock", "Last refilled".
  - **Refill** opens an inline form (quantity, Confirm/Cancel).
  - Empty: "No medications track inventory…"
- **Modal `#med-modal`** [NEW, never designed]:
  - Name and dosage.
  - Rx display.
  - Daily/Weekly/As-needed pills.
  - Days picker: a legacy `.days-select` built from spans.
  - Time list ("+ Add time", "×").
  - Start and end dates.
  - Track inventory, which reveals stock, quick restock and restock history.
  - Archived and Supplement checkboxes.
  - **Timezone adjustment policy** select: Flexible, Medium (3h steps), Strict (2h steps).
- **Take-meds modal `#med-confirm-modal`** [H]:
  - Three modes: confirm, edit intake ("Update") and log past ("Log Intake").
  - Optional "Time taken" field.
  - Checklist, "Snooze 10m", "Skip" and "Confirm selected".
- **Drug interactions** [NEW, no UI]: RxNorm results show only *after saving*, as `safeAlert("⚠️ …")`.
- **Duplicate medication**: shown as an alert.
- **Archive / delete**: an archived medication with no history can be deleted.
- **Toasts**: "✅ Confirmed: …", "Skipped!", "Updated!", "Intake logged!"
- **Missing**: the Schedule tab has no empty state for zero medications.

## 5. Vitals (internal id `health`) (`static/js/features/health.js`)

**Purpose:** passive health metrics, mostly from Mi Band `.nxk` backups, plus a diary.

- **Sub-tabs** [H]: Overview | Notes.
- **Overview** [H]:
  - Summary tiles: sleep, steps, HR, SpO2, stress, each with a trend arrow.
  - 7d/30d range pills. These sit **below** the tiles they control, unlike the handoff.
  - Chart cards: Sleep stages, Steps, Heart rate, SpO2, Stress.
  - Each chart card has a per-chart empty state ("No … data yet") and a "DATA SOURCE · .nxk backups" footer.
  - Loading reads "Loading metrics…" as plain text, toggled with an inline style.
- **Live heart rate card** [NEW, experimental, behind a flag] (`live-hr.js`):
  - A Web Bluetooth connection.
  - Buttons: Connect, Show all devices, Disconnect, Copy log.
  - A raw `<pre>` log.
  - It looks like a debug tool.
- **Notes** [H]:
  - **Composer**: 6 tag chips, a textarea, a character count, and "+ Add note".
  - **Feed**: grouped by day. Each note shows a tag (tap it to filter by that tag), time, content, sync tags and edit/delete. A "Load more" button pages the feed.
  - **Empty states**: "No notes yet — write your first one." and "No notes tagged X".
  - **Edit**: opens `#note-modal`, which can edit the content only, not the tag.
- **Mi Band import** [NEW]: lives in Settings → Backup & data. Nothing on Vitals links to it.

## 6. Workouts (`static/js/features/workout/*`)

**Purpose:** training plans, logging individual sets, analysis, and equipment. Detail is in [workout-depth.md](../workout-depth.md).

**Naming change:** what the handoff called "Group" and "Variant" are now **"Plan"** and **"Day"**.

- **Sub-tabs**: History [H], Plans [H as "Groups"], Exercises [H], Stats [H], **Equipment** [NEW].
- **History** (`next-card.js`, `history.js`):
  - **Next-workout card** [H; Swap → Ad hoc]:
    - "Ready to Start" / "To Be Skipped", the plan, and the day.
    - Buttons: **Ad hoc** (always the leftmost), Start, Skip, Cancel Skip.
    - **Gym switch** "At: … ▾" [NEW].
  - **Sessions** [H]: grouped by day.
    - Tags: Skipped, **"Unfinished — finish?"** [NEW], sync tags.
    - Actions: view, edit, delete.
  - **Mi Band cardio cards** [NEW]: emoji icons 🏔️🚴🚶🏃.
  - **Empty / error**: "No workout history yet" and "Error loading history".
- **Plans** (`groups.js`):
  - Rows: Rotating/Inactive tags.
  - Row actions: **Share** [NEW], **Print** [NEW], **Scan filled sheet** [NEW, cloud], Edit, Delete.
  - Bottom buttons: "+ Add plan" and **"Import plan"** [NEW].
  - **Plan modal** `#workout-group-modal`:
    - Fields: name, description, training goal, a "Rotate through days" toggle, "Repeats on" chips, time, notify-before, active.
    - Contents: a list of Days, or a flat exercise list when the plan does not rotate.
  - **Day modal** `#workout-variant-modal`.
  - **Exercise modal** `#workout-exercise-modal`: goal cascade, weight suggestion, equipment helper.
  - **Share modal** [NEW]: QR code, copy link, native share; links expire after 30 days.
  - **Import modal** [NEW]: paste a link or scan a QR code.
  - **Scan review modal** [NEW]: AI photo of a filled-in plan sheet.
  - **Printed plan** [NEW]: an A4 sheet with blank boxes to fill in.
- **Exercises** (`library.js`) [H]:
  - "Library" header with "+ Add", search, a source segmented control, and rows with a body-part tag.
  - **Library modal** `#exercise-library-modal`.
  - **Exercise detail** [NEW] (`exercise-detail.js`): replaces the Stats pane in place instead of opening a modal.
    - Records: heaviest weight, est. 1RM with a confidence flag, best set, most volume, most reps, RIR.
    - Rep-max records and goal-ordered charts.
- **Stats** (`stats.js`) [H, heavily extended]:
  - Hard-set headline [NEW].
  - View toggle [NEW]: **Consistency** (activity calendar), **Load** (weekly tonnage bars, tiles, week-over-week caption, Records list) and **Balance** (sets per body part, "Not Trained" chips, Pull:Push and Hinge:Squat).
  - Range pills; Streak/Sessions/Done/Skipped tiles; Top exercises; auto-tag button.
- **Equipment** [NEW] (`equipment.js`):
  - Header: Import, "+ Gym", "+ Add".
  - List grouped by gym, with an Active badge.
  - Gyms are renamed and deleted through safePrompt/safeConfirm.
  - **Equipment modal**: kind segmented control, plate rows, a "Fill" load generator. Gyms can be shared and imported.
- **Session modal** `#workout-session-modal` [NEW, the heaviest surface] (`sessions.js`, about 2,000 lines):
  - **Sticky header**: slot tag, date, status, gym switch, "+ Exercise", ×.
  - **Body**: per-exercise cards with set rows (weight, reps, RPE, set type), "+ Add set", notes, PR chip, body-part chip and **plate-loading chip**.
  - **Footer**: autosave status ("Saving…") and "Finish workout".
  - **Toast on close**: closing an unfinished session shows a nudge.
- **Other modals**:
  - **Log set** `#workout-add-exercise-to-session-modal`.
  - **Mi Band cardio** `#miband-workout-modal` [NEW].
  - **Workout start** `#workout-start-modal`: "Workout Time!" with Start, Snooze 1h/2h, Skip.

## 7. Weight (`static/js/features/weight.js`, `weight-unit-state.js`)

**Purpose:** log weight and track progress toward a goal.

- **Goal card** [NEW]:
  - With no goal: "Set a weight goal to track your progress."
  - With a goal: the goal, a progress bar and the distance remaining. Progress comes from the Goal Line read-model.
  - The +/✎ icon opens **safePrompt "Target weight"** (a generic dialog, not a modal).
- **Toolbar** [H]: 7d/30d/90d/All pills plus "Log".
- **Chart** [H, extended]: "Current" badge, actual line, **plan trajectory** [NEW], dashed **GOAL** line, **14-point trend** line, and a legend (Actual / Plan / Goal).
- **Prognosis card**: "Projected goal date". Currently hidden; it is being moved to the Goal Line.
- **History** [H]: grouped by day, with edit/delete.
- **Modal `#weight-modal`** [H]: time, weight with a kg/lb toggle, notes. The unit you pick becomes your saved preference.
- **Missing**: the history has no empty state, and rows show no sync tags.

## 8. Settings (`static/index.html:445-1060`, `features/settings.js`, `settings/*`)

The handoff Settings screen had four sections:
- Features toggles (4)
- Smart reminders (BP, Weight)
- Food targets
- General rows: Notifications, Time zone, Units, Export

The shipped screen has six collapsible groups, with a Feedback card above them:

0. **Send feedback** [NEW] (`cloud/js/feedback-ui.js`): a card at the top that opens a modal. The modal has text, "Attach image", "Record voice", and Send.
1. **Preferences**:
   - **Notifications** [NEW, cloud]: Web Push Enable, Send test push, delivery (push / Telegram / both), Telegram detail level.
   - **Features**: **13 toggles** (handoff: 4). BP, Weight, Workouts, Meds, Food, Health Data, Journey, Weekly Digest, Experiments, Traits, AI Story, ED-safe mode, Live HR. Below them, a **"Re-run onboarding"** button [NEW].
   - **Reminders** [H]: BP and Weight.
   - **Units** [H]: kg/lb.
2. **Targets**:
   - Food targets [H]: a 2×2 grid and Save.
   - **Journey targets** [NEW]: low/high bands for systolic, diastolic, resting HR, sleep, steps and bedtime, plus Save.
3. **Integrations** [NEW]:
   - **OpenAI**: key, URL, model, "Load models", Vision overrides.
   - **Food Database**: key and URL.
   - **ElevenLabs**: key and agent id.
   - **Telegram**: a step-by-step mini wizard (intro, create bot, open bot, connected with Send test / Unlink, bring-your-own token, chat-agent glossary).
   - One global "Save Integrations" button.
4. **Devices & connections** [NEW]:
   - A second-device nudge, plus links "Manage devices" and "Claude connector". These go to **separate cloud-shell pages**, `/devices` and `/connectors`.
   - **Invite a friend**: a modal with a QR code and Copy link.
5. **Backup & data** [H "Export data", greatly extended]:
   - Export: "Include API keys" checkbox, optional **age** passphrase, Download.
   - Import: file + passphrase, "Import backup (replace)".
   - **Mi Band .nxk import**.
   - Reset local sync.
6. **Account & privacy** [NEW]:
   - "What can the operator see?" (generated privacy list).
   - **Delete account** danger modal: Export first, then type "delete my account", then "Verify passkey & delete".

**Removed from the handoff:** the Time zone row. Timezone handling now lives only in the Today timezone-plan card.

## 9. Journey (gamification) (`static/js/features/journey.js`, `docs/gamification.md` §0)

[NEW] This screen is not in the nav. It opens from the Today Goal Line card.

- **Goal Line idea**: the weight goal is the spine of the game. Workouts, BP and food are levers that move it. HP, levels and the Health Score are hidden.
- **Today Goal Line card**:
  - "current → target", a basis line ("trend · N weigh-ins/28d"), and a progress bar with the next milestone.
  - "7 days: ±x".
  - **Safety line** when losing faster than 1% a week. This line never praises.
  - Facts: workouts done this week, BP 7-day average vs target.
  - "This week: …" plan, missed-dose nudge, one CTA ("Weigh in" / "Start today's session").
  - Milestone "Got it".
  - Variants: no goal, preliminary, at goal / maintaining, and ED-safe (only the missed-dose alert).
- **Journey screen order**:
  1. Goal context
  2. Weekly review / plan picker
  3. "What's new" strip
  4. Atlas
  5. Gauges (Weight, BP, Resting HR)
  6. `<details>` "More · experiments, chapters, traits, keystones"
  7. **AI Story** narrator card
- **States**: "Gamification is off…", plus offline cold-cache placeholders.

## 10. AI and narrator surfaces [NEW]

- **Narrator** (`cloud/js/gamification-narrator.js`): has no UI of its own; it renders in the Journey "AI STORY" card.
  - Buttons: Narrate my week, Workout insight, Chapter recap, Experiment idea.
  - "Narrating with your AI…" while it runs, then the prose with a "narrated by your AI" tag.
  - Failure: "AI narration unavailable…"
- **AI-powered features** (`cloud/js/aiclient.js`; your own OpenAI/Anthropic key or the operator trial):
  - food photo and food text parsing
  - workout-sheet scan
  - exercise auto-tagging
- **AI errors**: these surface only as error strings, in five near-duplicate wordings that all point to Settings → Integrations.
- **Trial consent modal**: shown before the first use of the trial.
- **Voice agent**: the Today card plus the floating pill (§1).
- **Outside the PWA UI**:
  - **MCP / Claude connector** (`/connectors` page) and the **Telegram chat agent**. Telegram can log `/food`, `/note` and `/weight` and accepts photos.
  - The **weekly digest** is a push notification.

## 11. Out-of-nav surfaces

- **First-run onboarding** [NEW] (`static/js/features/firstrun/`, `static/css/firstrun.css`, fully built on tokens):
  - Full-screen overlay with 4 steps:
    1. Welcome (Get started / Skip all)
    2. "What do you want to track?" (6 toggles)
    3. OpenAI key (Save / Skip; trial note)
    4. "You're all set" (capability links, Open app)
  - **Missing**: a step indicator.
  - Uses its own `wg-firstrun-btn` button system.
- **Cloud shell** [NEW] (`cloud/*.html`, `cloud/css/cloud.css`): a separate stylesheet with about 15 copied tokens. **Fonts are not loaded**, so it falls back to system fonts.
  - **Landing**: text only, "Invitations only".
  - **Unlock**: "Unlock with passkey", a recovery link, and a share-link note.
    - When unlocked: Reminders / Devices / Connectors / Lock.
  - **Signup wizard** (`signup.js`), 8 steps:
    1. Invite check
    2. Already claimed
    3. Welcome, Create passkey
    4. Device incompatible (Run compatibility check)
    5. Device-loss acknowledgement
    6. **Emergency Kit** (QR + recovery code, Download / Print)
    7. Telegram
    8. Add to Home Screen (iOS / Android variants)
  - **Claim** (add device by code; optional "Continue without PRF").
  - **Recover**.
  - **Devices**: list with verified badges, Revoke, Add a device, Regenerate Emergency Kit.
  - **Transfer**: QR + code, then "Device added" or "expired".
  - **Connectors**: remote connector URL with a consent dialog, or a local pairing code.
  - **Share landing** `/s/<id>`: plan preview, "Add to my Med Tracker", "Copy plan code".
  - **Feedback decryptor** (operator-only).
  - **Buttons**: plain `<button>` styled by `.wizard-step button`. `.secondary` is the only variant.
- **Imports**:
  - **Vault import/export** (Settings) — see [vault-format.md](../vault-format.md).
  - **Mi Band .nxk** (Settings, plus Telegram attachments).
  - **Plan / gym share links and QR codes** (Workouts).
  - **Scanned filled plan sheet** (Workouts, AI).
  - **Barcode** and **food photo** (Food).

---

## Known visual debt / drift

Ordered roughly by how much a designer should care.

### A. No single button or modal system
- **Bootstrap-era `btn btn-sm btn-primary/secondary/link` classes are still live:**
  - Today Goal Line: `static/js/features/today.js:1247,1263,1267`.
  - Every Journey button: `static/js/features/journey.js:97,565,754,805,975`.
  - Food scanner and product modals: `static/index.html:1969,1982`.
- **About 57 button-ish selectors exist in `static/css/styles.css`.**
  - `wg-gloss` is the de facto primitive, but every surface adds its own layout class:
    - `wg-toolbar-btn`, `wg-icon-btn`, `wg-settings-action-btn`, `wg-settings-save-btn`
    - about 15 `*-modal__header-btn` classes
    - about 10 `*-subtabs__btn` / `*-range-selector__btn` classes
  - There is no shared size or variant scale (primary / secondary / danger / icon / toolbar).
- **Two more parallel button systems:**
  - `wg-firstrun-btn` (`static/css/firstrun.css`)
  - `.wizard-step button` (`cloud/css/cloud.css:80`)
- **Modal headers come in three shapes:**
  - (a) The handoff pattern: eyebrow + mono title + Cancel/Save top-right. It is cloned under about 20 different BEM prefixes, and scan/share/import modals borrow `wg-workouts-group-modal`.
  - (b) The generic `wg-modal__header` with footer actions: `core/utils.js` dialogs and feedback.
  - (c) Legacy `.modal-header` + `<h3>`: `#food-scanner-modal`, `#food-product-modal`.
- **Specific outliers:**
  - The Take-meds modal's title repeats its eyebrow ("Time for meds" / "Time for Meds!").
  - The session modal has no eyebrow and closes with an ×.
- **Primary action labels are inconsistent:**
  - "Log" (BP, Weight), "Add" (Meds, Food), "+ Add" (Exercises, Equipment), "+ Add plan", "+ Add note".
  - The CTA position varies too: toolbar, header, bottom of pane, inline.

### B. Overloaded screens and surfaces
- **Today** stacks up to 8 blocks plus the floating pill.
  - The Goal Line card alone can run to about 10 lines.
  - The call card always mounts, even with no voice key and no trial; it fails only after the user taps it (`static/js/features/today.js:1379`, `elevenlabs-call.js:154-170`).
  - Call controls appear twice: once in the card and again in the pill.
- **Workout session modal** (`static/js/features/workout/sessions.js`, about 2,000 lines): a whole logging app inside a modal.
- **Plan modal** (`static/index.html:1113`): a nested editor for Plan → Days → Exercises.
- **Food day-nav row**: two chevrons, a date and three primary buttons (Add/Photo/Scan).
  - The Food Log tab also shows progress twice: the macro card bars and the legacy `#food-target-progress` rows (`static/js/features/food/log.js:1020-1080`).
- **Settings**: about 600 lines of hand-written markup, 13 feature toggles, and a Telegram wizard nested inside Integrations.
  - Devices and Connectors leave the app for differently styled shell pages.
- **Workouts** has 5 sub-tabs, and Stats has two stacked segmented strips plus a headline.
- **Exercise detail** replaces the Stats pane in place, so there is no clear way back.

### C. Legacy markup and inline styles
- **Inline `.style` writes in JS: 47.** Worst offenders:
  - `workout/groups.js` 16
  - `health.js` 9 (loading divs)
  - `workout/variants.js` 6
  - `meds.js` 4
  - `meds-history.js` 4
  - `index.html` itself has 0 `style=` attributes.
- **Legacy class names still in use:**
  - `.no-data-msg` (BP and Weight charts), `.text-hint`, `.hint`, `.med-empty-text`.
  - `.days-select` span picker (Med modal and Plan modal).
  - `.food-db-*`, `.food-meal-badge`, `.autocomplete-*`.
  - `.bp-input-group` borrowed by the food product modal.
  - `log-input-group` / `exercise-log-*` (`static/js/features/workout/sessions.js`), `workout-variant-card` / `cursor-pointer` / `text-danger` (`static/js/features/workout/variants.js:40-90`).
  - Dual classes kept as JS hooks: `.med-tab`, `.med-item`, `.workout-tab`.
- **Cloud shell** (`cloud/css/cloud.css`, `cloud/js/{signup,unlock,claim,recover,devices,transfer,connectors,telegram}.js`):
  - Wizard markup throughout: `wizard-step`, `wizard-error`, `secondary`, `muted`.
  - No Wandergeek fonts load.
  - `telegram.js` mixes wizard and `wg-*` markup inside Settings.

### D. Emoji where icons or tags belong
- **Status tags:** "✅ Taken / ⏳ Pending / ❌ Missed" and "⚠️ Low stock" (`static/js/features/meds.js:636-650`).
- **Edit/delete buttons:** 🗑️ / ✏️ (`static/js/components/action-row.js`). Used by the Plan modal's Day and exercise lists, Food DB and Meds. Everywhere else uses `wg-icon-btn` with SVG icons.
- **Mi Band activity icons:** 🏔️🚴🚶🏃 (`static/js/features/workout/history.js:11-14`).
- **Timezone card icon:** 🌍 (`static/js/features/tz-plan-banner.js:184`).
- **Food:** 🍽 / 🍱 meal prefixes and ✎ ✕ ▲ glyph buttons (`static/js/features/food/log.js:823`, `food/products.js`).
- **Toasts:** "❌" (`workout/sessions.js:1591,1751,1778`) and "✅ Confirmed" (`meds-history.js`). Feedback chips use ✓.
- **Alerts:** drug-interaction alerts start with "⚠️".

### E. Missing or inconsistent states
- **No empty state:**
  - BP history list
  - Weight history list
  - Meds Schedule with zero medications
  - the Upcoming tab when no forecast is available
- **Sync tags are inconsistent:**
  - Pending/Failed tags are built three times, separately (`food/log.js:834`, `health.js:955`, `workout/history.js:420`).
  - BP, Weight and Meds rows show none, although the code comments say they keep these states.
  - `createSyncBadge` in `action-row.js` is unused.
- **Loading states:** Vitals uses unstyled "Loading metrics…" / "Loading notes…" text. Today, BP and Weight have no loading state; they render from cache. Food DB uses innerHTML strings.
- **Offline and error states:**
  - Offline cold start uses the same string everywhere ("No cached data — will load when online"), rendered with three different classes.
  - Errors appear as `<p class="error">` text.
  - `empty-state.js` is used only by BP, Weight and Meds.
- **Text prompts used instead of modals:** the weight goal, gym rename, "When did you eat this?", validation errors, and drug interactions all use generic `safe*` dialogs.
- **Range pills are placed inconsistently:** Vitals puts them below the tiles they control; BP, Weight and Workouts put them above.
- **First-run wizard** has no progress indicator.

### F. Dead or orphaned design components
These are loaded but have no consumers. Each should be adopted or deleted:
- `static/js/components/wg-settings.js`
- `static/js/components/wg-toggle.js`
- `static/js/components/stat-card.js`
- `static/js/components/wg-phone-chrome.js`
- the sync badges in `action-row.js`

The handoff's `AppHeader` (title + date) was never adopted, so no screen has a title.

### G. Discoverability
- **Journey** is reachable only through the Goal Line card.
- **Mi Band import** sits in Settings → Backup, with no link from Vitals.
- **Live HR** is behind an experimental flag and styled like a debug tool.
- **CSV export** for BP and Weight is not in the UI.
- **Scheduled ad-hoc workouts** can be created only through MCP.
