# Post 9 — Two buttons, one built

**Channel:** LinkedIn only
**Point:** revocation is not compromise recovery. Removing a device's future access
exists today; truly evicting a compromised device (fresh keys, fresh snapshot,
everything signed out) is designed but not built, and a stolen unlocked device may
already hold everything it saw. The product says so in its own copy.
**Ends on:** a plain declarative sentence: "So the button copy tells the truth, and the
second button waits until it can too." (P.S. teases post 10, the recap + invite.)
**Status:** draft; codex-reviewed 2026-08-06, shipped/designed paragraphs split, rotation detail compressed to user cost.

---

## LinkedIn

"Retire this device" and "my phone was stolen" are different buttons. I've only built one.

Retiring works today. Remove an old phone from your account and my server forgets that phone's passkey and destroys the sealed key packet only that passkey could open, both in one motion. Its next request is refused. Your data keys do not change, because for a device still in your own drawer they do not need to.

A stolen phone that was left unlocked is a different problem. That phone already holds a readable copy of everything it had synced, and its own copy of the key. Removing its access closes the door on the future and does nothing about the past, because the past is sitting on hardware in someone else's pocket, where nothing I run can reach.

Real recovery from that is a bigger machine: new keys, the whole record re-sealed under them, every device signed out at once so you add each one back from the phone you still hold. I have it designed down to the last failure case. I have not built it. Until I have, the advice after losing an unlocked phone is to assume everything logged up to that day is readable.

And that is roughly what the app tells you today. Press remove and the warning says: use this for a device you still control; if it was lost or stolen, this alone does not protect your data.

The stolen-phone screen does not exist yet. When it ships, it is specified to open under a heading most products would never print: "What this cannot do." New keys protect what happens next. They cannot un-leak what already left.

The tempting version was one button with soft copy, and I understand why products ship it. But {{product}} has exactly one pitch, that nobody else can read your record, and that pitch dies the first time the product implies a safety it does not have. So the limitation is stated in the button itself, at full volume, on the day you need it.

So the button copy tells the truth, and the second button waits until it can too.

P.S. Next post is the last one: the whole story in one piece, and the only time in this series I will ask you for anything.

---

## Constraint check

| Rule | Result |
|---|---|
| ≤400 words | 385 (measured with the awk pipeline) |
| Hook inside 210 chars | 90 |
| Em dashes | 0 |
| Negative parallelism / "Not X. Not Y." | none |
| Self-answered rhetorical one-liners | none |
| Tricolons (max 2) | 1 ("new keys, the whole record re-sealed under them, every device signed out at once") |
| Anaphora runs | none |
| Banned words | 0 hits |
| Straight quotes only | yes |
| Prose paragraphs, no bullets | yes |
| No CTA, no link | clean |
| Product named exactly once, late | once, paragraph 6 |
| Ends on the beat | "So the button copy tells the truth, and the second button waits until it can too." — a full declarative closer (breaks the epigram run per the 2026-08-10 pass), then P.S. tease for post 10 |

## Facts this post rests on

- What removal does today: `DELETE /api/devices/{credential_id}` deletes the
  credential row and its envelope in one transaction and touches nothing else — not
  snapshots, oplog, push, or data keys (`internal/cloudstore/repo.go:686-726`,
  `DeleteCredentialWithEnvelope`; summarized in docs/cloud-key-rotation.md §1.1). A
  last-credential guard refuses to strand the account.
- "Its next request is refused": sessions are stateless; revocation happens because
  `RequireSession` checks `CredentialExists` on every account-scoped request
  (`internal/cloudserver/session.go:142-146`, docs/cloud-key-rotation.md §1.2).
- "forgets that phone's passkey": the server deletes only its own credential record.
  A passkey synced into iCloud Keychain or similar keeps existing there; it just can
  no longer authenticate to this service (docs/cloud-key-rotation.md §0). The post's
  phrasing stays on the server side and does not claim the passkey itself is erased.
- Rotation is **a design proposal, not implemented**: docs/cloud-key-rotation.md
  header ("Status: design proposal, not yet implemented") and docs/cloud-crypto.md
  ("DEK rotation is a documented gap").
- A stolen unlocked device holds a full plaintext mirror plus the DEK; rotation
  stops future access only and "cannot un-leak the past"
  (docs/cloud-key-rotation.md §0; docs/security/threat-model.md:262-266).
- v1 rotation signs out every other device, which must be re-added from the
  initiating one — the "add each one back" cost is stated in the design's own user
  copy (docs/cloud-key-rotation.md §3.3, §7.2).
- Today's shipped UI copy (paraphrased in the post, marked "roughly"): the single
  Revoke button's confirm dialog reads "Use this to retire a device you still
  control. If it was lost or stolen, revoking here does not protect your data on its
  own…" (`web/cloud/js/devices.js:169-173`).
- The "What this cannot do" heading is in the **designed** compromise screen
  (docs/cloud-key-rotation.md §7.2), not in shipped product; the post says
  "is specified to open", not "opens".

## Verify with the author / Open items

- **Status check at publish date**: if any part of rotation ships before this post
  runs, "I have not built it" flips and the post needs a rewrite, not a patch.
- Today's confirm dialog points users at "the recovery guide about rotating your
  keys"; confirm such a user-facing guide actually exists or is planned — the post
  deliberately does not mention it.
- Author comfort check: the post states publicly that stolen-device recovery is
  unbuilt. This is already public in the repo docs, but confirm it is a disclosure
  he wants amplified on LinkedIn.
- "I have it designed down to the last failure case" rests on the design doc's
  crash-point table (§6.4) and acceptance criteria (§9); author to confirm he
  stands behind "the last failure case".

## Provenance

Drafted solo by claude against the plan row (post 9), LAUNCH-POSTS.md rules including
the 2026-08-06 editor pass, and the voice of posts 1–3, with every mechanism claim
checked against docs/cloud-key-rotation.md, docs/cloud-crypto.md,
docs/security/threat-model.md, and the live code (`internal/cloudstore/repo.go`,
`internal/cloudserver/session.go`, `web/cloud/js/devices.js`). Not yet
cross-critiqued by a second model or reviewed by the author.
