---
# Add Drag-and-Drop Tab Reordering

## Overview
Allow users to reorder the main navigation tabs via drag-and-drop on the tab bar. The new order is persisted server-side in the settings table and included in the bootstrap payload, so it is cached locally in IndexedDB and applied on every startup from the local cache — no extra server round-trip on load.

## Context
- Files involved:
  - `internal/store/migrations/` - new migration 036
  - `internal/store/store.go` - GetTabOrder/SetTabOrder methods
  - `internal/server/store_interfaces.go` - extend SettingsStore interface
  - `internal/server/settings_handlers.go` - bootstrap includes tab_order; POST handler to save
  - `internal/server/server.go` - new route registration for POST only
  - `web/static/js/app.js` - apply tab order from bootstrap payload; update applyBootstrapPayload and swipe nav
  - `web/static/js/features/settings.js` - saveTabOrder() helper
  - `web/static/js/features/tabs-dnd.js` - new file: drag-and-drop logic
  - `web/static/index.html` - add script tag for tabs-dnd.js
- Related patterns: feature toggles (migration 022, settings_handlers.go), bootstrap settings bundle (applyBootstrapPayload in app.js), weight ruler drag (pointer events)
- Dependencies: none (vanilla JS pointer events, no new libraries)

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- Follow Domain Service Pattern: settings store → SettingsStore interface → handler → frontend
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Backend - persist tab_order and include in bootstrap

**Files:**
- Create: `internal/store/migrations/036_add_tab_order.sql`
- Modify: `internal/store/store.go`
- Modify: `internal/server/store_interfaces.go`
- Modify: `internal/server/settings_handlers.go`
- Modify: `internal/server/server.go`

- [ ] Create migration 036: `ALTER TABLE settings ADD COLUMN tab_order TEXT DEFAULT NULL`
- [ ] Add `GetTabOrder(ctx) (string, error)` and `SetTabOrder(ctx, order string) error` to Store in store.go (return empty string if NULL)
- [ ] Add `GetTabOrder` and `SetTabOrder` to `SettingsStore` interface in store_interfaces.go
- [ ] In `handleBootstrap`: fetch tab_order and include it as `settings.tab_order` in the response (alongside existing `food_targets`, `bp_reminder_status`, `weight_reminder_status`)
- [ ] Add `handleSetTabOrder` handler: `POST /api/settings/tab-order` accepts `{"order": [...]}`, validates all entries are known tab IDs, saves JSON string
- [ ] Register POST route in server.go
- [ ] Write store tests for GetTabOrder/SetTabOrder
- [ ] Write server handler tests for POST /api/settings/tab-order and bootstrap tab_order inclusion (httptest pattern)
- [ ] Run `go test ./internal/store ./internal/server` - must pass

### Task 2: Frontend - apply tab order from bootstrap cache on startup

**Files:**
- Modify: `web/static/js/app.js`

- [ ] In `applyBootstrapPayload`: extract `res.settings.tab_order` (JSON array or null); call `applyTabOrder(order)` immediately if non-null
- [ ] Implement `applyTabOrder(order)`: reorder `<button class="tab">` DOM nodes in `#tabs` container according to the saved order; skip tabs not present in DOM, append any unlisted tabs at end
- [ ] Store tab_order into `settings_bundle` cache so it survives the session and future offline loads (it's already written via `cacheApiSnapshot('settings_bundle', settingsBundle)` — extend `normalizeSettingsBundle` to pass through `tab_order`)
- [ ] Update swipe navigation to derive the visible-tabs list from current DOM order rather than a hardcoded array, so it respects the user-set order
- [ ] Manual test: a saved order in DB is applied on reload without any extra fetch

### Task 3: Frontend - drag-and-drop on tab bar

**Files:**
- Create: `web/static/js/features/tabs-dnd.js`
- Modify: `web/static/index.html`
- Modify: `web/static/js/app.js`
- Modify: `web/static/js/features/settings.js`

- [ ] Create `tabs-dnd.js` with `initTabsDragAndDrop(container, onOrderChange)`:
  - Use pointer events (`pointerdown`, `pointermove`, `pointerup`) — unified mouse/touch
  - Long-press (300ms) to activate drag mode; show visual indicator (scale-up on dragged tab)
  - During drag: translate the dragged tab, detect which slot the pointer is over, swap positions in DOM
  - On `pointerup`: finalize DOM order, call `onOrderChange(newOrder)` with array of tab `data-tab` values
  - Cancel drag on `pointercancel`
- [ ] In settings.js, add `window.saveTabOrder(order)`: POST to `/api/settings/tab-order`; update local `settings_bundle` cache entry for offline consistency
- [ ] In app.js after DOM ready: call `initTabsDragAndDrop(document.getElementById('tabs'), async (order) => { await window.saveTabOrder(order); })`
- [ ] Add `<script src="/static/js/features/tabs-dnd.js?v=...">` to index.html
- [ ] Manual test: drag tab to new position → reload → order preserved; swipe navigation follows new order; works on mobile touch

### Task 4: Verify acceptance criteria

- [ ] Manual test: drag a tab to a new position, reload page — position is preserved (served from IndexedDB cache instantly)
- [ ] Manual test: disable a feature tab (e.g. food) — hidden tab stays out of rotation; re-enable — appears in last saved position
- [ ] Manual test: first load with no saved order — default order applies correctly
- [ ] Manual test: swipe navigation respects custom tab order
- [ ] Manual test: works on mobile (touch)
- [ ] Run `go test ./...` — must pass
- [ ] Run `go vet ./...`

### Task 5: Update documentation

- [ ] Update CLAUDE.md if new patterns introduced (tabs-dnd.js, tab_order in bootstrap)
- [ ] Move this plan to `docs/plans/completed/`
