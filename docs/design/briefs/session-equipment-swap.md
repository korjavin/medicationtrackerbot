# Brief — Swap equipment mid-workout

Short single-feature brief (claude-design skill, "Owner decisions"). Screens land in
`ui_kits/app-v2/screens-workouts.html` as **W4** (and **W4b** if a second state is needed);
beads reference them as `Spec: screens-workouts.html W4`.

## What it does

During an in-progress workout (W1 session takeover), each exercise card shows the
plate-loading strip (`.wg-plates`: bar glyph + "0.1 + 15 · 10 · 1 · 26.1 kg (+0.1 kg)").
That strip comes from the equipment the exercise resolves to: the plan row's own
equipment override, else the library exercise's binding, else an auto-match from the
inventory at the session's gym (shown as "auto: <name>").

Today the user cannot change that equipment without leaving the workout. Owner wants a
**tiny button on the strip** that lets them **pick a different equipment item** for this
exercise (e.g. barbell → dumbbells, home rack → gym rack), without leaving the session.

Screenshot: `current/screenshots/40-session-plates-chip.png` (Bulgarian Split Squat,
exercise 2 of 3).

Behaviour already decided (architect):
- The pick is **persistent**: it writes the same field as P3's "Equipment" value row
  (plan-row override; for an ad-hoc exercise, the library binding). Next time this
  exercise comes up, the same equipment is used.
- Choices = the inventory items available at the session's gym, plus **"Auto"** (clear the
  override, go back to auto-match). The current choice is marked.
- After the pick, the strip and the weight suggestion re-solve instantly (optimistic, undo
  via toast per kit rule 3).
- No new data; no editing of the equipment item itself here (that stays in the Equipment
  editor).

## Screens wanted

**W4: Equipment affordance on the session plates strip** (sits in W1 / W2)
- Where the tiny button lives on `.wg-plates` (trailing edge?) and what icon: it must read
  as "change", stay quieter than the set rows and never compete with the one sun control
  (kit rule 1). Hit target ≥ 44px (kit rule 6) even if the glyph is small.
- States to draw:
  - plated item, normal strip
  - auto-matched item ("auto: Home barbell" prefix)
  - **no strip today** (no equipment resolved, exact fixed load, bare bar, bodyweight):
    the swap affordance still has to exist somewhere — e.g. a minimal "Equipment: none ›"
    line or a tag in `.wg-ex__meta`. Draw what that looks like.

**W4b: Equipment picker sheet** (opened by the button)
- Bottom sheet over the session: rows of inventory items at this gym (implement icon —
  barbell/dumbbell/kettlebell — name, short summary like "bar 20 · plates to 25"),
  "Auto" row at top, current item selected. One tap = pick and close.
- Footer/secondary link: "Manage equipment" → existing Equipment editor (optional — open
  question below).
- Empty inventory state.

## Constraints

- `wg-*` kit v2 only (`tokens.css`, `components.css`, `icons.js`); dark theme; 390×844.
- No native selects as the visible control (kit rule 7); no inline styles (kit rule 5).
- Reuse existing sheet/row/pick patterns from W1–W3 / P3.

## Open UX questions

1. Icon for the button: swap arrows, gear, chevron, or the implement icon itself?
2. Should the picker include "Manage equipment" (edit/add items) or stay pick-only?
3. Is persistent-by-default clear enough, or should the sheet say "Saved to plan"?
