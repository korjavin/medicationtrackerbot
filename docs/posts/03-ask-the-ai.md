# Post 3 — I asked an AI, nobody else saw a byte

**Channel:** LinkedIn (~400 words + answer) · X (7 tweets)
**Point:** the payoff, early — and the "how is this not magic" answer: blind pipe,
capped menu, on-device compute, scripts run where the data is.
**Ends on:** "No app open, no answers. I built it that way on purpose."
**Status:** draft — blocked on two publish gates (see Open items). Do not publish with the placeholder in.

---

## LinkedIn

I asked an AI what changed in the month before my blood pressure got worse. It read seven months of my data. Nobody else saw a byte.

If you've read the last two posts, you should be suspicious. The record lives on my devices. The machine in the middle can't read it. And now an AI has read it? Here is the trick.

The AI never gets a copy of my record. It gets permission to ask questions. It's the same assistant you have open in another tab; its questions travel scrambled through the machine in the middle (the one that holds the scrambled backup), which learns that something passed and how big it was, and land on my laptop, where the app is open. The answer is worked out there, on my device, and goes back scrambled the same way.

And it can't just say "send me everything." The questions come off a fixed menu the app publishes, and every item has a ceiling: ask for raw readings and only so many come back. For heavy questions, like "line up my sleep against my blood pressure for the spring," it goes further: the AI writes a small program, my device runs it next to the data, and only the result travels back. Seven months of readings never left my laptop. What made the trip was one screenful: what moved, and when.

When I asked mine, I watched it work. It pulled the dose times, had my device line up the sleep against the readings, checked the weight, and answered in plain sentences with the dates it used. [PLACEHOLDER — the real answer from the real run, two or three sentences, ~40 words: what moved first and in which week. Screenshot attached. The post is dead without it.]

One limit. This only works while the app is open on one of my devices. Close every tab and the AI gets silence. There is no copy on a server that could answer in my place, and a server that could answer questions about my health could be asked by someone who is not me.

That is myhealthbot.ai. My whole record, one reader at a time, on my terms.

No app open, no answers. I built it that way on purpose.

Next post I'll show you the hole in this story myself, before anyone else finds it.

---

## X (7 tweets)

**1/** I asked an AI what changed in the month before my blood pressure got worse. It read seven months of my data. Nobody else saw a byte.

**2/** If you've read the last two posts you should be suspicious. The record lives on my devices. The machine in the middle can't read it. And now an AI read it? That sounds like where the trick is hidden. Here's the trick, in full.

**3/** The AI never gets a copy of my record. It gets permission to ask questions. They travel scrambled through the machine in the middle, which learns only that something passed and how big it was, and land on my own laptop, where the app is open. The answer is computed there and goes back the same way.

**4/** And it can't say "send me everything." Questions come off a fixed menu, every item with a ceiling. For heavy questions the AI writes a small program, my device runs it next to the data, and only the result travels back. Seven months of readings never left my laptop. What made the trip was one screenful: what moved, and when.

**5/** So I watched it work: it pulled the dose times, had my device line up the sleep against the readings, checked the weight, and answered in plain sentences with the dates it used. [PLACEHOLDER — real answer + screenshot.]

**6/** The limit: this only works while the app is open on one of my devices. There is no copy on a server to answer in my place. A server that could answer about my health could be asked by someone who is not me.

**7/** That is myhealthbot.ai with an AI plugged in. No app open, no answers. I built it that way on purpose.

Next: I'll show you the hole in this story myself, before anyone else finds it.

---

## Fallback paragraph (if the scripting port has not shipped by publish date)

Swap the "And it can't just say…" LinkedIn paragraph (and tweet 4) for the menu-only
version:

> And it can't just say "send me everything." The questions come off a fixed menu the
> app publishes, and every item has a ceiling built in. Ask for raw readings and there
> is a hard cap on how many come back. The heavy questions, like "line up my sleep
> against my blood pressure for the spring," get computed on my device, and what
> travels back is a summary: averages and dates, a screenful, instead of months of raw
> numbers. The record stays home. Answers travel.

## Constraint check

| Rule | Result |
|---|---|
| ≤400 words | 395 as drafted; the placeholder swaps for a ~35-word real answer, keeping it ≈400 — recount after it lands |
| Hook inside 210 chars | 133 |
| No jargon (posts 1–4) | clean; encryption said as "scrambled", the relay as "the machine in the middle", MCP/scripting language never named — "writes a small program" |
| Em dashes | 0 |
| Negative parallelism | none |
| Anaphora / tricolon runs | none stacked |
| No CTA, no link | clean |
| Product named once, late | once, paragraph 7 |
| Ends on the no-server-fallback point | yes, phrased as "No app open, no answers." (post-4 tease follows as a P.S.) |

## Facts this post rests on (checked against the code)

- Tier 1 is a blind pipe: frames are opaque to the relay, which sees sizes, timing and
  pairing ids only; the pairing key never touches the server (docs/cloud-mode.md → MCP).
- The AI is a stock assistant (Claude Desktop / Claude Code) talking through
  `cmd/mcpshim` on the user's own machine.
- Ceilings are real: list reads cap at 1000 rows and defaults never mean "everything"
  (`web/domain/paginate.js`), composite analyses clamp to 90-day windows
  (`web/domain/analysis.js`), medications.history hard-caps at 100 rows, diary notes
  truncate to 50 in analyses.
- On-device aggregates exist today: `health.bp.stats`, `food.stats.read`,
  `health.overview`, and the `analyze_cardiovascular` / `analyze_fitness` composites
  computed in the browser.
- Every cloud MCP call requires a live, unlocked tab; there is no server-side fallback,
  deliberately.
- **Scripting ("writes a small program") is announced ahead**: `mcp_execute` exists in
  bot mode (Python executor) and is being ported to cloud mode. It is NOT live in cloud
  yet (`web/cloud/js/mcp-responder.js` returns an explicit error for it today).

## Verify with the author before publish

- "I watched the AI work" — true in Claude Desktop (tool calls are visible), but
  confirm it matches how the real run is actually done.
- If the real run uses menu ops rather than a script, tweak "had my device line up the
  sleep against the readings" to match what actually happened.

## Open items

- **Publish gate 1 — the real run.** Ask the real question against the real seven
  months, screenshot the answer, replace both PLACEHOLDER blocks. Plan rule: if the
  answer is boring, the post is dead — test before week 1.
- **Publish gate 2 — the scripting port.** The cloud `mcp_execute` port must be live by
  publish date, or swap in the fallback paragraph above.
- Recount LinkedIn words after the answer lands; budget is ~35 words.
- X thread for post 2 is still undrafted (carried over).

## Provenance

Drafted solo by claude against the plan row and the two published-format posts, then
reworked twice with the author: (1) recentred on the skeptic's question ("how can an AI
work with local data — sounds like magic") with the blind pipe, the capped menu, and
on-device compute; (2) scripting added as announce-ahead once the author confirmed the
bot-mode executor is being ported to cloud. Not yet cross-critiqued by a second model.
