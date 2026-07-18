// Core API client — direct fetch wrapper and offline-aware wrapper.
// Loaded before app.js. Reads window.userInitData at call time (set by app.js
// on load). Depends on window.offlineAwareApiCall (sync.js, optional) and
// window.DataStore (data-store.js, for cursor advancement).
// safeAlert() is provided by core/utils.js, loaded before this file.

// resolveApiUrl prepends the bootstrap-injected `apiBase` when present so
// the Capacitor shell can serve the WebView from one origin
// (capacitor://localhost in future iterations) and reach the embedded Go
// backend at another (http://127.0.0.1:<port>). In the canonical Phase 2a
// design the WebView is loaded directly from the backend origin and apiBase
// equals self.location.origin — in that case the prefix is functionally a
// no-op but harmless. In the browser PWA + server-mode build no bootstrap
// is injected and endpoint paths fall through unchanged.
function resolveApiUrl(endpoint) {
    if (typeof endpoint !== 'string' || !endpoint.startsWith('/')) {
        return endpoint;
    }
    const bs = (typeof window !== 'undefined') ? window.__MEDTRACKER_BOOTSTRAP__ : null;
    const apiBase = (bs && typeof bs.apiBase === 'string') ? bs.apiBase : '';
    if (!apiBase) return endpoint;
    // Trim a single trailing slash so we don't produce '//api/...'.
    const trimmed = apiBase.endsWith('/') ? apiBase.slice(0, -1) : apiBase;
    return trimmed + endpoint;
}
window.resolveApiUrl = resolveApiUrl;

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

// makeWriteHeaders builds the headers for a non-GET request that must travel
// outside apiCallDirect (multipart/form-data uploads and other direct fetch
// sites). It returns makeAuthHeaders(extra) augmented with X-Client-ID when
// DataStore.getClientId() is available, so the backend's
// notifyOnWriteMiddleware can attribute the resulting change_events to this
// browser and the SSE subscribers can recognise their own echo via
// source_client_id instead of relying on the 5s timing-window fallback.
//
// GET callers should keep using makeAuthHeaders directly — emitting
// X-Client-ID on reads is wasteful and would let the value appear in
// access-log query strings on routes that have no need for it.
function makeWriteHeaders(extra) {
    const headers = makeAuthHeaders(extra);
    try {
        if (window.DataStore && typeof window.DataStore.getClientId === 'function') {
            const cid = window.DataStore.getClientId();
            if (typeof cid === 'string' && cid.length > 0) {
                headers['X-Client-ID'] = cid;
            }
        }
    } catch (_e) { /* defensive: getClientId must never block a write */ }
    return headers;
}
window.makeWriteHeaders = makeWriteHeaders;

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
    const { timeoutMs = 60_000, signal: callerSignal, headers: extraHeaders } = opts;
    // A Uint8Array/Blob/ArrayBuffer body is sent verbatim — the vault import
    // POSTs a gzipped JSON body (Content-Encoding via opts.headers) because the
    // plaintext runs to hundreds of MB. Everything else is JSON-encoded.
    const isRawBody = body instanceof Uint8Array || body instanceof Blob || body instanceof ArrayBuffer;
    const headers = makeAuthHeaders(body ? { "Content-Type": "application/json" } : null);
    Object.assign(headers, extraHeaders || {});

    // Tag non-GET writes with the per-browser stable client id so the
    // backend can echo it back on the SSE payload (source_client_id),
    // letting us classify our own writes as self-echoes deterministically
    // instead of relying on the 5s lastOwnWriteAt timing window.
    if (method !== 'GET' && window.DataStore && typeof window.DataStore.getClientId === 'function') {
        try {
            const clientId = window.DataStore.getClientId();
            if (typeof clientId === 'string' && clientId.length > 0) {
                headers['X-Client-ID'] = clientId;
            }
        } catch (_e) { /* defensive: getClientId must never block a write */ }
    }

    const signal = composeAbortSignal(timeoutMs, callerSignal);

    // The try/catch spans the body-read too — a timeout firing after headers
    // arrive aborts res.text(), and that abort must still surface as
    // err.aborted so apiCall() can rethrow instead of swallowing it.
    try {
        const res = await fetch(resolveApiUrl(endpoint), {
            method,
            headers,
            body: body ? (isRawBody ? body : JSON.stringify(body)) : null,
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
            // Client-side validation rejections (the cloud domain layer's
            // invalidRequest, code 'invalid_request') mean the request was
            // malformed and never should have been sent — they are not a
            // delivery/offline failure, so propagate them to the caller rather
            // than swallowing to null. Server-origin 4xx from apiCallDirect
            // carry only .status (no such code), so bot mode is unaffected.
            // Still surface the alert for writes first: uncaught cloud write
            // handlers (e.g. saveExercise) rely on apiCall for feedback, so a
            // silent rethrow would leave a malformed save with no explanation.
            if (e && e.code === 'invalid_request') {
                if (method !== 'GET' && !(e && e.demoLimit)) {
                    safeAlert("Error: " + e.message);
                }
                throw e;
            }
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
        if (e && e.code === 'invalid_request') {
            if (method !== 'GET' && !(e && e.demoLimit)) {
                safeAlert("Error: " + e.message);
            }
            throw e;
        }
        console.error(e);
        // Only show alerts for write operations that fail
        if (method !== 'GET' && !(e && e.demoLimit)) {
            safeAlert("Error: " + e.message);
        }
        return null;
    }
}
