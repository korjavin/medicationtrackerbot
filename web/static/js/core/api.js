// Core API client — direct fetch wrapper and offline-aware wrapper.
// Loaded before app.js. No auth headers are attached — requests authenticate
// via the session cookie. Depends on window.offlineAwareApiCall (sync.js,
// optional). safeAlert() is provided by core/utils.js, loaded before this file.


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
    const headers = { ...(body ? { "Content-Type": "application/json" } : null) };
    Object.assign(headers, extraHeaders || {});

    const signal = composeAbortSignal(timeoutMs, callerSignal);

    // The try/catch spans the body-read too — a timeout firing after headers
    // arrive aborts res.text(), and that abort must still surface as
    // err.aborted so apiCall() can rethrow instead of swallowing it.
    try {
        const res = await fetch(endpoint, {
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
            // precondition_failed joins the carve-out (bd med-qop3): the plan
            // delete flow branches on the guard (open-session count) to offer
            // cancel-and-delete, and a swallowed null gives it nothing to
            // branch on. Only deleteGroup throws that code, and its sole
            // apiCall caller catches it — every other write keeps the
            // alert-and-null path. Still surface the alert for writes first:
            // uncaught cloud write handlers (e.g. saveExercise) rely on
            // apiCall for feedback, so a silent rethrow would leave a
            // malformed save with no explanation.
            if (e && (e.code === 'invalid_request' || e.code === 'precondition_failed')) {
                if (method !== 'GET' && !opts.suppressWriteAlert) {
                    safeAlert("Error: " + e.message);
                }
                throw e;
            }
            console.error(e);
            // Only show alerts for write operations that fail
            // GET requests failing is expected when offline - UI will handle empty state
            // suppressWriteAlert lets background writers (e.g. workout autosave)
            // surface failures inline instead of popping a blocking alert on
            // every debounced batch while offline.
            if (method !== 'GET' && !opts.suppressWriteAlert) {
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
        if (e && (e.code === 'invalid_request' || e.code === 'precondition_failed')) {
            if (method !== 'GET' && !opts.suppressWriteAlert) {
                safeAlert("Error: " + e.message);
            }
            throw e;
        }
        console.error(e);
        // Only show alerts for write operations that fail
        if (method !== 'GET' && !opts.suppressWriteAlert) {
            safeAlert("Error: " + e.message);
        }
        return null;
    }
}
