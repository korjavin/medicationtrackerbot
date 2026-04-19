# Today Card Drag-Reorder

Deferred from `2026-04-19-today-as-primary-nav.md` (Design Decision 6).

## Overview

Restore user-configurable ordering of Today dashboard cards via drag-and-drop, persisting to the existing `tab_order` field in `settings_bundle`. The tab strip's drag-and-drop (`web/static/js/features/tabs-dnd.js`) was removed with the strip itself; this plan re-implements reorder for the CSS grid that Today uses.

## Context (from discovery)

- `tab_order` semantics already flipped to mean "Today card order" in the Today-as-primary-nav change — no schema work needed
- Today card grid is rendered by `features/today.js` `renderToday(state, root, ctx)`
- Settings is excluded from `tab_order` (it's not a card)
- The old `tabs-dnd.js` operated on flex-row `.tab` buttons with HTML5 drag events; grid reorder has different hit-test mechanics

## Design Decisions (to confirm at kickoff)

1. **Trigger**: long-press to enter "edit mode" (consistent with iOS home-screen edit) vs. always-on drag handles
2. **Feedback**: haptic tick on grab (Telegram WebApp haptic API is available), shadow + scale on the dragged card
3. **Persistence**: debounce the `PATCH /api/settings` call during active dragging; save once the drop settles
4. **Empty-slot behavior**: if the user reorders with stale `tab_order` values (e.g. a feature they disabled), existing render logic already ignores unknown entries — no extra cleanup needed

## Open questions

- Accept pointer events + library (e.g. SortableJS) vs. hand-roll with touchstart/touchmove/touchend?
- Should Settings appear as a card in edit mode, to allow removing the gear-only access path? (No in MVP — gear stays.)

## Testing Strategy

- Vitest: unit test the reorder function that maps drop-index → new `tab_order` array
- Integration: mock drag events on the grid, verify DOM order + `settings_bundle` persistence

## Implementation Steps

_To be fleshed out when this plan is picked up. Skeleton only._

### Task 1: Choose drag library or hand-roll

### Task 2: Implement grid reorder + visual feedback

### Task 3: Persist to `tab_order` on drop

### Task 4: Tests + acceptance criteria

## Post-Completion

- Verify on iOS + Android Telegram (drag mechanics differ between WebView implementations)
- Screenshot update for README / marketing if visually distinctive
