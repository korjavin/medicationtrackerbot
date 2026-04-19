// Auth state cache helpers.
// Stateless localStorage-based auth-cache utilities extracted from app.js.
// checkAuth() and applyBootstrapPayload() remain in app.js because they
// directly mutate shared let-scoped state (medications, featureSettings, …).
//
// Loaded after app.js.  Plain function declarations propagate to window in
// non-strict eval so checkAuth() can call these by name at runtime.
//
// SECURITY NOTE: The localStorage auth cache is used *strictly* for UX purposes
// (e.g., avoiding UI flashes during offline loads or initial boot) and does not
// provide any actual security. True authentication is secured by the HttpOnly
// "auth_session" cookie which is inaccessible to JavaScript. While an XSS attack
// could read or modify this cache, it contains no sensitive credentials or tokens.

const AUTH_CACHE_KEY = 'medtracker_auth_state';
const AUTH_CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days in ms

// Keys in localStorage that hold *user-specific* UX state and must be dropped
// alongside the auth cache on logout, so a prior user's preferences can't
// leak into the next session on a shared browser. Keep this list in sync with
// any new user-scoped localStorage writes elsewhere in the app.
const USER_SCOPED_LOCAL_KEYS = ['medtracker_tab_order'];

function saveAuthState(authMethod = 'cookie') {
    const authState = {
        authenticated: true,
        authMethod: authMethod,
        timestamp: Date.now(),
        ttl: AUTH_CACHE_TTL
    };
    localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify(authState));
    console.log('[Auth] Saved auth state to cache');
}

function getCachedAuthState() {
    try {
        const cached = localStorage.getItem(AUTH_CACHE_KEY);
        if (!cached) return null;

        const authState = JSON.parse(cached);

        // Check if cache is still valid (within TTL)
        if (Date.now() - authState.timestamp < authState.ttl) {
            return authState;
        }

        // Expired, clear it
        localStorage.removeItem(AUTH_CACHE_KEY);
        console.log('[Auth] Auth state cache expired');
        return null;
    } catch (e) {
        console.error('[Auth] Failed to read auth state cache:', e);
        return null;
    }
}

function clearAuthState() {
    if (localStorage.getItem(AUTH_CACHE_KEY) !== null) {
        localStorage.removeItem(AUTH_CACHE_KEY);
        console.log('[Auth] Cleared auth state cache');
    }
    for (const key of USER_SCOPED_LOCAL_KEYS) {
        try { localStorage.removeItem(key); } catch (_) { /* best-effort */ }
    }
}
