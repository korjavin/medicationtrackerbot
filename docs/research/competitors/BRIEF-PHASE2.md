# Phase 2 Brief — Customers, Killer Features, Marketing, Counter-positioning

Deepening pass over all 22 competitors already in this folder. Same rules as BRIEF.md (primary sources, URLs + access dates, `(unverified)` markers, comprehensive over fast). Claude audits each batch and will push back on thin answers — expect challenge rounds.

## Deliverable

Append a `## Phase 2` section to each existing `<slug>.md` with exactly these four subsections:

### 1. Customer base
Hard numbers where they exist; honest proxies where they don't. Hunt all of: vendor-claimed users/MAU in press releases or investor decks; app-store download brackets and review counts (Google Play shows brackets, both stores show review counts); funding rounds and what they imply; for OSS — GitHub stars over time, F-Droid presence, Docker Hub pulls, subreddit/forum size, contributor count. State each figure's source and date; label inference as inference (e.g. "1M+ Play downloads bracket, ~40k reviews → plausibly low-millions installed base, (estimate)"). "Unknown" with evidence of having looked beats a guessed number.

### 2. Killer features — why customers actually choose it
Not the feature list (Phase 1 has that) — the decision driver. Mine real user voice: app-store review themes, Reddit threads (r/selfhosted, r/ChronicIllness, r/diabetes_t1, r/QuantifiedSelf...), HN comments, comparison articles' verdicts. Name the top 2-3 reasons people pick this product over alternatives, each backed by where you saw it said.

### 3. Marketing & acquisition — how they win customers
Channels and mechanics, specifically: SEO topics they rank for, app-store optimization, paid ads, pharma/insurer/employer B2B2C partnerships (MyTherapy!), physician recommendation programs, community/word-of-mouth (Nightscout's #WeAreNotWaiting), F-Droid/awesome-selfhosted listings, press coverage, influencer/affiliate. End with 1-2 sentences: **what we can learn** — the transplantable tactic.

### 4. Beating them in comparison
Given 1-3: what would make a prospective user comparing us against THIS product choose us? Concrete — a message, a feature emphasis, a table row we'd win — not generic "we're private". Also note honestly where we'd lose the comparison and what would neutralize it.

## Process

- Work in batches of ~5, commit and ping Claude after each batch so auditing overlaps with your next batch.
- Order: start with the three that matter most (Guava, MedM, Apple Health), then medication trackers, then multi-metric SaaS, then ecosystems, then OSS.
- For OSS projects, "customers" = installed base proxies and community energy; "marketing" = how self-hosters discover them (directories, YouTube homelab channels, awesome lists).
- If a number genuinely cannot be found, say what you searched for and where — that is a valid result; an uncited round number is not.
