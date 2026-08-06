# Post 8 — One code path, two callers

**Channel:** LinkedIn only
**Point:** purity as the enabling constraint. The domain logic lives in one pure layer;
the UI and the AI connector route through the same router, so the AI cannot do anything
the app cannot, and a fix lands in both at once. Continues post 3: that post explained
how the AI reads; this one explains why it can be trusted to behave like the app.
**Ends on:** "One router serves two callers, and every rule binds them both." (plain
declarative sentence per the editor pass; the post-9 tease follows as a P.S.)
**Status:** draft; codex-reviewed 2026-08-06. Hook reworked consequence-first 2026-08-06 after codex and agy independently flagged the engineering opening; cross-reference fixed (post 3, not "last post").

---

## LinkedIn

The AI cannot do anything to my record that my own app cannot do. There is no second door for it to find.

In post 3 I showed an AI reading seven months of my health record while nobody else saw a byte. The fair follow-up is why that AI can be trusted to behave once it is inside. My answer is structural, because structure survives years of edits.

Everything the app knows how to do, what counts as a dose taken, how a blood pressure average is worked out, when a reminder is due, lives in one layer of plain functions. That layer is forbidden to touch the screen, the network, or the browser's storage. A test runs on every change and fails the build if any file in that layer reaches for one of those. That sounds like purism, but it is plumbing: code that touches nothing can be called from anywhere.

In front of that layer sits one router. When I tap a button, the tap travels through it. When the AI connector asks for something, it looks the operation up in a published catalog and dispatches to the very address the button uses, through the same router. The connector holds no logic of its own. Whenever I catch myself wanting a special branch on the AI's side, the rule is to push that behavior down into the shared layer instead, where both callers inherit it.

Here is what that buys you as a user. A wider view than the app's would need a second code path to live in, and the tests refuse to let one grow. The read ceilings from that post bind the AI because they sit in the shared layer where every call lands. And when I fix a bug there, the screen and the AI pick up the fix in the same release.

A second test closes the loop from the other side. It takes every operation in the AI's catalog and drives it through the real router, and the build fails if a single one comes back unanswered.

This is the part of myhealthbot.ai I would keep in any rewrite. One router serves two callers, and every rule binds them both.

P.S. Then the hard one: "Retire this device" and "my phone was stolen" are different buttons, and so far I have built only one of them.

---

## Constraint check

| Rule | Result |
|---|---|
| ≤400 words | 396 (measured with the awk pipeline below) |
| Hook inside 210 chars | 105 |
| Em dashes | 0 |
| Negative parallelism | only the grandfathered hook line; "a wider view would need a second code path" is phrased as a positive requirement |
| Tricolons (max 2) | 2: "dose taken / average / reminder"; "the screen, the network, or the browser's storage" |
| Anaphora runs | none |
| Self-answered rhetorical one-liners | none; the follow-up question is reported, not asked |
| Banned words | 0 hits |
| Straight quotes | yes |
| Prose, no bullets | yes |
| Product named once, late | once, final paragraph |
| No CTA, no links | clean |
| Jargon level | "code path", "router", "catalog" in plain sense; the connector is never called MCP |
| Ends on a plain declarative sentence | yes, "One router serves two callers, and every rule binds them both." |

Word count command:
`awk '/^## LinkedIn/{f=1;next} /^---$/{if(f)exit} f' docs/posts/08-one-code-path.md | wc -w`

## Facts this post rests on (checked against the code)

- Domain logic lives in one pure layer: `web/domain/*.js`, pure ES modules behind
  injected ports, no browser globals (CLAUDE.md Critical Rule 1).
- "A test fails the build": `web/static/js/tests/architecture.domain-purity.test.js`
  bans `window`, `document`, `fetch`, and IndexedDB inside `web/domain/`.
- One router, two callers: `createApiRouter` in `web/cloud/js/apishim.js` is the same
  function the UI's `window.offlineAwareApiCall` is assigned to, and the MCP responder's
  `createDispatcher({ router })` takes that same router, dispatching by each catalog
  entry's `method` + `path` (docs/cloud-mode.md → "Every catalogued op is dispatchable,
  through the router the UI already uses"). There is no second dispatch table.
- "No logic of its own / push it down": docs/cloud-mode.md states an op needing behavior
  `web/domain/*` lacks gets it added there, "never branched into `mcp-responder.js`".
- "A second test drives every operation": the sweep in
  `web/cloud/js/tests/mcp-responder.test.js` drives all 97 catalogued ops (63 writes,
  payloads synthesized from each op's `required`) through the real router and fails CI
  naming any op that 404s.
- "Read ceilings sit in the shared layer": the caps cited in post 3 live in
  `web/domain/paginate.js` and `web/domain/analysis.js`, so they apply to any caller of
  the domain layer, UI or AI.

## Verify with the author / Open items

- "the tests refuse to let one grow" compresses two guards (domain purity + the
  responder coverage sweep) into one clause; confirm the author is happy with that
  compression rather than naming both.
- The responder does merge a few connector-local operations beyond the 97-op catalog
  (docs/cloud-mode.md notes it serves 100); these are transport-level, not domain
  logic, so the "no logic of its own" claim stands, but the author should confirm
  none of the extras reads or writes health data outside the router.
- Post 3 must be published first: this post leans on "last post" twice (the AI-read
  payoff and the read ceilings).

## Provenance

Drafted solo by claude against the plan row (LAUNCH-POSTS.md #8 plus the 2026-08-06
editor pass: plain declarative closer, P.S. tease for post 9), with facts verified
against CLAUDE.md Critical Rule 1, docs/cloud-mode.md's MCP dispatch section,
`web/cloud/js/apishim.js`, and the two architecture tests named above. Not yet
cross-critiqued by a second model or reviewed by the author.
