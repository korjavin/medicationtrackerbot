// Back-button integration for section-level navigation.
// Single back handler for the whole app:
//   - If a modal is open → close the topmost modal (modal-history's MutationObserver
//     handles the history.back() + visibility reconciliation via refresh()).
//   - Otherwise → switch back to Today from the current section view.
//
// modal-history.js drives show() when a modal opens; after a modal closes it calls
// AppBackButton.refresh() so the button re-appears on non-Today sections.
//
// All BackButton interactions go through window.MessengerAdapter so the same
// code path serves the Telegram Mini App (forwards to the Telegram SDK
// BackButton) and the browser PWA (in-app chevron + popstate).
//
// Loaded after app.js and modal-history.js.  bootstrap.js calls
// AppBackButton.setup() once, after the initial tab is activated.

(function () {
    let refreshFn = null;

    function setupAppBackButton() {
        const adapter = window.MessengerAdapter;
        if (!adapter || typeof adapter.isBackButtonSupported !== 'function') return;
        if (!adapter.isBackButtonSupported()) return;

        function modalIsOpen() {
            const overlay = document.getElementById('modal-overlay');
            return !!overlay && !overlay.classList.contains('hidden');
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

        adapter.onBack(function () {
            if (modalIsOpen()) {
                if (window.ModalManager && typeof window.ModalManager.closeTopMostVisibleModal === 'function') {
                    window.ModalManager.closeTopMostVisibleModal();
                }
                return;
            }
            if (typeof window.switchTab === 'function') {
                window.switchTab('today');
            }
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
