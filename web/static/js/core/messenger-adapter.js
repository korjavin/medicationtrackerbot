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
                // Let any synchronous throw from showConfirm propagate out of
                // confirm() so callers (safeConfirm) can fall back to the
                // in-page modal *synchronously* — wrapping the call in a
                // Promise executor would defer the rejection to a microtask,
                // and at that point the caller's sync code has already
                // returned without mounting a fallback dialog.
                let resolveFn;
                const promise = new Promise(function (resolve) { resolveFn = resolve; });
                tg.showConfirm(msg, function (ok) { resolveFn(!!ok); });
                return promise;
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

    // loadTelegramSdk — dynamically injects telegram.org/js/telegram-web-app.js
    // when running in a real browser without the SDK already present. The
    // static <script> tag was removed from index.html so the Capacitor mobile
    // APK never makes a network call to telegram.org; this helper now owns
    // that load for the web build. Returns a Promise that resolves on the
    // script's load/error events (or immediately when injection is skipped).
    //
    //   native Capacitor          → no injection, resolves immediately
    //   window.Telegram.WebApp    → no injection, resolves immediately
    //   prior injection in DOM    → no duplicate, awaits the existing tag
    //   otherwise                 → injects + resolves on load/error
    function loadTelegramSdk() {
        try {
            const cap = (typeof window !== 'undefined') ? window.Capacitor : null;
            if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) {
                return Promise.resolve();
            }
        } catch (e) { /* fall through */ }

        // Embedded-shell signal: once MainActivity redirects the WebView to
        // http://127.0.0.1:<port>, window.Capacitor is gone (plain HTTP origin,
        // not the capacitor:// scheme) but the JavaScriptInterface binding
        // persists across navigations and window.__MEDTRACKER_BOOTSTRAP__ is
        // re-set by native-bootstrap.js. Either marker means "embedded mobile
        // shell — never reach out to telegram.org."
        try {
            if (typeof window !== 'undefined' && (window.MedtrackerNative || window.__MEDTRACKER_BOOTSTRAP__)) {
                return Promise.resolve();
            }
        } catch (e) { /* fall through */ }

        if (typeof window !== 'undefined' && window.Telegram && window.Telegram.WebApp) {
            return Promise.resolve();
        }

        if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
            return Promise.resolve();
        }

        const existing = document.querySelector('script[data-medtracker-telegram-sdk]');
        if (existing) {
            return new Promise(function (resolve) {
                existing.addEventListener('load', function () { resolve(); }, { once: true });
                existing.addEventListener('error', function () { resolve(); }, { once: true });
            });
        }

        return new Promise(function (resolve) {
            const s = document.createElement('script');
            s.src = 'https://telegram.org/js/telegram-web-app.js';
            s.async = true;
            s.setAttribute('data-medtracker-telegram-sdk', 'true');
            s.addEventListener('load', function () { resolve(); }, { once: true });
            s.addEventListener('error', function () { resolve(); }, { once: true });
            (document.head || document.documentElement).appendChild(s);
        });
    }

    function pickAdapter() {
        const hasTelegram = (typeof window.Telegram !== 'undefined')
            && !!window.Telegram
            && !!window.Telegram.WebApp;
        return hasTelegram ? TelegramAdapter : BrowserAdapter;
    }

    // Sync default selection so window.MessengerAdapter is never undefined
    // for the rest of the bundle's synchronous boot path (app.js reads
    // .identityToken() and fires .init() immediately).
    window.MessengerAdapter = pickAdapter();

    // Async upgrade: once the dynamic SDK load completes on the web build,
    // re-pick the adapter so Telegram Mini App users still get the
    // TelegramAdapter even though the static <script> tag in index.html is
    // gone. On native Capacitor / when Telegram is already present, this
    // resolves immediately and the re-pick is a no-op. Re-fires init() on
    // the upgraded adapter so ready()/expand() actually run for late
    // Telegram arrivals, and refreshes window.userInitData so
    // makeAuthHeaders() sees the Telegram initData on subsequent requests
    // (app.js snapshots it synchronously at boot, before this resolves).
    window.MessengerAdapterReady = loadTelegramSdk().then(function () {
        const upgraded = pickAdapter();
        if (upgraded !== window.MessengerAdapter) {
            window.MessengerAdapter = upgraded;
            try { upgraded.init(); } catch (e) { /* swallow */ }
            // Refresh window.userInitData only on a real upgrade. app.js
            // snapshots userInitData synchronously at boot from whatever the
            // initial pick returned; if we upgrade BrowserAdapter →
            // TelegramAdapter mid-boot, makeAuthHeaders() would still see the
            // stale null. Skipping this when the adapter is unchanged avoids
            // clobbering manually-injected token values in test harnesses.
            window.userInitData = upgraded.identityToken() || null;
            if (window.userInitData && typeof window.sendSwAuthToken === 'function') {
                try { window.sendSwAuthToken(); } catch (e) { /* swallow */ }
            }
        }
        return window.MessengerAdapter;
    });
})();
