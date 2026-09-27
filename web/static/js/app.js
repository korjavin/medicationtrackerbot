// app.js — top-level orchestrator (post-split, 2026-06-10).
//
// After the two-round app.js split (2026-05-13 utilities/state machines,
// 2026-06-10 view orchestrators), this file holds ONLY the top-level glue
// that has no natural feature home:
//   • Messenger bootstrap — adapter init.
//   • checkAuth() / loadInitData() — the cloud auth-orchestration entry point.
//   • switchTab() / switchHealthTab() / switchMedTab() — section lifecycle.
//   • The deferred-refresh banner cluster (requestTabRefresh / reloadCurrentTab
//     / isSafeToAutoRefresh) — cross-section refresh coordination.
//   • Top-level wiring — control bindings (bindMedicationControls etc.),
//     handlePushAction routing, tab-order persistence, and the shared
//     webpush-status helpers (applyWebpushStatus/hideWebpushStatus) that the
//     cloud Notifications settings block uses.
//
// View orchestrators now live in their own feature modules:
//   features/today-loader.js  (window.TodayLoader)   — Today view loading.
//   features/settings.js      (window.SettingsView)  — Settings view.
//   features/meds-history.js  (window.MedsHistory)   — med modal + history.
//   features/workout/modals.js(window.WorkoutModals) — workout start/snooze/skip.
//
// Justified leftovers (documented per Task 5 of the split plan): the shared
// cross-feature module globals `medications`, `editingMedId`, and `formatDate`
// (declared near the "// State" marker below) stay here as their single
// declaration site. Several feature files read/write them by bare name —
// auth-bootstrap.js mirrors window.medications, meds.js / meds-history.js
// mutate editingMedId, and bp.js / weight.js / meds.js call formatDate — so
// moving them into any one feature module would make them private and break
// the others. They are owned here until a dedicated shared-state pass.
//
// Bootstrap the messenger host. window.MessengerAdapter (the BrowserAdapter)
// is set synchronously at the top of core/messenger-adapter.js so this never
// null-checks; init() resolves immediately.
window.MessengerAdapter.init();

var initialAuthLoad = false;

// Auth-cache constants and helpers are defined in features/auth-flow.js.
// checkAuth() (below) calls saveAuthState / getCachedAuthState / clearAuthState
// by name; those names resolve to the window-scoped definitions from auth-flow.js
// which is always loaded before checkAuth() is ever invoked.

if (!window.DataStore) {
    throw new Error('DataStore is not available. Ensure data-store.js loads before app.js');
}

// cacheApiSnapshot, normalizeSettingsBundle, applyBootstrapPayload,
// hydrateFeatureSettingsFromBundle, hydrateMedicationsFromDexie, and
// hydrateSectionsFromDexie live in features/auth-bootstrap.js (Plan
// 2026-05-13-split-app-js.md, Task 3). They remain reachable as the
// original window.X globals through the backwards-compat shims at the
// bottom of that file.

const TAB_ORDER_STORAGE_KEY = 'medtracker_tab_order';

// Persist tab_order to localStorage so it survives settings_bundle cache
// invalidations (timezone updates, feature toggles, 'settings' change-stream
// events) that would otherwise drop the user's Today card order until a full
// bootstrap restores it. /api/settings has no tab_order field, so the bundle
// fetcher needs a durable fallback.
function persistTabOrder(order) {
    if (!Array.isArray(order)) return;
    try {
        localStorage.setItem(TAB_ORDER_STORAGE_KEY, JSON.stringify(order));
    } catch (_) { /* localStorage unavailable — best-effort */ }
}

function readPersistedTabOrder() {
    try {
        const raw = localStorage.getItem(TAB_ORDER_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : null;
    } catch (_) { return null; }
}

function clearPersistedTabOrder() {
    try {
        localStorage.removeItem(TAB_ORDER_STORAGE_KEY);
    } catch (_) { /* localStorage unavailable — best-effort */ }
}

// Load init data (feature settings) needed before first render.
// Falls back gracefully so auth flow is not blocked on failure.
// apiCall() already catches errors and returns null – no try/catch needed here.
async function loadInitData() {
    const res = await apiCall('/api/init', 'GET');
    if (res && res.features) {
        window.SettingsState.applyBootstrapFeatures(res.features);
        updateFeatureTabVisibility();
    }
}

// Check Auth Environment — cloud-only. cloud-boot.js warm-unlocks the vault
// and installs the apiCall shim asynchronously; MedTrackerCloudReady gates
// the first network touch the same way. No cookie, no login UI.
async function checkAuth() {
    // Preflight Dexie hydration runs before any bootstrap fetch so a
    // relaunch-while-offline already has the meds list in DataStore by the
    // time the first switchTab() / Today tile / loadMeds() reads it.
    await hydrateMedicationsFromDexie();
    await hydrateSectionsFromDexie();

    if (window.MedTrackerCloudReady) {
        try { await window.MedTrackerCloudReady; } catch (_) { /* boot() already redirects to /unlock on failure */ }
    }
    sessionStorage.removeItem('medtracker_auth_reload_in_progress');
    saveAuthState('cloud');
    const bootstrap = await apiCall('/api/bootstrap', 'GET');
    if (bootstrap) {
        await applyBootstrapPayload(bootstrap);
    } else {
        await loadInitData();
        if (!window.SettingsState.isLoaded() && window.DataStore) {
            try {
                const cachedBundle = await window.DataStore.getCached('settings_bundle');
                if (cachedBundle) {
                    hydrateFeatureSettingsFromBundle(cachedBundle);
                }
            } catch (_) { /* best-effort cache read */ }
        }
    }
    return true;
}

// Bootstrap orchestration lives in features/bootstrap.js (loaded after all feature scripts).

// Shared webpush-status helpers for the Settings Notifications blocks
// (features/settings.js cloud branch calls these by name).
const WEBPUSH_STATUS_VARIANT_CLASSES = [
    'status-success', 'status-error', 'status-muted',
    'wg-tag--mono--success', 'wg-tag--mono--alert', 'wg-tag--mono--muted',
];
const WEBPUSH_STATUS_VARIANT_MAP = {
    success: ['status-success', 'wg-tag--mono--success'],
    error: ['status-error', 'wg-tag--mono--alert'],
    muted: ['status-muted', 'wg-tag--mono--muted'],
};

function applyWebpushStatus(status, text, variant) {
    status.textContent = text;
    status.classList.remove('wg-settings-hidden', ...WEBPUSH_STATUS_VARIANT_CLASSES);
    const classes = WEBPUSH_STATUS_VARIANT_MAP[variant];
    if (classes) status.classList.add(...classes);
}

function hideWebpushStatus(status) {
    status.classList.add('wg-settings-hidden');
    status.classList.remove(...WEBPUSH_STATUS_VARIANT_CLASSES);
}

// BP Reminders Toggle Handler
document.getElementById('bp-reminders-toggle').addEventListener('change', async function () {
    const enabled = this.checked;
    const response = await apiCall('/api/bp/reminder/toggle', 'POST', { enabled });
    if (response) {
        await window.DataStore.invalidateTags(['settings']);
        console.log('BP reminders toggled:', enabled);
    } else {
        // apiCall already showed the error alert; revert the toggle UI
        this.checked = !enabled;
    }
});

document.getElementById('food-intake-toggle').addEventListener('change', async function () {
    await toggleFeatureSetting('food', this.checked);
});

document.getElementById('bp-feature-toggle').addEventListener('change', async function () {
    await toggleFeatureSetting('bp', this.checked);
});

document.getElementById('weight-feature-toggle').addEventListener('change', async function () {
    await toggleFeatureSetting('weight', this.checked);
});

document.getElementById('health-feature-toggle').addEventListener('change', async function () {
    await toggleFeatureSetting('health', this.checked);
});

document.getElementById('gamification-feature-toggle').addEventListener('change', async function () {
    await toggleFeatureSetting('gamification', this.checked);
});

document.getElementById('medication-feature-toggle').addEventListener('change', async function () {
    await toggleFeatureSetting('medication', this.checked);
});

document.getElementById('workout-feature-toggle').addEventListener('change', async function () {
    await toggleFeatureSetting('workout', this.checked);
});

document.getElementById('weekly-digest-feature-toggle').addEventListener('change', async function () {
    await toggleFeatureSetting('weekly_digest', this.checked);
});

document.getElementById('save-food-targets-btn').addEventListener('click', async function () {
    await saveFoodTargets();
});

const saveGamificationTargetsBtn = document.getElementById('save-gamification-targets-btn');
if (saveGamificationTargetsBtn) {
    saveGamificationTargetsBtn.addEventListener('click', async function () {
        await saveGamificationTargets();
    });
}

// The weight-unit (kg/lb) preference state machine — the PATCH serial queue,
// the optimistic-rollback baseline, the stale-hydration guard, and the
// segmented-toggle DOM helper — lives in features/weight-unit-state.js.
// app.js delegates via window.WeightUnitState (commit/apply/setPreference);
// window.commitAuthoritativeWeightUnit and window.setWeightUnitPreference
// remain as backwards-compatible shims for features/weight.js and tests.
(function bindWeightUnitSegmented() {
    const root = document.getElementById('weight-unit-segmented');
    if (!root) return;
    root.addEventListener('click', async (event) => {
        const btn = event.target.closest('.wg-settings-segmented__btn');
        if (!btn || !root.contains(btn)) return;
        const unit = btn.getAttribute('data-unit');
        if (unit !== 'kg' && unit !== 'lb') return;
        await window.WeightUnitState.setPreference(unit);
    });
})();

// Weight Reminders Toggle Handler
document.getElementById('weight-reminders-toggle').addEventListener('change', async function () {
    const enabled = this.checked;
    const response = await apiCall('/api/weight/reminder/toggle', 'POST', { enabled });
    if (response) {
        await window.DataStore.invalidateTags(['settings']);
        console.log('Weight reminders toggled:', enabled);
    } else {
        // apiCall already showed the error alert; revert the toggle UI
        this.checked = !enabled;
    }
});

// Listen for service worker messages
navigator.serviceWorker && navigator.serviceWorker.addEventListener('message', event => {
    if (event.data.type === 'MEDICATION_CONFIRMED') {
        // Reload data if visible
        refreshMedsAfterMutation();
    } else if (event.data.type === 'BOOTSTRAP_UPDATED' && event.data.data) {
        // Fresh bootstrap data arrived from SW background revalidation
        applyBootstrapPayload(event.data.data).then(() => {
            reloadCurrentTab();
        });
    }
});

// Auto-advance for BP input fields
document.getElementById('bp-systolic').addEventListener('input', function (e) {
    // After 3 digits, move to diastolic
    if (this.value.length >= 3) {
        document.getElementById('bp-diastolic').focus();
    }
});

document.getElementById('bp-diastolic').addEventListener('input', function (e) {
    // After 2 digits, move to pulse
    if (this.value.length >= 2) {
        document.getElementById('bp-pulse').focus();
    }
});

// State
var medications = [];
var editingMedId = null;
// `currentFoodLogs` and `foodTargets` previously lived here as top-level
// `var` declarations. They moved to features/food/log.js as part of the
// food.js split (2026-05-13). `currentFoodLogs` is now closure-private and
// accessed via window.FoodLog.getCurrent(); `foodTargets` is closure-private
// and accessed via window.FoodLog.targets (the legacy window.foodTargets
// alias is still defined for back-compat readers but new code should use
// the namespaced accessor).
// featureSettings + featureSettingsLoaded live in features/auth-bootstrap.js
// behind window.SettingsState (Plan 2026-05-13-split-app-js.md, Task 3).
// The reducer owns the previously-racy three-writer cluster (bootstrap,
// /api/init, Dexie hydration) and mirrors to window.featureSettings,
// window.featureSettingsLoaded, and AppStore on every transition. Readers
// here go through window.featureSettings; writers through SettingsState.

// Default weight-unit preference. Hydrated from /api/bootstrap into a window
// property so weight.js can seed the modal toggle synchronously on open.
// 'kg' is the storage canon and the conservative default before bootstrap
// resolves; persisted in IndexedDB via settings_bundle for offline reload.
if (typeof window.weightUnitPreference !== 'string'
    || (window.weightUnitPreference !== 'kg' && window.weightUnitPreference !== 'lb')) {
    window.weightUnitPreference = 'kg';
}
var formatDate = (dateStr) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return d.toLocaleString('de-DE', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    });
};

// UI Functions
// activateTabGroup + bindTabGroup live in features/tab-controller.js
// (Plan 2026-05-13, Task 6). Local aliases keep this file's call sites
// short; both helpers are also reachable as window.TabController.*.
const activateTabGroup = (tab, options) => window.TabController.activateTabGroup(tab, options);
const bindTabGroup = (options) => window.TabController.bindTabGroup(options);

function switchTab(tab) {
    const tabToFeature = {
        food: 'food',
        health: 'health',
        bp: 'bp',
        weight: 'weight',
        meds: 'medication',
        workouts: 'workout',
        journey: 'gamification'
    };
    const feature = tabToFeature[tab];
    if (feature && window.featureSettingsLoaded && !window.featureSettings[feature]) {
        switchTab('today');
        return;
    }

    const activated = activateTabGroup(tab, {
        contentSelector: '.view',
        contentIdFromTab: (tabName) => `${tabName}-view`,
        ariaCurrent: 'page'
    });
    if (!activated) return;

    window.AppStore && window.AppStore.set('currentTab', tab);
    // Persist the active section plus a "last activity" timestamp. bootstrap.js
    // only restores the saved section if the user returns within 30 min;
    // otherwise it opens Today (see readSavedActiveTab).
    try {
        window.localStorage.setItem('mt-active-tab', tab);
        window.localStorage.setItem('mt-active-tab-at', String(Date.now()));
    } catch (_) {}
    if (window.AppKernel && typeof window.AppKernel.onTabSwitch === 'function') {
        window.AppKernel.onTabSwitch(tab);
    }

    if (tab === 'meds') {
        const stored = typeof getActiveMedsSubTab === 'function' ? getActiveMedsSubTab() : 'history';
        const activeMedTab = document.querySelector('.med-tab.active');
        if (!activeMedTab || activeMedTab.dataset.tab !== stored) {
            switchMedTab(stored);
        } else {
            reloadCurrentTab();
        }
    } else if (tab === 'bp') { loadBPReadings(); }
    else if (tab === 'weight') { loadWeightLogs(); }
    else if (tab === 'health') {
        const stored = typeof getActiveHealthSubTab === 'function' ? getActiveHealthSubTab() : 'overview';
        switchHealthTab(stored);
    }
    else if (tab === 'workouts') { loadWorkouts(); }
    else if (tab === 'food') { loadFoodLogs(); }
    else if (tab === 'today') { loadToday(); }
    else if (tab === 'journey') { if (window.Gamification) window.Gamification.load(); }
    else if (tab === 'settings') { loadSettings(); }
}

// The Today view loading orchestration — loadToday(), _todayRender(),
// _todayReadCaches(), fetchSettingsBundle(), todayFetchSpecs(),
// fetchNextIntakePayload(), loadNextIntakeCached(), todayFoodKey(),
// healthOverviewCacheKey(), and the Today subscription + refetch in-flight
// state — moved to features/today-loader.js (Plan 2026-06-10
// finish-app-js-split, Task 3). They remain reachable as the original bare
// globals (loadToday / todayFoodKey / fetchNextIntakePayload /
// fetchSettingsBundle / window.healthOverviewCacheKey): switchTab() and
// reloadCurrentTab() call loadToday() at call time; features/today.js
// (window.TodayDashboard) stays the pure aggregation/render contract this
// loader feeds. window.requestTabRefresh / window.reloadCurrentTab (section
// lifecycle + deferred-refresh banner) stay below as top-level wiring.

function switchHealthTab(tab) {
    const activated = activateTabGroup(tab, {
        buttonSelector: '.health-tab',
        contentSelector: '.health-tab-content',
        contentIdFromTab: (t) => `health-${t}-tab`
    });
    if (!activated) return;

    if (typeof syncHealthSubTabActiveClass === 'function') syncHealthSubTabActiveClass(tab);
    if (typeof setActiveHealthSubTab === 'function') setActiveHealthSubTab(tab);

    if (tab === 'overview') { loadHealthOverview(); }
    else if (tab === 'notes') { loadNotes(); }
}

bindTabGroup({
    container: document.querySelector('.health-tabs'),
    buttonSelector: '.health-tab',
    onTabSelect: switchHealthTab
});

// The three bind* helpers below previously each carried their own
// module-level `*ControlsBound = false` flag. They now share a single
// TabController.bindOnce(scope, fn) registry (Plan 2026-05-13, Task 6),
// so adding a fourth bind-once scope is free and the flags can't drift
// apart.

function bindMedicationControls() {
    window.TabController.bindOnce('medicationControls', () => {
        const bindClick = (id, handler) => {
            const element = document.getElementById(id);
            if (element) element.addEventListener('click', handler);
        };

        const bindChange = (id, handler) => {
            const element = document.getElementById(id);
            if (element) element.addEventListener('change', handler);
        };

        bindChange('history-filter-med', () => loadHistory());
        bindChange('history-filter-days', () => loadHistory());

        bindClick('add-btn', () => showAddModal());
        bindClick('med-modal-cancel-btn', () => closeModal());
        bindClick('med-modal-save-btn', () => saveMedication());

        bindChange('schedule-type', () => toggleScheduleFields());
        document.querySelectorAll('.wg-meds-modal__pill').forEach((pill) => {
            pill.addEventListener('click', () => {
                const type = pill.dataset.scheduleType;
                if (type) setScheduleType(type);
            });
        });
        document.querySelectorAll('#days-container .days-select span').forEach((day) => {
            day.addEventListener('click', () => toggleDay(day));
        });

        bindClick('initial-remove-time-btn', () => {
            const button = document.getElementById('initial-remove-time-btn');
            if (button) removeTime(button);
        });
        bindClick('add-time-btn', () => addTimeInput());

        bindChange('med-track-inventory', () => toggleInventoryFields());
        bindClick('restock-add-btn', () => handleRestock());
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindMedicationControls, { once: true });
}
bindMedicationControls();

function bindMeasurementControls() {
    window.TabController.bindOnce('measurementControls', () => {
        const bindClick = (id, handler) => {
            const element = document.getElementById(id);
            if (element) element.addEventListener('click', handler);
        };

        // #add-bp-btn lives inside the dynamically-rendered #bp-range-selector
        // row (Phase 5, Task 5); its click handler is bound in renderRangeSelector.
        bindClick('bp-modal-cancel-btn', () => closeBPRecordModal());
        bindClick('add-weight-btn', () => showWeightModal());
        bindClick('weight-modal-cancel-btn', () => closeWeightModal());

        const bpForm = document.getElementById('bp-form');
        if (bpForm) {
            bpForm.addEventListener('submit', (event) => {
                handleBPSubmit(event);
            });
        }

        const weightForm = document.getElementById('weight-form');
        if (weightForm) {
            weightForm.addEventListener('submit', (event) => {
                handleWeightSubmit(event);
            });
        }
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindMeasurementControls, { once: true });
}
bindMeasurementControls();

function bindNotificationControls() {
    window.TabController.bindOnce('notificationControls', () => {
        const bindClick = (id, handler) => {
            const element = document.getElementById(id);
            if (element) element.addEventListener('click', handler);
        };


        bindClick('med-confirm-dismiss-btn', () => closeMedicationConfirmModal());
        // NOTE: the action button (med-confirm-action-btn) is intentionally NOT
        // bound here. showMedicationConfirmModal() assigns its handler per mode via
        // actionBtn.onclick (confirm → confirmSelectedMedications, edit →
        // updateIntakeHistory, log_past → confirmLogPast). A permanent
        // addEventListener('click', confirmSelectedMedications) here would double-bind
        // the button: in edit mode confirmSelectedMedications fired first, disabled the
        // button via withSubmit, and the per-mode updateIntakeHistory then bailed out of
        // its own withSubmit guard — so unchecking a taken med POSTed
        // /api/medications/confirm-schedule ("Confirmed!") instead of /api/intakes/update
        // and never reverted the dose.
        bindClick('med-confirm-snooze-btn', () => snoozeMedicationConfirm());
        bindClick('med-confirm-skip-btn', () => skipSelectedMedications());

        bindClick('workout-start-now-btn', () => startWorkoutFromModal());
        bindClick('workout-start-snooze-60-btn', () => snoozeWorkout(60));
        bindClick('workout-start-snooze-120-btn', () => snoozeWorkout(120));
        bindClick('workout-start-skip-btn', () => skipWorkout());
        bindClick('workout-start-dismiss-btn', () => closeWorkoutStartModal());
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindNotificationControls, { once: true });
}
bindNotificationControls();


function switchMedTab(tab) {
    const activated = activateTabGroup(tab, {
        buttonSelector: '.med-tab',
        contentSelector: '.med-tab-content',
        contentIdFromTab: (tabName) => `med-${tabName}-tab`
    });
    if (!activated) return;

    if (typeof syncMedsSubTabActiveClass === 'function') syncMedsSubTabActiveClass(tab);
    if (typeof setActiveMedsSubTab === 'function') setActiveMedsSubTab(tab);

    if (tab === 'schedule') { loadMeds(); }
    else if (tab === 'history') { loadHistory(); }
    else if (tab === 'upcoming') {
        if (typeof loadUpcoming === 'function') loadUpcoming();
    }
    else if (tab === 'inventory') {
        if (typeof loadInventory === 'function') loadInventory();
    }
}

bindTabGroup({
    container: document.querySelector('.med-tabs'),
    buttonSelector: '.med-tab',
    onTabSelect: switchMedTab
});

// The Settings view — loadSettings(),
// updateFeatureToggles(), updateFoodTargetsVisibility(), toggleFeatureSetting(),
// and updateFeatureTabVisibility() — moved to features/settings.js (Plan
// 2026-06-10 finish-app-js-split, Task 2). They remain reachable as the original
// bare globals (window.loadSettings / window.toggleFeatureSetting /
// window.updateFeatureTabVisibility …): switchTab/reloadCurrentTab call
// loadSettings(), the feature-toggle change handlers above call
// toggleFeatureSetting(), loadInitData()/auth-bootstrap.js call
// updateFeatureTabVisibility(), all resolved at call time. The weight-unit
// (kg/lb) state machine lives in features/weight-unit-state.js.

let pendingRefreshReason = null;
let refreshDebounceTimer = null;

function getRefreshBanner() {
    let banner = document.getElementById('data-refresh-banner');
    if (banner) return banner;

    banner = document.createElement('div');
    banner.id = 'data-refresh-banner';
    banner.className = 'data-refresh-banner hidden';

    const message = document.createElement('span');
    message.textContent = 'New data is available.';

    const refreshButton = document.createElement('button');
    refreshButton.type = 'button';
    refreshButton.textContent = 'Refresh';
    refreshButton.addEventListener('click', applyPendingTabRefresh);

    banner.appendChild(message);
    banner.appendChild(refreshButton);
    document.body.appendChild(banner);
    return banner;
}

function showRefreshBanner() {
    getRefreshBanner().classList.remove('hidden');
}

function hideRefreshBanner() {
    const banner = document.getElementById('data-refresh-banner');
    if (banner) banner.classList.add('hidden');
}

function isEditingNow() {
    const activeElement = document.activeElement;
    if (!activeElement) return false;

    if (activeElement.isContentEditable) return true;
    const tagName = activeElement.tagName;
    return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
}

function hasOpenModal() {
    const modalCandidates = document.querySelectorAll('[id$="-modal"]');
    return Array.from(modalCandidates).some((el) => {
        if (!el || el.classList.contains('hidden')) {
            return false;
        }
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
    });
}

function isSafeToAutoRefresh() {
    return !document.hidden && !isEditingNow() && !hasOpenModal();
}

function applyPendingTabRefresh() {
    pendingRefreshReason = null;
    hideRefreshBanner();
    reloadCurrentTab();
}

function requestTabRefresh(meta = {}) {
    const source = meta?.source || 'changes';
    // Optimistic / commit / rollback paths originate from the caller's own
    // write flow. The user is actively engaged with the app — no deferred
    // banner. Re-render the current tab immediately from the freshly-written
    // optimistic cache. fetchFresh suppresses concurrent GETs during the
    // optimistic window (see DataStore.fetchFresh's pendingOptimistic check)
    // so the user sees only optimistic → real, no stale flash.
    if (typeof source === 'string' && source.startsWith('optimistic')) {
        reloadCurrentTab();
        return;
    }
    // `self-echo` is the echo of one of the user's own recent writes.
    // The optimistic-commit path has already painted authoritative state;
    // an echo must never
    // surface a "New data is available" banner because the user is the
    // source. If the page is safe to refresh, reconcile now; otherwise
    // silently drop the reload — the next loadX() will fetch fresh.
    if (source === 'self-echo') {
        if (isSafeToAutoRefresh()) {
            reloadCurrentTab();
        }
        return;
    }
    if (!isSafeToAutoRefresh()) {
        console.log('[refresh] deferred: source=%s modal=%s editing=%s hidden=%s tags=%o',
            source, hasOpenModal(), isEditingNow(), document.hidden,
            meta?.changedTags || []);
        pendingRefreshReason = source;
        showRefreshBanner();
        return;
    }

    if (refreshDebounceTimer) {
        clearTimeout(refreshDebounceTimer);
    }
    refreshDebounceTimer = setTimeout(() => {
        refreshDebounceTimer = null;
        reloadCurrentTab();
    }, 500);
}

window.requestTabRefresh = requestTabRefresh;

document.addEventListener('visibilitychange', () => {
    if (document.hidden || !pendingRefreshReason) return;
    if (!isSafeToAutoRefresh()) return;
    applyPendingTabRefresh();
});

// Reload current active tab data.
function reloadCurrentTab() {
    let tab = window.AppStore && window.AppStore.get && window.AppStore.get('currentTab');
    if (!tab) {
        const activeView = document.querySelector('.view.active');
        if (!activeView) return;
        tab = activeView.id.replace(/-view$/, '');
    }

    if (tab === 'meds') {
        const activeMedTab = document.querySelector('.med-tab.active');
        const medTab = activeMedTab ? activeMedTab.dataset.tab : 'schedule';
        if (medTab === 'history') { loadHistory(); }
        else if (medTab === 'inventory') {
            if (typeof loadInventory === 'function') loadInventory();
        }
        else { loadMeds(); }
    } else if (tab === 'bp') { loadBPReadings(); }
    else if (tab === 'weight') { loadWeightLogs(); }
    else if (tab === 'workouts') { loadWorkouts(); }
    else if (tab === 'food') { loadFoodLogs(); }
    else if (tab === 'today') { loadToday(); }
    else if (tab === 'journey') { if (window.Gamification) window.Gamification.load(); }
    else if (tab === 'health') {
        const stored = typeof getActiveHealthSubTab === 'function' ? getActiveHealthSubTab() : 'overview';
        switchHealthTab(stored);
    }
    else if (tab === 'settings') { loadSettings(); }
}

// Expose for sync manager
window.reloadCurrentTab = reloadCurrentTab;

// refreshMedsAfterMutation, the medication add modal + form helpers
// (showAddModal / setMedModalHeader / closeModal / toggleScheduleFields /
// addTimeInput / toggleInventoryFields / loadRestockHistory / isLowOnStock …),
// the Meds → History load + next-intake card (loadHistory /
// renderNextIntakeTrigger / triggerNextIntake) moved to
// features/meds-history.js (Plan 2026-06-10 finish-app-js-split, Task 1).
// Init
// loadMeds() removed to avoid redundant call. It is called by checkAuth -> switchTab.


/* Push Notification Modals */

function handlePushAction(action, params) {
    if (action === 'medication_confirm') {
        const ids = params.get('ids') ? params.get('ids').split(',').map(Number) : [];
        const names = params.get('names') ? params.get('names').split(',') : [];
        const scheduled = params.get('scheduled');
        const intakeIds = params.get('intake_ids') ? params.get('intake_ids').split(',').map(Number) : [];

        setTimeout(() => {
            showMedicationConfirmModal(ids, names, scheduled, 'confirm', intakeIds);
        }, 500);
    } else if (action === 'workout_start') {
        // Coerce to Number — cached workout_next.session.id is numeric, and
        // the optimistic snooze/skip mutators compare via strict equality.
        const raw = params.get('session_id');
        const parsed = Number(raw);
        const sessionId = Number.isFinite(parsed) ? parsed : raw;
        setTimeout(() => {
            showWorkoutStartModal(sessionId);
        }, 500);
    }
}

// pendingMedConfirmIds / pendingMedConfirmScheduled / pendingWorkoutSessionId
// / pendingMedConfirmMode / pendingMedConfirmIntakeIds live in
// features/push-modal.js as closure-private fields on window.PushModalState
// (Plan 2026-05-13, Task 4). The "at most one push modal open at a time"
// invariant is enforced by the openMedConfirm / openWorkoutStart API.

// showMedicationConfirmModal() moved to features/meds.js (Phase 5 Task 1)

// closeMedicationConfirmModal, the optimistic history-cache helpers
// (_applyOptimisticHistoryFlip / _applyOptimisticNextIntakeClear /
// _applyOptimisticHistoryAdd / _commit/_rollbackOptimistic), and the
// confirm/skip/edit/log-past handlers (confirmSelectedMedications,
// skipSelectedMedications, updateIntakeHistory, confirmLogPast,
// snoozeMedicationConfirm) moved to features/meds-history.js (Plan
// 2026-06-10 finish-app-js-split, Task 1).

// showWorkoutStartModal, closeWorkoutStartModal, startWorkoutFromModal,
// snoozeWorkout, skipWorkout, skipWorkoutFromModal moved to
// features/workout/modals.js (Plan 2026-06-10 finish-app-js-split, Task 4).
// The workout-start modal buttons are still bound here in
// bindNotificationControls via call-time arrow wrappers, and handlePushAction
// (above) still opens the modal — both resolve the moved globals at call time.

window.saveTabOrder = async function(order) {
    if (!Array.isArray(order)) return;

    const res = await apiCall('/api/settings/tab-order', 'POST', { order });
    if (res) {
        persistTabOrder(order);
        if (window.DataStore) {
            const cached = await window.DataStore.getCached('settings_bundle');
            if (cached) {
                cached.tabOrder = order;
                await window.DataStore.setCached('settings_bundle', cached);
            }
        }
    }
};

// Modal back-gesture integration lives in features/modal-history.js.

// Health Overview + Diary Notes flow live in features/health.js.
