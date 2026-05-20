// Core API client — direct fetch wrapper and offline-aware wrapper.
// Loaded before app.js. Reads window.userInitData at call time (set by app.js
// on load). Depends on window.offlineAwareApiCall (sync.js, optional) and
// window.DataStore (data-store.js, for cursor advancement).
// safeAlert() is provided by core/utils.js, loaded before this file.

// Builds the canonical headers object for a messenger-authenticated request.
// The header name is sourced from window.MessengerAdapter.authHeaderName()
// (TelegramAdapter → 'X-Telegram-Init-Data'; BrowserAdapter → null, header
// omitted entirely for the cookie-only path). The token value still comes
// from window.userInitData so SW-token updates and adapter-driven boot
// (Task 3) share one mutable global. When no adapter has loaded — e.g. in
// isolated unit tests — falls back to the legacy 'X-Telegram-Init-Data'
// header so older test harnesses continue to work without modification.
// Returns a fresh object every call; never mutates `extra`. Direct-fetch
// callers (streaming, multipart, CSV exports) that cannot route through
// apiCallDirect must use this helper.
function makeAuthHeaders(extra) {
    const headers = { ...(extra || {}) };
    const adapter = window.MessengerAdapter;
    const headerName = (adapter && typeof adapter.authHeaderName === 'function')
        ? adapter.authHeaderName()
        : 'X-Telegram-Init-Data';
    if (headerName && window.userInitData) {
        headers[headerName] = window.userInitData;
    }
    return headers;
}
window.makeAuthHeaders = makeAuthHeaders;

// Composes an AbortSignal from an optional timeout and an optional caller
// signal. Returns undefined when neither is supplied so fetch() runs unguarded.
function composeAbortSignal(timeoutMs, callerSignal) {
    const timeoutSignal = Number.isFinite(timeoutMs)
        ? AbortSignal.timeout(timeoutMs)
        : null;
    if (timeoutSignal && callerSignal) {
        return AbortSignal.any([timeoutSignal, callerSignal]);
    }
    return timeoutSignal || callerSignal || undefined;
}

async function apiCallDirect(endpoint, method = "GET", body = null, opts = {}) {
    const { timeoutMs = 60_000, signal: callerSignal } = opts;
    const headers = makeAuthHeaders(body ? { "Content-Type": "application/json" } : null);

    const signal = composeAbortSignal(timeoutMs, callerSignal);

    // The try/catch spans the body-read too — a timeout firing after headers
    // arrive aborts res.text(), and that abort must still surface as
    // err.aborted so apiCall() can rethrow instead of swallowing it.
    try {
        const res = await fetch(endpoint, {
            method,
            headers,
            body: body ? JSON.stringify(body) : null,
            signal
        });
        if (res.status === 401 || res.status === 403) {
            const err = new Error("Unauthorized");
            err.status = res.status;
            throw err;
        }

        if (res.status === 429) {
            const txt = await res.text();
            let parsed = null;
            try { parsed = JSON.parse(txt); } catch (_) { /* not JSON */ }
            if (parsed && parsed.error === 'demo_rate_limit') {
                if (window.DemoBanner && typeof window.DemoBanner.showDemoLimitAlert === 'function') {
                    window.DemoBanner.showDemoLimitAlert(parsed);
                }
                const err = new Error('Demo rate limit reached');
                err.status = 429;
                err.demoLimit = parsed;
                throw err;
            }
            const err = new Error(txt || 'Too Many Requests');
            err.status = 429;
            throw err;
        }

        if (!res.ok) {
            const txt = await res.text();
            // Check if this is a service worker offline response (503 with {error:'offline'})
            if (res.status === 503) {
                try {
                    const json = JSON.parse(txt);
                    if (json.error === 'offline') {
                        throw new Error('Network request failed');
                    }
                } catch (e) {
                    if (e.message === 'Network request failed') throw e;
                }
            }
            const err = new Error(txt || 'Service Unavailable');
            err.status = res.status;
            throw err;
        }
        let result;
        if (res.status === 204 || method === "DELETE") {
            result = true;
        } else {
            const txt = await res.text();
            if (!txt) {
                result = true;
            } else {
                try {
                    result = JSON.parse(txt);
                } catch (e) {
                    console.log("Response is not JSON:", txt);
                    result = true;
                }
            }
        }

        // After a successful write, advance the change cursor so that the
        // next poll does not show a refresh banner for our own mutations.
        // Also stamp lastOwnWriteAt so the SSE echo of this same write
        // (which usually races ahead of advanceCursorSilently's response)
        // is recognised as a self-echo and doesn't surface a banner.
        if (method !== 'GET' && window.DataStore) {
            if (typeof window.DataStore.recordOwnWrite === 'function') {
                window.DataStore.recordOwnWrite();
            }
            if (typeof window.DataStore.advanceCursorSilently === 'function') {
                window.DataStore.advanceCursorSilently(); // fire-and-forget
            }
        }

        return result;
    } catch (err) {
        if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
            err.aborted = true;
        }
        throw err;
    }
}

// Expose for sync.js
window.apiCallDirect = apiCallDirect;

// API Client (offline-aware wrapper)
async function apiCall(endpoint, method = "GET", body = null, opts = {}) {
    // Use offline-aware wrapper if available for all API endpoints
    if (window.offlineAwareApiCall) {
        try {
            return await window.offlineAwareApiCall(endpoint, method, body, opts);
        } catch (e) {
            // Aborts/timeouts are caller-driven — let them bubble so the
            // caller can render a typed status instead of seeing null.
            if (e && e.aborted) throw e;
            console.error(e);
            // Only show alerts for write operations that fail
            // GET requests failing is expected when offline - UI will handle empty state
            // Suppress generic alert when DemoBanner has already surfaced a
            // formatted demo-restriction popup (apiCallDirect sets e.demoLimit).
            if (method !== 'GET' && !(e && e.demoLimit)) {
                safeAlert("Error: " + e.message);
            }
            return null;
        }
    }

    // Fallback to direct API call if offline wrapper not available
    try {
        return await apiCallDirect(endpoint, method, body, opts);
    } catch (e) {
        if (e && e.aborted) throw e;
        console.error(e);
        // Only show alerts for write operations that fail
        if (method !== 'GET' && !(e && e.demoLimit)) {
            safeAlert("Error: " + e.message);
        }
        return null;
    }
}
