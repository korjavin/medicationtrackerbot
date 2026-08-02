---
name: adjust-text-tone
description: Write or rewrite user-facing prose so it converts and doesn't read as AI slop. Use for landing/marketing copy, README and docs intros, onboarding and empty-state text, error and toast messages, release notes, emails, or when the user says "write copy", "improve this text", "make this punchier", "de-slop this", "sounds like AI", "adjust the tone", or "too wordy". Not for code, commit messages, or test names.
---

# Adjust text tone

Two jobs, always both: make the copy convert, and strip the AI tells.

## Voice

- **Human** — write like you speak. No jargon. Approachable, not chummy.
- **Punchy** — short sentences, strong verbs, active voice.
- **Benefit-first** — answer "what's in it for me?" in the first line. Features are evidence, not the pitch.
- **Confident and plain** — Stripe/Linear/Apple, not a pitch deck.
- **Clarity over cleverness** — if the reader has to decode a pun, you lost them.

The "so what?" test: every sentence earns its place.

- Bad: "We utilize advanced AI algorithms to facilitate image generation."
- Good: "Create stunning images in seconds."

## Structure

- Headline: ~6 words, one clear value proposition.
- Subhead: the how, or the second-best benefit.
- Body: 2-3 sentence paragraphs. Bullets only when the content is genuinely a list.
- CTA: a verb the reader wants to do. "Start building", not "Submit".

## The de-slop pass

Non-negotiable before you hand anything back. Read
[references/ai-tropes.md](references/ai-tropes.md) and sweep the draft against it.

The ones that show up in almost every first draft:

1. `It's not X — it's Y.` and `Not X. Not Y. Just Z.` — delete, state the point directly.
2. `The result? Devastating.` — self-answered rhetorical questions.
3. Em dashes. 2-3 per piece, not 20.
4. `**Bold**:` opening every bullet.
5. `delve`, `leverage`, `robust`, `streamline`, `seamless`, `landscape`, `tapestry`.
6. `serves as` / `stands as` where `is` works.
7. `Here's the thing`, `Let's break this down`, `Think of it as`, `Imagine a world where`.
8. `In conclusion` / `To sum up` — competent writing doesn't announce its own structure.
9. Unicode decoration: `→`, curly quotes. Type what a keyboard types.
10. One point restated five ways. Say it once, well.

Any single trope once can be fine. The failure mode is stacking them.

## Workflow

1. **Ask the goal** if it isn't obvious: who reads this, what should they do next?
   One line, then proceed — don't stall.
2. **Draft three variations** (safe / bold / direct) for headlines, CTAs, and short
   hero copy. For long-form or an edit of existing text, draft one and iterate.
3. **De-slop** against the trope list above.
4. **Trim** — cut adjectives, strengthen verbs, read the rhythm out loud.
5. **Deliver** the copy itself, no commentary about the copy. If you cut something
   deliberate, one line at the end.

When editing existing text, preserve the author's voice and every factual claim.
De-slopping is not rewriting someone's meaning.

## In this repo

Product copy is user-facing health text — reliability beats flair.

- Never invent a medical claim, a number, or a study to make a line land.
- Keep the vault promise honest: don't soften "the operator can see X" into marketing fog.
- UI strings live in `web/static/` and `web/cloud/`; check length against the
  component before shipping a longer line.
