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
    const tabToFeature = { bp: 'bp', weight: 'weight', health: 'health', workouts: 'workout' };
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

    // Shared-plan deeplink (bd med-uo64.3): tapping someone's
    // #share-plan=<token> link lands on our own app. Strip the fragment
    // FIRST — a reload must never re-import — then hand the token to the
    // same receive() paste/scan use, after the /bp_add settle.
    // #share-gym=<token> (med-8j5w.3) takes the same path — receive() routes
    // by the token's prefix.
    const shareHash = new URLSearchParams(window.location.hash.slice(1));
    const sharePlanToken = shareHash.get('share-plan') || shareHash.get('share-gym');
    if (sharePlanToken) {
        if (!isDeepLinkFeatureEnabled('workouts')) {
            window.history.replaceState({}, '', '/');
            switchTab('today');
            return;
        }
        window.history.replaceState({}, '', '/');
        switchTab('workouts');
        setTimeout(() => {
            if (window.WorkoutShare && typeof window.WorkoutShare.receive === 'function') {
                window.WorkoutShare.receive(sharePlanToken);
            }
        }, 100);
        return;
    }

    // Query-param-based deep links and push actions
    const urlParams = new URLSearchParams(window.location.search);
    const action = urlParams.get('action');
    const tab = urlParams.get('tab');

    if (!action && tab === 'settings') {
        // ?tab=settings&page=devices|connectors — where the passkey shell's old
        // /devices and /connectors pages redirect (med-xso6.25). Only a fixed
        // page list; anything else just lands on Settings.
        const page = urlParams.get('page');
        switchTab('settings');
        if (page === 'devices' || page === 'connectors') {
            setTimeout(() => {
                if (window.SettingsView && typeof window.SettingsView.openDevicesDeeplink === 'function') {
                    window.SettingsView.openDevicesDeeplink(page);
                }
            }, 100);
        }
        window.history.replaceState({}, '', '/');
    } else if (!action && tab) {
        // Bare ?tab=<section> (no action): plain section deep-link, e.g. the
        // Telegram reminder "Open" URL button (?tab=workouts|bp|weight). Only
        // switch to a whitelisted, stable section id (bp/weight/health land on
        // the Health tab with that segment active); ignore unknown tabs so
        // activateTabGroup can't blank the page.
        const allowedTabs = ['workouts', 'bp', 'weight', 'health'];
        if (allowedTabs.includes(tab)) {
            if (!isDeepLinkFeatureEnabled(tab)) {
                switchTab('today');
            } else {
                switchTab(tab);
            }
        }
        window.history.replaceState({}, '', '/');
    } else if (action === 'add') {
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
    } else if (action === 'trial_consent') {
        // The cloud bot's "🔓 Allow trial AI" button (med-eas.61). Consent is a
        // vault write only an unlocked client can make, so the link cannot grant
        // anything — it lands on Settings and opens the SAME disclosure dialog
        // the Integrations row uses. Allowing there is still the user's tap.
        const scope = urlParams.get('scope');
        if (['ai', 'tg', 'voice'].includes(scope)) {
            switchTab('settings');
            setTimeout(async () => {
                if (!window.TrialConsent || typeof window.TrialConsent.request !== 'function') return;
                const granted = await window.TrialConsent.request(scope);
                // Repaint the Integrations consent rows behind the dialog, which
                // still read "Not asked" from the pre-grant load.
                if (granted === true) window.SettingsIntegrations?.load?.();
            }, 100);
        }
        window.history.replaceState({}, '', '/');
    } else if (action) {
        handlePushAction(action, urlParams);
        // Clean URL
        window.history.replaceState({}, '', '/');
    }
}
window.handleDeepLinks = handleDeepLinks;

// Check for a start-param deep link (URL ?start= / #start= / bare #hash).
// This runs before bootstrap.js populates featureSettings, so we must
// wait for featureSettingsLoaded too — otherwise isDeepLinkFeatureEnabled
// returns default-on and can open BP even when the user disabled it.
// Falls back to default-on behavior after ~5s if bootstrap never completes,
// matching the URL-path deep-link guard.
function maybeRunStartParamDeepLink() {
    if (!window.MessengerAdapter || window.MessengerAdapter.startParam() !== 'bp_add') return;
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

maybeRunStartParamDeepLink();
