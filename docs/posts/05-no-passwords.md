# Post 5 — No passwords, anywhere

**Channel:** LinkedIn only
**Point:** the passkey is a keyed function, not just a login: the face/fingerprint unlock derives the key material, so there is nothing on the server to grind offline, ever. Includes the spec trap: create() can report the feature enabled and return nothing.
**Structure:** motivated derivation (per the 2026-08-10 style decision, modeled on privacypass.github.io/protocol): four numbered attempts, each broken with an explicit "Problem:" beat, arriving at the shipped design; the spec trap is the final break. The repeated "Attempt / Problem:" labels are the style's deliberate scaffold, not a formula violation.
**Ends on:** a plain declarative sentence (editor pass: no mic-drop fragment on this one), then a P.S. teasing post 6.
**Status:** rewritten 2026-08-10 in the derivation style; hook, ending beat, spec-trap placement, and P.S. unchanged from the codex-reviewed 2026-08-06 draft. "One extra face-check" softened to "a second check" (unverified cross-platform behavior). Revdiff annotations 2026-08-10 addressed: (1) the shipped-design paragraph states explicitly that the passkey is not an entry ticket to a cloud holding the data — it mints the key on-device and nobody ever sees a password, a private key, or the record unlocked; (2) the real task is framed up front, before the ladder — not authenticating a user but minting a key that is too strong to guess yet impossible to lose (reliability is carried by "the same answer every time" in the shipped-design paragraph); attempt four's pivot was trimmed since the intro now owns it; (3) attempt two rephrased for data sovereignty — "your app scrambles the password before sending it", never "I scramble"; (4) attempt three's problem also covers watching/copying the typed secret, not just phishing.

---

## LinkedIn

There is no password in this app. Not one, anywhere.

The task here was never login. Your record is locked on your device before it goes anywhere, and the real task is minting the key that locks it: too strong to guess, yet impossible to lose. Every familiar design fails one of the two. Watch.

Attempt one: you pick a password. Problem: humans pick guessable secrets, and the machines doing the guessing never sleep.

Attempt two: your app scrambles the password before sending it; my server keeps only scrambled copies. Problem: someone steals the scrambled list anyway, and a computer in a basement works through it, because a person still chose the thing being guessed. The breach emails you get are the paperwork of this design.

Attempt three: a password manager picks a long random one for you. Nothing left to guess. Problem: you still type it, so a fake login page dressed up as mine can collect it, and anyone watching your screen can copy it.

Attempt four: a passkey, the way most sites use one. A look-alike site gets nothing, because the passkey refuses to speak to the wrong address. Login solved, but the key is still nowhere. If I store one on my server, stealing the server reads your record. Pick a passphrase and we are back at attempt one.

So the shipped design gives the passkey a second job. It is not an entry ticket my cloud inspects before handing your data back; no readable copy exists on my side. When you unlock with your face or fingerprint, the chip in your device takes a fixed question and computes an answer from a secret sealed inside the hardware, the same answer every time. On your device, that answer becomes the key that seals and opens your record. No human chose the secret and nothing gets typed. Nobody, me included, ever sees a password, a private key, or your record unlocked.

One last break, from the standard itself: a device may claim this second job is supported and still hand back nothing at creation. So my app never takes its word: right after creating a passkey it asks for the real answer, a second check, and rejects it if that answer is empty.

The cost is printed on the tin. myhealthbot.ai has no reset flow, no security questions, and no email loop. The only paper in this system is the recovery code from day one: 160 random bits. The key comes out of the chip in your hand, and my server only ever meets the locked result.

P.S. Still ahead: I built reminders, then realised my server isn't allowed to know what the reminder is for.

---

## Constraint check

| Rule | Result |
|---|---|
| ≤450 words | 449 (measured with the awk/wc pipeline, includes the P.S.) |
| Hook inside 210 chars | 52 |
| Em dashes | 0 |
| Negative parallelism | none added; the hook's "Not one, anywhere." is the plan's grandfathered instance |
| Tricolons | 2 (reset flow/questions/email loop; password/private key/record unlocked) |
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
