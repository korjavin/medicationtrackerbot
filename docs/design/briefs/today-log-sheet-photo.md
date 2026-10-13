# Brief — Today Log sheet: camera and library as two tiles

Short single-feature brief (claude-design skill, "Owner decisions"). The screen lands as a
revision of T3 in `ui_kits/app-v2/screens-today.html` (new frame id **T3b**); the bead references it
as `Spec: screens-today.html T3b`.

## What it does

The Today "Log" button opens the T3 Log sheet. Its FOOD group has four tiles: Search, Photo meal,
Scan barcode, Describe. "Photo meal" hands a photo to the AI food flow (F6 review). Today the tile
has one behaviour per platform: on Android 14+ the system photo picker has no camera entry, and
the camera-direct path (`<input type=file capture=environment>`) has no library entry, so one tile
can only ever offer one of the two.

The Food Add sheet (F4) already solved this in code with two tiles, Photo (camera, one tap) and
Gallery (photo picker), bead med-yey6 / PR #991 — the shipped F4 now has four tiles
Scan · Photo · Gallery · Describe, while the mirrored F4 spec still shows three.

Owner decision (2026-10-11): the Today Log sheet gets the same two tiles — **"Photo meal"** =
camera one-tap, **"From library"** = photo picker — and the FOOD group is re-gridded as needed.
No in-page chooser (rejected: one extra tap on every photo log).

Bead: `med-jp7z`.

## Screens wanted

**T3b: Log sheet with five FOOD tiles** (revision of T3; same sheet, same header, same
MEASUREMENTS & NOTES group)
- FOOD tiles: Search (sub "Your foods + database"), Photo meal (camera icon, sub "AI estimates
  it"), From library (`image` icon, sub e.g. "Pick a photo"), Scan barcode, Describe (sub
  `"200 g chicken, rice"`).
- The grid must not leave an orphan cell. Two candidate layouts, designer picks or proposes better:
  - **A (recommended):** Search becomes a full-width `.wg-action--row` above the grid (it is the
    only non-fast path and already reads like a search field), and the four fast paths sit in the
    existing 2-column `.wg-actions`: Photo meal · From library / Scan barcode · Describe.
  - **B:** keep all five as tiles in a 3-column `.wg-actions--3` with shorter or no sub-labels
    (as F4 does), accepting one empty cell or a 2+3 split.
- Photo meal and From library must read as siblings of one flow (same icon tint, adjacent),
  without Photo meal becoming a second sun-filled control (kit rule 1).
- States: full sheet; sheet with Food disabled (FOOD group drops out, unchanged from T3).
- Optional: refresh F4 to its shipped four-tile state (Scan · Photo · Gallery · Describe) so the
  mirror matches code; same labels as the code or the designer's better ones.

## Sits next to (kit v2 ids)

- T3 Log sheet (`screens-today.html`), the frame being revised; T1 Today behind it.
- F4 Add sheet (`screens-food.html`), the existing two-tile precedent (Photo / Gallery).
- F6 AI review, where both tiles land.
- Empty-day Food shortcut row (F1 empty state) keeps one Photo action = camera; not in scope.

## Constraints

- Use `wg-*` kit tokens and components only (`tokens.css`, `components.css`, `icons.js`); the
  `image` glyph already exists in `icons.js`. No inline styles except `--p` / `--n`.
- Design at 390×844, dark only (the app is dark-only, owner 2026-10-11). Hit targets ≥ 44px;
  `.wg-action` min-height stays 84px for tiles.
- Kit rule 1: one sun-filled control per view — no `.wg-action--primary` on either photo tile.
- No native dialogs or file inputs as the visible control (kit rule 7); the camera / picker open
  only after the tile tap.
- English copy only. Labels are final unless the designer proposes shorter ones: "Photo meal",
  "From library".

## Open UX questions for the designer

Owner (2026-10-11): the designer decides all of these, including the tile layout and labels;
the defaults below are only starting suggestions.

1. Layout A (Search as a row + 2×2 fast paths) or B (3-column tiles)? Default A.
2. Sub-label for "From library": "Pick a photo" / "Existing photo" / none? Default "Pick a photo".
3. Should "From library" also say the AI estimates it, or is adjacency to "Photo meal" enough?
   Default: adjacency is enough.
4. Refresh F4 to four tiles in the same pass? Default yes, it is a caption-level change.

## Prompt for Claude Design

```
Read briefs/today-log-sheet-photo.md (Today Log sheet: split "Photo meal" into a camera tile
and a "From library" tile, re-grid the FOOD group). Use ui_kits/app-v2/ as the source of
truth: tokens.css, components.css, icons.js and README.md for the kit rules; screens-today.html
T3 is the frame being revised; screens-food.html F4 is the existing Photo / Gallery two-tile
precedent (the shipped app now has Scan · Photo · Gallery · Describe there).

First, give a short critical review of the brief and answer its four open questions with a
recommendation. Then design T3b: the Log sheet with five FOOD tiles and no orphan cell,
comparing layout A (Search as a full-width .wg-action--row above a 2x2 grid of Photo meal,
From library, Scan barcode, Describe) with layout B (3-column tiles), and pick one. Keep the
MEASUREMENTS & NOTES group as in T3. Dark theme only, 390x844, wg-* components only, no new
sun-filled control, English copy. Add the T3b frame next to T3 in screens-today.html with a
kit-cap caption, and if you agree, refresh F4 in screens-food.html to its four-tile state. Any
new layout rule goes into components.css, never inline.
```
