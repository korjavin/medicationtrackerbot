// Telegram WebApp BackButton integration for section-level navigation.
// Single BackButton click handler for the whole app:
//   - If a modal is open → close the topmost modal (modal-history's MutationObserver
//     handles the history.back() + visibility reconciliation via refresh()).
//   - Otherwise → switch back to Today from the current section view.
//
// modal-history.js drives show() when a modal opens; after a modal closes it calls
// AppBackButton.refresh() so the button re-appears on non-Today sections.
//
// Loaded after app.js and modal-history.js.  bootstrap.js calls
// AppBackButton.setup() once, after the initial tab is activated.

(function () {
    let refreshFn = null;

    function setupAppBackButton() {
        const webApp = window.Telegram && window.Telegram.WebApp;
        const backButton = webApp && webApp.BackButton;
        if (!backButton) return;
        const supported = typeof webApp.isVersionAtLeast !== 'function'
            || webApp.isVersionAtLeast('6.1');
        if (!supported) return;

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
                backButton.show();
            } else {
                backButton.hide();
            }
        }
        refreshFn = refreshBackButton;

        backButton.onClick(function () {
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
