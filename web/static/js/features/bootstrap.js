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
        // rather than the now-stale cached value.  This race is now hot: bootstrap
        // schedules this function fire-and-forget AFTER switchTab() runs so the
        // first paint is not blocked by the confirm dialog, which means the active
        // tab may already be rendering with the old cached timezone when the user
        // accepts the prompt.  Invalidating here lets the next interaction (tab
        // switch, polling tick) re-fetch with the updated timezone.
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

// Mount the Wandergeek bottom nav into #app once. Idempotent — re-entry is a
// no-op. The nav registers itself with AppKernel so subsequent switchTab()
// calls update the active slot. Tapping a slot calls switchTab(id) which
// then fires AppKernel.onTabSwitch back into this module; the setActive()
// call there is a no-op on the already-active button, no loop.
// Disabled feature slots are hidden so tapping them can't silently bounce
// back to Today via the switchTab feature-flag guard.
const NAV_ID_TO_FEATURE = {
    bp: 'bp',
    weight: 'weight',
    meds: 'medication',
    workouts: 'workout',
    food: 'food',
    health: 'health',
};
function filterNavItemsByFeatures(items, features) {
    if (!features) return items.slice();
    return items.filter((item) => {
        const feature = NAV_ID_TO_FEATURE[item.id];
        return !feature || features[feature];
    });
}
function readSavedActiveTab() {
    try {
        const saved = window.localStorage.getItem('mt-active-tab');
        if (!saved) return 'today';
        const items = window.WGBottomNav
            ? filterNavItemsByFeatures(window.WGBottomNav.DEFAULT_ITEMS, window.featureSettings)
            : [];
        return items.some((i) => i.id === saved) ? saved : 'today';
    } catch (_) {
        return 'today';
    }
}
let navCtrl = null;
function mountCanonicalBottomNav() {
    if (!window.WGBottomNav || document.querySelector('.wg-bottom-nav')) return;
    const host = document.getElementById('app') || document.body;
    if (!host) return;
    const items = filterNavItemsByFeatures(window.WGBottomNav.DEFAULT_ITEMS, window.featureSettings);
    navCtrl = window.WGBottomNav.mount(host, {
        items,
        active: readSavedActiveTab(),
        onChange: (id) => {
            if (typeof switchTab === 'function') switchTab(id);
        },
    });
    if (window.AppKernel && typeof window.AppKernel.register === 'function') {
        window.AppKernel.register('wgBottomNav', {
            onTabSwitch(tab) { navCtrl && navCtrl.setActive(tab); },
        });
    }
}

// Re-mount the bottom nav with the current feature flags. Called from
// settings.js after a feature toggle so disabled slots disappear without a
// reload — satisfies CLAUDE.md rule 6 ("filtered out of the nav before mount,
// not bounced after tap").
function rebuildCanonicalBottomNav() {
    if (!window.WGBottomNav) return;
    const previousActive = navCtrl ? navCtrl.getActive() : 'today';
    if (navCtrl) {
        navCtrl.destroy();
        navCtrl = null;
    }
    const host = document.getElementById('app') || document.body;
    if (!host) return;
    const items = filterNavItemsByFeatures(window.WGBottomNav.DEFAULT_ITEMS, window.featureSettings);
    const stillPresent = items.some((i) => i.id === previousActive);
    navCtrl = window.WGBottomNav.mount(host, {
        items,
        active: stillPresent ? previousActive : 'today',
        onChange: (id) => {
            if (typeof switchTab === 'function') switchTab(id);
        },
    });
}
window.rebuildCanonicalBottomNav = rebuildCanonicalBottomNav;

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

        // Mount the canonical bottom nav once (before the first switchTab so
        // it can receive the AppKernel.onTabSwitch('today') notification).
        mountCanonicalBottomNav();

        // Mount the persistent call indicator at app-shell level so it
        // survives tab switches and stays visible during a voice call.
        if (window.WGCallIndicator && typeof window.WGCallIndicator.mount === 'function') {
            window.WGCallIndicator.mount(document.body);
        }

        // Restore the last section the user was on (Today by default; deep links below override)
        switchTab(readSavedActiveTab());

        // Detect timezone after the visible shell has mounted. Fire-and-forget
        // so the confirm dialog never blocks first paint — in a plain browser
        // (non-Telegram) the fallback was the synchronous native confirm(),
        // which halted the main thread before any UI rendered and left users
        // staring at a white page until they pressed Esc.
        queueMicrotask(() => { maybeUpdateTimezone(); });

        // Surface a pending TZ transition plan if one is in flight. The banner
        // stays hidden when no plan exists, so this is silent for users who
        // never travel.
        if (window.TZPlanBanner && typeof window.TZPlanBanner.refresh === 'function') {
            window.TZPlanBanner.refresh();
        }

        // Wire the Telegram BackButton to return-to-Today once the initial tab is active.
        if (window.AppBackButton && typeof window.AppBackButton.setup === 'function') {
            window.AppBackButton.setup();
        }

        // Handle deep links and push actions from URL
        handleDeepLinks();
    }
});
