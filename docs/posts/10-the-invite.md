# Post 10 — The invite

**Channel:** LinkedIn only
**Point:** recap of the series' promises in the reader's terms, then the only CTA of the series: an invite.
**Ends on:** the invite itself (CTA mechanics placeholder, then one warm plain sentence). No tease P.S. — it is the last post.
**Status:** draft; codex-reviewed 2026-08-06, formula fixes applied. Codex's five-beats-to-three recap compression deferred to the author. CTA mechanics placeholder still blocking.

---

## LinkedIn

What question about your own health can't you answer right now, because the answer is split across five apps that don't talk to each other?

Mine was about blood pressure. Yours might be about sleep, a new medication, or a spring you can't quite reconstruct. It has the same shape either way: every piece is logged somewhere, and nobody is paid to put the pieces together for you.

Nine posts ago I started describing what I built about that, and here is the whole of it, one sentence per promise. One record now holds the medications, readings, weight, sleep, food and notes those apps keep apart. The real copy lives on your devices, and what reaches my machine is noise it cannot read. You can point an AI at the whole record and get an answer while nobody else sees a byte. I published the biggest hole in that story myself rather than waiting for someone to find it. And where the product still falls short, the button says so plainly instead of implying safety it doesn't have.

The work behind those five sentences is 4,267 commits, a number that belongs at the end of a series and not in a headline.

Because this last post is an invitation. There is no signup page. I mint every invite by hand and answer every request myself; invites go out at the pace I can personally stand behind. And every invite carries the same warning I gave in post 2: if you lose every passkey and the recovery code, your data is gone for good. Nobody can recover it for you, least of all me, and that is by design.

If your apps are holding a question hostage, myhealthbot.ai is what I built to get mine back, and I would like to hand you a key.

[CTA MECHANICS: how to request an invite — author fills in]

I'll be on the other end when you ask.

---

## Constraint check

| Rule | Result |
|---|---|
| ≤400 words | 324 (measured, includes the placeholder line) |
| Hook inside 210 chars | 139 |
| Em dashes | 0 in prose (the em dash inside the bracketed CTA placeholder is the task-specified marker, not post text; it leaves with the placeholder) |
| Negative parallelism | none |
| Self-answered rhetorical one-liners | none; the hook question is left open for the reader |
| Tricolons | 1 ("sleep, a new medication, or a spring…") |
| Anaphora runs | none |
| Banned words | none |
| Product named once | once, final prose paragraph (CTA placeholder excluded per rules) |
| CTA | present — the only one in the series |
| No bare links in prose | clean; how to ask is deferred to the placeholder |
| No tease P.S. | correct, last post |
| Recap discipline | five beats, one sentence each, single paragraph |
| Closer | warm plain sentence after the CTA placeholder, no mic-drop fragment |

## Facts this post rests on

- Invites are minted by the operator; there is no public signup; every reply is handled
  manually by the author (LAUNCH-POSTS.md → Invite CTA).
- Losing every enrolled passkey **and** the recovery code makes the encrypted backup
  permanently unrecoverable; no operator recovery path exists, deliberately
  (docs/cloud-crypto.md; post 2's warning paragraph).
- The record spans medications, BP readings, weight, sleep, food and notes/diary
  (post 1's inventory; CLAUDE.md project overview).
- The real copy lives on the user's devices; the server stores only encrypted sync
  state it cannot read (post 2; docs/cloud-mode.md → privacy boundary).
- The AI reads the record through a blind relay with on-device compute; nobody else
  sees plaintext (post 3; docs/cloud-mode.md → MCP).
- "The biggest hole, published myself" is post 4: the operator serves the JavaScript
  that holds the key (docs/security/release-integrity.md).
- "The button says so" is post 9: device retirement vs. compromise recovery, honest
  copy instead of implied safety.
- **4,267** is the real measured commit count: `git rev-list --count HEAD` on
  2026-08-06 in this worktree.

## Verify with the author / Open items

- **Refresh the commit count on publish day**: rerun `git rev-list --count HEAD`,
  update the prose and this table.
- **Fill the CTA mechanics placeholder** — the post cannot publish with it in.
- "Nine posts ago" and "post 2" assume the series published in plan order on one
  channel; confirm before publish.
- The post says "every passkey"; post 2 phrased the same warning as "every device you
  have set up". Confirm the author is happy naming passkeys by post 10 (the no-jargon
  rule covers posts 1–4 only).

## Provenance

Drafted solo by claude against the plan row for post 10, the 2026-08-06 editor pass
(hook must flip post 1 to the reader; the commit number allowed inside, never as the
hook), posts 1–3 for voice, and docs/cloud-mode.md for factual bounds. Commit count
measured, not estimated. Not yet cross-critiqued by a second model.
