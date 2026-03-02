// Modal history / back-gesture integration.
// Drives the browser history stack and Telegram BackButton so that the
// hardware back gesture (iOS edge-swipe → popstate, Android back button →
// Telegram BackButton) closes the topmost open modal.
//
// The single source of truth for modal state is the modal-overlay element:
// visible  → push history entry + show BackButton
// hidden   → pop history entry + hide BackButton
//
// Loaded after app.js so ModalManager is available.
// The harness loads this file so modal-history tests can rely on it.

// Back gesture / hardware-back closes the topmost open modal
// iOS edge-swipe fires popstate; Android hardware back fires Telegram BackButton
(function initModalHistory() {
    let modalPushed = false;
    let poppingFromHistory = false;
    const webApp = window.Telegram?.WebApp;
    const backButton = webApp?.BackButton;
    const isBackButtonSupported = !!backButton && (
        typeof webApp?.isVersionAtLeast !== 'function' || webApp.isVersionAtLeast('6.1')
    );

    function onOverlayShown() {
        if (modalPushed) return;
        modalPushed = true;
        history.pushState({ modal: true }, '');
        if (isBackButtonSupported) backButton.show();
    }

    function onOverlayClosed() {
        if (!modalPushed || poppingFromHistory) return;
        modalPushed = false;
        history.back();
        if (isBackButtonSupported) backButton.hide();
    }

    // iOS edge-swipe (and desktop browser back)
    window.addEventListener('popstate', () => {
        if (!modalPushed) return;
        const overlay = document.getElementById('modal-overlay');
        if (!overlay || overlay.classList.contains('hidden')) {
            modalPushed = false;
            if (isBackButtonSupported) backButton.hide();
            return;
        }
        poppingFromHistory = true;
        window.ModalManager.closeTopMostVisibleModal();
        poppingFromHistory = false;
        modalPushed = false;
        // Sub-modal closed but parent still open → re-push so next back also works
        if (!overlay.classList.contains('hidden')) {
            modalPushed = true;
            history.pushState({ modal: true }, '');
        } else {
            if (isBackButtonSupported) backButton.hide();
        }
    });

    // Android hardware back / Telegram header back button
    if (isBackButtonSupported) {
        backButton.onClick(() => {
            const overlay = document.getElementById('modal-overlay');
            if (!overlay || overlay.classList.contains('hidden')) return;
            poppingFromHistory = true;
            window.ModalManager.closeTopMostVisibleModal();
            poppingFromHistory = false;
            modalPushed = false;
            if (!overlay.classList.contains('hidden')) {
                modalPushed = true; // BackButton stays visible
            } else {
                backButton.hide();
                history.back(); // clean up the history entry we pushed
            }
        });
    }

    // Watch modal-overlay for class changes to drive history push/pop
    function setupObserver() {
        const overlay = document.getElementById('modal-overlay');
        if (!overlay) return;
        new MutationObserver(() => {
            overlay.classList.contains('hidden') ? onOverlayClosed() : onOverlayShown();
        }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
    }

    document.readyState === 'loading'
        ? document.addEventListener('DOMContentLoaded', setupObserver)
        : setupObserver();
})();
