// Modal history / back-gesture integration.
// Drives the browser history stack so iOS edge-swipe → popstate closes the
// topmost open modal.  The messenger back-button click is handled in
// features/back-button.js (single handler for modal-close + section-back).
//
// The single source of truth for modal state is the modal-overlay element:
// visible  → push history entry + show back button
// hidden   → pop history entry + defer visibility to AppBackButton.refresh()
//
// All back-button toggling goes through window.MessengerAdapter so this file
// behaves identically in the Telegram Mini App (forwards to the Telegram SDK
// BackButton) and in the plain-browser path (in-app chevron + popstate).
//
// Loaded after app.js so ModalManager is available.
// The harness loads this file so modal-history tests can rely on it.
(function initModalHistory() {
    let modalPushed = false;
    let poppingFromHistory = false;
    // True when we've just triggered history.back() ourselves from
    // onOverlayClosed() and the resulting popstate is purely an echo of that
    // call. Without this, BrowserAdapter's section-back popstate listener
    // would fire on top of the in-app modal close and bounce the user to
    // Today. No-op in TelegramAdapter mode (no popstate listener there).
    let swallowNextPopstate = false;
    // Resolve the adapter at use time, not at IIFE start. The Telegram SDK
    // now loads asynchronously (see core/messenger-adapter.js), so the
    // initial pick on a fresh Telegram Mini App open is BrowserAdapter;
    // window.MessengerAdapter is swapped to TelegramAdapter once the SDK
    // resolves. Caching a reference here would permanently route modal
    // back-button toggling through the in-app chevron instead of Telegram's
    // native BackButton.
    function isBackButtonSupported() {
        const a = window.MessengerAdapter;
        return !!(a && typeof a.isBackButtonSupported === 'function' && a.isBackButtonSupported());
    }
    function adapterShowBack() {
        const a = window.MessengerAdapter;
        if (a && typeof a.showBack === 'function') a.showBack();
    }
    function adapterHideBack() {
        const a = window.MessengerAdapter;
        if (a && typeof a.hideBack === 'function') a.hideBack();
    }

    function reconcileBackButtonVisibility() {
        if (!isBackButtonSupported()) return;
        if (window.AppBackButton && typeof window.AppBackButton.refresh === 'function') {
            window.AppBackButton.refresh();
        } else {
            adapterHideBack();
        }
    }

    function onOverlayShown() {
        if (modalPushed) return;
        modalPushed = true;
        history.pushState({ modal: true }, '');
        if (isBackButtonSupported()) adapterShowBack();
    }

    function onOverlayClosed() {
        if (!modalPushed || poppingFromHistory) return;
        modalPushed = false;
        swallowNextPopstate = true;
        history.back();
        reconcileBackButtonVisibility();
    }

    // iOS edge-swipe (and desktop browser back)
    window.addEventListener('popstate', (event) => {
        if (swallowNextPopstate) {
            swallowNextPopstate = false;
            // Stop the BrowserAdapter section-back listener from also firing
            // on this synthetic-from-history.back() popstate.
            if (event && typeof event.stopImmediatePropagation === 'function') {
                event.stopImmediatePropagation();
            }
            return;
        }
        if (!modalPushed) return;
        const overlay = document.getElementById('modal-overlay');
        if (!overlay || overlay.classList.contains('hidden')) {
            modalPushed = false;
            reconcileBackButtonVisibility();
            return;
        }
        // BrowserAdapter.onBack also listens on popstate to drive section-back
        // (switchTab('today')). When we're consuming this event to close a
        // modal, stop it so that listener doesn't also fire and bounce the
        // user back to Today on top of the modal close. No-op in TelegramAdapter
        // mode because that adapter doesn't register a popstate listener.
        if (event && typeof event.stopImmediatePropagation === 'function') {
            event.stopImmediatePropagation();
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
