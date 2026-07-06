// ==================== Settings view ====================
// Extracted from app.js (Plan 2026-06-10 "finish-app-js-split", Task 2).
//
// This file owns the Settings tab's view orchestration: the SWR settings-bundle
// load (loadSettings), the feature-toggle write path (toggleFeatureSetting), the
// feature-toggle / food-targets / nav-visibility DOM sync helpers, the Settings
// stale badge mount, and the OIDC setup banner renderer. These functions remain
// global (script-tag loading) and rely on app.js + sibling globals at call time:
// apiCall, safeAlert, readPersistedTabOrder, switchTab, window.featureSettings,
// window.AuthBootstrap, window.SettingsState, window.WeightUnitState,
// window.FoodLog, window.TimeFormat, window.DataStore, window.WGStaleBadge,
// window.SettingsIntegrations, window.AppStore, window.rebuildCanonicalBottomNav,
// window.OIDC_CONFIG, applyWebpushStatus, hideWebpushStatus (both from app.js).
//
// The timezone info renderer (window.renderSettingsTimeInfo) lives in
// core/time-format.js and the Integrations card lives in
// features/settings/integrations.js — both already extracted; loadSettings()
// delegates to them. The weight-unit (kg/lb) state machine lives in
// features/weight-unit-state.js.
//
// Cloud-mode Notifications (bindCloudNotifications) dynamic-imports
// web/cloud/js/push.js + reminders.js and reads window.MedTrackerCloud.ctx
// (published by cloud-boot.js post-unlock) — see docs/cloud-mode.md.
//
// Public surface is mirrored on window.SettingsView for discoverability; the
// bare function names are the live call path used by app.js bindings
// (switchTab/reloadCurrentTab → loadSettings; the feature-toggle change handlers
// → toggleFeatureSetting; loadInitData / auth-bootstrap.js →
// updateFeatureTabVisibility) and by tests.

function initOIDCSetupBanner() {
    const container = document.getElementById('oidc-setup-container');
    if (!container) return;

    const oidcConfig = window.OIDC_CONFIG || { enabled: false };
    if (!oidcConfig.enabled) {
        container.replaceChildren();
        return;
    }

    const title = document.createElement('h3');
    title.className = 'wg-settings-section__title';
    title.textContent = 'OIDC Setup';

    const desc = document.createElement('p');
    desc.className = 'wg-settings-section__desc';
    desc.textContent = 'Copy redirect URIs for Pocket-ID / OIDC clients.';

    const rowList = document.createElement('div');
    rowList.className = 'wg-settings-row-list';

    const row = document.createElement('div');
    row.className = 'wg-settings-row';

    const rowContent = document.createElement('div');
    rowContent.className = 'wg-settings-row__content';
    const rowTitle = document.createElement('div');
    rowTitle.className = 'wg-settings-row__title wg-mono-display';
    rowTitle.textContent = 'Redirect URIs';
    const rowDesc = document.createElement('div');
    rowDesc.className = 'wg-settings-row__desc';
    rowDesc.textContent = 'Opens the setup page (new tab) to copy redirect URIs and client credentials into your Pocket-ID / OIDC clients.';
    rowContent.appendChild(rowTitle);
    rowContent.appendChild(rowDesc);

    const rowControl = document.createElement('div');
    rowControl.className = 'wg-settings-row__control';
    // Opens in a new tab so the mini-app URL isn't clobbered — returning via
    // browser-back otherwise re-runs handleDeepLinks() with no matching path
    // and switchTab('today') fires as a fallback.
    const actionLink = document.createElement('a');
    actionLink.className = 'wg-gloss wg-settings-action-btn';
    actionLink.textContent = 'Open';
    actionLink.href = '/oidc-setup';
    actionLink.target = '_blank';
    actionLink.rel = 'noopener noreferrer';
    actionLink.setAttribute('aria-label', 'Open OIDC setup page in a new tab');
    rowControl.appendChild(actionLink);

    row.appendChild(rowContent);
    row.appendChild(rowControl);
    rowList.appendChild(row);

    container.replaceChildren();
    container.appendChild(title);
    container.appendChild(desc);
    container.appendChild(rowList);
}

// Cloud-mode Notifications wiring. The server block's Web Push toggle +
// Test buttons POST to bot-mode /api/webpush/* + /api/bp/reminder/test
// routes cmd/cloud never registers, so cloud mode swaps in the
// .wg-settings-notifications-cloud block instead, driven by the DOM-free
// web/cloud/js/push.js + reminders.js primitives (dynamic-imported so
// server/mobile builds never pull in cloud-only modules).
// ponytail: no memoization — import() already caches by specifier. These
// functions exist only as the test seam (Vitest overrides the window globals).
let _cloudNotificationsBound = false; // module-state: one-time guard so the cloud toggle/test click listeners bind once across repeated loadSettings() calls
function loadCloudPushModule() { return import('/js/push.js'); }
function loadCloudRemindersModule() { return import('/js/reminders.js'); }

async function refreshCloudPushToggleState(toggleBtn) {
    try {
        const { getSubscription } = await loadCloudPushModule();
        const sub = await getSubscription();
        toggleBtn.dataset.subscribed = sub ? '1' : '0';
        toggleBtn.textContent = sub ? 'Disable' : 'Enable';
    } catch (e) {
        toggleBtn.dataset.subscribed = '0';
        toggleBtn.textContent = 'Enable';
    }
}

// WebKit/iOS implement the LEGACY callback form of Notification.requestPermission():
// it returns undefined and delivers the result via callback. A plain
// `await Notification.requestPermission()` then yields undefined, which reads as
// "not granted" even after the user taps Allow (med-eas.19). Normalize both
// forms. The requestPermission call runs synchronously inside the Promise
// executor, so calling this as the first await in the click handler preserves
// Safari's transient-activation requirement. Mirrors push.js's
// requestNotificationPermission (settings.js can't import it before the gesture).
function requestNotificationPermissionNormalized() {
    return new Promise((resolve) => {
        const maybe = Notification.requestPermission(resolve);
        if (maybe && typeof maybe.then === 'function') maybe.then(resolve);
    });
}

function bindCloudNotifications() {
    const toggleBtn = document.getElementById('cloud-push-toggle');
    const testBtn = document.getElementById('cloud-push-test-btn');
    const status = document.getElementById('cloud-push-status');
    if (!toggleBtn || !testBtn || !status) return;

    // Disable the controls until the async getSubscription() check resolves —
    // the button defaults to 'Enable' with dataset.subscribed unset, so a click
    // in that window could subscribe while already subscribed or wrongly report
    // "Enable push notifications first."
    toggleBtn.disabled = true;
    testBtn.disabled = true;
    const ready = refreshCloudPushToggleState(toggleBtn).finally(() => {
        toggleBtn.disabled = false;
        testBtn.disabled = false;
    });
    if (_cloudNotificationsBound) return ready;
    _cloudNotificationsBound = true;

    toggleBtn.addEventListener('click', async () => {
        toggleBtn.disabled = true;
        try {
            if (toggleBtn.dataset.subscribed === '1') {
                const { unsubscribe } = await loadCloudPushModule();
                await unsubscribe();
                applyWebpushStatus(status, 'Notifications disabled', 'muted');
            } else if (typeof Notification === 'undefined') {
                // Non-installed iOS Safari exposes no Notification API — Web Push
                // there requires the app be added to the Home Screen first.
                applyWebpushStatus(status, 'To enable notifications on iOS, add this app to your Home Screen, then reopen it from there.', 'error');
            } else if (Notification.permission === 'denied') {
                applyWebpushStatus(status, 'Notifications are blocked in your browser settings.', 'error');
            } else {
                // Reach requestPermission() synchronously inside the click's
                // transient activation — Safari/iOS drop it across the dynamic
                // import() await below, so requesting here (not only inside push.js
                // subscribe()) keeps first-enable working on iOS. The normalized
                // helper handles WebKit's callback form (med-eas.19). subscribe()
                // re-checks and no-ops when already granted.
                const permission = await requestNotificationPermissionNormalized();
                if (permission !== 'granted') {
                    applyWebpushStatus(status, 'Notification permission was not granted.', 'error');
                } else {
                    applyWebpushStatus(status, 'Requesting permission...', null);
                    const { subscribe } = await loadCloudPushModule();
                    await subscribe();
                    applyWebpushStatus(status, 'Notifications enabled', 'success');
                }
            }
        } catch (err) {
            applyWebpushStatus(status, err.message || 'Failed to update notifications', 'error');
        }
        await refreshCloudPushToggleState(toggleBtn);
        toggleBtn.disabled = false;
        setTimeout(() => hideWebpushStatus(status), 3000);
    });

    testBtn.addEventListener('click', async () => {
        const ctx = window.MedTrackerCloud?.ctx;
        if (!ctx) {
            applyWebpushStatus(status, 'Unlock the vault before sending a test push.', 'error');
        } else if (toggleBtn.dataset.subscribed !== '1') {
            applyWebpushStatus(status, 'Enable push notifications first.', 'error');
        } else {
            testBtn.disabled = true;
            try {
                const { sendTestPush } = await loadCloudRemindersModule();
                await sendTestPush(ctx);
                applyWebpushStatus(status, 'Test push scheduled — it should arrive shortly.', 'success');
            } catch (err) {
                applyWebpushStatus(status, err.message || 'Failed to send test push', 'error');
            }
            testBtn.disabled = false;
        }
        setTimeout(() => hideWebpushStatus(status), 3000);
    });
    return ready;
}

// Load settings (BP reminders status, etc.)
async function loadSettings() {
    if (window.__MEDTRACKER_CLOUD__) {
        document.querySelector('.wg-settings-notifications')?.classList.add('wg-settings-hidden');
        document.querySelector('.wg-settings-notifications-cloud')?.classList.remove('wg-settings-hidden');
        await bindCloudNotifications();
        // Devices row (add/manage a second device) only makes sense in cloud
        // mode — server/mobile builds have no /devices shell route.
        document.querySelector('.wg-settings-cloud-devices')?.classList.remove('wg-settings-hidden');
    }
    const applyBundle = async (rawBundle) => {
        const bundle = window.AuthBootstrap.normalizeSettingsBundle(rawBundle);
        window.SettingsState.applyBootstrapFeatures(bundle.featureSettings);
        window.WeightUnitState.applyAuthoritative(bundle.weightUnitPreference);
        updateFeatureToggles();
        updateFeatureTabVisibility();

        window.FoodLog.targets = { ...bundle.foodTargets };
        const targets = window.FoodLog.targets;
        const calsInput = document.getElementById('food-target-calories');
        const carbsInput = document.getElementById('food-target-carbs');
        const protInput = document.getElementById('food-target-protein');
        const fatInput = document.getElementById('food-target-fat');
        if (calsInput) calsInput.value = targets.calories || '';
        if (carbsInput) carbsInput.value = targets.carbs || '';
        if (protInput) protInput.value = targets.protein || '';
        if (fatInput) fatInput.value = targets.fat || '';

        document.getElementById('bp-reminders-toggle').checked = !!bundle.bpReminderStatus.enabled;
        document.getElementById('weight-reminders-toggle').checked = !!bundle.weightReminderStatus.enabled;
        window.TimeFormat.render(bundle);
        window.TimeFormat.ensureTimer();
    };

    const fetchBundle = async () => {
        const [featureSettingsRes, foodTargetsRes, bpReminderStatus, weightReminderStatus, settingsRes] = await Promise.all([
            apiCall('/api/settings/features', 'GET'),
            apiCall('/api/food/settings/targets', 'GET'),
            apiCall('/api/bp/reminder/status', 'GET'),
            apiCall('/api/weight/reminder/status', 'GET'),
            apiCall('/api/settings', 'GET')
        ]);
        // /api/settings now returns the same slices the four legacy endpoints
        // return (features, food_targets, bp_reminder_status,
        // weight_reminder_status). Treat it as a fallback for any legacy slice
        // that came back null, so a partial outage of one legacy endpoint
        // doesn't make us skip onFresh and leave Settings stale.
        const features = featureSettingsRes !== null
            ? featureSettingsRes
            : (settingsRes && settingsRes.features !== undefined ? settingsRes.features : null);
        const foodTargetsData = foodTargetsRes !== null
            ? foodTargetsRes
            : (settingsRes && settingsRes.food_targets !== undefined ? settingsRes.food_targets : null);
        const bpReminder = bpReminderStatus !== null
            ? bpReminderStatus
            : (settingsRes && settingsRes.bp_reminder_status !== undefined ? settingsRes.bp_reminder_status : null);
        const weightReminder = weightReminderStatus !== null
            ? weightReminderStatus
            : (settingsRes && settingsRes.weight_reminder_status !== undefined ? settingsRes.weight_reminder_status : null);
        // apiCall returns null silently on offline / 5xx. Defaulting null
        // slices to {} / 0 / {enabled:false} here would produce a non-null
        // bundle that fetchFresh would then write to ApiCache, blanking the
        // good cached bundle and the rendered UI (toggles off, macros 0,
        // weight unit back to kg). Surface the failure to loadSWR by
        // returning null — it skips onFresh and the cached row + onCached
        // already-painted UI stay intact.
        if (
            settingsRes === null
            || features === null
            || foodTargetsData === null
            || bpReminder === null
            || weightReminder === null
        ) {
            return null;
        }
        // tab_order: /api/settings includes it (when set) but for compat with
        // clients that haven't migrated to consuming it from here, prefer the
        // existing cache, then fall back to localStorage, then to the /api/settings
        // response. This preserves the user's saved Today card order across SWR
        // re-writes and invalidations of settings_bundle.
        let tabOrder = null;
        try {
            const existing = await window.DataStore.getCached('settings_bundle');
            if (existing && Array.isArray(existing.tabOrder)) tabOrder = existing.tabOrder;
        } catch (_) { /* no cache available — leave tabOrder null */ }
        if (!tabOrder) tabOrder = readPersistedTabOrder();
        if (!tabOrder && Array.isArray(settingsRes?.tab_order)) tabOrder = settingsRes.tab_order;
        return {
            featureSettings: features || {},
            tabOrder,
            timezone: settingsRes?.timezone || '',
            serverTime: settingsRes?.server_time || '',
            serverTimezone: settingsRes?.server_timezone || '',
            dismissedTzSuggestion: settingsRes?.dismissed_tz_suggestion || '',
            weightUnitPreference: settingsRes?.weight_unit_preference || window.weightUnitPreference || 'kg',
            foodTargets: {
                calories: foodTargetsData?.calories || 0,
                carbs: foodTargetsData?.carbs || 0,
                protein: foodTargetsData?.protein || 0,
                fat: foodTargetsData?.fat || 0
            },
            bpReminderStatus: bpReminder || { enabled: false },
            weightReminderStatus: weightReminder || { enabled: false }
        };
    };

    // Mount the stale badge from the bootstrap-warmed settings_bundle row so
    // the user can see "Offline · 2h old" when Settings is opened on a cold
    // start without network — and "Updated just now" after the SWR fetch
    // lands a fresh bundle. Best-effort: never blocks Settings render.
    const mountStaleBadge = async () => {
        try { await renderSettingsStaleBadge(); } catch (_) { /* no-op */ }
    };

    try {
        await window.DataStore.loadSWR({
            key: 'settings_bundle',
            tags: ['settings', 'food_targets', 'feature_settings'],
            fetcher: fetchBundle,
            onCached: async (cached) => {
                await applyBundle(cached);
                await mountStaleBadge();
            },
            onFresh: async (fresh) => {
                await applyBundle(fresh);
                await mountStaleBadge();
            },
            onError: async (error, cached) => {
                console.error('Failed to load settings:', error);
                if (cached) applyBundle(cached);
                await mountStaleBadge();
            }
        });
    } catch (error) {
        console.error('Failed to load settings:', error);
    }
    // Safety-net mount for the case where no callback fires (e.g., no cached
    // row AND fetcher returns null) — mountFromKey gracefully no-ops if
    // there's nothing to surface.
    await mountStaleBadge();
    // The Integrations section is loaded lazily from its own endpoint so
    // the settings_bundle SWR fetch stays focused on the feature-flags +
    // food-targets + reminders + weight-unit slice that bootstrap also
    // returns. Best-effort: never blocks the rest of Settings.
    if (window.SettingsIntegrations && typeof window.SettingsIntegrations.load === 'function') {
        try { await window.SettingsIntegrations.load(); } catch (_) { /* no-op */ }
    }
    // Journey targets editor — loaded lazily off its own endpoint (best-effort;
    // internally gated on the gamification flag).
    await loadGamificationTargets();
}

// Mounts the wg-stale-badge into the Settings section header from the
// `settings_bundle` api_cache row (warmed by /api/bootstrap and refreshed by
// loadSettings()'s SWR fetcher). Mirrors the BP/Weight/Workout/Health pattern.
async function renderSettingsStaleBadge() {
    const slot = document.getElementById('settings-stale-badge');
    if (!slot) return;
    const api = (typeof window !== 'undefined') ? window.WGStaleBadge : null;
    if (!api || typeof api.mountFromKey !== 'function') {
        slot.replaceChildren();
        slot.classList.add('hidden');
        return;
    }
    await api.mountFromKey({ slot, key: 'settings_bundle' });
}

function updateFeatureToggles() {
    const flags = window.featureSettings || {};
    document.getElementById('food-intake-toggle').checked = !!flags.food;
    document.getElementById('bp-feature-toggle').checked = !!flags.bp;
    document.getElementById('weight-feature-toggle').checked = !!flags.weight;
    document.getElementById('health-feature-toggle').checked = !!flags.health;
    document.getElementById('medication-feature-toggle').checked = !!flags.medication;
    document.getElementById('workout-feature-toggle').checked = !!flags.workout;
    document.getElementById('weekly-digest-feature-toggle').checked = !!flags.weekly_digest;
}

function updateFoodTargetsVisibility() {
    const settingsBlock = document.getElementById('food-target-settings');
    if (!settingsBlock) return;
    settingsBlock.style.display = window.featureSettings.food ? 'flex' : 'none';
}

// ---- Journey (gamification) targets editor (Plan 3, Task 4) -----------------
// The overridable band-shaped metrics, in the same display order the backend
// returns (internal/domain/gamification/scoreday.go targetMetricKeys). Labels +
// units live in the static HTML; JS only addresses fields by metric_key.
const GAMIFICATION_TARGET_METRICS = ['bp_systolic', 'bp_diastolic', 'resting_hr', 'sleep_hours', 'steps', 'bedtime'];

// Metric keys the user has a custom override for, per the last applied view.
// saveGamificationTargets consults this so clearing a previously-custom band
// sends an explicit reset (not just a skip) and actually reverts to default.
const gamCustomMetrics = new Set();

// Format an effective/recommended band value for display: round to ≤1 decimal
// (sleep hours are fractional, the rest integral) and stringify. Empty string
// for absent/non-numeric so a blank input keeps its recommended placeholder.
function fmtGamTargetVal(n) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '';
    return String(Math.round(Number(n) * 10) / 10);
}

// Populate the Journey Targets fields from a GET/PUT /api/gamification/targets
// view: recommended bounds become the placeholder + hint; custom overrides
// prefill the inputs (so a recommended metric shows faint placeholders and a
// customized one shows its own values).
function applyGamificationTargets(view) {
    if (!view || view.enabled === false || !Array.isArray(view.targets)) return;
    gamCustomMetrics.clear();
    for (const t of view.targets) {
        const key = t.metric_key;
        if (t.is_custom) gamCustomMetrics.add(key);
        const lowEl = document.getElementById(`gam-target-${key}-low`);
        const highEl = document.getElementById(`gam-target-${key}-high`);
        const hintEl = document.querySelector(`[data-gam-hint="${key}"]`);
        if (!lowEl || !highEl) continue;
        const recLow = fmtGamTargetVal(t.recommended_low);
        const recHigh = fmtGamTargetVal(t.recommended_high);
        lowEl.placeholder = recLow;
        highEl.placeholder = recHigh;
        lowEl.value = t.is_custom ? fmtGamTargetVal(t.low) : '';
        highEl.value = t.is_custom ? fmtGamTargetVal(t.high) : '';
        if (hintEl) {
            hintEl.textContent = t.is_custom
                ? `custom · rec ${recLow}–${recHigh}`
                : `recommended ${recLow}–${recHigh}`;
        }
    }
}

// Best-effort field population — fetched separately from the settings_bundle SWR
// (mirrors SettingsIntegrations.load) so a targets-endpoint outage never blanks
// the rest of Settings. Skips entirely when the feature is off.
async function loadGamificationTargets() {
    if (!window.featureSettings || !window.featureSettings.gamification) return;
    try {
        const view = await apiCall('/api/gamification/targets', 'GET');
        if (view) applyGamificationTargets(view);
    } catch (e) {
        console.warn('Failed to load journey targets:', e);
    }
}

function updateGamificationTargetsVisibility() {
    const block = document.getElementById('gamification-targets-settings');
    if (!block) return;
    const on = !!(window.featureSettings && window.featureSettings.gamification);
    block.classList.toggle('hidden', !on);
}

// Save the edited bands. Only metrics the user actually filled are sent (a blank
// pair keeps the recommended default). Optimistic write (Critical Rule #9) on the
// shared 'gamification' cache key: a band change can't retro-repaint the Journey
// without a re-score, so the mutator is a no-op — the value is the rollback +
// tag-refresh lifecycle, which on failure restores the prior journey cache and on
// success invalidates it so the next Journey load re-scores against the new bands.
async function saveGamificationTargets() {
    const targets = [];
    for (const key of GAMIFICATION_TARGET_METRICS) {
        const lowEl = document.getElementById(`gam-target-${key}-low`);
        const highEl = document.getElementById(`gam-target-${key}-high`);
        if (!lowEl || !highEl) continue;
        const lowStr = lowEl.value.trim();
        const highStr = highEl.value.trim();
        const low = lowStr === '' ? null : Number(lowStr);
        const high = highStr === '' ? null : Number(highStr);
        const pretty = key.replace(/_/g, ' ');
        // Client-side guard against obviously unsafe values before the PUT (the
        // service validates the same, but catch it early for a clearer message).
        if ((low !== null && (Number.isNaN(low) || low < 0)) || (high !== null && (Number.isNaN(high) || high < 0))) {
            safeAlert(`Enter valid non-negative numbers for ${pretty}`);
            return;
        }
        if (low !== null && high !== null && low > high) {
            safeAlert(`${pretty}: low must not exceed high`);
            return;
        }
        if (low === null && high === null) {
            // Both blank. If this metric was a custom override, the user cleared it
            // to revert to the recommended default — send an all-nil reset so the
            // backend deletes the override (honouring the "leave blank to keep the
            // recommended default" copy). A never-custom metric is genuinely
            // unchanged, so skip it.
            if (gamCustomMetrics.has(key)) targets.push({ metric_key: key });
            continue;
        }
        const t = { metric_key: key };
        if (low !== null) t.low_val = low;
        if (high !== null) t.high_val = high;
        targets.push(t);
    }

    const ds = window.DataStore;
    const handle = (ds && typeof ds.applyOptimistic === 'function')
        ? await ds.applyOptimistic('gamification', (prev) => prev, ['gamification'])
        : null;

    let res;
    try {
        res = await apiCall('/api/gamification/targets', 'PUT', { targets });
    } catch (e) {
        if (handle) await handle.rollback();
        console.error('Failed to save journey targets:', e);
        safeAlert('Failed to save targets');
        return;
    }
    if (!res) {
        if (handle) await handle.rollback();
        // apiCall already surfaced the failure alert for the write; don't stack a second.
        return;
    }
    if (handle) await handle.commit(null);
    applyGamificationTargets(res);
    try { await ds.invalidateTags(['gamification']); } catch (_) { /* best-effort */ }
    safeAlert('Targets saved');
}

async function toggleFeatureSetting(feature, enabled) {
    const result = await apiCall(`/api/settings/features/${feature}`, 'POST', { enabled });
    if (!result) {
        // apiCall returns null on failure and has already surfaced the error.
        // Revert the DOM toggle to the last-known state so the UI doesn't lie.
        updateFeatureToggles();
        return;
    }
    window.SettingsState.setFeature(feature, enabled);
    if (typeof window.rebuildCanonicalBottomNav === 'function') {
        window.rebuildCanonicalBottomNav();
    }
    try {
        await window.DataStore.invalidateTags(['settings', 'feature_settings']);
    } catch (e) {
        console.warn(`Failed to invalidate settings cache after toggling ${feature}:`, e);
    }
    updateFeatureTabVisibility();
}

function updateFeatureTabVisibility() {
    const tabToFeature = {
        food: 'food',
        health: 'health',
        bp: 'bp',
        weight: 'weight',
        meds: 'medication',
        workouts: 'workout',
        journey: 'gamification'
    };

    const currentTab = window.AppStore && window.AppStore.get('currentTab');
    const currentFeature = tabToFeature[currentTab];
    if (currentFeature && !window.featureSettings[currentFeature]) {
        switchTab('today');
    }
    updateFoodTargetsVisibility();
    updateGamificationTargetsVisibility();
}

window.initOIDCSetupBanner = initOIDCSetupBanner;

// Public surface mirror — bare names above are the live call path; this object
// documents the module's API and satisfies the globals allowlist.
window.SettingsView = {
    initOIDCSetupBanner,
    loadSettings,
    renderSettingsStaleBadge,
    updateFeatureToggles,
    updateFoodTargetsVisibility,
    toggleFeatureSetting,
    updateFeatureTabVisibility,
    loadGamificationTargets,
    applyGamificationTargets,
    saveGamificationTargets,
    updateGamificationTargetsVisibility
};
