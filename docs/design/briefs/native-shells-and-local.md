# Brief: native shells, local mode, lock, onboarding safety (re-sync 2026-10-20)

This is the re-sync brief for everything that shipped after App UI kit v2 was approved on 2026-10-09. The new work is:

- the iOS app (a Swift WKWebView shell);
- the Android app (a Kotlin WebView shell);
- "Only on this device" local mode;
- the native app lock;
- account move, leave and delete;
- encrypted backup and erase;
- the AI free trial;
- the reworked signup wizard (loss protection and the Emergency Kit).

Most of these surfaces were built straight in code with no design. Some are SwiftUI or Android Views, which never used the `wg-*` kit; the rest are web pages that grew around v2.

**Inputs in this project:**

- `current/CAPABILITIES.md`: the section "Since the 2026-10 kit (v2)" and the "Known visual debt" block H, with file:line refs.
- `current/screenshots/v3/`: 45 shots from CI (iPhone 16e at 390pt, Pixel at 412dp). `README.md` there lists each shot with its issues.
- `ui_kits/app-v2/`: the approved kit. Reuse its tokens, components and rules; this is a v2 extension, not a v3.

**Constraints:**

- Dark only.
- 390×844 frames.
- Kit rules 1–7 from `ui_kits/app-v2/README.md`, including no native dialogs, selects or checkboxes as the visible control.
- English copy.
- No emoji for status.

## What we need

### 1. Native shell screens, one design for both platforms (beads med-nt9p.41, med-w6gx.25)

These screens appear before the web app has loaded, so they can't use the web CSS. Today:

- **iOS** uses the teal background but system fonts, system-blue buttons and orange warnings (shots 01–06).
- **Android** uses stock Material light or dark, grey buttons and no hierarchy (18–27). The owner's verdict: "not Wandergeek style".

Design each screen once and draw it in an iOS frame and an Android frame. The platform should change only system details: status bar, back gesture, biometric wording ("Face ID" vs "fingerprint, face or screen lock").

| id | Screen | States to draw |
|----|--------|----------------|
| N1 | First run | default; "records ready to move" hint (21); "There is no account at …" inline error (04, 23); 2× font scale (20 clips today); QR-scan entry |
| N2 | Local intro "Only on this device" | default; lock switch on (03); pending-move warning (27); backup note. Android has no lock switch today; design it for both |
| N3 | App lock | locked, with the app mark; biometric failed or cancelled; the system prompt over it (24, 25) |
| N4 | Load error | network/503, not-found/404, local-mode variant. Copy is human, not "server answered 503"; Try again / Switch account / Copy diagnostics in a clear hierarchy (05, 06, 22) |
| N5 | Ceremony exit bar "Not your account? Use another invite" plus its confirm | it currently covers the Emergency Kit's Continue button (31); design where it lives so it never covers a primary action |
| N6 | Splash → web hand-off | the colour and mark continuity from splash to app (Android flashes white or grey today) |

**Developer hand-off:** list the 5–8 tokens (colours, type ramp, radius, button styles) each shell must mirror natively, so the SwiftUI and Kotlin ports are a small palette and type helper, not a re-implementation.

### 2. Onboarding vault safety: one page (bead med-1uuq)

Today "Protect against device loss" (30) and "Your Emergency Kit" (31) are two pages, and the second is a wall. The owner wants them merged:

- one page with collapsible sections (why it matters; what's in the kit; download or print);
- an **"I saved it" acknowledgement** that lets the user continue even if they haven't downloaded, at their own risk;
- a long Account ID must wrap inside the 16px gutter (bead med-i0fj);
- Continue is never hidden (N5).

| id | Screen |
|----|--------|
| O1 | Combined loss-protection + Emergency Kit: collapsed, expanded, and acknowledged-without-download |
| O2 | First Today after signup: no ghosting of the Welcome screen under the Today header (32), and "Track anything" not cut off by the tab bar (33) |
| O3 | Notification permission ask in context, when the user turns on reminders in onboarding or creates their first reminder; plus the "reminders won't fire" hint when permission is denied (bead med-1ikf) |

### 3. Local mode and account lifecycle (Settings)

The Settings home now changes with the mode. Local mode adds an "On this device only" card, Move to a cloud account, App lock, and Apple Health or Health Connect (07, 35, 36). These pages are a mix of kit and legacy markup, with visible native `<select>`s.

| id | Screen |
|----|--------|
| S6 | Settings home in local vs cloud mode: one fixed row order (today it depends on which module mounts first) and a clear mode indicator |
| S7 | Backup & import, local: export with passphrase, save/share, restore, "Move to a cloud account" steps, Erase (08, 43, 44). One wording for "Move to a cloud account", which today appears twice |
| S8 | Reminders & notifications: permission state, Allow/Test, lock-screen reminder text (39: the title truncates, and it uses a native select) |
| S9 | Account & privacy: leave account ("use this phone without an account"), delete account (40–42) |
| D1 | The destructive and type-to-confirm dialogs: erase (11), delete (42), replace records (45), move (37). Make them one dialog family; today they're generic |

### 4. AI free trial

| id | Screen |
|----|--------|
| A1 | Today "Try AI for free" card, the Settings → AI & integrations trial entry, and the trial consent step (iOS App Attest / Android Play Integrity). Today's consent text is about 120 words per platform; make it scannable. There are no screenshots, because no CI scene captures it yet (med-y5xx.13), so design from CAPABILITIES.md |

### 5. Small polish to fold in

- **med-fhil:** after "Add time" in the med schedule, the empty time row looks blank on iOS. Show a visible tappable time or "Set time" affordance (M-series editor).
- **Shot 09:** the backup page while the keyboard is up (the previous page bleeds through).
- **Shot 13:** a field under the keyboard accessory bar. Show the intended keyboard-up layout for long forms.
- **Shot 44:** the backup filename wraps mid-extension.

## Ask for Claude Design

1. Start with a short critical review of the v3 shots against kit v2: what's inconsistent across iOS, Android and web.
2. Then extend the kit, at 390×844 using `ui_kits/app-v2/tokens.css` / `components.css`. Add any new components to `components.css` and `components.html`, changing existing ones only if you must and saying so.
3. Put the output in:
   - `ui_kits/app-v2/screens-native.html`: N1–N6, iOS and Android frames side by side;
   - `ui_kits/app-v2/screens-onboarding.html`: O1–O3;
   - `ui_kits/app-v2/screens-settings.html`: append S6–S9 and D1;
   - `ui_kits/app-v2/screens-today.html`: append A1;
   - the native token-mirror table as a section in `screens-native.html`.
4. Keep the screen ids above; implementation beads will cite them.

## Open questions for the owner and designer

- **Android theme:** should the native screens always be dark like the web app (recommended), or follow the system theme?
- **Lock screen:** show the app mark or the account name?
- **"I saved it":** does skipping the download leave a persistent "kit not saved" nudge in Settings?
