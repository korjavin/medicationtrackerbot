# Brief — Choose reminder detail when enabling notifications

Source: owner's TestFlight feedback 2026-10-24 (item 7 in `TestFlight feedback · work`). Bead: med-mt0l; then web + iOS/Android twins.

## What's wrong now
Reminders default to generic text ("Medication time"). The only way to get the medication name is Settings → Reminders & notifications → Lock-screen text → Detailed (S8). The owner found it only because they knew; a user won't.
The permission ask (O3 sheet "Let Med Tracker remind you") mentions "unless you choose detailed text" but offers no way to choose. The first-run W1 path ("Allow notifications" under Medications) goes straight to the system prompt with no ask sheet at all.

## Screens wanted (390×844, kit v2 `wg-*`)
1. **O3 ask sheet + choice** — the lock-screen choice in the sheet: Generic / Detailed (`wg-choices`) with the existing `wg-notif` preview updating live. Default stays Generic (privacy). Sun stays "Allow notifications".
2. **W1 path** — after the system prompt grants, where does the choice show? (inline under Medications, or the same O3 sheet minus the Allow step).
3. **First-reminder hint** — the take sheet opened from a generic reminder shows a quiet one-time line: "Want the medication name on the lock screen? Show details" → sets Detailed in place, toast with Undo. Shown once, dismissible.

## Neighbouring kit screens
`screens-onboarding.html` O3; `screens-settings.html` S8; `screens-meds.html` M2 (take sheet); `screens-onboarding-v3.html` W1.

## Scope
Local mode only. In an account, device reminders (web push and the iOS/Android shells) always carry the full text; Generic/Detailed there shapes only Telegram (Steve/Webb, 2026-10-24). The account ask sheet keeps its "Reminders name the medication or measurement that is due" fact. (Not here: a Generic option for account lock screens — separate product question.)

## Constraints
- Kit rules 1–8; one sun per view; no native controls.
- The privacy line stays: "Anyone holding your phone can read the lock screen, even while it is locked."
- Same design for iOS and Android (native shells render the web page; system prompt differs only).

## Open questions
1. Hint on the first reminder: take sheet only, or also Today's Next up card?
