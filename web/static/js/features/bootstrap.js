// Post-auth initialization orchestration.
// Runs checkAuth() and, on success, wires up all services and routes the
// initial URL.  Separated from app.js so the bootstrap is explicit and testable.
//
// Loaded last (after auth-flow.js, deeplink-router.js, workout.js, push.js).
// The test harness does NOT load this file – tests invoke functions directly.

// Detect and optionally sync the user's browser timezone to the server.
// Called after successful auth so that the bootstrap payload (with stored TZ) is available.
async function maybeUpdateTimezone() {
    try {
        const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (!detectedTz) return;

        // Read stored timezone from the cached settings bundle (populated by applyBootstrapPayload)
        let storedTz = '';
        if (window.DataStore) {
            const cached = await window.DataStore.getCached('settings_bundle');
            if (cached && cached.timezone) {
                storedTz = cached.timezone;
            }
        }

        if (detectedTz === storedTz) return;

        // If the user already dismissed the prompt for this specific detected timezone, don't ask again.
        try {
            if (localStorage.getItem('tz_prompt_dismissed') === detectedTz) return;
        } catch (_) { /* localStorage unavailable in some sandboxed environments */ }

        const message = storedTz
            ? `You appear to be in ${detectedTz} (currently set to ${storedTz}). Change your timezone and adjust notifications?`
            : `You appear to be in ${detectedTz}. Change your timezone and adjust notifications?`;

        const confirmed = await safeConfirm(message);
        if (!confirmed) {
            // Suppress re-prompt until the browser timezone changes to something different.
            // Use localStorage because applyBootstrapPayload always overwrites the IndexedDB
            // settings_bundle with the server value before maybeUpdateTimezone reads it, making
            // an IndexedDB write here ineffective as a suppression mechanism.
            try { localStorage.setItem('tz_prompt_dismissed', detectedTz); } catch (_) { /* ignore */ }
            return;
        }

        await apiCall('/api/settings', 'POST', { timezone: detectedTz });
        // Clear the cached settings_bundle so that any tab loaded during this same
        // startup (e.g. workout history) reads the updated timezone from the server
        // rather than the now-stale cached value.  advanceCursorSilently() runs
        // fire-and-forget inside apiCall and may not finish before switchTab() is
        // called below, so we eagerly invalidate here to close the race window.
        if (window.DataStore?.invalidateKey) {
            await window.DataStore.invalidateKey('settings_bundle');
        }
        // Clear any previous dismissal so future timezone changes are prompted correctly.
        try { localStorage.removeItem('tz_prompt_dismissed'); } catch (_) { /* ignore */ }
    } catch (e) {
        // Timezone detection is best-effort; never block the app
        console.warn('Timezone detection failed:', e);
    }
}

checkAuth().then(async authorized => {
    if (authorized) {
        window.DataStore.startChangePolling();
        window.addEventListener('beforeunload', () => window.DataStore.stopChangePolling(), { once: true });

        // Initialize SyncManager for offline support
        if (window.SyncManager) {
            window.SyncManager.init();
        }

        // Initialize PushManager
        if (window.MedTrackerPush) {
            window.MedTrackerPush.initialize().then(supported => {
                if (supported && window.MedTrackerPush.subscription) {
                    // Update UI if already subscribed
                    const toggle = document.getElementById('webpush-toggle');
                    if (toggle) toggle.checked = true;
                }
            });
        }

        initOIDCSetupBanner();

        // Detect timezone after auth so bootstrap payload is cached
        await maybeUpdateTimezone();

        // Today is unconditionally the initial view; sections are reached via
        // Today cards or deep links.
        switchTab('today');

        // Wire the Telegram BackButton to return-to-Today once the initial tab is active.
        if (window.AppBackButton && typeof window.AppBackButton.setup === 'function') {
            window.AppBackButton.setup();
        }

        // Handle deep links and push actions from URL
        handleDeepLinks();
    }
});
