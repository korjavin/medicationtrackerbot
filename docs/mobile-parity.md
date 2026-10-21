# Mobile parity (iOS ↔ Android)

The two native shells (`ios/`, `android/`) wrap the same web app. Keep them in step.

## Rules

1. **Twins only for user-visible behaviour and bridge ops.** A change to either shell that the user can see, or that adds/removes a bridge op, gets a twin bead for the other platform. Anything else (build, CI, signing, store listing, OS integrations) is labelled `parity:n/a` with a one-line reason.
2. **Bridge-op parity is enforced.** `web/static/js/tests/architecture.native-bridge-parity.test.js` diffs the op lists in `ios/App/LocalOrigin.swift` and `android/.../LocalOrigin.kt`; a one-platform op must be in its `PLATFORM_ONLY` map with a reason.
3. **Cross-session notes are beads.** File a `for:ios` / `for:android` task (P3, parent = the receiving epic, title `Q: …` or `FYI: …`). The receiver closes it with the answer or converts it into a twin. If the peer session is live, also SendMessage it.

## Feature matrix

| Feature | iOS | Android | Status / reason |
|---|---|---|---|
| Account mode (cloud vault in WebView) | ✓ | ✓ | parity |
| Local mode (bundled app, no account) | `WKURLSchemeHandler` (`wgapp://local`) | `appassets` + `files.js` / `chrome.js` | divergent: platform loader |
| Local → cloud move / account → local leave | ✓ | ✓ | parity |
| Page downloads (blob:/data:) | Files export picker (med-o7zq.43) | `ACTION_CREATE_DOCUMENT` picker, no shell dialog (med-nt9p.48) | parity: both go straight to the system picker; Share lives in the web sheet (hidden in the Android WebView) |
| Anonymous trial attestation | App Attest | Play Integrity (device-recall flag OFF) | divergent: platform API |
| Health data | HealthKit | Health Connect | divergent: platform API |
| Notifications (bridge ops) | ✓ | ✓ | parity |
| Account gone (`X-Account-Gone`) | ✓ → local mode, home `?invite=1` (med-ta2n.17) | ✓ → local mode, home `?invite=1` (med-ta2n.12) | parity |
| Local app lock (`lock.status` / `lock.set`) | ✓ | ✓ | parity (med-o7zq.39) |
| Switch account entry | Settings.bundle | launcher long-press shortcut (`MainActivity.kt`) | divergent: platform convention |
| Native token mirror (N1 first run / N2 local intro deleted, kit v2.1) | ✓ mirror only (med-ta2n.17) | ✓ mirror only (med-ta2n.12) | parity |
| N3 lock / N4 load error / N5 web exit bar / N6 splash hand-off + `notifications.openSettings` (kit v2.1); N4 · local has no exit | ✓ (med-ckm5.15, med-ta2n.17) | ✓ (med-ckm5.16, med-ta2n.12) | parity |
| Invite capture (applinks/App Links + `medtracker://`, pending slot, `invite.pending` / `invite.clear`, `local.leave` / `account.leave {url}`) | ✓ phase 2 (med-ta2n.11, med-ta2n.17) | ✓ phase 2 (med-ta2n.12.1, med-ta2n.12) | parity |
| `clipboard.read` (F1 Paste) | n/a (`navigator.clipboard` from the tap) | ✓ | Android-only: WebView has no clipboard-read prompt |
| Play Install Referrer → pending slot | n/a | ✓ (true first install only) | Android-only: Play |
| First launch = local mode (W1); native exits (Switch account, N4, account gone, `account.leave` no args) → local mode + `home?invite=1` (F1); no-url `local.leave` stays local | ✓ (med-ta2n.17) | ✓ (med-ta2n.12) | parity |
| Switch account / `forget()` from local mode drops the move stash | ✓ (med-ta2n.17) | ✓ (med-nt9p.49, med-ta2n.12) | parity |
| System bars (`chrome` op) | n/a | ✓ | Android-only: system bars |
| `diag.append` + Copy diagnostics (passkey debug aid) | ✓ (error screen, ceremony dialog, Home Screen quick action) | ✓ | parity (med-w6gx.24) |
| Back gesture exits app | n/a | ✓ | Android-only: back-exit |
| e2e flow QA scenarios | partial: local-mode flows (`ios.yml` `qa`) | ✓ (`android/qa`) | partial: account flows are owner device checks ([ios.md](ios.md#owner-device-checklist-account-flows-need-a-passkey)); med-w6gx.23 |
| Visual QA scene driver | ✓ (Simulator) | gap | open: med-y5xx.9 |
