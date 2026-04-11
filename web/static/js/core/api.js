// Core API client — direct fetch wrapper and offline-aware wrapper.
// Loaded before app.js. Reads window.userInitData at call time (set by app.js
// on load). Depends on window.offlineAwareApiCall (sync.js, optional) and
// window.DataStore (data-store.js, for cursor advancement).
// safeAlert() is provided by core/utils.js, loaded before this file.

async function apiCallDirect(endpoint, method = "GET", body = null) {
    const headers = { "X-Telegram-Init-Data": window.userInitData };
    if (body) headers["Content-Type"] = "application/json";

    const res = await fetch(endpoint, { method, headers, body: body ? JSON.stringify(body) : null });
    if (res.status === 401 || res.status === 403) { throw new Error("Unauthorized"); }

    // Check if this is a service worker offline response
    if (res.status === 503) {
        const txt = await res.text();
        try {
            const json = JSON.parse(txt);
            if (json.error === 'offline') {
                // This is the service worker's offline response
                // Throw a network error instead of the JSON string
                throw new Error('Network request failed');
            }
        } catch (e) {
            // If it's not JSON or not the offline error, fall through
            if (e.message === 'Network request failed') throw e;
        }
    }

    if (!res.ok) { const txt = await res.text(); const err = new Error(txt); err.status = res.status; throw err; }
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
    if (method !== 'GET' && window.DataStore?.advanceCursorSilently) {
        window.DataStore.advanceCursorSilently(); // fire-and-forget
    }

    return result;
}

// Expose for sync.js
window.apiCallDirect = apiCallDirect;

// API Client (offline-aware wrapper)
async function apiCall(endpoint, method = "GET", body = null) {
    // Use offline-aware wrapper if available for all API endpoints
    if (window.offlineAwareApiCall) {
        try {
            return await window.offlineAwareApiCall(endpoint, method, body);
        } catch (e) {
            console.error(e);
            // Only show alerts for write operations that fail
            // GET requests failing is expected when offline - UI will handle empty state
            if (method !== 'GET') {
                safeAlert("Error: " + e.message);
            }
            return null;
        }
    }

    // Fallback to direct API call if offline wrapper not available
    try {
        return await apiCallDirect(endpoint, method, body);
    } catch (e) {
        console.error(e);
        // Only show alerts for write operations that fail
        if (method !== 'GET') {
            safeAlert("Error: " + e.message);
        }
        return null;
    }
}
