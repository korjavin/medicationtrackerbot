// Service Worker API helper — POST wrapper used by notification action
// handlers in sw.js. Mirrors the main-thread apiCallDirect contract:
//   - sends X-Telegram-Init-Data when an auth token has been handed off
//     via the SET_AUTH_TOKEN message
//   - always sends credentials: 'include' so cookie-based deployments work
//   - returns the parsed JSON body on 2xx (true if empty)
//   - throws an Error with .status set for non-2xx
//
// Loaded into the SW via importScripts at the top of sw.js. Also imported
// directly in unit tests as plain JS.
//
// See docs/plans/2026-05-13-sw-handler-unification.md.

(function (root) {
    const SwApi = {
        authToken: null,
        async call(endpoint, method = 'GET', body = null) {
            const headers = {};
            if (body) headers['Content-Type'] = 'application/json';
            if (this.authToken) headers['X-Telegram-Init-Data'] = this.authToken;

            const res = await fetch(endpoint, {
                method,
                headers,
                credentials: 'include',
                body: body ? JSON.stringify(body) : null,
            });

            if (!res.ok) {
                const txt = await res.text().catch(() => '');
                const err = new Error(txt || res.statusText || 'Request failed');
                err.status = res.status;
                throw err;
            }

            if (res.status === 204) return true;
            const txt = await res.text();
            if (!txt) return true;
            try {
                return JSON.parse(txt);
            } catch (e) {
                return true;
            }
        },
        // Placeholder for the failed-action queue. Task 4 of the SW
        // handler unification plan replaces this with a direct
        // IndexedDB write into the `pending_sw_actions` Dexie store
        // (drained by the main thread in sync.js). Until then this is
        // a no-op resolve so handler call sites are unconditional and
        // safe to ship in the same PR as the handler rewrite.
        async enqueueFailedAction(_action) {
            return false;
        },
    };

    root.SwApi = SwApi;
    root.swApiCall = (endpoint, method, body) => SwApi.call(endpoint, method, body);
})(typeof self !== 'undefined' ? self : globalThis);
