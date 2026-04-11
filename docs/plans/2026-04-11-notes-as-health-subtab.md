# Notes as Health Sub-Tab

## Overview
Move the diary notes from being a hardcoded section at the bottom of the Health view into a proper sub-tab, matching the Food tab pattern (Daily Log / My Meals / Food DB). The Health view will have two sub-tabs: **Overview** (existing vitals/sleep/steps charts) and **Notes** (diary notes).

**Current:** Notes are a `<div class="notes-section">` block at the bottom of `#health-view`, always visible below the charts.
**After:** Health view has sub-tab buttons ("Overview" | "Notes"), content switches on tab click. Default active tab: Overview.

## Context
- Health view HTML: `web/static/index.html:212-228` — `#health-view` with `#health-overview-content` and `.notes-section`
- Notes JS logic: `web/static/js/app.js:2657-2876` — `loadNotes()`, `renderNotes()`, `appendNotes()`, `addNote()`, `deleteNote()`
- Food sub-tab pattern: `web/static/js/features/food.js:97-101` — `bindTabGroup()` + `switchFoodTab()`
- Tab activation utility: `web/static/js/app.js:779-805` — `activateTabGroup()` + `bindTabGroup()` — reusable
- CSS for sub-tabs: `.med-tabs`, `.food-tabs` pattern in `styles.css:276-304`
- The Health overview loading function: `web/static/js/features/health.js` — `loadHealthOverview()`
- Notes are loaded via `loadNotes()` in app.js, called when health tab is selected (`app.js:834` area)

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**
- Frontend-only changes — no backend modifications

## Testing Strategy
- **Architecture tests**: existing `architecture.design-tokens.test.js` and `architecture.globals.test.js` must pass
- Verify no hardcoded colors, no inline styles in new code
- Verify tab switching works (notes load lazily on first tab click)

## Progress Tracking
- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix

## Implementation Steps

### Task 1: Add sub-tab HTML structure to health view
- [ ] In `index.html`, inside `#health-view`, add a `.health-tabs` container with two buttons BEFORE `#health-overview-content`:
  ```html
  <div class="health-tabs">
      <button class="health-tab active" data-tab="overview">Overview</button>
      <button class="health-tab" data-tab="notes">Notes</button>
  </div>
  ```
- [ ] Wrap the existing `#health-overview-content` and `#health-overview-loading` in a new `<div id="health-overview-tab" class="health-tab-content active">`
- [ ] Wrap the existing `.notes-section` div in a new `<div id="health-notes-tab" class="health-tab-content">` (not active by default)
- [ ] Remove the `<h3>Health Overview</h3>` standalone heading — the sub-tab label "Overview" replaces it
- [ ] Add CSS rules for `.health-tabs` and `.health-tab` following the existing `.food-tabs` / `.food-tab` pattern in styles.css (add `.health-tabs` and `.health-tab` to the existing comma-separated selectors)
- [ ] Add `.health-tab-content` to the existing `.food-tab-content` visibility rules
- [ ] Run architecture tests — must pass before next task

### Task 2: Add sub-tab switching logic in JS
- [ ] In the JS code that handles health tab initialization (likely `app.js` where `loadHealthOverview` and `loadNotes` are called), add `bindTabGroup()` for health tabs:
  ```js
  bindTabGroup({
      container: document.querySelector('.health-tabs'),
      buttonSelector: '.health-tab',
      onTabSelect: switchHealthTab
  });
  ```
- [ ] Create `switchHealthTab(tab)` function:
  ```js
  function switchHealthTab(tab) {
      const activated = activateTabGroup(tab, {
          buttonSelector: '.health-tab',
          contentSelector: '.health-tab-content',
          contentIdFromTab: (t) => `health-${t}-tab`
      });
      if (!activated) return;
      if (tab === 'overview') { loadHealthOverview(); }
      else if (tab === 'notes') { loadNotes(); }
  }
  ```
- [ ] Update the main tab switch handler: when the Health main tab is selected, call `loadHealthOverview()` only (not `loadNotes()` — notes load lazily when their sub-tab is clicked)
- [ ] If `loadNotes()` is currently called when health tab activates, remove that call — it should only trigger via the Notes sub-tab
- [ ] Verify sub-tab state persists when switching away from Health and back (the active sub-tab should remain)
- [ ] Run architecture tests — must pass before next task

### Task 3: Verify acceptance criteria
- [ ] Verify Health tab shows "Overview" and "Notes" sub-tabs
- [ ] Verify Overview sub-tab is active by default
- [ ] Verify clicking "Notes" shows the notes section, hides overview
- [ ] Verify clicking "Overview" shows charts, hides notes
- [ ] Verify notes CRUD still works (add, delete, load)
- [ ] Verify health overview charts still render correctly
- [ ] Verify switching to another main tab and back preserves active sub-tab
- [ ] Run full JS architecture tests (design tokens, globals)
- [ ] Run `go test ./...` (no Go changes expected, but verify nothing broke)

### Task 4: [Final] Update documentation
- [ ] Update CLAUDE.md health-view section if needed

## Technical Details

### Existing sub-tab CSS pattern (styles.css:276-304)
```css
.med-tabs, .workout-tabs, .food-tabs {  /* ADD: .health-tabs */
    display: flex;
    gap: var(--space-md);
    margin-bottom: var(--space-xl);
    border-bottom: 2px solid var(--hint-color);
}

.med-tab, .workout-tab, .food-tab {  /* ADD: .health-tab */
    padding: var(--space-md) var(--space-xl);
    min-height: 44px;
    border: none;
    background: none;
    cursor: pointer;
    color: var(--hint-color);
    font-weight: var(--font-weight-medium);
    border-bottom: 3px solid transparent;
    transition: color 0.15s ease;
}

.med-tab.active, .workout-tab.active, .food-tab.active {  /* ADD: .health-tab.active */
    color: var(--link-color);
    border-bottom: 3px solid var(--link-color);
}

.med-tab-content, .workout-tab-content, .food-tab-content {  /* ADD: .health-tab-content */
    display: none;
}

.med-tab-content.active, .workout-tab-content.active, .food-tab-content.active {  /* ADD: .health-tab-content.active */
    display: block;
}
```

### HTML structure after change
```html
<div id="health-view" class="view">
    <div class="health-tabs">
        <button class="health-tab active" data-tab="overview">Overview</button>
        <button class="health-tab" data-tab="notes">Notes</button>
    </div>

    <div id="health-overview-tab" class="health-tab-content active">
        <div id="health-overview-loading">Loading metrics...</div>
        <div id="health-overview-content" class="hidden">
            <!-- Injected dynamically -->
        </div>
    </div>

    <div id="health-notes-tab" class="health-tab-content">
        <div class="notes-section">
            <h4>My Notes</h4>
            <div class="notes-add">
                <textarea id="notes-textarea" placeholder="Write a note..." rows="3"></textarea>
                <button id="notes-save-btn" class="btn btn-primary">Save Note</button>
            </div>
            <div id="notes-loading" style="display:none;">Loading notes...</div>
            <ul id="notes-list" class="notes-list"></ul>
        </div>
    </div>
</div>
```

## Post-Completion

**Manual verification:**
- Test on mobile — sub-tabs should be touch-friendly (44px min height)
- Verify notes textarea keyboard doesn't occlude the save button
- Verify the notes sub-tab shows correct count or empty state on first load
