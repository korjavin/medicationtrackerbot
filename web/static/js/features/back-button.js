// Telegram WebApp BackButton integration for section-level navigation.
// Companion to features/modal-history.js:
//   modal-history.js  → BackButton click closes the topmost open modal
//   back-button.js    → BackButton click returns to Today when no modal is open
// Both integrations call BackButton.show()/hide() independently; this one only
// drives visibility when no modal is on-screen, so it never fights modal-history.
//
// Loaded after app.js and modal-history.js.  bootstrap.js calls
// AppBackButton.setup() once, after the initial tab is activated.

(function () {
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

        function refreshBackButton(tab) {
            if (modalIsOpen()) return;
            if (tab && tab !== 'today') {
                backButton.show();
            } else {
                backButton.hide();
            }
        }

        backButton.onClick(function () {
            if (modalIsOpen()) return;
            if (typeof window.switchTab === 'function') {
                window.switchTab('today');
            }
        });

        if (window.AppStore && typeof window.AppStore.subscribe === 'function') {
            window.AppStore.subscribe('currentTab', refreshBackButton);
        }

        const initialTab = (window.AppStore && typeof window.AppStore.get === 'function' && window.AppStore.get('currentTab'))
            || ((document.querySelector('.view.active') || {}).id || '').replace(/-view$/, '');
        refreshBackButton(initialTab);
    }

    window.AppBackButton = { setup: setupAppBackButton };
})();
