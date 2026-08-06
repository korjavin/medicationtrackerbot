# Post 6 — The blind alarm clock

**Channel:** LinkedIn only
**Point:** the blind alarm clock. The browser computes the reminder schedule inside
the vault and hands the server an opaque list of times; the server fires pushes on
time without knowing what any of them mean. Honest cost included: stop opening the
app and the schedule runs out, by design.
**Ends on:** reminders lapse if you never open the app, and that is deliberate.
(a one-line tease for post 7 follows as a P.S.)
**Status:** draft; codex-reviewed 2026-08-06, honesty scoping and formula fixes applied.

---

## LinkedIn

I built reminders, then realised my server isn't allowed to know what the reminder is for.

A normal reminder service reads your schedule and rings you. Mine can't do the first half. Everything it stores for me was sealed on my own devices before it arrived, so the machine holding my backup has no idea I take anything at all, let alone at eight in the morning.

So the app does the thinking where the data is. On my phone, inside the vault, it works out every reminder for the week ahead and hands the server a plain list: at this minute, deliver this sealed envelope. The server is an alarm clock with a stack of letters it can't open. When a time comes up, it forwards the envelope through the browser's push service, wrapped in a second layer of scrambling so that service can't read it either. My phone unseals it at the last moment and shows "BP pill, 10 mg". If the vault is locked, it shows a generic "medication reminder" instead.

From all this my server learns a list of times, how many entries there are, how big each envelope is, which browser to deliver through, and when I last opened the app. The full inventory sits on a Settings screen. Even the snooze button's meaning travels inside the seal.

Now the cost. Every time I open the app, the list is rebuilt and reuploaded, so in normal use it never runs out. But it only reaches a week ahead. Stop opening the app entirely and the stack runs dry, and the server cannot add a single entry, because writing a reminder means knowing what it is for. All it can do is notice, from the sync times it does see, that the stack is a few days from empty, and send the one message it composes itself, fixed wording, identical for every user: open the app to keep reminders running.

So yes, walk away for good and after a week the reminders stop, and that is deliberate. That is myhealthbot.ai declining to know me even when knowing me would be convenient.

An alarm clock that never needs winding is an alarm clock that has read your schedule.

P.S. The next one is the short list of what does leave the vault, toggles and no-toggles alike.

---

## Constraint check

| Rule | Result |
|---|---|
| ≤400 words | 389 (measured: `awk '/^## LinkedIn/{f=1;next} /^---$/{if(f)exit} f' 06-blind-reminders.md \| wc -w`) |
| Hook inside 210 chars | 90 |
| Em dashes | 0 |
| Negative parallelism | none |
| "Not X. Not Y. Just Z." | none |
| Self-answered rhetorical one-liners | none |
| Tricolons (max 2) | 0 (the "learns" list is four items, kept as a flat inventory) |
| Anaphora runs | none |
| Banned words | 0 hits |
| Straight quotes | yes |
| Prose only, no bullets | yes |
| Product named once, late | once, paragraph 6 |
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
