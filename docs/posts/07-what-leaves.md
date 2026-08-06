# Post 7 — What still leaves the vault

**Channel:** LinkedIn only
**Point:** the carve-outs — everything that deliberately leaves the vault, told as
honesty rather than confession. The list is generated from the source code, the
Settings screen derives from the same file, and the three activation classes are
named instead of flattened.
**Ends on:** "Not everything has a toggle, and I said which. Burying the list would be the actual lie." (post-8 tease follows as a P.S.)
**Status:** draft; codex-reviewed 2026-08-06, honesty scoping ("everything" claims narrowed) and formula fixes applied.

Hook note: replaces the plan's original ("Here is everything that still leaves the
vault...") per the 2026-08-06 editor pass, which named post 1's pull-quote line
("A log a company can read gets softened the same way") as the stronger front door.

---

## LinkedIn

A record someone else can read gets softened, the same way people soften a number for a doctor. So I keep mine where nobody else can read it. Almost. Here is what still can.

An app that never talks to the outside world cannot tell me whether two medications clash, or what is in a barcode. A few things deliberately step outside the vault, and I keep a public list of every one. This is the short version.

When I ask the AI to read a meal photo, the photo and my description go to an AI provider. With my own key they travel straight from my browser to my provider. On the shared trial key they pass through my server first, and only after I agreed to exactly that, a consent I can revoke. Food and barcode searches go through my server to a food database, and there is no switch for that; adding your own database takes my server out of the path. Drug name and interaction checks go to RxNav, run by the US National Institutes of Health; it has no toggle and cannot be pointed anywhere else. Link a Telegram bot and the chat crosses my server in plain text both ways, because a chat bot cannot be sealed end to end. Turn on push reminders and the server learns when one fires, and nothing about what it says.

The whole list lives in the app, on a Settings screen called "What can the operator see?" Nobody writes that screen by hand: it and the public docs table are generated from one file in the source code. Hand-edit the table and the build fails. A check combs the code for ways data can leave and fails on any the list misses. I cannot widen what leaves without the code telling on me first.

The list has three shapes: some of it waits for my yes, some runs the moment I use the feature, and some I can replace with a provider of my own. Flattening those into one comforting "all opt-in" sentence would read better, and it would be false. myhealthbot.ai says which is which, next to each feature.

Not everything has a toggle, and I said which. Burying the list would be the actual lie.

P.S. Next, the proof: the AI and my UI run the exact same code path. There is no second copy.

---

## Constraint check

| Rule | Result |
|---|---|
| ≤400 words | 400 (measured: `awk '/^## LinkedIn/{f=1;next} /^---$/{if(f)exit} f' docs/posts/07-what-leaves.md \| wc -w`) |
| Hook inside 210 chars | 173 |
| Em dashes | 0 |
| Negative parallelism | none |
| Self-answered rhetorical one-liners | none ("Almost." is a qualifier, not an answer to a question) |
| Tricolons (max 2) | 1 ("some of it waits... some runs... some I can replace") |
| Anaphora runs | none |
| Banned words | 0 hits |
| Straight quotes only | yes |
| Prose, no bullets | yes — the carve-out list rendered as one prose paragraph |
| Product named once, late | once, paragraph 5 |
| No CTA, no link | clean |
| Ends on the toggle beat | yes, then P.S. tease for post 8 |

## Facts this post rests on

All checked against `web/cloud/js/privacy-manifest.js` (the single source of truth)
and the generated table in `docs/cloud-mode.md`:

- The boundary table in `docs/cloud-mode.md` is GENERATED from
  `renderBoundaryTable()` in the manifest (`pnpm privacy:docs`); a guard test fails
  CI if the committed doc drifts, so hand-editing the table fails the build.
- Settings → "What can the operator see?" is derived from the same manifest
  (`web/cloud/js/privacy.js` builds it from every entry's `userCopy`).
- `web/cloud/js/tests/architecture.privacy-claims.test.js` derives the set of
  things that must be disclosed from the code itself (outbound HTTP, proxies,
  third-party hosts in `internal/cloudserver/*.go` and `web/cloud/js/**`); an
  undeclared egress path fails CI — "the code tells on me first".
- Trial AI (manifest id `trial-ai`): meal descriptions and photos pass through the
  operator's server to the operator's OpenAI account, activation `opt-in-consent`,
  revocable in Settings → Integrations; BYO key goes browser-direct (`byo-openai`).
- Operator-default food DB (`food-operator`): search terms and barcodes through the
  operator's proxy, activation `no-toggle`; setting your own endpoint removes the
  operator from the path (`food-byo`).
- RxNav (`rxnav`): drug-name and interaction queries through a blind same-origin
  proxy to RxNav (NIH), activation `no-toggle`, and `byo: "None — there is no BYO
  alternative for drug lookups"`.
- Telegram relay (`telegram-relay`): opt-in (you link your own bot), text crosses
  the relay in plain text both ways; "a chat bot cannot be made end-to-end
  encrypted".
- Push relay (`push-relay`): opt-in via notification permission; the server sees
  when a reminder fires, the payload is app-layer encrypted on top of RFC 8291
  (operator visibility: ciphertext).
- The manifest's honesty constraints forbid flattening the activation classes into
  "all opt-in" (comment block, `privacy-manifest.js` lines 36–40).

## Verify with the author / Open items

- "I keep a public list" — the docs table is public with the repo; confirm the repo
  (or the rendered doc) is public at publish time.
- Carve-outs deliberately left to the in-app list, not named in prose: sync
  metadata (cadence, blob sizes, IPs), record-type tags, account existence, MCP
  hosted mode, the Mi Band import, and both feedback paths. Confirm the author is
  happy that none of these is reader-relevant enough to displace the five named.
- Plan says post 7 may link engineering note B as its only cross-link; the no-links
  rule for the main track won — no link drafted. Revisit if note B ships first.
- LAUNCH-POSTS.md plan-table hook for row 7 updated to match the final hook (in
  scope per the brief).

## Provenance

Drafted solo by claude against the plan row, the 2026-08-06 editor pass, and the
three published-format posts (01, 02, 03) for voice. Carve-outs enumerated from
`web/cloud/js/privacy-manifest.js`, not from memory. Not yet cross-critiqued by a
second model.
