# Post 4 — The hole, volunteered

**Channel:** LinkedIn only
**Point:** volunteering the hole before anyone finds it — the operator serves the
code that handles the vault key, so a bad operator could serve altered code. What
narrows that, what doesn't, and why it's in a post instead of the small print.
**Ends on:** what narrows it, what doesn't, why I published it.
**Status:** draft; codex-reviewed 2026-08-06, clear-win and formula fixes applied. Hook change ("code" for "JavaScript") suggested by codex, deferred to the author.

---

## LinkedIn

Here's the part that should bother you: I still send you the JavaScript that holds your key.

Two posts ago I said the backup on my machine is a block of noise I cannot read. That holds right up to the moment you open the app. The page that unscrambles your record, the page holding your key while you use it, comes from my machine. If I turned bad tomorrow, picking the lock would be the hard way. The easy way would be to change that page without telling you, then take a copy the next time you opened your record. Anyone who seized my machine could do the same.

You might reasonably ask whether the whole promise rests on me behaving. Partly, yes. Three things make that a smaller trust than it sounds. The page never runs anyone else's code: no ad scripts, no analytics, nothing fetched from another company's machine. It carries a short list of places it is allowed to talk to, so a bad script that got in has almost nowhere to send your key. And every version I ship leaves a public trail, the exact code it was built from and a fingerprint for the files it serves, which an independent technical reader can compare against what my machine hands out.

Now the uncomfortable half. None of that stops me. A page cannot prove to you what it ran; the checking happens outside the page, after the fact. A changed page aimed at one person for one afternoon would likely pass unseen. If that residue is too much, you can run the whole thing on your own machine, and then the person you are trusting is you.

So why write this? Because every product that makes this promise from a web page has the same hole, and the usual move is to wait for a researcher to find it and then call it a technicality. I would rather it sit here in the post than in the small print. A risk you can weigh is worth more than a risk tidied out of view, and myhealthbot.ai only makes sense to me if you do the weighing.

The weakest spot in this product is the one you just heard about, from me, first.

P.S. Next up: there is no password anywhere in this app, and that turned out to be the best decision in it.

---

## Constraint check

| Rule | Result |
|---|---|
| ≤400 words | 399 (awk-measured, includes closer and P.S.) |
| Hook inside 210 chars | 92 |
| No jargon (posts 1–4) | clean; "scrambled" register kept ("unscrambles"), CSP said as "a short list of places it is allowed to talk to", provenance/SHA256SUMS said as "a public trail" and "a fingerprint for the files it serves" |
| Em dashes | 0 |
| Negative parallelism | none; hard-way/easy-way pair is affirmative on both sides |
| Tricolons (max 2) | 2: "no ad scripts, no analytics, nothing fetched"; the three-things enumeration |
| Anaphora runs | none |
| Self-answered rhetorical fragments | none; "So why write this?" is answered by a full paragraph, and the reader-voiced suspicion ("you might reasonably ask") is the post-3-style allowed move |
| No CTA, no link | clean |
| Product named once, late | once, final body paragraph |
| Ends on narrows / doesn't / why published | yes, in that order across the last three paragraphs |
| "Said in the post, not in small print" move | owned here: "I would rather it sit here in the post than in the small print" (post 2 kept its instance; post 3's was cut) |

## Facts this post rests on

- The residual risk, stated first in the source doc: the operator serves the code
  that handles the DEK; a malicious or coerced operator (or poisoned build/deploy
  path) can ship JavaScript that reads the vault after unlock, to everybody or to
  one targeted account (`docs/security/release-integrity.md` → "The residual risk,
  stated first"; `docs/security/threat-model.md` §7.1, boundary B2 in §3).
- Narrowing 1 — no third-party script, ever: `script-src 'self'` on every document
  the cloud origin serves, no CDN/analytics/inline, voice SDK vendored
  (`docs/security/release-integrity.md` → "No third-party script, ever";
  test-pinned in `internal/cloudserver/router_test.go`).
- Narrowing 2 — scoped egress: the app document's connect list is a per-account
  allowlist, never a bare wildcard, so injected code has almost nowhere to send the
  key. "Almost" is deliberate: an XSS with persistence can register its own host
  and force a reload — a harder attack, not a closed door
  (`docs/security/release-integrity.md` → "Scoped egress"; threat model §7.2).
- Narrowing 3 — verifiable builds: every push to master signs SLSA provenance
  bound to the CI identity and publishes SHA256SUMS over browser-delivered files;
  divergence becomes detectable, not prevented
  (`docs/security/release-integrity.md` → "Verifiable builds",
  `.github/workflows/deploy.yml`).
- What doesn't narrow it, kept in the post: nothing in a browser can attest what
  it ran; detection is manual and after the fact; nothing forces an operator to
  keep serving an attested build ("What is still missing": no reproducible build,
  no transparency log, no update pinning, no independent review — none of these
  are claimed).
- Self-hosting moves "the operator" to the user themselves
  (`docs/security/release-integrity.md`, closing line of the residual-risk section).
- Deliberately NOT cited: the frozen mobile build (the doc forbids citing it as a
  mitigation), reproducible builds, any automatic in-browser verification.

## Verify with the author / Open items

- "A fingerprint for the files it serves" is softened from "every file": two served
  documents (`/` and `/static/config.js`) are assembled at runtime and compared by
  eye, not by hash (`docs/security/release-integrity.md` → path-mapping table).
  Confirm the softened wording is acceptable rather than reintroducing "every".
- The public-trail claim depends on the deploy workflow continuing to publish
  provenance + SHA256SUMS on every push; re-verify at publish date.
- Self-hosting appears in post 2 (run the backup yourself) and again here (run the
  code yourself). Different point each time, but the series-level repetition is the
  author's call.
- "Every product that makes this promise from a web page has the same hole" is the
  doc's "property of web delivery, not of this implementation" claim, scoped to web
  delivery on purpose; confirm the author is comfortable generalizing to
  competitors.
- Measured counts below were taken with the awk command from the plan; recount
  after any edit.

## Provenance

Drafted by claude subagent from the plan row and the two security docs, pending codex review.
