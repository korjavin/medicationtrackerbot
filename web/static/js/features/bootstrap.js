// Post-auth initialization orchestration.
// Runs checkAuth() and, on success, wires up all services and routes the
// initial URL.  Separated from app.js so the bootstrap is explicit and testable.
//
// Loaded last (after auth-flow.js, deeplink-router.js, workout.js, push.js).
// The test harness does NOT load this file – tests invoke functions directly.

checkAuth().then(authorized => {
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

        // Default start tab
        switchTab('bp');

        // Handle deep links and push actions from URL
        handleDeepLinks();
    }
});
