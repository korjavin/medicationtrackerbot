# Brief — Why get an invite (invite motivation)

Source: owner's TestFlight feedback 2026-10-24 (item 6 in `TestFlight feedback · work`). Bead: med-er5x.

## What's wrong now
A local-mode user meets "invite" with no reason attached:
- W1 footnote: a bare **How to get an invite** link next to Privacy policy.
- Request sheet: lede "Sync is invite-only for now. Leave your email…" (says *how*, never *why*).
- W5 Sync card: two facts (every device, server can't read it), then "Sync needs an invite for now".
Local mode is complete on its own, so the value of an account has to be stated, briefly and honestly.

## What an account adds (true today, for copy)
- Your records on every device (phone, tablet, any browser) — add a device with a code.
- Off-phone copy: lose or reset the phone and the records are still there (end-to-end encrypted; server can't read them).
- Reminders and logging in Telegram.
- Connect an AI assistant (MCP) to your own records.
- Share with a doctor or family; voice with your own ElevenLabs key; Mi Band import.
Not a reason: AI and the food database (the free trial already works in local mode).

## Screens wanted (390×844, kit v2 `wg-*`)
1. **W1 footnote** — replace the bare link with one line of value + link, e.g. "Want it on every device? Get an invite". Stays low-key: W1 is still "just open it and use it", no choice screen.
2. **Request sheet** (now "Request an invite") — top: 3 short facts (`wg-facts`) of what an account adds, then the existing email + note form. Title may change.
3. **W5 Sync card** — same facts set (max 3–4), consistent with the sheet; "needs an invite" line stays.
4. Optional: **W4 protect-your-data nudge** — one line pointing at sync as the off-phone copy, if it fits without a second sun.

## Neighbouring kit screens
`screens-onboarding-v3.html` W1, W4, W5, F1; `screens-settings.html` S6.

## Constraints
- Kit rules 1–8; one sun per view (the request sheet's sun stays "Send request").
- English only; no emoji; honest — no promises the app can't keep (no "unlimited", no "backup" wording that implies we can restore without the user's passkey/kit).
- Local mode must not read as second-class.

## Open UX questions
1. One shared facts list for W1 link target, sheet and W5 — or shorter on the sheet?
2. Lead benefit: "every device" or "safe if you lose your phone"? (owner's call)
3. Should the W1 link open the sheet directly (today) or a short "What an account adds" page first?
