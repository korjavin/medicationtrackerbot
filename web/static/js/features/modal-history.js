// Modal history / back-gesture integration.
// Drives the browser history stack so iOS edge-swipe → popstate closes the
// topmost open modal.  The Telegram BackButton click is handled in
// features/back-button.js (single handler for modal-close + section-back).
//
// The single source of truth for modal state is the modal-overlay element:
// visible  → push history entry + show BackButton
// hidden   → pop history entry + defer visibility to AppBackButton.refresh()
//
// Loaded after app.js so ModalManager is available.
// The harness loads this file so modal-history tests can rely on it.
(function initModalHistory() {
    let modalPushed = false;
    let poppingFromHistory = false;
    const webApp = window.Telegram?.WebApp;
    const backButton = webApp?.BackButton;
    const isBackButtonSupported = !!backButton && (
        typeof webApp?.isVersionAtLeast !== 'function' || webApp.isVersionAtLeast('6.1')
    );

    function reconcileBackButtonVisibility() {
        if (!isBackButtonSupported) return;
        if (window.AppBackButton && typeof window.AppBackButton.refresh === 'function') {
            window.AppBackButton.refresh();
        } else {
            backButton.hide();
        }
    }

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
        reconcileBackButtonVisibility();
    }

    // iOS edge-swipe (and desktop browser back)
    window.addEventListener('popstate', () => {
        if (!modalPushed) return;
        const overlay = document.getElementById('modal-overlay');
        if (!overlay || overlay.classList.contains('hidden')) {
            modalPushed = false;
            reconcileBackButtonVisibility();
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
            reconcileBackButtonVisibility();
        }
    });

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
