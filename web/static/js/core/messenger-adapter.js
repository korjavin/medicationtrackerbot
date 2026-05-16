// MessengerAdapter — the only file allowed to reach into window.Telegram.WebApp.
// All other frontend code calls window.MessengerAdapter.<method>() so the
// surrounding "messenger" (Telegram Mini App today, browser PWA tomorrow,
// some-other-messenger embed someday) can be swapped without touching the
// 6+ feature-level call sites that used to inline `window.Telegram.WebApp`.
//
// Interface contract (every adapter implements):
//
//   init()             → Promise<void>
//                        One-time bootstrap (ready/expand for Telegram, no-op
//                        elsewhere). app.js awaits this very early.
//
//   identityToken()    → string | null
//                        Auth credential for outgoing HTTP requests. Telegram:
//                        initData blob (string). Browser fallback: null
//                        (cookie-only auth path).
//
//   authHeaderName()   → string | null
//                        Header name to attach identityToken() under. Returns
//                        null when no header should be sent (cookie path).
//
//   alert(msg)         → void   — best-effort native popup
//   confirm(msg)       → Promise<boolean>
//   showPopup(opts)    → void   — forwarded to host SDK when available
//
//   startParam()       → string | null
//                        Deep-link start parameter (Telegram start_param /
//                        URL hash / query param).
//
//   onBack(handler)    → void   — registers single back handler
//   showBack()         → void
//   hideBack()         → void
//
//   isPresent()        → boolean
//                        True when a real messenger host is wrapping the page.
//                        Callers use this to gate messenger-specific UX.
//
// Selection runs at the very top of this file so subsequent <script> tags can
// rely on window.MessengerAdapter immediately.

(function () {
    'use strict';

    const TelegramAdapter = {
        init: function () {
            return new Promise(function (resolve) {
                try {
                    const tg = window.Telegram && window.Telegram.WebApp;
                    if (tg) {
                        if (typeof tg.ready === 'function') tg.ready();
                        if (typeof tg.expand === 'function') tg.expand();
                    }
                } catch (e) {
                    // swallow — boot must not block on SDK quirks
                }
                resolve();
            });
        },

        identityToken: function () {
            const tg = window.Telegram && window.Telegram.WebApp;
            return (tg && typeof tg.initData === 'string') ? tg.initData : '';
        },

        authHeaderName: function () {
            return 'X-Telegram-Init-Data';
        },

        alert: function (msg) {
            const tg = window.Telegram && window.Telegram.WebApp;
            if (tg && typeof tg.showAlert === 'function') {
                try {
                    tg.showAlert(msg);
                    return;
                } catch (e) {
                    // fall through
                }
            }
            try { window.alert(msg); } catch (e) { /* ignore */ }
        },

        confirm: function (msg) {
            const tg = window.Telegram && window.Telegram.WebApp;
            if (tg && typeof tg.showConfirm === 'function') {
                return new Promise(function (resolve) {
                    try {
                        tg.showConfirm(msg, function (ok) { resolve(!!ok); });
                    } catch (e) {
                        resolve(!!window.confirm(msg));
                    }
                });
            }
            return Promise.resolve(!!window.confirm(msg));
        },

        showPopup: function (opts) {
            const tg = window.Telegram && window.Telegram.WebApp;
            if (tg && typeof tg.showPopup === 'function') {
                try {
                    tg.showPopup(opts);
                    return;
                } catch (e) {
                    // fall through
                }
            }
            const msg = (opts && (opts.message || opts.title)) || '';
            try { window.alert(msg); } catch (e) { /* ignore */ }
        },

        startParam: function () {
            const tg = window.Telegram && window.Telegram.WebApp;
            const unsafe = tg && tg.initDataUnsafe;
            return (unsafe && typeof unsafe.start_param === 'string')
                ? unsafe.start_param
                : null;
        },

        onBack: function (handler) {
            const tg = window.Telegram && window.Telegram.WebApp;
            const bb = tg && tg.BackButton;
            if (bb && typeof bb.onClick === 'function') {
                bb.onClick(handler);
            }
        },

        showBack: function () {
            const tg = window.Telegram && window.Telegram.WebApp;
            const bb = tg && tg.BackButton;
            if (bb && typeof bb.show === 'function') bb.show();
        },

        hideBack: function () {
            const tg = window.Telegram && window.Telegram.WebApp;
            const bb = tg && tg.BackButton;
            if (bb && typeof bb.hide === 'function') bb.hide();
        },

        isPresent: function () {
            return true;
        },

        // Exposed so back-button.js can keep its "isVersionAtLeast 6.1" guard
        // without reading window.Telegram directly.
        isBackButtonSupported: function () {
            const tg = window.Telegram && window.Telegram.WebApp;
            const bb = tg && tg.BackButton;
            if (!bb) return false;
            if (typeof tg.isVersionAtLeast !== 'function') return true;
            try { return !!tg.isVersionAtLeast('6.1'); } catch (e) { return false; }
        },
    };

    // BrowserAdapter is filled in by Task 2; for now a placeholder stub keeps
    // selection well-defined when window.Telegram is absent.
    const BrowserAdapter = {
        init: function () { return Promise.resolve(); },
        identityToken: function () { return null; },
        authHeaderName: function () { return null; },
        alert: function (msg) { try { window.alert(msg); } catch (e) { /* ignore */ } },
        confirm: function (msg) { return Promise.resolve(!!window.confirm(msg)); },
        showPopup: function (opts) {
            const msg = (opts && (opts.message || opts.title)) || '';
            try { window.alert(msg); } catch (e) { /* ignore */ }
        },
        startParam: function () { return null; },
        onBack: function () { /* placeholder — Task 2 wires popstate */ },
        showBack: function () { /* placeholder */ },
        hideBack: function () { /* placeholder */ },
        isPresent: function () { return false; },
        isBackButtonSupported: function () { return false; },
    };

    const hasTelegram = (typeof window.Telegram !== 'undefined')
        && !!window.Telegram
        && !!window.Telegram.WebApp;

    window.MessengerAdapter = hasTelegram ? TelegramAdapter : BrowserAdapter;
})();
