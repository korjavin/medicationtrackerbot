# Launch post series — plan

10 posts · 2/week · 5 weeks · first person · **400–450 words soft limit, ~2 min read**.

Every post: **product consequence → mechanism → what it cost.**
Never two technical posts in a row without a broad one adjacent.
CTA in post 10 only.

## The arc

| # | Hook (first line) | Point | Ends on |
|---|---|---|---|
| 1 | My blood pressure got worse over one month last year, and I couldn't tell you why, because the answer was sitting in five apps that don't talk to each other. | The pitch, as a problem | That's not an accident |
| 2 | If every server on earth went dark tonight, I would open my app in the morning and seven months of my life would still be there. | Your devices hold the real copy; my cloud backup is a scrambled convenience you can self-host | **Anyone who can hand your record back to you can hand it to somebody else** |
| 3 | I asked an AI what changed in the month before my blood pressure got worse. It read seven months of my data. Nobody else saw a byte. | The payoff, early | Only works while the app is open — no server fallback |
| 4 | The part that should bother you: I still send you the code that holds your key. | Volunteering the hole before anyone finds it | What narrows it, what doesn't, why I published it |
| 5 | There is no password in this app. Not one, anywhere. | Passkey as a keyed PRF — nothing to grind, ever | No reset flow: the key comes out of the chip in your hand (the spec trap — `create()` says enabled, returns nothing — is a beat inside, not the ending) |
| 6 | I built reminders, then realised my server isn't allowed to know what the reminder is for. | Blind alarm clock | Stop opening the app and reminders lapse — by design |
| 7 | A record someone else can read gets softened, the same way people soften a number for a doctor. So I keep mine where nobody else can read it. Almost. Here is what still can. | The carve-outs, three activation classes | Not everything has a toggle, and I say which |
| 8 | The AI cannot do anything to my record that my own app cannot do. There is no second door for it to find. | Purity as the enabling constraint | One router, two callers |
| 9 | "Retire this device" and "my phone was stolen" are different buttons. I've only built one. | Revocation ≠ compromise recovery | The button copy tells the truth, and the second button waits until it can too |
| 10 | What question about your own health can't you answer right now, because the answer is split across five apps that don't talk to each other? | Recap + invite | The only CTA in the series |

## Second track — engineering notes

Too technical for the main feed, too good to cut. Long-form, off-cadence, dev audience
that has already self-selected. Published as posts on the repo/dev.to; the main track
links to them in passing, never depends on them.

| Note | Hook | Point |
|---|---|---|
| A | Two phones, no referee. Whoever wrote last wins — but "last" can't mean the clock. | Device handoff + merge. Ends on: the Cancel button that only cleared a local timer |
| B | My privacy policy is generated from my source code. Hand-editing it fails the build. | One manifest → docs, settings screen, CI guard. Ends on: can't add a data path without the build telling on you |

Post 7 may link note B as evidence for the carve-out list. That is the only cross-link.

## Format

- **LinkedIn** — 400–450 words, one asset, hook inside the first 210 chars (the "see more" cut).
- **X** — dropped (2026-08-10): LinkedIn only. No new threads.
- Assets, reuse verbatim: system diagram (`docs/architecture.md` §1), key hierarchy
  (`docs/cloud-crypto.md`), trust boundaries (`docs/security/threat-model.md` §3),
  screenshot of Settings → *What can the operator see?*.

## Rules

- **Posts 1–4 contain no jargon.** No "API", no "encryption", no "architecture".
  The audience hasn't self-selected yet.
- **No vanity metrics in any hook.** "4,261 commits" is proof inside post 10, never the
  front door.
- Post 3 needs a **real** answer, run against real data, screenshotted. If the answer is
  boring the post is dead — test this before week 1, not during it.

### From the 2026-08-06 editor pass

- **Every post ends with a one-line tease for the next** — a P.S. after the closer.
  Not a CTA, no links; it names unfinished business ("I'll show you the hole in this
  story myself").
- **The mic-drop fragment closer must not run 10-for-10.** Posts 5, 8 and 9 end on a
  plain declarative sentence instead; a formula repeated every post becomes a tell of
  its own.
- **The "said in the post, not in small print" honesty flex** appears at most once per
  pair of adjacent posts. Post 4 owns it fully; 2 keeps its instance, 3's was cut.
- **Post 10's hook flips post 1 to the reader** ("what question can't you answer across
  your apps?"), never a re-wear of post 1's opener — three posts (1, 3, 10) already
  lean on the same BP anecdote.
- **Post 7 hook candidate:** "A log a company can read gets softened the same way"
  (now a standalone pull-quote line in post 1) — stronger front door than "Here is
  everything that still leaves the vault", which assumes an already-sold reader.
- Tricolon budget: max two per post. Post 1 held four; two were flattened.

## Blocker before post 1

~~Repo still describes itself as "A small telegram bot to track medication."~~
**Done** (verified 2026-08-10): README and the GitHub description are both the
myhealthbot.ai rewrite on master. Remaining blockers are in the posts themselves:
post 3's real AI answer (run + screenshot) and post 10's invite-CTA mechanics.

## Cut

"Everything in one place" (SaaS fluff), standalone WebAuthn PRF gotcha (folded into 5),
gzip-before-encrypt snapshots, per-account CSP, "I deleted my API" (jargon, and post 8
is the better version of it).

## Invite CTA

Minted with `cmd/cloud invite`; no public signup, every reply is manual. The invite
message repeats post 2's line: lose every passkey **and** the recovery code and the data
is gone. No operator recovery exists, by design.

---

Reviewed independently by codex and agy. Both flagged the same three things: a six-post
technical cluster loses both audiences, cutting the honesty posts was the biggest
mistake, and "everything in one place" is fluff. Codex additionally caught that the AI
payoff was buried at post 11 — it is now post 3.

Multi-device merge and the generated privacy manifest moved to the second track: both
were mechanism-first with no product consequence a non-builder feels, and together they
made 5–8 four technical posts in a row.
