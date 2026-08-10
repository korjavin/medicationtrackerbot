# Post 6 — The blind alarm clock

**Channel:** LinkedIn only
**Point:** the blind alarm clock. The browser computes the reminder schedule inside
the vault and hands the server an opaque list of times; the server fires pushes on
time without knowing what any of them mean. Honest cost included: stop opening the
app and the schedule runs out, by design.
**Ends on:** reminders lapse if you never open the app, and that is deliberate.
(a one-line tease for post 7 follows as a P.S.)
**Structure:** motivated derivation (per the 2026-08-10 style decision, modeled on privacypass.github.io/protocol): task framed up front (ring me without knowing why), two numbered attempts each broken by a "Problem:" beat (server reads the schedule; phone rings itself), then the shipped split, then the deliberately unpatched final break (the stack runs dry). The repeated "Attempt / Problem:" labels are the style's scaffold, not a formula violation.
**Status:** draft; codex-reviewed 2026-08-06, honesty scoping and formula fixes applied. Rewritten 2026-08-10 in the derivation style; hook, lapse-is-deliberate ending, closer, and P.S. unchanged. Revdiff annotation 2026-08-10 addressed: attempt two's problem also names delivery flexibility — the knock should reach me wherever I am (browser, messenger), not just the one phone.

---

## LinkedIn

I built reminders, then realised my server isn't allowed to know what the reminder is for.

The task sounds ordinary: ring me at eight so I take the pill. But everything my server stores was sealed on my devices before it arrived, so the machine that should ring me has no idea I take anything.

Attempt one: the server reads my schedule and rings me, like every reminder service. Problem: there is no schedule to read, and handing it one would unseal the exact data this product exists to keep sealed.

Attempt two: skip the server, let the phone ring itself. Problem: an app that is not open is asleep, and a bell wired to one phone is the wrong shape. I want the knock wherever I am, in my browser or my messenger, and something outside has to know when to deliver it.

The shipped design splits the job: the thinking happens where the data is, and only the ringing leaves. On my phone, inside the vault, the app works out every reminder for the week ahead and hands the server a plain list: at this minute, deliver this sealed envelope. The server is an alarm clock with a stack of letters it cannot open. At the appointed minute it forwards the envelope through the browser's push service, wrapped in a second layer of scrambling so that middleman cannot read it either. My phone unseals it at the last moment and shows "BP pill, 10 mg". If the vault is locked, it shows a generic "medication reminder" instead. What my server learns from all this: a list of times, how many envelopes, how big, which browser, and when I last opened the app. That inventory sits on a Settings screen. Even the snooze button's meaning travels inside the seal.

One last break, and I chose not to patch it. The list reaches a week ahead, and every app open rebuilds it, so in normal use it never runs dry. But stop opening the app entirely and the stack empties, and the server cannot add a single entry, because writing a reminder means knowing what it is for. All it can do is notice the stack is nearly out and send the one message it composes itself, identical for every user: open the app to keep reminders running.

So yes, walk away for good and after a week the reminders stop. That is myhealthbot.ai declining to know me even when knowing me would be convenient.

An alarm clock that never needs winding is an alarm clock that has read your schedule.

P.S. The next one is the short list of what does leave the vault, toggles and no-toggles alike.

---

## Constraint check

| Rule | Result |
|---|---|
| ≤450 words | 449 (measured: `awk '/^## LinkedIn/{f=1;next} /^---$/{if(f)exit} f' 06-blind-reminders.md \| wc -w`; the "and that is deliberate" echo dropped 2026-08-10 — the "declining to know me" sentence carries that beat alone) |
| Hook inside 210 chars | 90 |
| Em dashes | 0 |
| Negative parallelism | none |
| "Not X. Not Y. Just Z." | none |
| Self-answered rhetorical one-liners | none |
| Tricolons (max 2) | 0 (the "learns" list is five items, kept as a flat inventory) |
| Anaphora runs | none |
| Banned words | 0 hits |
| Straight quotes | yes |
| Prose only, no bullets | yes |
| Product named once, late | once, penultimate paragraph |
| No CTA, no links | clean |
| Ends on lapse-is-deliberate + earned closer | yes; P.S. teases post 7 |

## Facts this post rests on

- The server is a blind alarm clock: the client computes the horizon and uploads
  `(fire_at, app_ciphertext)` rows, replace-all per sync; the server cannot compute
  "when is the next dose" (docs/architecture.md §5; docs/cloud-mode.md → Push relay
  & reminder lifecycle).
- Horizon length is **7 days** (`FORECAST_DAYS = 7`, `web/domain/reminders.js`),
  capped at 500 entries client-side; the relay accepts up to 2000 entries, 4KB
  ciphertext each (`internal/cloudserver/push.go`).
- Two encryption layers: NK app-layer ciphertext inside RFC 8291 Web Push, so the
  push service (FCM/APNs/Mozilla) and the operator each see only their own layer
  (docs/architecture.md §5; docs/cloud-mode.md privacy table, "Push reminder relay").
- What the server sees: fire times, entry count, ciphertext sizes, subscription
  endpoints (browser vendor), last-sync time. Reminder *kind* (bp/weight/medication)
  and snooze semantics ride inside the NK ciphertext (docs/cloud-mode.md,
  "Notification actions").
- Locked-vault fallback: SW shows a generic "Medication reminder" when the NK is
  unavailable (docs/cloud-mode.md → Push relay & reminder lifecycle, step 3).
- Horizon refresh on every app open; dry-queue safety net: server sends a generic,
  fixed-wording, content-free warning ("Open the app to keep reminders running"),
  fired by the hourly stale-sync sweep when the queue is within 120h (5 days) of
  running dry and the account hasn't synced in 24h, at most once per day
  (`internal/cloudserver/relay.go:27-50`; docs/cloud-mode.md → Dry-queue safety net).

## Verify with the author / Open items

- **Doc/code discrepancy on horizon length:** docs/cloud-mode.md says "default 30
  days, configurable"; the shipped code says 7 days, not configurable
  (`FORECAST_DAYS = 7`). The post says "a week ahead" per the code. If 30 days is
  the intended future default, either fix the doc or confirm the post's number
  before publish.
- The dry-queue email fallback (docs/cloud-mode.md mentions "if an email is on
  file, an email fallback") was left out for word budget; confirm it exists in
  shipped code before ever citing it.
- "BP pill, 10 mg" is the example string from docs/cloud-mode.md; confirm it
  matches a real rendered notification if a screenshot is attached.

## Provenance

Drafted by claude subagent from the plan row (LAUNCH-POSTS.md #6) and the fact
sources above, pending codex review.
