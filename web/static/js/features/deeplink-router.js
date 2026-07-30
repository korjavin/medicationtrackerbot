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

    if (!action && tab) {
        // Bare ?tab=<section> (no action): plain section deep-link, e.g. the
        // Telegram reminder "Open" URL button (?tab=workouts|bp|weight). Only
        // switch to a whitelisted, stable bottom-nav id; ignore unknown tabs so
        // activateTabGroup can't blank the page.
        const allowedTabs = ['workouts', 'bp', 'weight'];
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

// Check for a messenger start-param deep link (Telegram start_param, or the
// URL ?start= / #start= fallback in BrowserAdapter).
// This runs before bootstrap.js populates featureSettings, so we must
// wait for featureSettingsLoaded too — otherwise isDeepLinkFeatureEnabled
// returns default-on and can open BP even when the user disabled it.
// Falls back to default-on behavior after ~5s if bootstrap never completes,
// matching the URL-path deep-link guard.
//
// MessengerAdapterReady awaits the dynamic Telegram SDK load (see
// core/messenger-adapter.js). Without that wait the adapter is still
// BrowserAdapter at this point on a fresh Telegram Mini App open and
// startParam() returns null (Telegram passes `tgWebAppStartParam` in the
// URL hash, not `start`), permanently missing the bp_add handshake.
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

if (window.MessengerAdapterReady && typeof window.MessengerAdapterReady.then === 'function') {
    window.MessengerAdapterReady.then(maybeRunStartParamDeepLink);
} else {
    maybeRunStartParamDeepLink();
}
