# Launch post series — plan

12 posts · 2/week · 6 weeks · first person · **400 words max, ~2 min read**.

Every post: **product consequence → mechanism → what it cost.**
Never two technical posts in a row without a broad one adjacent.
CTA in post 12 only.

## The arc

| # | Hook (first line) | Point | Ends on |
|---|---|---|---|
| 1 | Your health data is split across five apps, and the whole picture — the sensitive one — is the part nobody hands back to you. | The pitch, as a problem | That's not an accident |
| 2 | Every health app promises not to sell your data. I can't verify that. Neither can you. | I didn't ask to be trusted — I built it so I can't read it | I also can't reset your password. **If I could help you, I could read you** |
| 3 | I asked an AI what changed in the month before my blood pressure got worse. It read seven months of my data. Nobody else saw a byte. | The payoff, early | Only works while the app is open — no server fallback |
| 4 | Here's the part that should bother you: I still send you the JavaScript that holds your key. | Volunteering the hole before anyone finds it | What narrows it, what doesn't, why I published it |
| 5 | There is no password in this app. Not one, anywhere. | Passkey as a keyed PRF — nothing to grind, ever | The spec trap: `create()` says enabled, returns nothing |
| 6 | I built reminders, then realised my server isn't allowed to know what the reminder is for. | Blind alarm clock | Stop opening the app and reminders lapse — by design |
| 7 | Two phones, no referee. Whoever wrote last wins — but "last" can't mean the clock. | Device handoff + merge | The Cancel button that only cleared a local timer |
| 8 | My privacy policy is generated from my source code. Hand-editing it fails the build. | One manifest → docs, settings screen, CI guard | Can't add a data path without the build telling on you |
| 9 | Here is everything that still leaves the vault. I keep the list because burying it is the actual lie. | The carve-outs, three activation classes | Not everything has a toggle, and I say which |
| 10 | The AI and my UI run the exact same code path. There is no second copy. | Purity as the enabling constraint | One router, two callers |
| 11 | "Retire this device" and "my phone was stolen" are different buttons. I've only built one. | Revocation ≠ compromise recovery | Honest copy instead of implied safety |
| 12 | Seven months ago I couldn't answer a simple question about my own health. | Recap + invite | The only CTA in the series |

## Format

- **LinkedIn** — 400 words, one asset, hook inside the first 210 chars (the "see more" cut).
- **X** — same beats, 4–7 tweets.
- One draft per idea, two shapes. Never two different pieces.
- Assets, reuse verbatim: system diagram (`docs/architecture.md` §1), key hierarchy
  (`docs/cloud-crypto.md`), trust boundaries (`docs/security/threat-model.md` §3),
  screenshot of Settings → *What can the operator see?*.

## Rules

- **Posts 1–4 contain no jargon.** No "API", no "encryption", no "architecture".
  The audience hasn't self-selected yet.
- **No vanity metrics in any hook.** "4,261 commits" is proof inside post 12, never the
  front door.
- Post 3 needs a **real** answer, run against real data, screenshotted. If the answer is
  boring the post is dead — test this before week 1, not during it.

## Blocker before post 1

Repo still describes itself as *"A small telegram bot to track medication."* Every link
in the series lands there. Rewrite description + README first.

## Cut

"Everything in one place" (SaaS fluff), standalone WebAuthn PRF gotcha (folded into 5),
gzip-before-encrypt snapshots, per-account CSP, "I deleted my API" (jargon, and post 10
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
