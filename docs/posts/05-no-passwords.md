# Post 5 — No passwords, anywhere

**Channel:** LinkedIn only
**Point:** the passkey is a keyed function, not just a login: the face/fingerprint unlock derives the key material, so there is nothing on the server to grind offline, ever. Includes the spec trap: create() can report the feature enabled and return nothing.
**Ends on:** a plain declarative sentence (editor pass: no mic-drop fragment on this one), then a P.S. teasing post 6.
**Status:** draft; codex-reviewed 2026-08-06, formula fixes applied. Codex's suggestion to compress the spec-trap paragraph deferred to the author (it is the plan's designated ending beat).

---

## LinkedIn

There is no password in this app. Not one, anywhere.

Every password system ends the same way: somewhere there is a list of scrambled passwords, someone steals the list, and a computer in a basement starts guessing. Humans choose guessable secrets, and the machines doing the guessing never sleep. The breach emails you get are the paperwork of that system.

So I refused to build one. When you unlock my app with your face or fingerprint, a chip in your device does more than say "yes, that's them." Handed a fixed question, it computes an answer from a secret sealed inside the hardware, the same answer every time, and that answer is the raw material the app turns into the key that opens your record. The secret never leaves the chip. No human chose it, so there is nothing to guess, and nothing you could type into a fake login page. Steal my whole server and there is still nothing to grind offline, because it holds only your record locked under keys it has never seen. Even the recovery code you write down on day one is 160 random bits.

This is the passkey standard doing a second job. Most sites use passkeys to sign you in. I also use them as the machine that mints your key.

That second job has a trap I want on record. When the app creates a passkey, the browser can report the key-minting feature as enabled and still hand back nothing, because the standard treats the answer at creation time as optional. So my app never trusts that word. Right after creating a passkey it turns around and asks the fresh passkey for the actual answer, one extra face-check in the same breath. If the answer comes back empty, the app rejects that passkey on the spot and tells you, before a single byte of your record gets locked under a key that could never be derived again. The alternative was discovering that at unlock time, on a device that could no longer open anything.

That is why myhealthbot.ai has no reset flow, no security questions, and no email loop. The key comes out of the chip in your hand, and my server only ever meets the locked result.

P.S. Still ahead: I built reminders, then realised my server isn't allowed to know what the reminder is for.

---

## Constraint check

| Rule | Result |
|---|---|
| ≤400 words | 395 (measured with the awk/wc pipeline, includes the P.S.) |
| Hook inside 210 chars | 52 |
| Em dashes | 0 |
| Negative parallelism | none added; the hook's "Not one, anywhere." is the plan's grandfathered instance |
| Tricolons | 2 (list/steal/guess; reset flow/questions/email loop) |
| Anaphora runs | none |
| Banned words | none |
| Straight quotes | yes |
| No CTA, no link | clean |
| Product named once, late | once, final paragraph |
| Ends on a plain declarative sentence | yes: "The key comes out of the chip in your hand, and my server only ever meets the locked result." |
| P.S. teases post 6 | yes, post 6's exact hook |

## Facts this post rests on

- No passphrases anywhere; unlock is a passkey ceremony; the recovery code is the only writable thing and is a backup credential, not a memorized secret (docs/cloud-crypto.md, core stance + R1).
- The passkey acts as a keyed pseudo-random function: deterministic 32-byte output per (credential, salt), released only after user verification; secret never leaves the authenticator (docs/cloud-crypto.md, "The enabling primitive").
- Nothing to grind offline: every wrap key is ≥128 bits of true entropy; full DB theft yields ciphertext and metadata only (docs/cloud-crypto.md, R3 + R5).
- Recovery code is 160 random bits, Crockford base32, printed in the Emergency Kit (docs/cloud-crypto.md, "Recovery envelope").
- Origin-binding kills fake login pages: a look-alike site cannot run an assertion for the real RP ID (docs/cloud-crypto.md, security analysis table).
- The spec trap, as documented: some authenticators do not return PRF outputs during create(), only `enabled: true`; the enrollment ceremony always follows registration with an immediate get() on the new credential; "Never rely on PRF-at-creation" (docs/cloud-crypto.md, "Registration caveat").
- The code does exactly that: web/cloud/js/signup.js runs a `navigator.credentials.get()` with the fixed salt right after create(), and if `prf?.results?.first` is empty it renders the unsupported-authenticator screen before any envelope is written (signup.js lines 152-166; KEK derivation in web/cloud/js/crypto.js `deriveKEK`).

## Verify with the author / Open items

- "one extra face-check in the same breath" — the immediate get() does trigger a second user-verification prompt on most platforms; confirm this matches observed behavior on the devices you demo with, or soften to "a second check".
- "nothing you could type into a fake login page" leans on passkey origin-binding; kept short here since post 4 owns the code-serving caveat. Confirm you're happy with the adjacency.
- Post 2 already introduced the recovery code; this post adds its entropy. One-sentence overlap, kept because the grind claim is incomplete without it.

## Provenance

Drafted by claude subagent from the plan row (LAUNCH-POSTS.md, post 5) and the 2026-08-06 editor pass, facts checked against docs/cloud-crypto.md and web/cloud/js/signup.js + crypto.js; pending codex review.
