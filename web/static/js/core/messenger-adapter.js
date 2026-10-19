// MessengerAdapter — browser-only host adapter for the cloud PWA.
//
// The Telegram Mini-App client is gone: no host SDK to reach into, no
// initData identity token, and no auth header to attach. All frontend code
// calls window.MessengerAdapter.<method>(); the object below is the only
// implementation, assigned synchronously at the bottom of this file so
// subsequent <script> tags can rely on it immediately.
//
// Interface contract:
//
//   init()             → Promise<void> (always resolved; kept as the boot seam
//                        app.js awaits very early).
//
//   identityToken()    → null — no host identity; requests authenticate via
//                        the session cookie.
//   authHeaderName()   → null — no auth header is ever attached.
//
//   Dialogs are not the adapter's job: core/utils.js renders every one
//   in-page (safeAlert / safeConfirm / safePrompt / safeChoose).
//
//   startParam()       → string | null
//                        Deep-link parameter from the URL query (?start=foo),
//                        hash (#start=foo), or a bare hash (#foo).
//
//   onBack(handler)    → void   — registers the single back handler
//   showBack()         → void   — reveals the in-app chevron
//   hideBack()         → void   — hides the in-app chevron
//   historyPush(state) → void   — history.pushState, held while an own Back is in flight
//   historyBack()      → void   — history.back() whose popstate the app never sees
//
//   isPresent()        → false — no messenger host wraps the page.
//
//   isBackButtonSupported() → true — the in-app chevron is always usable.

(function () {
    'use strict';

    // BrowserAdapter — the only adapter. Identity: cookie-only
    // (authHeaderName returns null → no header is ever attached).
    // Deep links: URL query (?start=foo) or hash (#start=foo or bare #foo).
    // Back: popstate listener + an in-app chevron rendered into <body> on
    // showBack(). The chevron and popstate both invoke the registered handler.
    const BrowserAdapter = (function () {
        let backHandler = null;
        let backButtonEl = null;
        let popstateListenerAttached = false;
        // guardPushed tracks a synthetic history entry we push whenever a
        // section back-affordance is shown (showBack). Without it a browser/
        // system Back on a non-Today section pops the *page* off the stack and
        // leaves the app entirely (bd med-z1n.2: "back on Journey sends me to the
        // previous site"). With the guard entry present, Back pops it instead,
        // fires popstate, and routes to Today in-app. Reset in onPopstate before
        // the handler runs so the resulting hideBack() doesn't pop a second
        // (real) entry.
        let guardPushed = false;

        function hasHistory() {
            return typeof window !== 'undefined' && window.history
                && typeof window.history.pushState === 'function';
        }

        // The app's own history ops, one traversal at a time (bd med-nt9p.39).
        // history.back() is async and Android WebView delivered its popstate
        // ~3-4 s late on a cold start: an entry pushed in between (a Settings
        // page, a dialog, the guard) was the one it popped, and the echo then
        // ran the Back handler, so pages and dialogs closed by themselves.
        // While one of our backs is in flight, later pushes and backs queue in
        // order (two back() calls in one tick can collapse into one traversal,
        // so a second one only starts after the first lands), and its popstate
        // is swallowed here, before any app popstate listener.
        // ponytail: a user Back landing while ours is in flight is taken for
        // our echo (and ours for the user's); a sequence number in
        // history.state would tell them apart if that shows up.
        let backInFlight = false;
        let queuedOps = []; // { push: state } | { back: true }
        let backTimer = null;
        const OWN_BACK_MAX_MS = 10000; // a back() that never fires popstate must not hold history forever

        function startBack() {
            backInFlight = true;
            clearTimeout(backTimer);
            backTimer = setTimeout(backLanded, OWN_BACK_MAX_MS);
            window.history.back();
        }

        function backLanded() {
            backInFlight = false;
            clearTimeout(backTimer);
            while (queuedOps.length && !backInFlight) {
                const op = queuedOps.shift();
                if (op.back) startBack();
                else window.history.pushState(op.push, '');
            }
        }

        function historyPush(state) {
            if (backInFlight) queuedOps.push({ push: state });
            else window.history.pushState(state, '');
        }

        function historyBack() {
            if (!backInFlight) return startBack();
            const last = queuedOps[queuedOps.length - 1];
            // The entry to pop was never pushed: drop it instead.
            if (last && !last.back) queuedOps.pop();
            else queuedOps.push({ back: true });
        }

        if (hasHistory() && typeof window.addEventListener === 'function') {
            // Capture + registered at load: runs before modal-history's and onPopstate.
            window.addEventListener('popstate', (event) => {
                if (!backInFlight) return;
                event.stopImmediatePropagation();
                backLanded();
            }, true);
        }

        function invokeHandler() {
            if (typeof backHandler === 'function') {
                try { backHandler(); } catch (e) { /* swallow */ }
            }
        }

        // popstate fired: the browser already consumed the top entry (our guard,
        // if any). Clear the flag first so the handler's downstream hideBack()
        // treats the guard as gone and never calls history.back() again.
        function onPopstate() {
            guardPushed = false;
            invokeHandler();
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

            startParam: readStartParam,

            onBack: function (handler) {
                backHandler = (typeof handler === 'function') ? handler : null;
                if (!popstateListenerAttached && typeof window !== 'undefined'
                    && typeof window.addEventListener === 'function') {
                    window.addEventListener('popstate', onPopstate);
                    popstateListenerAttached = true;
                }
            },

            showBack: function () {
                const el = ensureBackButton();
                if (el) el.hidden = false;
                // Push a guard entry so a browser/system Back is captured in-app
                // instead of exiting to the previous site (bd med-z1n.2). Once
                // per section visit; modal-history pushes its own entry on top.
                if (!guardPushed && hasHistory()) {
                    historyPush({ wgSectionBack: true });
                    guardPushed = true;
                }
            },

            hideBack: function () {
                if (backButtonEl) backButtonEl.hidden = true;
                // Returning to Today via a nav tap (not a Back press): consume
                // the stale guard entry so the stack stays clean. In the Back /
                // popstate path onPopstate already cleared guardPushed, so this
                // does nothing there (never pops a real page entry).
                if (guardPushed && hasHistory()) {
                    guardPushed = false;
                    historyBack();
                }
            },

            historyPush: historyPush,

            historyBack: historyBack,

            isPresent: function () { return false; },

            // BrowserAdapter always provides a working in-app back affordance,
            // so back-button.js can wire up without a version gate.
            isBackButtonSupported: function () { return true; },
        };
    })();
    // Single synchronous assignment so window.MessengerAdapter is never
    // undefined for the rest of the bundle's synchronous boot path (app.js
    // reads it and fires .init() immediately).
    window.MessengerAdapter = BrowserAdapter;
})();
