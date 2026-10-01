// Modal history / back-gesture integration.
// Drives the browser history stack so iOS edge-swipe → popstate closes the
// topmost open modal.  The messenger back-button click is handled in
// features/back-button.js (single handler for modal-close + section-back).
//
// Two kinds of modal state drive the history stack:
// - the modal-overlay element (registered modals):
//   visible  → push history entry + show back button
//   hidden   → pop history entry + defer visibility to AppBackButton.refresh()
// - the in-page dialog (safeConfirm/safePrompt/safeChoose mount
//   mt-modal.mt-confirm-modal straight on <body>, outside the overlay):
//   mounted  → push its own history entry
//   removed  → pop it
//   so Back over a dialog cancels just the dialog (bd med-62lh).
//
// All back-button toggling goes through window.MessengerAdapter
// (in-app chevron + popstate in the browser PWA).
//
// Loaded after app.js so ModalManager is available.
// The harness loads this file so modal-history tests can rely on it.
(function initModalHistory() {
    let modalPushed = false;
    let poppingFromHistory = false;
    // True when we've just called history.back() ourselves (onOverlayClosed
    // or a dialog's removal) and the next popstate is purely its echo.
    // Without this, BrowserAdapter's section-back popstate listener would
    // fire on top of the in-app close and bounce the user to Today.
    // ponytail: a flag, not a counter — two back() calls in one tick collapse
    // into one traversal (jsdom, and likely browsers), so a counter would leak
    // and swallow the user's next real Back. No caller does that today.
    let swallowNextPopstate = false;
    let dialogPushed = false;
    function isDialogOpen() {
        return !!(window.ModalManager && window.ModalManager.isDialogOpen());
    }
    // Resolve the adapter at use time, not at IIFE start, so a swapped
    // window.MessengerAdapter is picked up by the overlay handlers.
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

    function onBodyChildrenChanged() {
        // A closing window tears <body> down after its document is gone.
        if (!window.document) return;
        const open = isDialogOpen();
        if (open && !dialogPushed) {
            dialogPushed = true;
            history.pushState({ modalDialog: true }, '');
        } else if (!open && dialogPushed) {
            dialogPushed = false;
            swallowNextPopstate = true;
            history.back();
        }
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
        if (dialogPushed && isDialogOpen()) {
            // Back consumed the dialog's own entry: cancel the dialog only.
            // The overlay modal / section guard entry below stays intact.
            if (event && typeof event.stopImmediatePropagation === 'function') {
                event.stopImmediatePropagation();
            }
            dialogPushed = false;
            window.ModalManager.closeTopMostVisibleModal();
            // A stacked dialog still open → re-push for the next Back.
            if (isDialogOpen()) {
                dialogPushed = true;
                history.pushState({ modalDialog: true }, '');
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
        // user back to Today on top of the modal close.
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

    // Watch modal-overlay for class changes and <body> children for the
    // in-page dialog to drive history push/pop
    function setupObserver() {
        if (document.body) {
            new MutationObserver(onBodyChildrenChanged).observe(document.body, { childList: true });
        }
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
