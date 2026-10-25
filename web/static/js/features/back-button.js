// Back-button integration for section-level navigation.
// The chevron tap and the BrowserAdapter's popstate run AppBack.step()
// (features/app-back.js): close the topmost modal (modal-history's
// MutationObserver handles the history.back() + visibility reconciliation via
// refresh()), else return to the previous section, else nothing at Today.
//
// modal-history.js drives show() when a modal opens; after a modal closes it calls
// AppBackButton.refresh() so the button re-appears on non-Today sections.
//
// All back-button interactions go through window.MessengerAdapter
// (in-app chevron + popstate in the browser PWA).
//
// Loaded after app.js and modal-history.js.  bootstrap.js calls
// AppBackButton.setup() once, after the initial tab is activated.

(function () {
    let refreshFn = null;

    function setupAppBackButton() {
        const adapter = window.MessengerAdapter;
        if (!adapter || typeof adapter.isBackButtonSupported !== 'function') return;
        if (!adapter.isBackButtonSupported()) return;

        // Overlay modal or in-page dialog (shared predicate, bd med-62lh).
        function modalIsOpen() {
            return !!(window.ModalManager && window.ModalManager.isAnyOpen());
        }

        function currentTab() {
            if (window.AppStore && typeof window.AppStore.get === 'function') {
                const t = window.AppStore.get('currentTab');
                if (t) return t;
            }
            return ((document.querySelector('.view.active') || {}).id || '').replace(/-view$/, '');
        }

        function refreshBackButton(tab) {
            if (modalIsOpen()) return;
            const t = (typeof tab === 'string') ? tab : currentTab();
            if (t && t !== 'today') {
                adapter.showBack();
            } else {
                adapter.hideBack();
            }
        }
        refreshFn = refreshBackButton;

        // The one back order lives in features/app-back.js (bd med-y7b4.3).
        adapter.onBack(function () {
            if (window.AppBack) window.AppBack.step();
        });

        if (window.AppStore && typeof window.AppStore.subscribe === 'function') {
            window.AppStore.subscribe('currentTab', refreshBackButton);
        }

        refreshBackButton(currentTab());
    }

    window.AppBackButton = {
        setup: setupAppBackButton,
        refresh: function () { if (refreshFn) refreshFn(); }
    };
})();
