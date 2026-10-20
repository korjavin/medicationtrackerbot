# Brief: onboarding v3 — "just open it and use it"

Status: owner-approved hypotheses (2026-10-20), awaiting design. Supersedes
the first-run parts of kit v2.1: **N1** (local/invite choice), **N2** (local
intro wall) and the placement of **O1** (Emergency Kit inside signup). Kit
v2.1 tokens, components, N3–N6, S6–S9, D1 and A1 stay.

## Problem

Today the very first screen asks a stranger to choose between "only on this
device" and "I have an invite", then explains vaults, passkeys and loss risk
before they have logged a single pill. People who found the app in a store
don't know our encryption story and shouldn't need to.

## Principles

- The app works on first launch. No choice, no QR, no account.
- Cloud sync is a **feature you turn on**, not a mode you pick up front.
- The words *encryption*, *key*, *vault*, *passkey* do not appear in
  onboarding. Say "sign in with Face ID / fingerprint".
- Risk talk (lose the phone → lose the data, Emergency Kit) comes later, as a
  nudge, when the user has something worth protecting.

## Paths

### P1 — installed from the App Store / Google Play

1. Splash (N6) → **Welcome: what do you want to track?** One screen, module
   picker (meds, BP, weight, workouts, sleep, food, diary). Skippable.
2. **AI trial offer** — the A1 onboarding step. A new user won't paste their own
   AI key into an app they just found; the trial is how they discover what
   the assistant does. This step should *sell*, not just inform: show what it
   does for them. One tap to start, easy to skip.
3. Today, in local mode, with empty-state hints for the picked modules.
4. Notifications are asked in context (O3), not here.
5. Later: a **protect-your-data nudge** (e.g. after ~7 days or ~20 records):
   "Your log is a week old. Back it up or turn on sync?" → Backup (S7) or the
   sync setup.
6. Settings → **Sync & backup** card: the entry point to cloud. Everything
   cloud-specific (sign in with Face ID, Emergency Kit, what the server can
   and can't see) lives behind it.

### P2 — arrived via an invite link or QR (app not installed)

The invite is a single-use link, valid 14 days, that claims one prepared
account.

1. **Invite landing page** (web). Detects the platform and shows **one**
   button: "Get the app for iPhone" / "Get the app for Android". Secondary:
   "Continue in the browser" (the PWA stays a supported path).
   On a desktop it shows a QR: "Scan with your phone's camera".
2. After install the invite must reach the app:
   - **Android:** the store link carries the invite (Play Install Referrer).
     On first launch the app sees it and goes straight to "Sign in with your
     fingerprint" → (welcome picker, trial) → Today. Seamless, no QR.
   - **iPhone:** there is no reliable automatic hand-off. The app starts in
     local mode as in P1. The landing page in Safari stays on "Installed? Tap
     to continue", which opens the app with the invite (universal link) →
     P3. Fallback: the app's first screen can offer "Have an invite? Paste"
     (system paste button, no scary prompt) or "Scan QR".
3. The Emergency Kit is **not** in this flow; it arrives as the P1 nudge.

### P3 — invite opened when the app is already installed (local mode)

"Turn on sync? Your records move to your account." → sign in with Face ID /
fingerprint → done. This is the existing seamless Move with friendlier words.
The same screen serves the iPhone continuation of P2 and any later invite.

## Screens wanted (390×844, kit v2.1)

| id | screen |
|---|---|
| W1 | Welcome — module picker (replaces N1/N2) |
| W2 | AI trial offer, onboarding variant (sells the value; ties to A1) |
| W3 | Today first run, local, empty-state hints for chosen modules (revises O2) |
| W4 | Protect-your-data nudge (card on Today + the sheet it opens) |
| W5 | Settings → Sync & backup card and the sync setup flow (Face ID sign-in, then Emergency Kit offer) |
| L1 | Invite landing — phone (iPhone / Android variants, "Continue in browser") |
| L2 | Invite landing — desktop (QR) |
| L3 | Invite landing — "Installed? Tap to continue" state (iPhone) |
| P3 | "Turn on sync?" in-app confirmation for an incoming invite |
| F1 | First-launch "Have an invite?" affordance (low-key, not a choice screen) |

## Constraints

- Kit v2.1 only (`wg-*` tokens/components). Native shells mirror the tokens;
  N3 lock, N4 error, N6 splash are unchanged.
- English copy.
- No real hostnames, handles or tokens in mock-ups.

## Open questions for the designer

1. W1: one screen with a grid of modules, or a short 2–3 step chat-like flow?
2. W2: where is the line between "urge" and "pushy"? What does the user see
   before starting the trial — a demo answer, a sample prompt?
3. W4: card on Today, banner, or Settings badge? What happens when dismissed?
4. F1: does the "Have an invite?" link belong on W1, or only in Settings?
5. L1: how much do we explain on the landing page — one sentence or none?
