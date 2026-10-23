// Post-auth initialization orchestration.
// Runs checkAuth() and, on success, wires up all services and routes the
// initial URL.  Separated from app.js so the bootstrap is explicit and testable.
//
// Loaded last (after auth-flow.js, deeplink-router.js, workout.js, push.js).
// The test harness does NOT load this file – tests invoke functions directly.

// Register every static cache key + dynamic key-family with DataStore before
// any feature module's first loadSWR / cachedFetch call. The CacheKeys
// registry is the single source of truth for which tag each key belongs to;
// registering up-front means tag-based invalidation works on cold start even
// for keys the user has not yet visited (e.g. the push-modal flow firing
// invalidateTags(['workout']) before the workouts tab is ever opened).
if (window.CacheKeys && window.DataStore && typeof window.CacheKeys.registerAll === 'function') {
    window.CacheKeys.registerAll(window.DataStore);
}

// Detect the device timezone and offer to switch to it. Whether to ask is the
// domain's call (web/domain/tzplan.js shouldPromptSuggestion: stored tz,
// synced dismissal, active transition plan) — no local heuristic here.
async function maybeUpdateTimezone() {
    try {
        const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (!detectedTz) return;

        const decision = await apiCall(`/api/tz-suggestion/should-prompt?detected_tz=${encodeURIComponent(detectedTz)}`);
        if (!decision || !decision.prompt) return;
        const storedTz = decision.current_tz || '';

        const message = storedTz
            ? `You appear to be in ${detectedTz} (currently set to ${storedTz}). Change your timezone and adjust notifications?`
            : `You appear to be in ${detectedTz}. Change your timezone and adjust notifications?`;

        const confirmed = await safeConfirm(message);
        if (!confirmed) {
            // The dismissal is a synced settings field, so other devices skip it too.
            await apiCall('/api/tz-suggestion/dismiss', 'POST', { detected_tz: detectedTz });
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
    } catch (e) {
        // Timezone detection is best-effort; never block the app
        console.warn('Timezone detection failed:', e);
    }
}

// Mount the Wandergeek tab bar (components/wg-bottom-nav.js) into #app once.
// Idempotent — re-entry is a no-op. The bar registers with AppKernel so
// subsequent switchTab() calls update the active tab; a page (Settings /
// Journey) lights no tab (AppNav.navSectionFor). Tapping a tab
// calls switchTab with the tab's section — the Health tab resolves to the
// remembered, still-enabled BP / Weight / Vitals segment (features/app-nav.js).
// A tab whose whole feature set is off is filtered out before mount, so
// tapping it can't silently bounce back to Today via switchTab's guard.
const NAV_ID_TO_FEATURE = {
    meds: 'medication',
    workouts: 'workout',
    food: 'food',
    bp: 'bp',
    weight: 'weight',
    health: 'health',
};
function navSectionEnabled(section, features) {
    const feature = NAV_ID_TO_FEATURE[section];
    return !feature || !features || !!features[feature];
}
function filterNavItemsByFeatures(items, features) {
    if (!features) return items.slice();
    return items.filter((item) => (Array.isArray(item.sections)
        ? item.sections.some((s) => navSectionEnabled(s, features))
        : navSectionEnabled(item.id, features)));
}
function currentNavItems() {
    return filterNavItemsByFeatures(window.WGBottomNav.DEFAULT_ITEMS, window.featureSettings);
}
// Restore the saved section only if the user was last active within this
// window; after a longer absence we reopen Today. The timestamp is written by
// switchTab (app.js) on every navigation. Restorable: any enabled section a
// visible tab owns (bp / weight / health via the Health tab) plus the
// Settings / Journey pages (switchTab's own guard bounces a disabled Journey).
const ACTIVE_TAB_TTL_MS = 30 * 60 * 1000;
function readSavedActiveTab() {
    try {
        const saved = window.localStorage.getItem('mt-active-tab');
        if (!saved) return 'today';
        const savedAt = Number(window.localStorage.getItem('mt-active-tab-at'));
        if (!Number.isFinite(savedAt) || (Date.now() - savedAt) > ACTIVE_TAB_TTL_MS) {
            return 'today';
        }
        if (saved === 'settings' || saved === 'journey') return saved;
        if (!window.WGBottomNav) return 'today';
        const item = window.WGBottomNav.itemFor(currentNavItems(), saved);
        return item && navSectionEnabled(saved, window.featureSettings) ? saved : 'today';
    } catch (_) {
        return 'today';
    }
}
function navTargetFor(id) {
    return window.AppNav ? window.AppNav.resolveNavTarget(id) : id;
}
function navHighlightFor(tab) {
    return window.AppNav ? window.AppNav.navSectionFor(tab) : tab;
}
function mountNav(active) {
    const host = document.getElementById('app') || document.body;
    if (!host) return null;
    return window.WGBottomNav.mount(host, {
        items: currentNavItems(),
        active,
        onChange: (id) => {
            if (typeof switchTab === 'function') switchTab(navTargetFor(id));
        },
    });
}
let navCtrl = null;
function mountCanonicalBottomNav() {
    if (!window.WGBottomNav || document.querySelector('.wg-tabbar')) return;
    navCtrl = mountNav(readSavedActiveTab());
    if (window.AppKernel && typeof window.AppKernel.register === 'function') {
        window.AppKernel.register('wgBottomNav', {
            onTabSwitch(tab) { navCtrl && navCtrl.setActive(navHighlightFor(tab)); },
        });
    }
}

// Re-mount the tab bar with the current feature flags. Called from
// settings.js after a feature toggle (and auth-bootstrap.js when fresh flags
// arrive) so a tab whose whole feature set went off disappears without a
// reload, and the Health segment strip re-filters.
function rebuildCanonicalBottomNav() {
    if (!window.WGBottomNav) return;
    const current = (window.AppStore && window.AppStore.get('currentTab')) || 'today';
    if (navCtrl) {
        navCtrl.destroy();
        navCtrl = null;
    }
    navCtrl = mountNav(navHighlightFor(current));
    if (window.AppNav) {
        window.AppNav.syncChrome(current);
        window.AppNav.refreshMedsBadge();
    }
}
window.rebuildCanonicalBottomNav = rebuildCanonicalBottomNav;

checkAuth().then(async authorized => {
    if (authorized) {
        // Initialize SyncManager for offline support
        if (window.SyncManager) {
            window.SyncManager.init();
        }

        // Deletes a previous page owed (killed inside the Undo window).
        if (typeof replayPendingDeletes === 'function') replayPendingDeletes();

        // Mount the tab bar once (before the first switchTab so
        // it can receive the AppKernel.onTabSwitch('today') notification).
        mountCanonicalBottomNav();

        // Fill markup-authored <i class="wg-ico" data-icon> placeholders.
        // Components that inject such markup later hydrate their own subtree.
        // A bad data-icon name must cost one icon, not the rest of boot.
        if (window.WGIcons && typeof window.WGIcons.hydrate === 'function') {
            try { window.WGIcons.hydrate(document); } catch (e) { console.error('WGIcons.hydrate failed', e); }
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

        // Wire Back (chevron + popstate) once the initial tab is active: pages return to their origin tab, sections to Today.
        if (window.AppBackButton && typeof window.AppBackButton.setup === 'function') {
            window.AppBackButton.setup();
        }

        // Handle deep links and push actions from URL
        handleDeepLinks();
    }
});
