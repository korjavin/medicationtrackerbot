(function () {
    window.apiCallDirect = async function (endpoint, method = "GET", body = null) {
        let headers = {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest'
        };
        if (window.userInitData) {
            headers['X-Telegram-Init-Data'] = window.userInitData;
        }

        const options = {
            method,
            headers
        };

        if (body) {
            options.body = JSON.stringify(body);
        }

        const res = await fetch(endpoint, options);
        if (res.status === 401 || res.status === 403) {
            if (typeof window.onDataStoreUnauthorized === 'function') {
                window.onDataStoreUnauthorized();
            }
            throw new Error('Unauthorized');
        }
        if (!res.ok) {
            const err = await res.text();
            throw new Error(err || 'API call failed');
        }
        return await res.json();
    };

    window.apiCall = async function (endpoint, method = "GET", body = null) {
        // Use offline-aware wrapper if available for all API endpoints
        if (window.offlineAwareApiCall) {
            try {
                return await window.offlineAwareApiCall(endpoint, method, body);
            } catch (e) {
                console.error(e);
                // Only show alerts for write operations that fail
                // GET requests failing is expected when offline - UI will handle empty state
                if (method !== 'GET') {
                    if (typeof window.safeAlert === 'function') window.safeAlert("Error: " + e.message);
                    else alert("Error: " + e.message);
                }
                return null;
            }
        }

        // Fallback to direct API call if offline wrapper not available
        try {
            return await window.apiCallDirect(endpoint, method, body);
        } catch (e) {
            console.error(e);
            // Only show alerts for write operations that fail
            if (method !== 'GET') {
                if (typeof window.safeAlert === 'function') window.safeAlert("Error: " + e.message);
                else alert("Error: " + e.message);
            }
            return null;
        }
    };
})();
