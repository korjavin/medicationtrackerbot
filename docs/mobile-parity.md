# Mobile parity (iOS ↔ Android)

The two native shells (`ios/`, `android/`) wrap the same web app. Keep them in step.

## Rules

1. **Twins only for user-visible behaviour and bridge ops.** A change to either shell that the user can see, or that adds/removes a bridge op, gets a twin bead for the other platform. Anything else (build, CI, signing, store listing, OS integrations) is labelled `parity:n/a` with a one-line reason.
2. **Bridge-op parity is enforced.** `web/static/js/tests/architecture.native-bridge-parity.test.js` diffs the op lists in `ios/App/LocalOrigin.swift` and `android/.../LocalOrigin.kt`; a one-platform op must be in its `PLATFORM_ONLY` map with a reason.
3. **Cross-session notes are beads.** File a `for:ios` / `for:android` task (P3, parent = the receiving epic, title `Q: …` or `FYI: …`). The receiver closes it with the answer or converts it into a twin. If the peer session is live, also SendMessage it.
4. **Common scenarios are parity contracts.** A `testscenarios/common/` scenario that passes on one platform and fails on another is a parity bug, filed with the scenario id ([testscenarios/README.md](../testscenarios/README.md)).

## iOS feature hold (2026-10-22 → 2026-10-23, lifted)

Lifted 2026-10-23: token budget allowed a parallel iOS track. iOS work resumed (epic `med-w6gx` incl. catch-up audit `med-w6gx.26`, `med-y5xx` visual testing, `med-ta2n.26`, `med-o7zq.47`); rule 1 (twins) applies again for new work. Only `med-erq1.4` stays deferred (waits on server push `med-erq1.1`–`.3`). The bullets below remain for the catch-up.

- **Catch-up baseline** = master `1ff23578ba4d3101db256ea4cd3c5f412f39f80c` (last TestFlight upload, 2026-10-20). Fixed: a later TestFlight build does not move it; advance it only after the intervening range is audited and banked.
- **Installed-shell build** = the latest TestFlight build/SHA, tracked on `med-w6gx`; it is what the compatibility review item below protects.
- **New Android-only bridge op** goes in `PLATFORM_ONLY` with a reason starting `pending-ios:` (genuine platform differences keep their normal reason). Don't change the test code.
- **Review item for every PR touching web/native contracts:** the installed iOS shell must keep working (account mode loads fresh web code; bundled local mode is pinned to the shell release). Web must feature-detect the new op/field, gate the rollout, or record a release blocker on `med-w6gx`.
- **Resume** (`med-w6gx.26` runs it for the hold range): (a) `pending-ios:` entries in the parity test; (b) Android beads closed since the catch-up baseline + their PRs (final contracts); (c) `git log <baseline>..master -- android/ web/` for shell-gated web changes; (d) `bd list --label pending-ios --status deferred` (now only `med-erq1.4`) then `bd undefer`, file iOS beads, refresh the feature matrix, run iOS smoke + upgrade checks before claiming parity.

## Feature matrix

Audited 2026-10-22 against the iOS hold baseline (bd med-nt9p.51): every iOS-shipped behaviour has a row; bridge ops are at parity (`PLATFORM_ONLY` = `chrome`, `clipboard.read`, both Android-only by design). One Android gap found and filed (med-nt9p.52).

Re-audited 2026-10-23 for iOS (bd med-w6gx.26) over `1ff23578..ab598cd5`: two iOS gaps filed (med-w6gx.27, med-w6gx.28); the Android `base.post` hardening (#1273, #1274) is folded into med-ta2n.26. The catch-up baseline stays at `1ff23578` until those and med-o7zq.47 are banked.

| Feature | iOS | Android | Status / reason |
|---|---|---|---|
| Account mode (cloud vault in WebView) | ✓ | ✓ | parity |
| Local mode (bundled app, no account) | `WKURLSchemeHandler` (`wgapp://local`) | `appassets` + `files.js` / `chrome.js` | divergent: platform loader |
| Local → cloud move (`move.stash` / `move.take` / `move.clear`, stash lifecycle; since onboarding v3 started from the web P3 sheet) | ✓ (med-o7zq.35) | ✓ (med-nt9p.32.17) | parity |
| Account → local leave (`leave.stash` / `leave.take` / `leave.clear`, Cancel returns to the account) | ✓ (med-o7zq.36.2, med-o7zq.42) | ✓ (med-o7zq.36.3, med-nt9p.43) | parity |
| `local.reset` forgets the remembered leave host | ✓ (med-w6gx.28, #1280) | ✓ (med-nt9p.43, #1217) | parity |
| Erase deletes the install record (`base.post` `/api/attest/delete`; `local.reset {dropAttest: true}` drops the attest key, never the trial pass) | ✓ (med-egb3) | ✓ (med-egb3) | parity: one PR, allowlist identity in the parity test |
| Mode-switch restore: Replace / Merge / Cancel choice, silent pickup Cancel, orphan-intake guard | ✓ | ✓ | parity: shared web (med-o7zq.37, .38, .40, .41, .42) |
| Page downloads (blob:/data:) | Files export picker (med-o7zq.43) | `ACTION_CREATE_DOCUMENT` picker, no shell dialog (med-nt9p.48) | parity: both go straight to the system picker; Share lives in the web sheet (hidden in the Android WebView) |
| `window.print()` → native print (incl. the offscreen print-doc iframe) | ✓ (med-w6gx.11) | ✓ (med-nt9p.10) | parity |
| File chooser (`<input type=file>`, `.age` / `.nxk` restore) | ✓ (med-2au7) | ✓ `ACTION_GET_CONTENT` `*/*` + `EXTRA_MIME_TYPES` (med-nt9p.10) | parity |
| Anonymous trial attestation (AI, food DB, voice) | App Attest (med-o7zq.16, .20, .23) | Play Integrity client shipped (med-nt9p.32.8.4), device-recall flag OFF | divergent: platform API; Android owner checks open: med-nt9p.32.8.5, .32.8.7, .32.8.9 |
| Trial reinstall rejoins the same device bucket | ✓ keychain pass (med-o7zq.26) | ✓ `wg_trial` prefs in the backup rules (med-nt9p.32.8.4, .32.5) | parity |
| Health data (BP + weight; sleep + workouts; steps, HR, SpO2) | HealthKit (med-w6gx.6, .7; steps/HR/SpO2 med-0xad.2) | Health Connect (med-nt9p.8, .9; steps/HR/SpO2 med-0xad.3) | divergent: platform API; iOS follow-ups med-w6gx.18 open |
| Health steps (daily totals), heart rate, SpO2 — bridge contract in the `web/static/js/native/health.js` header: `steps` is a windowed daily-aggregate query (`{type, from, to}` → `[{day, steps, tz}]`, one per local day), `hr` / `spo2` are anchored pages `{uuid, start, value}` (bpm; SpO2 percent 0-100) with `from` on the first read (90 days back) and `limit`/`more` honoured on that scan too; all HR samples incl. workout-rate; Health Connect asks for history access where offered; an unknown type rejects its query | ✓ HealthKit statistics + anchored queries (med-0xad.2; a first scan's `from` rides in the anchor) | ✓ Health Connect aggregate + change tokens (med-0xad.3, #1411) | divergent: platform API; web side shipped (med-0xad.1) |
| Reminders: local notifications from the horizon (replace-all, lapse notice, tap guard for another vault) | ✓ (med-w6gx.5, med-o7zq.9) | ✓ exact alarms + boot/update rearm (med-nt9p.7) | parity (iOS 64-slot cap is the platform's; Android caps at 200) |
| Reminder tap target: a dose opens its take/log sheet (row `url`, `ReminderPath` allowlist), else its section | ✓ (med-w6gx.20, #1102) | ✓ (med-nt9p.52) | parity |
| Reminder tap on a page without the deep-link router (e.g. unlock) loads the path | ✓ (med-w6gx.27, #1280) | ✓ (med-nt9p.53, #1273) | parity |
| Stale reminder tap: url passed unchanged; logged dose → "Already logged" toast, moved slot → MT6 (QA-proven) | ✓ (med-wi09.6, #1406) | ✓ (med-wi09.7) | parity |
| Notifications (bridge ops incl. `notifications.openSettings`) | ✓ | ✓ | parity |
| Telegram (needs sync) upsell | ✓ | ✓ | parity (web) (med-ta2n.18) |
| Account gone (`X-Account-Gone`) | ✓ → local mode, home `?invite=1` (med-ta2n.17) | ✓ → local mode, home `?invite=1` (med-ta2n.12, #1251) | parity |
| Load-error screen (503 / 404 / local), Try again keeps the `#claim=` fragment, renderer-crash reload | ✓ (med-w6gx.3, med-ckm5.15) | ✓ (med-ckm5.16, med-nt9p.32.14) | parity |
| Failed invite claim → native "Use another invite" exit | ✓ (med-w6gx.21) | ✓ (med-nt9p.20) | parity |
| Local app lock (`lock.status` / `lock.set`; lifecycle: resume, taps deferred, snapshot cover, bridge says `locked`, screen-off) | ✓ Face ID (med-o7zq.8, .39) | ✓ BiometricPrompt (med-nt9p.32.9) | parity |
| Switch account entry | Settings.bundle | launcher long-press shortcut (`MainActivity.kt`) | divergent: platform convention |
| Local-mode storage diagnostic (owner spike page) | Settings.bundle toggle, test builds (med-o7zq.1) | debug-only `LocalSpikeActivity` (med-nt9p.32.1) | divergent: build flavour, not user-facing |
| Native token mirror (N1 first run / N2 local intro deleted, kit v2.1) | ✓ mirror only (med-ta2n.17) | ✓ mirror only (med-ta2n.12) | parity |
| N3 lock / N4 load error / N5 web exit bar / N6 splash hand-off + `notifications.openSettings` (kit v2.1); N4 · local has no exit | ✓ (med-ckm5.15, med-ta2n.17) | ✓ (med-ckm5.16, med-ta2n.12) | parity |
| Status/navigation band colour sampled in paint order (sheet backdrops) | ✓ `Shell.pageJS` (med-o7zq.44) | ✓ `chrome.js` → `chrome` op | parity |
| Invite capture (applinks/App Links + `medtracker://`, pending slot, `invite.pending` / `invite.clear`, `local.leave` / `account.leave {url}`) | ✓ phase 2 (med-ta2n.11, med-ta2n.17) | ✓ phase 2 (med-ta2n.12.1 #1240, med-ta2n.12 #1251) | parity; Android owner device check med-ta2n.12.2 open |
| Add-device hand-off: `/d/<sub>#<slot>.<TK>` App Link/universal link + `medtracker://d/` into the pending slot; `local.leave {url, erase: true}` (10-minute, single-host flag) + `local.erase` (shared op) | ✓ (med-r1j2.7) | ✓ (med-r1j2.8) | parity; iOS: the AASA lists `/d/*` only with `HANDOFF_APP_LINKS=1` |
| In-app camera (add-device scanner `/claim#scan`, W5) + `app.openSettings` (shared op, AD13 "Allow camera in Settings") + `account.leave {then: "local", forget: true}` (marker `account.leave.forget`, /unlock "Back to local mode") | ✓ camera granted to own main frames only (med-r1j2.18) | ✓ (med-r1j2.19, #1362) | parity |
| `clipboard.read` (F1 Paste) | n/a (`navigator.clipboard` from the tap) | ✓ | Android-only: WebView has no clipboard-read prompt |
| `base.post` (local-mode invite request + feedback POST through the shell) | ✓ (med-ta2n.26) | ✓ (med-ta2n.27, med-nt9p.53, med-nt9p.54) | parity: contract med-ta2n.24 §A; allowlist identity in the parity test |
| Play Install Referrer → pending slot | n/a | ✓ (true first install only) | Android-only: Play |
| First launch = local mode (W1); native exits (Switch account, N4, account gone, `account.leave` no args) → local mode + `home?invite=1` (F1); no-url `local.leave` stays local | ✓ (med-ta2n.17) | ✓ (med-ta2n.12) | parity |
| Switch account / `forget()` from local mode drops the move stash | ✓ (med-ta2n.17) | ✓ (med-nt9p.49, med-ta2n.12) | parity |
| Late `history.back()` across a mode/account switch: off-origin reload guard | ✓ back/forward off the current mode/account cancelled before commit, never Safari (med-o7zq.47, #1280) | ✓ reload after an off-origin commit (#1251) | parity (divergent mechanism: iOS refuses before commit) |
| Native push (`push.token`, remote wake) | ✓ APNs, inert until the App Store profile carries Push (med-erq1.4, med-erq1.7) | ✓ FCM, inert until the owner's Firebase config (med-erq1.5, med-erq1.7) | parity (account mode only; device check after med-erq1.7) |
| System bars (`chrome` op) | n/a | ✓ | Android-only: system bars |
| `diag.append` + Copy diagnostics (passkey debug aid) | ✓ (error screen, ceremony dialog, Home Screen quick action) | ✓ (error screen, launcher shortcut) | parity (med-w6gx.24, med-nt9p.22) |
| Passkey ceremony serialisation + discoverable gets + PRF-probe retry | n/a (ASAuthorization) | ✓ (med-nt9p.19 #1110, #1116; shell-gated web fix in flight) | Android-only: WebView WebAuthn quirks |
| WebView tuning (textZoom 100, pinch-zoom, no overscroll glow, Safe Browsing off), portrait lock, `VIBRATE`, cookie flush on pause | n/a (WKWebView defaults / `UIRequiresFullScreen`) | ✓ (med-nt9p.28, .29, .30, .45) | Android-only: engine settings matching iOS defaults |
| Back gesture exits app | n/a | ✓ | Android-only: back-exit |
| System Back → the page's `AppBack.step()` (`wg:native-back`, `back.state {canStep}`; sheet → page → previous section, nothing at the root) | ✓ left-edge swipe, on only while `canStep`; never WebView history or Safari (med-y7b4.4) | ✓ OnBackInvokedCallback only while `canStep` (predictive back peeks the launcher at the root); pages that never report keep WebView history (med-y7b4.5) | parity (contract `web/static/js/native/back.js`) |
| Store packaging, reviewer access, device verification | open: med-w6gx.8, .13, .14, .15 | open: med-nt9p.11, .13; reviewer runbook ✓ med-nt9p.12 | n/a: per-store owner work |
| e2e flow QA scenarios | partial: local-mode flows (`ios.yml` `qa`, med-w6gx.23.x) | ✓ (`android/qa`: first-run, invite-link, native-*, lock, backup, move-ops, delete-account, not-found, load-error) | partial: iOS account flows are owner device checks ([ios.md](ios.md#owner-device-checklist-account-flows-need-a-passkey)); med-w6gx.23 |
| Visual QA scene driver + compare against master | ✓ (Simulator, med-y5xx.1–.4) | ✓ (`android-qa` `local-visual` + `tests/visual/compare.sh`, med-y5xx.9) | parity |
