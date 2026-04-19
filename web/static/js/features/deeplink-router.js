// Deep-link and push-notification URL router.
// Handles path-based deep links (/bp_add, /weight_add),
// query-param deep links (?tab=…&action=add),
// push-action query params (?action=medication_confirm, etc.),
// and the Telegram start_param handshake.
//
// Loaded after app.js so all modal/tab helpers are available.
// handleDeepLinks is exposed on window for direct test invocation.

// Mirrors switchTab's feature-flag guard so modal openers aren't reached
// when the user has disabled the section. Default-on when flags haven't
// loaded yet (matches switchTab behaviour).
function isDeepLinkFeatureEnabled(tab) {
    const tabToFeature = { bp: 'bp', weight: 'weight' };
    const feature = tabToFeature[tab];
    if (!feature) return true;
    if (!window.featureSettingsLoaded) return true;
    return window.featureSettings ? window.featureSettings[feature] !== false : true;
}

function handleDeepLinks() {
    // Path-based deep links: /bp_add, /weight_add
    const deepLinkRoutes = {
        '/bp_add': { tab: 'bp', open: showBPRecordModal },
        '/weight_add': { tab: 'weight', open: showWeightModal }
    };
    const currentPath = window.location.pathname;
    const deepLink = deepLinkRoutes[currentPath];
    if (deepLink) {
        if (deepLink.tab && !isDeepLinkFeatureEnabled(deepLink.tab)) {
            switchTab('today');
            window.history.replaceState({}, '', '/');
            return;
        }
        if (deepLink.tab) {
            switchTab(deepLink.tab);
        }
        // Wait for data to load, then open modal
        setTimeout(() => {
            deepLink.open();
            // Clean up URL without reload
            window.history.replaceState({}, '', '/');
        }, 100);
        return;
    }

    // Query-param-based deep links and push actions
    const urlParams = new URLSearchParams(window.location.search);
    const action = urlParams.get('action');
    const tab = urlParams.get('tab');

    if (action === 'add') {
        // Handle ?tab=bp&action=add and ?tab=weight&action=add
        const tabAddModals = {
            'bp': showBPRecordModal,
            'weight': showWeightModal
        };
        const openFn = tab ? tabAddModals[tab] : null;
        if (openFn) {
            if (!isDeepLinkFeatureEnabled(tab)) {
                switchTab('today');
                window.history.replaceState({}, '', '/');
                return;
            }
            // Only switch to a known/supported tab; unknown tab values are ignored
            // to prevent clearing all active views without activating any.
            switchTab(tab);
            setTimeout(() => {
                openFn();
                window.history.replaceState({}, '', '/');
            }, 100);
        } else {
            window.history.replaceState({}, '', '/');
        }
    } else if (action) {
        handlePushAction(action, urlParams);
        // Clean URL
        window.history.replaceState({}, '', '/');
    }
}
window.handleDeepLinks = handleDeepLinks;

// Check for Telegram start_param deep link (e.g. from bot button).
// This runs before bootstrap.js populates featureSettings, so we must
// wait for featureSettingsLoaded too — otherwise isDeepLinkFeatureEnabled
// returns default-on and can open BP even when the user disabled it.
// Falls back to default-on behavior after ~5s if bootstrap never completes,
// matching the URL-path deep-link guard.
if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initDataUnsafe && window.Telegram.WebApp.initDataUnsafe.start_param === 'bp_add') {
    const startedAt = Date.now();
    const checkInterval = setInterval(() => {
        const modalReady = typeof showBPRecordModal === 'function';
        const flagsReady = window.featureSettingsLoaded === true;
        const timedOut = Date.now() - startedAt >= 5000;
        if (modalReady && (flagsReady || timedOut)) {
            clearInterval(checkInterval);
            if (!isDeepLinkFeatureEnabled('bp')) {
                switchTab('today');
                return;
            }
            switchTab('bp');
            setTimeout(showBPRecordModal, 500);
        }
    }, 100);
}
