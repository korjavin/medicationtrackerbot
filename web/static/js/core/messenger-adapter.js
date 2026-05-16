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

    // BrowserAdapter — used when no Telegram WebApp host wraps the page.
    // Identity: cookie-only (authHeaderName returns null → header omitted).
    // Dialogs: native window.alert / window.confirm.
    // Deep links: URL query (?start=foo) or hash (#start=foo or bare #foo).
    // Back: popstate listener + an in-app chevron rendered into <body> on
    // showBack(). The chevron and popstate both invoke the registered handler.
    const BrowserAdapter = (function () {
        let backHandler = null;
        let backButtonEl = null;
        let popstateListenerAttached = false;

        function invokeHandler() {
            if (typeof backHandler === 'function') {
                try { backHandler(); } catch (e) { /* swallow */ }
            }
        }

        function ensureBackButton() {
            if (backButtonEl) return backButtonEl;
            if (typeof document === 'undefined' || !document.createElement) return null;
            const el = document.createElement('button');
            el.id = 'wg-browser-back-button';
            el.type = 'button';
            el.setAttribute('aria-label', 'Back');
            el.className = 'wg-browser-back-button';
            el.textContent = '‹'; // ‹
            el.hidden = true;
            el.addEventListener('click', invokeHandler);
            const mount = function () {
                if (document.body && !backButtonEl.isConnected) {
                    document.body.appendChild(backButtonEl);
                }
            };
            backButtonEl = el;
            if (document.body) {
                mount();
            } else if (typeof document.addEventListener === 'function') {
                document.addEventListener('DOMContentLoaded', mount, { once: true });
            }
            return backButtonEl;
        }

        function readStartParam() {
            try {
                if (typeof window === 'undefined' || !window.location) return null;
                const loc = window.location;
                const search = loc.search || '';
                if (search && typeof URLSearchParams === 'function') {
                    const fromSearch = new URLSearchParams(search).get('start');
                    if (fromSearch) return fromSearch;
                }
                const hashRaw = (loc.hash || '').replace(/^#/, '');
                if (!hashRaw) return null;
                if (hashRaw.indexOf('=') !== -1 && typeof URLSearchParams === 'function') {
                    const fromHash = new URLSearchParams(hashRaw).get('start');
                    if (fromHash) return fromHash;
                    return null;
                }
                // Bare hash like #bp_add
                return hashRaw || null;
            } catch (e) {
                return null;
            }
        }

        return {
            init: function () { return Promise.resolve(); },

            identityToken: function () { return null; },

            authHeaderName: function () { return null; },

            alert: function (msg) {
                try { window.alert(msg); } catch (e) { /* ignore */ }
            },

            confirm: function (msg) {
                try { return Promise.resolve(!!window.confirm(msg)); }
                catch (e) { return Promise.resolve(false); }
            },

            showPopup: function (opts) {
                const title = (opts && opts.title) ? String(opts.title) : '';
                const message = (opts && opts.message) ? String(opts.message) : '';
                const text = (title && message) ? (title + '\n\n' + message) : (title || message);
                try { window.alert(text); } catch (e) { /* ignore */ }
            },

            startParam: readStartParam,

            onBack: function (handler) {
                backHandler = (typeof handler === 'function') ? handler : null;
                if (!popstateListenerAttached && typeof window !== 'undefined'
                    && typeof window.addEventListener === 'function') {
                    window.addEventListener('popstate', invokeHandler);
                    popstateListenerAttached = true;
                }
            },

            showBack: function () {
                const el = ensureBackButton();
                if (el) el.hidden = false;
            },

            hideBack: function () {
                if (backButtonEl) backButtonEl.hidden = true;
            },

            isPresent: function () { return false; },

            // BrowserAdapter always provides a working in-app back affordance,
            // so back-button.js can wire up without a version gate.
            isBackButtonSupported: function () { return true; },
        };
    })();

    const hasTelegram = (typeof window.Telegram !== 'undefined')
        && !!window.Telegram
        && !!window.Telegram.WebApp;

    window.MessengerAdapter = hasTelegram ? TelegramAdapter : BrowserAdapter;
})();
