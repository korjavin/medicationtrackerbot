// Tab binding + activation helpers extracted from app.js
// (Plan 2026-05-13, Task 6).
//
// app.js historically defined two tab helpers (bindTabGroup, activateTabGroup)
// plus three near-identical one-shot bind guards (medicationControlsBound,
// measurementControlsBound, notificationControlsBound) — each its own
// module-level `let` flag with the same "call me at most once" pattern. The
// guards drift apart over time (different DOMContentLoaded handlers, different
// ordering relative to dynamic re-renders) for no good reason.
//
// TabController collapses both concerns:
//   - bindTabGroup({ container, buttonSelector, onTabSelect })
//     wires a delegated click handler on `container`, using the existing
//     `dataset.tabBound` guard so reentrant calls are idempotent.
//   - activateTabGroup(tab, { buttonSelector?, contentSelector,
//     contentIdFromTab, ariaCurrent? }) toggles the active class on the
//     button strip (if present) and the content panes; returns `false` when
//     the target content node is missing so the caller can keep the previous
//     active state instead of blanking the page.
//   - bindOnce(scope, fn) calls `fn()` the first time per `scope` key; the
//     three *ControlsBound flags in app.js all collapse into this.
//
// The bound-scope set is closure-private inside the module (one allowed
// `let _state = { boundScopes: new Set() }` per the architecture test).
// Test code can reset it via `_resetForTesting()`.

window.TabController = (function () {
    let _state = {
        boundScopes: new Set(),
    }; // module-state: tab-controller bind-once registry; documented above

    function activateTabGroup(tab, options) {
        const { buttonSelector, contentSelector, contentIdFromTab, ariaCurrent } = options;
        // Validate target exists BEFORE clearing active state to avoid
        // blank-page on unknown tabs. tabButton is optional: the top-level
        // view group has no button strip after the Wandergeek bottom-nav
        // rework (buttonSelector is omitted), so the button-side toggle is a
        // no-op when missing.
        const tabButton = buttonSelector
            ? document.querySelector(`${buttonSelector}[data-tab="${tab}"]`)
            : null;
        const tabContent = document.getElementById(contentIdFromTab(tab));
        if (!tabContent) return false;

        if (buttonSelector) {
            document.querySelectorAll(buttonSelector).forEach((el) => {
                el.classList.remove('active');
                if (ariaCurrent) el.removeAttribute('aria-current');
            });
        }
        document.querySelectorAll(contentSelector).forEach((el) => el.classList.remove('active'));
        if (tabButton) {
            tabButton.classList.add('active');
            if (ariaCurrent) tabButton.setAttribute('aria-current', ariaCurrent);
        }
        tabContent.classList.add('active');
        return true;
    }

    function bindTabGroup(options) {
        const { container, buttonSelector, onTabSelect } = options;
        if (!container || container.dataset.tabBound === '1') return;
        container.dataset.tabBound = '1';

        container.addEventListener('click', (event) => {
            const button = event.target.closest(buttonSelector);
            if (!button || !container.contains(button)) return;
            const tab = button.dataset.tab;
            if (!tab) return;
            onTabSelect(tab);
        });
    }

    // bindOnce(scope, fn) calls `fn()` the first time it sees a given scope
    // key, then returns without invoking it on subsequent calls. Replaces the
    // three identical module-level `*ControlsBound` flags (medicationControlsBound,
    // measurementControlsBound, notificationControlsBound) in app.js with a
    // single shared registry, so adding a fourth one is free.
    function bindOnce(scope, fn) {
        if (typeof scope !== 'string' || !scope) return;
        if (_state.boundScopes.has(scope)) return;
        _state.boundScopes.add(scope);
        if (typeof fn === 'function') fn();
    }

    function isBound(scope) {
        return _state.boundScopes.has(scope);
    }

    function _resetForTesting() {
        _state.boundScopes = new Set();
    }

    return {
        activateTabGroup,
        bindTabGroup,
        bindOnce,
        isBound,
        _resetForTesting,
    };
})();
