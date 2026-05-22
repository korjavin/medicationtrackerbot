// features/backend-logs.js — Settings → About → Backend logs debug screen.
//
// Reveals a "View logs" button that opens a modal showing the last 200 lines
// of the embedded Go binary's stdout+stderr, fetched on demand from the
// Android-side NativeBridge.getBackendLogs(). The row stays hidden in the
// browser PWA + server-mode build (no MedtrackerNative bridge), so this file
// is a no-op outside the Capacitor shell.
//
// Phase 2a, Task 5. The native side captures both streams into a unified
// 200-line ring in GoServerService; lines that came from stderr are prefixed
// "E " so an end user copying the output into a bug report keeps the
// channel hint intact.
(function () {
    'use strict';

    const ROW_ID = 'backend-logs-row';
    const OPEN_BTN_ID = 'backend-logs-open-btn';
    const CLOSE_BTN_ID = 'backend-logs-close-btn';
    const MODAL_ID = 'backend-logs-modal';
    const OUTPUT_ID = 'backend-logs-output';

    function hasNativeBridge() {
        const n = (typeof window !== 'undefined') ? window.MedtrackerNative : null;
        return !!(n && typeof n.getBackendLogs === 'function');
    }

    function fetchLogs() {
        try {
            const text = window.MedtrackerNative.getBackendLogs();
            return typeof text === 'string' ? text : '';
        } catch (_e) {
            return '';
        }
    }

    function openModal() {
        const modal = document.getElementById(MODAL_ID);
        const out = document.getElementById(OUTPUT_ID);
        if (!modal || !out) return;
        const text = fetchLogs();
        out.textContent = text || '(no log lines captured yet)';
        modal.classList.remove('hidden');
    }

    function closeModal() {
        const modal = document.getElementById(MODAL_ID);
        if (!modal) return;
        modal.classList.add('hidden');
    }

    function mount() {
        const row = document.getElementById(ROW_ID);
        const openBtn = document.getElementById(OPEN_BTN_ID);
        const closeBtn = document.getElementById(CLOSE_BTN_ID);
        if (!row || !openBtn) return;

        if (!hasNativeBridge()) {
            // Stay hidden in non-Capacitor builds; nothing else to do.
            return;
        }

        row.classList.remove('hidden');
        openBtn.addEventListener('click', openModal);
        if (closeBtn) closeBtn.addEventListener('click', closeModal);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount, { once: true });
    } else {
        mount();
    }

    window.BackendLogs = {
        // Exported for tests + future programmatic refresh hooks.
        hasNativeBridge: hasNativeBridge,
        fetchLogs: fetchLogs,
        openModal: openModal,
        closeModal: closeModal,
        mount: mount,
    };
})();
