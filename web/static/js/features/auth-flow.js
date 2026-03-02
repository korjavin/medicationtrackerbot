// Auth state cache helpers.
// Stateless localStorage-based auth-cache utilities extracted from app.js.
// checkAuth() and applyBootstrapPayload() remain in app.js because they
// directly mutate shared let-scoped state (medications, featureSettings, …).
//
// Loaded after app.js.  Plain function declarations propagate to window in
// non-strict eval so checkAuth() can call these by name at runtime.

const AUTH_CACHE_KEY = 'medtracker_auth_state';
const AUTH_CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days in ms

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
    localStorage.removeItem(AUTH_CACHE_KEY);
    console.log('[Auth] Cleared auth state cache');
}
