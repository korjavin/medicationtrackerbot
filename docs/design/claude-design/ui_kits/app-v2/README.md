# MedTracker App UI kit v2

This kit is option B from `briefs/UX-AUDIT.md`. It's mobile-first, 390×844, and dark only. Open `index.html` for the review and the page index.

## Files
- `tokens.css`: the `--wg-*` tokens, including the palette, surfaces, text, status (ok, warn, danger, stale, pending), type, space, radius, heights and material. **Ship this.**
- `components.css`: every `wg-*` component, using classes only. **Ship this.**
- `icons.js`: a sprite of original line icons. `<i class="wg-ico" data-icon="pill"></i>` hydrates to inline SVG. **Ship this, or port the paths.**
- `kit.css` and `kit.js`: presentation only (phone frames, fake keyboard, demo toggles). **Don't ship these.**
- Pages: `foundations`, `components`, `screens-today`, `screens-food`, `screens-meds`, `screens-workouts`, `screens-settings`, `navigation`.

## Rules
1. There is one sun-filled control per view. Selection states (segmented controls, tabs, picks) use raised teal with sun text. `.wg-seg--accent` is only for a mode switch inside a sheet.
2. Forms put Cancel/Save in the sheet header or page bar. Flows (add food, take meds, finish workout) put their contextual primary in `.wg-sheet__foot`, docked above the keyboard with `.wg-scrim--kb`.
3. Tapping a row edits it. Swiping (`.wg-swipe`) reveals Edit and Delete, and an overflow button is the pointer and keyboard fallback. Deletes from a row are undone from a toast; record and account deletes go through `.wg-dialog`.
4. Status always comes from the five status token families. Use no emoji, and show negative stock as "Out · N over".
5. Components use no inline styles. The one exception: data values pass through `--p` (a percentage) or `--n` (a count) on the element.
6. Hit targets are at least 44px, and set rows are 56px.
7. Never use native dialogs, checkboxes, selects or date or file inputs as the visible control.

## Replaces
- **Buttons:** `wg-toolbar-btn`, `*-modal__header-btn` (×15), `*-subtabs__btn`, `btn btn-sm *`, `wg-firstrun-btn`, `.wizard-step button`, `.pwa-update-btn` → `wg-btn` plus its variants.
- **Status and sync:** emoji status tags and the three hand-built sync tags → `wg-chip--*`.
- **Empty and loading states:** `.no-data-msg`, `.hint`, `.med-empty-text` and the "Loading…" divs → `wg-empty` and `wg-skel`.
- **Pickers:** `.days-select` → `wg-picks`. The `action-row.js` ✏️/🗑 buttons → swipe plus overflow.
- **Nested editors:** stacked modals → pushed pages (`wg-pagebar`).
- **Navigation:** 8-slot nav → 5-tab `wg-tabbar` (see `navigation.html`). The legacy variant `wg-tabbar--legacy` is kept for comparison.
