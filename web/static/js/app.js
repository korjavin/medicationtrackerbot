// Bootstrap the messenger host (Telegram WebApp ready/expand, or no-op in a
// plain browser). MessengerAdapter is set synchronously at the top of
// core/messenger-adapter.js so this never null-checks. init() resolves once
// the host is ready; its side-effects (ready/expand for Telegram) run
// synchronously inside the executor so subsequent reads see the live state.
window.MessengerAdapter.init();

// Config — identityToken() returns the Telegram initData string in a Mini App,
// null in a plain browser (cookie-only auth path).
const userInitData = window.MessengerAdapter.identityToken() || null;
window.userInitData = userInitData;
var initialAuthLoad = false;

// Hot-cache reload case: the SW controller may already be active by the time
// this script runs (before app-shell.js registers its load handler). Post the
// auth token directly so notification handlers can authenticate immediately;
// app-shell.js will also re-post on registration & controllerchange.
if (userInitData && navigator.serviceWorker && navigator.serviceWorker.controller) {
    try {
        navigator.serviceWorker.controller.postMessage({
            type: 'SET_AUTH_TOKEN',
            token: userInitData,
        });
    } catch (err) {
        console.log('SW token post failed:', err);
    }
}

// Auth-cache constants and helpers are defined in features/auth-flow.js.
// checkAuth() (below) calls saveAuthState / getCachedAuthState / clearAuthState
// by name; those names resolve to the window-scoped definitions from auth-flow.js
// which is always loaded before checkAuth() is ever invoked.

if (!window.DataStore) {
    throw new Error('DataStore is not available. Ensure data-store.js loads before app.js');
}

window.onDataStoreUnauthorized = function () {
    if (sessionStorage.getItem('medtracker_auth_reload_in_progress') === '1') {
        return;
    }
    sessionStorage.setItem('medtracker_auth_reload_in_progress', '1');
    clearAuthState();
    if (window.SyncDebug) {
        window.SyncDebug.warn('Auth expired during changes sync');
    }
    window.location.reload();
};

// cacheApiSnapshot, normalizeSettingsBundle, applyBootstrapPayload,
// verifyAuthInBackground, clearSwBootstrapCache, bootstrapURL,
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

// Check Auth Environment
async function checkAuth() {
    // Preflight Dexie hydration runs before any bootstrap fetch so a
    // relaunch-while-offline already has the meds list in DataStore by the
    // time the first switchTab() / Today tile / loadMeds() reads it.
    await hydrateMedicationsFromDexie();
    await hydrateSectionsFromDexie();

    if (userInitData) {
        // We are in Telegram, proceed as normal
        sessionStorage.removeItem('medtracker_auth_reload_in_progress');
        saveAuthState('telegram');
        const bootstrap = await apiCall(bootstrapURL(), 'GET');
        if (bootstrap) {
            await applyBootstrapPayload(bootstrap);
        } else {
            await loadInitData();
            // Both bootstrap and /api/init failed — hydrate features from the
            // cached settings_bundle so the start_param BP/weight deep-link
            // guard sees real flags instead of defaulting to ON and bypassing
            // the user's disabled-feature preference when the backend is down.
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

    // Not in Telegram. Check cached auth state first (for offline support)
    const cachedAuth = getCachedAuthState();

    // Fast path: if we have cached auth and SW is active, fetch bootstrap
    // and auth status in parallel. The SW may serve a cached bootstrap
    // (stale-while-revalidate), so we must verify the session is still valid
    // before rendering to prevent briefly showing another user's cached data.
    if (cachedAuth && cachedAuth.authenticated && navigator.serviceWorker && navigator.serviceWorker.controller) {
        console.log('[Auth] Cached auth + active SW — verifying session');
        let rendered = false;
        let hardAuthReject = false;
        try {
            // Parallel fetch: bootstrap (may come from SW cache) + auth check
            const [bootstrapRes, authRes] = await Promise.all([
                fetch(bootstrapURL(), { method: 'GET', credentials: 'same-origin' }),
                fetch('/auth/status', { method: 'GET', credentials: 'same-origin' })
                    .catch(() => null) // Network error — treat as offline
            ]);

            // Check auth status first — if session is invalid, don't render cached data
            if (authRes && authRes.status === 200) {
                const authData = await authRes.json();
                if (!authData.authenticated) {
                    hardAuthReject = true;
                }
            } else if (authRes && authRes.status < 500) {
                // 4xx — definitive auth rejection
                hardAuthReject = true;
            }
            // authRes null (network error) or 5xx — server unreachable, allow cached render

            if (!hardAuthReject && bootstrapRes.status === 200) {
                const data = await bootstrapRes.json();
                await applyBootstrapPayload(data);
                sessionStorage.removeItem('medtracker_auth_reload_in_progress');
                saveAuthState('cookie');
                rendered = true;
            } else if (bootstrapRes.status === 401 || bootstrapRes.status === 403) {
                hardAuthReject = true;
            }
        } catch (_) {
            // Network error on bootstrap — fall through to cache-only path below
        }

        if (hardAuthReject) {
            console.log('[Auth] Session invalid — clearing cache');
            clearAuthState();
            await clearSwBootstrapCache();
            // Fall through to blocking auth flow below
        } else {
            if (!rendered) {
                // SW cache miss or network error — load from IndexedDB cache directly
                if (window.MedTrackerDB && window.MedTrackerDB.MedicationStore) {
                    const cached = await window.MedTrackerDB.MedicationStore.getCache();
                    if (cached) {
                        medications = cached;
                        initialAuthLoad = true;
                    }
                }
                if (window.DataStore) {
                    const cachedBundle = await window.DataStore.getCached('settings_bundle');
                    if (cachedBundle) {
                        hydrateFeatureSettingsFromBundle(cachedBundle);
                    }
                }
                sessionStorage.removeItem('medtracker_auth_reload_in_progress');
            }

            // Continue verifying in background for long-running sessions
            verifyAuthInBackground();
            return true;
        }
    }

    // No cached auth or no SW — blocking auth flow (first visit or cache cleared)
    let serverUnavailable = false;
    let hasSessionCookie = false;
    try {
        const authStatusRes = await fetch('/auth/status', {
            method: 'GET',
            credentials: 'same-origin'
        });
        if (authStatusRes.status === 200) {
            const authStatus = await authStatusRes.json();
            hasSessionCookie = !!authStatus.authenticated;
            if (!hasSessionCookie) {
                clearAuthState();
            }
        } else if (authStatusRes.status >= 500) {
            console.log('[Auth] Auth status error', authStatusRes.status, '- will try cached auth');
            serverUnavailable = true;
        } else {
            clearAuthState();
        }
    } catch (e) {
        console.log("[Auth] Network check failed:", e);
        serverUnavailable = true;
    }

    if (hasSessionCookie) {
        try {
            const res = await fetch(bootstrapURL(), { method: 'GET' });
            if (res.status === 200) {
                const data = await res.json();
                await applyBootstrapPayload(data);
                sessionStorage.removeItem('medtracker_auth_reload_in_progress');
                saveAuthState('cookie');

                return true;
            } else if (res.status === 401 || res.status === 403) {
                clearAuthState();
            } else if (res.status >= 500) {
                console.log('[Auth] Server error', res.status, '- will try cached auth');
                serverUnavailable = true;
            }
        } catch (e) {
            console.log("[Auth] Bootstrap failed:", e);
            serverUnavailable = true;
        }
    }

    // Server unavailable or network error — use cached auth if available
    if (serverUnavailable && cachedAuth && cachedAuth.authenticated) {
        console.log('[Auth] Server unavailable, using cached auth state');
        sessionStorage.removeItem('medtracker_auth_reload_in_progress');

        // Load medications from cache for offline use
        if (window.MedTrackerDB && window.MedTrackerDB.MedicationStore) {
            const cached = await window.MedTrackerDB.MedicationStore.getCache();
            if (cached) {
                console.log('[Auth] Loaded medications from cache:', cached.length);
                medications = cached;
                initialAuthLoad = true;
            }
        }

        if (window.DataStore) {
            const cachedBundle = await window.DataStore.getCached('settings_bundle');
            if (cachedBundle) {
                hydrateFeatureSettingsFromBundle(cachedBundle);
            }
        }

        return true; // Trust cached state when server is down
    }

    // Not authorized and no valid cache. Show login options
    const loginContainer = document.createElement('div');
    loginContainer.className = 'login-container';

    // Check if we're offline
    const isOffline = !navigator.onLine;

    if (isOffline) {
        // Show offline message instead of login widgets
        const title = document.createElement('h2');
        title.innerText = "Offline";
        title.className = 'login-title';
        loginContainer.appendChild(title);

        const message = document.createElement('p');
        message.appendChild(document.createTextNode("You need an internet connection to log in for the first time."));
        message.appendChild(document.createElement('br'));
        message.appendChild(document.createElement('br'));
        message.appendChild(document.createTextNode("If you have logged in before, your session will be available once you're back online."));
        message.className = 'login-message';
        loginContainer.appendChild(message);

        // Retry button
        const retryBtn = document.createElement('button');
        retryBtn.innerText = "Retry";
        retryBtn.onclick = () => location.reload();
        retryBtn.className = 'btn btn-primary btn-lg mt-sm';
        loginContainer.appendChild(retryBtn);

        // Listen for online event to auto-retry
        window.addEventListener('online', () => {
            console.log('[Auth] Back online, reloading...');
            location.reload();
        });
    } else {
        // Normal login page with standalone login options
        const title = document.createElement('h2');
        title.innerText = "Login to Med Tracker";
        title.className = 'login-title';
        loginContainer.appendChild(title);

        const tgWidgetContainer = document.createElement('div');
        tgWidgetContainer.id = 'telegram-login-container';
        tgWidgetContainer.className = 'login-tg-container';

        const rawBotUsername = typeof window['BOT_USERNAME'] === 'string' ? window['BOT_USERNAME'].trim() : '';
        const botUsername = rawBotUsername.replace(/^@+/, '');
        if (botUsername) {
            // Telegram Login Widget in redirect mode (no unsafe-eval needed)
            const tgScript = document.createElement('script');
            tgScript.async = true;
            tgScript.src = 'https://telegram.org/js/telegram-widget.js?22';
            tgScript.setAttribute('data-telegram-login', botUsername);
            tgScript.setAttribute('data-size', 'large');
            tgScript.setAttribute('data-auth-url', window.location.origin + '/auth/telegram/callback');
            tgScript.setAttribute('data-request-access', 'write');
            tgWidgetContainer.appendChild(tgScript);

            // Fallback link for users who prefer the native app
            const tgLink = document.createElement('a');
            tgLink.href = `https://t.me/${encodeURIComponent(botUsername)}`;
            tgLink.target = '_blank';
            tgLink.rel = 'noopener noreferrer';
            tgLink.textContent = "Open in Telegram";
            tgLink.className = 'login-tg-link';
            tgWidgetContainer.appendChild(tgLink);
        } else {
            const hint = document.createElement('p');
            hint.textContent = 'Use the Telegram app to open the bot and launch the web app.';
            hint.className = 'login-tg-hint';
            tgWidgetContainer.appendChild(hint);
        }

        loginContainer.appendChild(tgWidgetContainer);

        const oidcConfig = window.OIDC_CONFIG || { enabled: false };
        if (oidcConfig.enabled) {
            // Divider
            const divider = document.createElement('div');
            divider.className = 'login-divider';
            const line1 = document.createElement('span');
            line1.className = 'login-divider-line';
            const textSpan = document.createElement('span');
            textSpan.textContent = "or";
            const line2 = document.createElement('span');
            line2.className = 'login-divider-line';
            divider.appendChild(line1);
            divider.appendChild(textSpan);
            divider.appendChild(line2);
            loginContainer.appendChild(divider);

            // OIDC login button
            const oidcBtn = document.createElement('button');
            oidcBtn.innerText = oidcConfig.label || "Login";
            oidcBtn.onclick = () => window.location.href = (oidcConfig.loginUrl || "/auth/oidc/login");
            oidcBtn.className = 'btn btn-lg btn-oidc';
            if (oidcConfig.buttonColor) {
                oidcBtn.style.setProperty('--_oidc-bg', oidcConfig.buttonColor);
            }
            if (oidcConfig.buttonText) {
                oidcBtn.style.setProperty('--_oidc-text', oidcConfig.buttonText);
            }
            loginContainer.appendChild(oidcBtn);

            // Setup helper link
            const setupLink = document.createElement('a');
            setupLink.href = '/oidc-setup';
            setupLink.innerText = 'Need setup info?';
            setupLink.className = 'login-setup-link';
            loginContainer.appendChild(setupLink);
        }
    }

    document.body.replaceChildren();
    document.body.appendChild(loginContainer);

    return false;
}

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

window.initOIDCSetupBanner = initOIDCSetupBanner;

// Bootstrap orchestration lives in features/bootstrap.js (loaded after all feature scripts).

async function sendTestBPNotification() {
    const res = await apiCall('/api/bp/reminder/test', 'POST');
    if (res) {
        safeAlert("Notification sent! Check your device.");
    }
}

// Settings Toggle Handler
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

document.getElementById('webpush-toggle').addEventListener('change', async function () {
    const status = document.getElementById('webpush-status');
    if (!status) return;

    if (this.checked) {
        applyWebpushStatus(status, 'Requesting permission...', null);
        const success = await window.MedTrackerPush.subscribe();
        if (success) {
            applyWebpushStatus(status, 'Notifications enabled', 'success');
        } else {
            applyWebpushStatus(status, 'Failed to enable notifications. Please check permissions.', 'error');
            this.checked = false;
        }
    } else {
        const success = await window.MedTrackerPush.unsubscribe();
        if (success) {
            applyWebpushStatus(status, 'Notifications disabled', 'muted');
        } else {
            applyWebpushStatus(status, 'Failed to disable notifications', 'error');
            this.checked = true; // revert
        }
    }

    setTimeout(() => hideWebpushStatus(status), 3000);
});

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

document.getElementById('medication-feature-toggle').addEventListener('change', async function () {
    await toggleFeatureSetting('medication', this.checked);
});

document.getElementById('workout-feature-toggle').addEventListener('change', async function () {
    await toggleFeatureSetting('workout', this.checked);
});

document.getElementById('save-food-targets-btn').addEventListener('click', async function () {
    await saveFoodTargets();
});

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
        workouts: 'workout'
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
    try { window.localStorage.setItem('mt-active-tab', tab); } catch (_) {}
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
    else if (tab === 'settings') { loadSettings(); }
}

let todayUnsubscribe = null;
let todayRefreshInFlight = false;

function todayFoodKey(nowDate) {
    const d = nowDate || new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `food_${y}-${m}-${day}_day`;
}

// /api/medications/next-intake returns 204 No Content when no dose is upcoming;
// apiCall coerces that into boolean `true`. Map it to an explicit empty-state
// object so fetchFresh caches the authoritative "no upcoming" result. Without
// this, a previously-cached reminder whose scheduled time drifted into the
// past (no change event fired — wall-clock time alone doesn't invalidate)
// would keep rendering in Today and the History trigger indefinitely.
// Both renderNextIntakeTrigger and today.js nextMedCell treat a falsy
// scheduled_at as "missing", so the empty-state sentinel renders as no card.
async function fetchNextIntakePayload() {
    const res = await apiCall('/api/medications/next-intake');
    if (res === true) return { scheduled_at: null, medication_names: [] };
    return res && typeof res === 'object' ? res : null;
}

// next_intake freshness windows: revalidate after 5 min so the card cannot lag
// the schedule by more than a few minutes online; treat anything beyond 12 h
// as "stale" for the offline badge tone (longer than that and the schedule
// itself may no longer match reality after a TZ change or course edit).
const NEXT_INTAKE_FRESH_AFTER_MS = 5 * 60 * 1000;
const NEXT_INTAKE_STALE_AFTER_MS = 12 * 60 * 60 * 1000;

// Read-through wrapper for the Next Medication tile. Returns the same payload
// shape as fetchNextIntakePayload plus { fetchedAt, isFromCache, isStale } so
// Today can attach freshness metadata to the rendered cell. When cachedFetch
// is unavailable (e.g. tests that didn't load it) or throws OfflineNoCacheError,
// resolves to null so callers can fall back to the existing render path.
async function loadNextIntakeCached() {
    if (typeof window.cachedFetch !== 'function') {
        const data = await fetchNextIntakePayload();
        return data == null ? null : { data, fetchedAt: Date.now(), isFromCache: false, isStale: false };
    }
    try {
        const result = await window.cachedFetch('next_intake', '/api/medications/next-intake', {
            tags: ['history', 'medications'],
            freshAfterMs: NEXT_INTAKE_FRESH_AFTER_MS,
            staleAfterMs: NEXT_INTAKE_STALE_AFTER_MS,
            transform: (raw) => {
                if (raw === true) return { scheduled_at: null, medication_names: [] };
                return raw && typeof raw === 'object' ? raw : null;
            }
        });
        return result;
    } catch (err) {
        if (window.OfflineNoCacheError && err instanceof window.OfflineNoCacheError) {
            return null;
        }
        throw err;
    }
}

// Returns a timezone-qualified DataStore key for health overview so that a
// cached response from a prior timezone is never served as though it were
// current. The in-memory swrCaches object always uses the fixed property name
// 'health_overview'; only the IndexedDB key is qualified.
function healthOverviewCacheKey() {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz ? `health_overview_${tz}` : `health_overview_offset_${new Date().getTimezoneOffset()}`;
}
window.healthOverviewCacheKey = healthOverviewCacheKey;

// Fetchers for every key Today reads from IndexedDB. Calling fetchFresh with
// these tags both populates the cache and registers the key→tag mapping, so
// future applyChangesPayload invalidations can evict the entry.
function todayFetchSpecs(foodKey) {
    return {
        settings_bundle: {
            feature: null,
            tags: ['settings', 'food_targets', 'feature_settings'],
            fetch: fetchSettingsBundle
        },
        next_intake: {
            feature: 'medication',
            tags: ['history', 'medications'],
            fetch: fetchNextIntakePayload
        },
        bp: {
            feature: 'bp',
            tags: ['bp'],
            fetch: async () => {
                const [r, g, s] = await Promise.allSettled([
                    apiCall('/api/bp?days=60'),
                    apiCall('/api/bp/goal'),
                    apiCall('/api/bp/stats')
                ]);
                const readingsRes = r.status === 'fulfilled' ? r.value : null;
                const goalRes = g.status === 'fulfilled' ? g.value : null;
                const statsRes = s.status === 'fulfilled' ? s.value : null;
                if (readingsRes === null) return null;
                return { readingsRes, goalRes, statsRes };
            }
        },
        weight: {
            feature: 'weight',
            tags: ['weight'],
            fetch: async () => {
                const [l, g] = await Promise.allSettled([
                    apiCall('/api/weight?days=0&limit=1000'),
                    apiCall('/api/weight/goal')
                ]);
                const logsRes = l.status === 'fulfilled' ? l.value : null;
                const goalRes = g.status === 'fulfilled' ? g.value : null;
                if (logsRes === null) return null;
                return { logsRes, goalRes };
            }
        },
        workout_next: {
            feature: 'workout',
            tags: ['workout'],
            // Use apiCallDirect (which throws on error) so a legitimate null
            // server response ("no next workout") is distinguishable from a
            // transient failure. Only the former is cached as `{session: null}`;
            // errors return null so fetchFresh leaves the existing cache alone
            // and Today retries on the next visit.
            fetch: async () => {
                if (!window.apiCallDirect) return null;
                try {
                    const res = await window.apiCallDirect('/api/workout/sessions/next');
                    return res === null ? { session: null } : res;
                } catch (_e) {
                    return null;
                }
            }
        },
        [healthOverviewCacheKey()]: {
            feature: 'health',
            tags: ['health'],
            fetch: () => {
                const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone;
                const tzOffset = new Date().getTimezoneOffset();
                const tzParams = tzName
                    ? `?tz=${encodeURIComponent(tzName)}`
                    : `?tz_offset=${tzOffset}`;
                return apiCall(`/api/health/overview${tzParams}`, 'GET');
            }
        },
        [foodKey]: {
            feature: 'food',
            tags: ['food'],
            fetch: async () => {
                const dateStr = foodKey.replace(/^food_/, '').replace(/_day$/, '');
                const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone;
                const tzOffset = new Date(`${dateStr}T00:00:00`).getTimezoneOffset();
                const tzParams = tzName
                    ? `&tz=${encodeURIComponent(tzName)}`
                    : `&tz_offset=${tzOffset}`;
                const groups = await apiCall(`/api/food/log?date=${dateStr}${tzParams}`, 'GET');
                return { groups: groups || [] };
            }
        }
    };
}

// Shared settings-bundle fetcher — used by loadSettings() and Today's refetch
// loop so that invalidations of `settings_bundle` re-hydrate food_targets and
// cross-device feature flags even when the user never opens the Settings tab.
async function fetchSettingsBundle() {
    const [featureSettingsRes, foodTargetsRes, bpReminderStatus, weightReminderStatus, settingsRes] = await Promise.all([
        apiCall('/api/settings/features', 'GET'),
        apiCall('/api/food/settings/targets', 'GET'),
        apiCall('/api/bp/reminder/status', 'GET'),
        apiCall('/api/weight/reminder/status', 'GET'),
        apiCall('/api/settings', 'GET')
    ]);
    // apiCall returns null on any GET failure (network, 5xx, 4xx). If every
    // endpoint failed, signal total failure so DataStore.fetchFresh does not
    // overwrite a valid cached bundle with zeroed defaults.
    if (featureSettingsRes === null && foodTargetsRes === null
        && bpReminderStatus === null && weightReminderStatus === null
        && settingsRes === null) {
        return null;
    }
    // tab_order is delivered via /api/bootstrap (no standalone GET endpoint);
    // preserve it from the existing cache so SWR re-writes don't drop the
    // user's saved Today card order. Fall back to localStorage so invalidations
    // of settings_bundle (timezone update, feature toggle, change-stream
    // 'settings' events) don't wipe tabOrder before this fetch runs.
    let tabOrder = null;
    try {
        const existing = await window.DataStore.getCached('settings_bundle');
        if (existing && Array.isArray(existing.tabOrder)) tabOrder = existing.tabOrder;
    } catch (_) { /* no cache available — leave tabOrder null */ }
    if (!tabOrder) tabOrder = readPersistedTabOrder();
    return {
        featureSettings: featureSettingsRes || {},
        tabOrder,
        timezone: settingsRes?.timezone || '',
        serverTime: settingsRes?.server_time || '',
        serverTimezone: settingsRes?.server_timezone || '',
        dismissedTzSuggestion: settingsRes?.dismissed_tz_suggestion || '',
        weightUnitPreference: settingsRes?.weight_unit_preference || window.weightUnitPreference || 'kg',
        foodTargets: {
            calories: foodTargetsRes?.calories || 0,
            carbs: foodTargetsRes?.carbs || 0,
            protein: foodTargetsRes?.protein || 0,
            fat: foodTargetsRes?.fat || 0
        },
        bpReminderStatus: bpReminderStatus || { enabled: false },
        weightReminderStatus: weightReminderStatus || { enabled: false }
    };
}

async function _todayReadCaches(foodKey) {
    const bootstrap = { features: window.featureSettings || {} };
    const swrCaches = {};
    let cardOrder = null;
    // Tracks the *most recent* write among all caches we read. The offline-stale
    // banner ("cached data is >1h old") should fire only when nothing we have
    // is fresh. Using the oldest timestamp would let a single rarely-updated
    // cache (e.g. health_overview) pin the window even after bootstrap just
    // refreshed.
    let latestCacheTimestamp = null;
    // Worst-case freshness for the section-header badge (Task 5): the oldest
    // timestamp across the caches feeding Today. The user reads it as
    // "everything you see is at least this old", which lines up with how the
    // chip is positioned at the top of the screen.
    let oldestCacheTimestamp = null;
    // latest tracks every cache we read (used for firstRun + offline-stale gates).
    // oldest skips disabled-feature caches so the badge reflects only data the
    // user can actually see; otherwise a stale cache for a disabled feature
    // (e.g. health_overview the user turned off weeks ago) would pin the chip
    // to "Updated 7d ago" even when everything visible is fresh.
    const trackTs = (ts, { includeInOldest } = { includeInOldest: true }) => {
        if (!Number.isFinite(ts)) return;
        if (latestCacheTimestamp === null || ts > latestCacheTimestamp) {
            latestCacheTimestamp = ts;
        }
        if (includeInOldest && (oldestCacheTimestamp === null || ts < oldestCacheTimestamp)) {
            oldestCacheTimestamp = ts;
        }
    };
    try {
        const cacheStore = window.MedTrackerDB?.ApiCache;
        const readMeta = cacheStore && typeof cacheStore.getWithMeta === 'function'
            ? (key) => cacheStore.getWithMeta(key).catch(() => null)
            : null;
        const hoKey = healthOverviewCacheKey();
        if (readMeta) {
            const keys = ['settings_bundle', 'next_intake', 'medications', 'bp', 'weight', 'workout_next', hoKey, foodKey];
            const metas = await Promise.all(keys.map(readMeta));
            const [bundleM, nextIntakeM, medsM, bpM, weightM, workoutM, healthM, foodM] = metas;
            if (bundleM?.data) {
                bootstrap.features = bundleM.data.featureSettings || bootstrap.features;
                bootstrap.settings = { food_targets: bundleM.data.foodTargets };
                if (Array.isArray(bundleM.data.tabOrder)) cardOrder = bundleM.data.tabOrder;
                // Hydrate the saved weight unit so cross-device/bot changes that
                // refreshed settings_bundle (without the user opening Settings)
                // are reflected in Today/Weight renderers, which read window
                // .weightUnitPreference synchronously.
                const cachedUnit = bundleM.data.weightUnitPreference;
                if (cachedUnit === 'kg' || cachedUnit === 'lb') {
                    if (window.weightUnitPreference !== cachedUnit) {
                        window.WeightUnitState.applyAuthoritative(cachedUnit);
                    }
                }
            }
            if (nextIntakeM?.data) {
                bootstrap.next_intake = nextIntakeM.data;
                if (Number.isFinite(nextIntakeM.timestamp)) {
                    bootstrap.__next_intake_meta = {
                        fetchedAt: nextIntakeM.timestamp,
                        isStale: (Date.now() - nextIntakeM.timestamp) > NEXT_INTAKE_STALE_AFTER_MS
                    };
                }
            }
            // Medications list — feeds the Today next-dose tile's offline
            // fallback when next_intake is missing or stale (the schedule
            // parser is fully client-side, so the tile can compute its own
            // upcoming dose from the cached list).
            if (Array.isArray(medsM?.data)) {
                bootstrap.medications = medsM.data;
                if (Number.isFinite(medsM.timestamp)) {
                    bootstrap.__medications_meta = {
                        fetchedAt: medsM.timestamp,
                        isStale: (Date.now() - medsM.timestamp) > NEXT_INTAKE_STALE_AFTER_MS
                    };
                }
            }
            if (bpM?.data) {
                bootstrap.bp = {
                    readings: bpM.data.readingsRes || [],
                    goal: bpM.data.goalRes || {},
                    stats: bpM.data.statsRes || {}
                };
            }
            if (weightM?.data) {
                bootstrap.weight = {
                    logs: weightM.data.logsRes || [],
                    goal: weightM.data.goalRes || {}
                };
            }
            if (workoutM?.data) swrCaches.workout_next = workoutM.data;
            if (healthM?.data) swrCaches.health_overview = healthM.data;
            if (foodM?.data) {
                const groups = Array.isArray(foodM.data.groups) ? foodM.data.groups : [];
                swrCaches.food_today = { groups };
            }
            const featuresMap = bootstrap.features || {};
            const isFeatureOn = (feature) => {
                if (!feature) return true;
                if (Object.prototype.hasOwnProperty.call(featuresMap, feature)) {
                    return !!featuresMap[feature];
                }
                return true;
            };
            const keyFeatures = {
                settings_bundle: null,
                next_intake: 'medication',
                medications: 'medication',
                bp: 'bp',
                weight: 'weight',
                workout_next: 'workout',
                [hoKey]: 'health',
                [foodKey]: 'food'
            };
            for (let i = 0; i < keys.length; i++) {
                const m = metas[i];
                if (!m) continue;
                trackTs(m.timestamp, { includeInOldest: isFeatureOn(keyFeatures[keys[i]]) });
            }
        } else if (window.DataStore && typeof window.DataStore.getCached === 'function') {
            const keys = ['settings_bundle', 'next_intake', 'medications', 'bp', 'weight', 'workout_next', hoKey, foodKey];
            const [bundle, nextIntake, meds, bp, weight, workout, health, food] = await Promise.all(
                keys.map((k) => window.DataStore.getCached(k).catch(() => null))
            );
            if (bundle) {
                bootstrap.features = bundle.featureSettings || bootstrap.features;
                bootstrap.settings = { food_targets: bundle.foodTargets };
                if (Array.isArray(bundle.tabOrder)) cardOrder = bundle.tabOrder;
                const cachedUnit = bundle.weightUnitPreference;
                if (cachedUnit === 'kg' || cachedUnit === 'lb') {
                    if (window.weightUnitPreference !== cachedUnit) {
                        window.WeightUnitState.applyAuthoritative(cachedUnit);
                    }
                }
            }
            if (nextIntake) bootstrap.next_intake = nextIntake;
            if (Array.isArray(meds)) bootstrap.medications = meds;
            if (bp) {
                bootstrap.bp = {
                    readings: bp.readingsRes || [],
                    goal: bp.goalRes || {},
                    stats: bp.statsRes || {}
                };
            }
            if (weight) {
                bootstrap.weight = {
                    logs: weight.logsRes || [],
                    goal: weight.goalRes || {}
                };
            }
            if (workout) swrCaches.workout_next = workout;
            if (health) swrCaches.health_overview = health;
            if (food) {
                const groups = Array.isArray(food.groups) ? food.groups : [];
                swrCaches.food_today = { groups };
            }
        }
    } catch (_) { /* best-effort — render whatever we have */ }
    // Register key→tag mappings for every Today cache we just read directly
    // from IndexedDB. CacheKeys.registerAll now wires the static keys at
    // boot, but this loop covers the dynamic-keyed entries built from
    // todayFetchSpecs (food/health-overview today keys) so a feature save's
    // invalidateTags(['food']) etc. evicts them even on cached-start /
    // reload paths. todayFetchSpecs owns the canonical key→tags map;
    // reusing it keeps registration in sync with fetcher tags in one place.
    if (window.DataStore && typeof window.DataStore.registerTags === 'function') {
        try {
            const specs = todayFetchSpecs(foodKey);
            for (const key of Object.keys(specs)) {
                window.DataStore.registerTags(key, specs[key].tags || []);
            }
        } catch (_) { /* best-effort — invalidation will fall back to a no-op */ }
    }
    // Fall back to localStorage so Today renders in the user's saved order
    // even if the settings_bundle cache was invalidated since last render.
    if (!cardOrder) {
        const persisted = readPersistedTabOrder();
        if (persisted) cardOrder = persisted;
    }
    return { bootstrap, swrCaches, latestCacheTimestamp, oldestCacheTimestamp, cardOrder };
}

async function _todayRender(foodKey) {
    const root = document.getElementById('today-content');
    if (!root || !window.TodayDashboard) return { rendered: false };
    const { bootstrap, swrCaches, latestCacheTimestamp, oldestCacheTimestamp, cardOrder } = await _todayReadCaches(foodKey);
    const online = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
    const nowMs = Date.now();
    // Hand the schedule helpers to the aggregator so the meds tile can compute
    // its own fallback next-dose from bootstrap.medications when next_intake is
    // missing or stale (e.g. relaunch-while-offline). Helpers live on
    // features/medication-utils.js as window.MedicationUtils.* — pass explicitly
    // to keep today.js side-effect-free for tests.
    const state = window.TodayDashboard.aggregateToday(bootstrap, swrCaches, nowMs, {
        getNextScheduledDate: window.MedicationUtils.getNextScheduledDate,
        parseMedicationSchedule: window.MedicationUtils.parseMedicationSchedule
    });
    if (latestCacheTimestamp === null) {
        // No cached entry of any kind means bootstrap has never loaded on this
        // device — show the first-run "connect to load your day" message rather
        // than a grid of empty cards. Empty but cached bootstrap (new account
        // with no data yet) still renders the grid.
        state.__firstRun = true;
    }
    if (window.TodayDashboard.isOfflineStale({ online, cacheTimestamp: latestCacheTimestamp, now: nowMs })) {
        state.__offline = true;
    }
    // The badge tone needs the raw "navigator is offline" signal so an
    // offline session with a recent cache still renders "Offline · 5m old"
    // (warning tone) instead of a neutral "Updated 5m ago" — state.__offline
    // is gated on offline+stale and is the wrong signal for that.
    if (!online) {
        state.__navigatorOffline = true;
    }
    if (oldestCacheTimestamp !== null) {
        // Worst-case freshness — read by renderToday to mount the wg-stale-badge
        // chip so the user can see how old the displayed data really is.
        state.__fetchedAt = oldestCacheTimestamp;
    }
    window.TodayDashboard.renderToday(state, root, { now: nowMs, cardOrder });
    return { rendered: true, bootstrap, swrCaches, online };
}

async function loadToday() {
    const foodKey = todayFoodKey(new Date());
    const ctx = await _todayRender(foodKey);
    if (!ctx.rendered) return;

    if (!todayUnsubscribe && typeof window.TodayDashboard.subscribe === 'function') {
        todayUnsubscribe = window.TodayDashboard.subscribe({
            onRefresh: (payload) => {
                // 'bootstrap' and 'datastore' sources already trigger reloadCurrentTab
                // via the app-level BOOTSTRAP_UPDATED handler and DataStore's
                // window.requestTabRefresh call; re-invoking loadToday() here would
                // render twice and bypass the modal/editing deferral done by the
                // debounced app-level path. Keep 'online'/'offline' so the offline
                // banner updates without waiting for a data change.
                const source = payload && payload.source;
                if (source === 'bootstrap' || source === 'datastore') return;
                if (window.AppStore && window.AppStore.get('currentTab') === 'today') {
                    loadToday();
                }
            }
        });
    }

    // Refetch any cache that's missing — e.g. just evicted by a change poll.
    // Without this, a local mutation that clears next_intake would leave Today
    // showing "missing" until the user navigates away and back. fetchFresh
    // also registers tags so future invalidations work correctly.
    if (!ctx.online || todayRefreshInFlight || !window.DataStore) return;
    const specs = todayFetchSpecs(foodKey);
    todayRefreshInFlight = true;
    let bootstrap = ctx.bootstrap;
    let swrCaches = ctx.swrCaches;
    try {
        // Phase 1: if the settings bundle was invalidated (e.g. a cross-device
        // feature flip just came through the change stream), refresh it first
        // so Phase 2 sees the freshly-enabled features. Without this, a
        // false→true flip renders the newly-visible card as empty until a
        // second loadToday() pass fetches its data.
        if (!bootstrap.settings) {
            await window.DataStore.fetchFresh(
                'settings_bundle',
                specs.settings_bundle.fetch,
                specs.settings_bundle.tags
            ).catch(() => {});
            const refreshed = await _todayReadCaches(foodKey);
            bootstrap = refreshed.bootstrap;
            swrCaches = refreshed.swrCaches;
        }

        // Prefer the per-render features map (sourced from cached settings_bundle)
        // over the in-memory featureSettings global. On cached-start / offline
        // boot paths, featureSettingsLoaded is false but cached features still
        // tell us which cards Today will omit — without this, we'd refetch
        // disabled bp/food/workout/health caches even though their cards aren't
        // rendered.
        const renderFeatures = (bootstrap && bootstrap.features) || null;
        const isFeatureDisabled = (feature) => {
            if (!feature) return false;
            if (renderFeatures && Object.prototype.hasOwnProperty.call(renderFeatures, feature)) {
                return !renderFeatures[feature];
            }
            if (window.featureSettingsLoaded) {
                return !window.featureSettings[feature];
            }
            return false;
        };
        // Treat the `{ scheduled_at: null }` empty-state sentinel as "missing"
        // for presence. The endpoint's 12-hour window is wall-clock-based, so a
        // dose that started >12h away can drift into the window with no change
        // event firing — relying on cached sentinel presence alone would keep
        // the card hidden indefinitely until some unrelated invalidation ran.
        const hoKey = healthOverviewCacheKey();
        const presence = {
            bp: !!bootstrap.bp,
            weight: !!bootstrap.weight,
            workout_next: !!swrCaches.workout_next,
            [hoKey]: !!swrCaches.health_overview,
            [foodKey]: !!swrCaches.food_today
        };
        const missing = Object.keys(presence).filter((k) => {
            if (presence[k]) return false;
            const spec = specs[k];
            if (!spec) return false;
            // Skip fetches for features the user has disabled — Today omits those
            // cards entirely, so hitting the endpoint would be wasted work.
            if (isFeatureDisabled(spec.feature)) return false;
            return true;
        });
        // Food can be written from outside this client (Telegram /food and /intake
        // commands), and bootstrap advances the change cursor without including
        // today's food log payload — so a bot write between sessions leaves a
        // stale `food_<date>_day` cache that the change-poll never invalidates.
        // Always refetch food while Today is mounted so calories stay in sync
        // with the Food section (which already does true SWR).
        if (!missing.includes(foodKey) && specs[foodKey] && !isFeatureDisabled(specs[foodKey].feature)) {
            missing.push(foodKey);
        }
        // next_intake goes through cachedFetch so the helper's SWR window
        // (5 min) handles wall-clock drift without forcing a network call on
        // every render. cachedFetch returns cached instantly when fresh and
        // background-revalidates; on offline / 5xx it keeps cached.
        const nextIntakePromise = isFeatureDisabled('medication')
            ? Promise.resolve(null)
            : loadNextIntakeCached().catch(() => null);
        const otherFetches = missing.length > 0
            ? Promise.allSettled(missing.map((k) => window.DataStore.fetchFresh(k, specs[k].fetch, specs[k].tags)))
            : Promise.resolve([]);
        await Promise.all([nextIntakePromise, otherFetches]);
    } finally {
        todayRefreshInFlight = false;
    }
    if (window.AppStore && window.AppStore.get('currentTab') === 'today') {
        await _todayRender(foodKey);
    }
}

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

        bindClick('test-med-notification-btn', () => sendTestMedicationNotification());
        bindClick('test-bp-notification-btn', () => sendTestBPNotification());

        bindClick('med-confirm-dismiss-btn', () => closeMedicationConfirmModal());
        bindClick('med-confirm-action-btn', () => confirmSelectedMedications());
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
    else if (tab === 'inventory') {
        if (typeof loadInventory === 'function') loadInventory();
    }
}

bindTabGroup({
    container: document.querySelector('.med-tabs'),
    buttonSelector: '.med-tab',
    onTabSelect: switchMedTab
});

// Load settings (BP reminders status, etc.)
async function loadSettings() {
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
}

// The weight-unit (kg/lb) preference state machine — the PATCH serial queue,
// the optimistic-rollback baseline, the stale-hydration guard, and the
// segmented-toggle DOM helper — lives in features/weight-unit-state.js.
// app.js delegates via window.WeightUnitState (commit/apply/setPreference);
// window.commitAuthoritativeWeightUnit and window.setWeightUnitPreference
// remain as backwards-compatible shims for features/weight.js and tests.

function updateFoodTargetsVisibility() {
    const settingsBlock = document.getElementById('food-target-settings');
    if (!settingsBlock) return;
    settingsBlock.style.display = window.featureSettings.food ? 'flex' : 'none';
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
        workouts: 'workout'
    };

    const currentTab = window.AppStore && window.AppStore.get('currentTab');
    const currentFeature = tabToFeature[currentTab];
    if (currentFeature && !window.featureSettings[currentFeature]) {
        switchTab('today');
    }
    updateFoodTargetsVisibility();
}

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
    // write flow — they already repainted directly via cache writes and the
    // `datastore:changed` listener. The deferred-banner UX exists for
    // cross-device polling updates and isn't appropriate here.
    if (typeof source === 'string' && source.startsWith('optimistic')) {
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
    else if (tab === 'health') {
        const stored = typeof getActiveHealthSubTab === 'function' ? getActiveHealthSubTab() : 'overview';
        switchHealthTab(stored);
    }
    else if (tab === 'settings') { loadSettings(); }
}

// Expose for sync manager
window.reloadCurrentTab = reloadCurrentTab;

// Refresh the meds view siblings after a mutation (confirm/skip/edit/log-past).
// loadMeds refreshes the schedule data and the `medications` array; loadHistory
// refreshes the history list. Inventory is re-rendered (after loadMeds resolves)
// only when it's the active sub-tab, so stock counts stay correct without
// burning the per-med last-refilled fetch when off-screen.
function refreshMedsAfterMutation() {
    const medsPromise = typeof loadMeds === 'function' ? loadMeds() : null;
    if (typeof loadHistory === 'function') loadHistory();
    if (medsPromise && typeof medsPromise.then === 'function') {
        medsPromise.then(() => {
            const activeMedTab = document.querySelector('.med-tab.active');
            if (activeMedTab && activeMedTab.dataset.tab === 'inventory' &&
                typeof renderInventory === 'function') {
                renderInventory();
            }
        });
    }
}


function showAddModal() {
    editingMedId = null;
    window.ModalManager.med.open();

    setMedModalHeader('Medication', 'New medication');

    // Reset inputs
    document.getElementById('med-name').value = '';
    document.getElementById('med-dosage').value = '';
    document.getElementById('med-archived').checked = false;
    document.getElementById('med-supplement').checked = false;
    document.getElementById('med-rx-display').style.display = 'none';
    // showAddModal updates
    document.getElementById('med-start-date').value = '';
    document.getElementById('med-end-date').value = '';

    // Reset inventory fields
    document.getElementById('med-track-inventory').checked = false;
    document.getElementById('med-inventory-count').value = '';
    document.getElementById('inventory-fields').classList.add('hidden');
    document.getElementById('restock-section').style.display = 'none';
    document.getElementById('restock-history').replaceChildren();

    // Default: Daily, 1 time input
    document.getElementById('schedule-type').value = 'daily';
    document.getElementById('med-tz-policy').value = 'flexible';
    toggleScheduleFields();

    const timeContainer = document.getElementById('time-inputs');
    timeContainer.replaceChildren();
    addTimeInput(); // One empty input

    // Clear days
    document.querySelectorAll('#days-container .days-select span').forEach(s => s.classList.remove('selected'));
}

function setMedModalHeader(eyebrow, title) {
    const eyebrowEl = document.getElementById('med-modal-eyebrow');
    const titleEl = document.getElementById('med-modal-title');
    if (eyebrowEl) eyebrowEl.textContent = eyebrow;
    if (titleEl) titleEl.textContent = title;
}

// showEditModal() moved to features/meds.js (Phase 5 Task 1)

function closeModal() {
    window.ModalManager.med.close();
}

function toggleScheduleFields() {
    const type = document.getElementById('schedule-type').value;
    const daysContainer = document.getElementById('days-container');
    const timesContainer = document.getElementById('times-container');

    if (type === 'weekly') {
        daysContainer.classList.remove('hidden');
    } else {
        daysContainer.classList.add('hidden');
    }

    if (type === 'as_needed') {
        timesContainer.classList.add('hidden');
    } else {
        timesContainer.classList.remove('hidden');
    }

    syncScheduleTypePills(type);
}

function syncScheduleTypePills(activeType) {
    const pills = document.querySelectorAll('.wg-meds-modal__pill');
    pills.forEach((pill) => {
        const isActive = pill.dataset.scheduleType === activeType;
        pill.classList.toggle('wg-gloss--sun', isActive);
        pill.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
}

function setScheduleType(type) {
    const select = document.getElementById('schedule-type');
    if (!select) return;
    if (select.value !== type) select.value = type;
    toggleScheduleFields();
}

function toggleDay(el) {
    el.classList.toggle('selected');
}

function toggleInventoryFields() {
    const trackInventory = document.getElementById('med-track-inventory').checked;
    const inventoryFields = document.getElementById('inventory-fields');
    const restockSection = document.getElementById('restock-section');

    if (trackInventory) {
        inventoryFields.classList.remove('hidden');
        // Only show restock section when editing existing med
        if (editingMedId) {
            restockSection.style.display = 'block';
        } else {
            restockSection.style.display = 'none';
        }
    } else {
        inventoryFields.classList.add('hidden');
    }
}

async function loadRestockHistory(medId) {
    const restocks = await apiCall(`/api/medications/${medId}/restocks`);
    const container = document.getElementById('restock-history');

    container.replaceChildren();

    if (!restocks || restocks.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'hint';
        empty.textContent = 'No restock history';
        container.appendChild(empty);
        return;
    }

    const title = document.createElement('p');
    title.className = 'hint';
    title.textContent = 'Recent restocks:';
    container.appendChild(title);

    const list = document.createElement('ul');
    restocks.slice(0, 5).forEach((r) => {
        const date = formatDate(r.restocked_at);
        const item = document.createElement('li');
        item.textContent = `+${r.quantity} on ${date}${r.note ? ` - ${r.note}` : ''}`;
        list.appendChild(item);
    });

    container.appendChild(list);
}

async function handleRestock() {
    if (!editingMedId) return;

    const qtyInput = document.getElementById('restock-qty');
    const qty = parseInt(qtyInput.value);

    if (!qty || qty <= 0) {
        safeAlert("Please enter a valid quantity");
        return;
    }

    const res = await apiCall(`/api/medications/${editingMedId}/restock`, 'POST', { quantity: qty });
    if (res) {
        // Update displayed count
        document.getElementById('med-inventory-count').value = res.inventory_count;
        qtyInput.value = '';
        loadRestockHistory(editingMedId);
        safeAlert(`Added ${qty} units. New total: ${res.inventory_count}`);
    }
}

// Calculate if medication is low on stock considering end date
function isLowOnStock(med) {
    if (med.inventory_count === null || med.inventory_count === undefined) {
        return false;
    }

    // Calculate daily usage from schedule
    const dailyUsage = calculateDailyUsage(med);
    if (dailyUsage === 0) {
        return false; // Can't calculate for as-needed
    }

    const daysOfStock = med.inventory_count / dailyUsage;

    // If medication has an end date, check if we have enough until then
    if (med.end_date) {
        const endDate = new Date(med.end_date);
        const now = new Date();
        const daysUntilEnd = (endDate - now) / (1000 * 60 * 60 * 24);

        if (daysUntilEnd <= 0) {
            return false; // Already ended
        }

        return daysOfStock < daysUntilEnd;
    }

    // No end date: use 7-day threshold
    return daysOfStock < 7;
}

// Calculate how many doses per day based on schedule
function calculateDailyUsage(med) {
    try {
        const sched = JSON.parse(med.schedule);

        if (sched.type === 'as_needed') {
            return 0;
        }

        const timesPerDay = (sched.times || []).length;

        if (sched.type === 'daily') {
            return timesPerDay;
        }

        if (sched.type === 'weekly') {
            const daysPerWeek = (sched.days || []).length;
            return (daysPerWeek / 7.0) * timesPerDay;
        }

        return 0;
    } catch (e) {
        return 0;
    }
}

function addTimeInput(value = '') {
    const container = document.getElementById('time-inputs');
    const div = document.createElement('div');
    div.className = 'time-row wg-meds-modal__time-row';

    const wrap = document.createElement('div');
    wrap.className = 'wg-gloss--inset wg-meds-modal__input-wrap wg-meds-modal__time-wrap';

    const input = document.createElement('input');
    input.type = 'time';
    input.className = 'med-time-input wg-meds-modal__input';
    input.value = value;
    wrap.appendChild(input);

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'wg-icon-btn remove-time wg-meds-modal__remove-time';
    removeButton.setAttribute('aria-label', 'Remove time');
    removeButton.textContent = '×';
    removeButton.addEventListener('click', () => {
        removeTime(removeButton);
    });

    div.appendChild(wrap);
    div.appendChild(removeButton);
    container.appendChild(div);
}

function removeTime(btn) {
    btn.parentElement.remove();
}

// parseMedicationSchedule, getNextScheduledDate, getMedicationScheduleText, and
// getLastTakenTimeMs moved to features/medication-utils.js (Plan 2026-05-13,
// Task 5). Callers reach them through window.MedicationUtils.* or via the
// bare-name backwards-compat shims attached on that module.

// renderMeds(), logMedicationPast(), renderHistory() moved to features/meds.js (Phase 5 Task 1)

// escapeHtml moved to core/utils.js (Task 1 of split-app-js plan); the local
// call site below resolves to the function via global scope hoisting from
// core/utils.js, which is loaded earlier in index.html.

// loadMeds(), populateMedFilter(), saveMedication(), deleteMed() moved to features/meds.js (Phase 5 Task 1)

async function loadHistory() {
    // Ensure medications are loaded for name resolution
    // populateMedFilter() is called inside loadMeds(), so only call it explicitly
    // when loadMeds() is skipped (medications pre-loaded from bootstrap)
    if (medications.length === 0) await loadMeds();
    else populateMedFilter();

    const days = document.getElementById('history-filter-days').value;
    const medId = document.getElementById('history-filter-med').value;

    const cacheKey = `history_${days}_${medId}`;

    const result = await window.DataStore.loadSWR({
        key: cacheKey,
        tags: ['history'],
        fetcher: async () => await apiCall(`/api/history?days=${days}&med_id=${medId}`),
        allowNullFresh: true,
        onCached: async (cached) => {
            renderHistory(cached);
            await renderMedsHistoryStaleBadge(cacheKey);
        },
        onFresh: async (fresh) => {
            if (fresh && window.MedTrackerDB?.IntakeHistoryStore) {
                await window.MedTrackerDB.IntakeHistoryStore.saveCache(cacheKey, fresh);
            }
            renderHistory(fresh || []);
            await renderMedsHistoryStaleBadge(cacheKey);
        },
        onError: async (_err, cached) => {
            if (!cached) renderHistory([]);
            await renderMedsHistoryStaleBadge(cacheKey);
        }
    });
    renderNextIntakeTrigger();
    return result;
}

// Mounts the wg-stale-badge into the Meds History subtab from the active
// `history_<days>_<medId>` api_cache key. Re-runs whenever the user flips the
// filters because the cache key shifts with them. Mirrors the BP/Weight Task 6
// pattern.
async function renderMedsHistoryStaleBadge(cacheKey) {
    const slot = document.getElementById('meds-history-stale-badge');
    if (!slot) return;
    const api = (typeof window !== 'undefined') ? window.WGStaleBadge : null;
    if (!api || typeof api.mountFromKey !== 'function') {
        slot.replaceChildren();
        slot.classList.add('hidden');
        return;
    }
    await api.mountFromKey({ slot, key: cacheKey });
}

let _nextIntakeTimerInterval = null;

function _formatCountdown(ms) {
    if (ms <= 0) return '0:00';
    const totalMinutes = Math.floor(ms / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}:${String(minutes).padStart(2, '0')}`;
}

async function renderNextIntakeTrigger() {
    const container = document.getElementById('next-intake-trigger');
    if (!container) return;

    if (_nextIntakeTimerInterval) {
        clearInterval(_nextIntakeTimerInterval);
        _nextIntakeTimerInterval = null;
    }

    try {
        // Kick off a refresh as a side-effect. fetchFresh returns null for
        // both "no data" and "superseded by a concurrent invalidation", so we
        // can't use its return value to decide between "render empty" and
        // "leave the card alone". Instead, read the cache afterwards — it
        // reflects whichever fetch most recently won. This avoids wiping a
        // correctly-rendered card when an older, invalidated fetch resolves
        // after a newer one has already populated the cache.
        await window.DataStore.fetchFresh(
            'next_intake',
            fetchNextIntakePayload,
            ['history', 'medications']
        );

        const res = await window.DataStore.getCached('next_intake');

        if (!res || !res.scheduled_at) {
            container.replaceChildren();
            return;
        }

        const nextTime = new Date(res.scheduled_at);
        const medNamesStr = res.medication_names.join(', ');

        // Format the next time
        const timeStr = nextTime.toLocaleString('de-DE', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });

        // Round-2 Task 8 (#11b): restyled to match the Today "Next up" card —
        // elevated-teal surface + muted-uppercase kicker + display-numeric
        // countdown + secondary meta line + shared toolbar-btn primary CTA.
        const card = document.createElement('div');
        card.className = 'wg-meds-next-intake-card';

        const body = document.createElement('div');
        body.className = 'wg-meds-next-intake-card__text';

        const title = document.createElement('div');
        title.className = 'wg-meds-next-intake-card__kicker';
        title.textContent = 'Next scheduled intake';

        const countdown = document.createElement('div');
        countdown.className = 'wg-meds-next-intake-card__time';
        function updateCountdown() {
            countdown.textContent = _formatCountdown(nextTime - Date.now());
        }
        updateCountdown();
        _nextIntakeTimerInterval = setInterval(updateCountdown, 30000);

        const details = document.createElement('div');
        details.className = 'wg-meds-next-intake-card__meta';
        details.textContent = `${medNamesStr} at ${timeStr}`;
        body.appendChild(title);
        body.appendChild(countdown);
        body.appendChild(details);

        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'wg-toolbar-btn wg-toolbar-btn--primary wg-meds-next-intake-card__cta';
        const actionLabel = document.createElement('span');
        actionLabel.className = 'wg-toolbar-btn__label';
        actionLabel.textContent = 'Take Now';
        action.appendChild(actionLabel);
        action.addEventListener('click', () => {
            triggerNextIntake();
        });

        card.appendChild(body);
        card.appendChild(action);
        container.replaceChildren(card);
    } catch (e) {
        console.error("Error fetching next intake:", e);
        container.replaceChildren();
    }
}

async function triggerNextIntake() {
    const res = await apiCall('/api/medications/trigger-next-intake', 'POST');
    if (res && res.status === 'confirmed') {
        await window.DataStore.invalidateTags(['history', 'medications']);
        await window.DataStore.invalidateKey('next_intake');
        const medNamesStr = res.medication_names ? res.medication_names.join(', ') : `${res.medication_count} medication(s)`;
        safeAlert(`✅ Confirmed: ${medNamesStr}\n\nScheduled for: ${formatDate(res.scheduled_at)}\nTaken at: ${formatDate(res.taken_at)}`);
        await loadHistory();
    }
}

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
        const sessionId = params.get('session_id');
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

function closeMedicationConfirmModal() {
    window.ModalManager.medConfirm.close();
}

// Apply `mutator(log) → log|null` against every cached `history_*` payload so
// intake-status mutations (confirm/skip/edit/log-past/delete-future) repaint
// the meds History list synchronously before the POST resolves. Returns an
// array of applyOptimistic handles the caller settles on success/failure.
// Returning `null` from the mutator drops the log (used by deleteFutureIntakes).
async function _applyOptimisticHistoryFlip(mutator) {
    const handles = [];
    if (!window.DataStore || typeof window.DataStore.applyOptimistic !== 'function') {
        return handles;
    }
    const apiCache = window.MedTrackerDB && window.MedTrackerDB.ApiCache;
    if (!apiCache || typeof apiCache.keys !== 'function') return handles;

    let keys = [];
    try { keys = await apiCache.keys('history_'); } catch (_) { keys = []; }
    if (!Array.isArray(keys) || keys.length === 0) return handles;

    for (const key of keys) {
        const handle = await window.DataStore.applyOptimistic(key, (prev) => {
            if (!Array.isArray(prev)) return prev;
            const next = [];
            for (const log of prev) {
                const mapped = mutator(log);
                if (mapped) next.push(mapped);
            }
            return next;
        }, ['history']);
        handles.push(handle);
    }
    return handles;
}

// Clear `next_intake` cache when the just-confirmed/skipped scheduled time
// matches the cached "next" tile so Today's next-intake card vanishes before
// the round-trip. Returns a handle (no-op handle if nothing cached or mismatch).
async function _applyOptimisticNextIntakeClear(scheduledAt) {
    if (!window.DataStore || typeof window.DataStore.applyOptimistic !== 'function') {
        return { commit: async () => {}, rollback: async () => {} };
    }
    return window.DataStore.applyOptimistic('next_intake', (prev) => {
        if (!prev || typeof prev !== 'object') return prev;
        if (!scheduledAt || prev.scheduled_at !== scheduledAt) return prev;
        return { scheduled_at: null, medication_names: [] };
    }, ['medications', 'history']);
}

// Prepend a freshly-synthesised log into every cached `history_*` payload
// whose filter (range + medId) would include it. Used by confirmLogPast where
// no prior log row exists. `medId` matches the per-med filter; the "0" / "all"
// medId always matches. Range filter is not strictly enforced — the next
// loadHistory() refetch reconciles against authoritative server data.
async function _applyOptimisticHistoryAdd(log, medId) {
    const handles = [];
    if (!window.DataStore || typeof window.DataStore.applyOptimistic !== 'function') {
        return handles;
    }
    const apiCache = window.MedTrackerDB && window.MedTrackerDB.ApiCache;
    if (!apiCache || typeof apiCache.keys !== 'function') return handles;

    let keys = [];
    try { keys = await apiCache.keys('history_'); } catch (_) { keys = []; }
    if (!Array.isArray(keys) || keys.length === 0) return handles;

    for (const key of keys) {
        const parts = key.split('_');
        const keyMedId = parts[2] === undefined || parts[2] === '' ? 0 : Number(parts[2]);
        if (keyMedId !== 0 && keyMedId !== medId) continue;
        const handle = await window.DataStore.applyOptimistic(key, (prev) => {
            const base = Array.isArray(prev) ? prev : [];
            return [log, ...base];
        }, ['history']);
        handles.push(handle);
    }
    return handles;
}

async function _commitOptimistic(handles) {
    for (const h of handles) { try { await h.commit(null); } catch (_) { /* best-effort */ } }
}

async function _rollbackOptimistic(handles) {
    for (const h of handles) { try { await h.rollback(); } catch (_) { /* best-effort */ } }
}

async function confirmSelectedMedications() {
    const checks = document.querySelectorAll('.med-confirm-check:checked');
    const selectedIndices = Array.from(checks).map(c => parseInt(c.value, 10));
    const ids = window.PushModalState.getMedConfirmIds();
    const intakeIds = window.PushModalState.getMedConfirmIntakeIds();
    const selectedIds = selectedIndices.map(idx => Number(ids[idx]));
    const selectedIntakeIds = selectedIndices
        .map(idx => intakeIds[idx])
        .filter(id => id != null);

    const btn = document.getElementById('med-confirm-action-btn');
    await withSubmit(btn, async () => {
        const body = {
            scheduled_at: window.PushModalState.getMedConfirmScheduled(),
            medication_ids: selectedIds
        };
        if (selectedIntakeIds.length > 0) {
            body.intake_ids = selectedIntakeIds;
        }

        // Optimistic: flip the matched intake_log entries to TAKEN in every
        // cached `history_*` payload and clear `next_intake` so the meds
        // History list + Today's next-intake tile repaint before the POST
        // resolves. Mutator runs against each enumerated cache key so users
        // see the green check immediately instead of after the round-trip.
        const takenAt = new Date().toISOString();
        const handles = await _applyOptimisticHistoryFlip((log) => {
            if (!log || typeof log !== 'object') return log;
            const isSelectedIntake = selectedIntakeIds.indexOf(log.id) !== -1;
            const isSelectedMed = selectedIds.indexOf(log.medication_id) !== -1
                && log.status === 'PENDING'
                && log.scheduled_at === body.scheduled_at;
            if (isSelectedIntake || isSelectedMed) {
                return { ...log, status: 'TAKEN', taken_at: takenAt, _optimistic: true };
            }
            return log;
        });
        handles.push(await _applyOptimisticNextIntakeClear(body.scheduled_at));

        let res;
        try {
            res = await apiCall('/api/medications/confirm-schedule', 'POST', body);
        } catch (e) {
            await _rollbackOptimistic(handles);
            throw e;
        }

        if (res) {
            await _commitOptimistic(handles);
            safeAlert("Confirmed!");
            refreshMedsAfterMutation();
        } else {
            await _rollbackOptimistic(handles);
        }

        closeMedicationConfirmModal();
    });
}

async function skipSelectedMedications() {
    const checks = document.querySelectorAll('.med-confirm-check:checked');
    const selectedIndices = Array.from(checks).map(c => parseInt(c.value, 10));

    if (selectedIndices.length === 0) {
        closeMedicationConfirmModal();
        return;
    }

    const btn = document.getElementById('med-confirm-skip-btn');
    await withSubmit(btn, async () => {
        let hasErrors = false;
        const ids = window.PushModalState.getMedConfirmIds();
        const intakeIds = window.PushModalState.getMedConfirmIntakeIds();
        const scheduled = window.PushModalState.getMedConfirmScheduled();

        // Resolve intake_ids up-front (from PushModalState or via /api/history
        // fallback for push-notification entries) so we can apply the optimistic
        // SKIPPED flip in one pass before issuing the skip POSTs.
        const resolvedIntakeIds = [];
        const skipRequests = [];
        for (const idx of selectedIndices) {
            const medId = Number(ids[idx]);
            let intakeId = intakeIds[idx];

            if (!intakeId) {
                const pendingLogs = await apiCall(`/api/history?days=1`);
                if (pendingLogs && pendingLogs.length > 0) {
                    const scheduledTime = new Date(scheduled).getTime();
                    const log = pendingLogs.find(l =>
                        l.medication_id === medId &&
                        l.status === 'PENDING' &&
                        Math.abs(new Date(l.scheduled_at).getTime() - scheduledTime) < 60000
                    );
                    if (log) {
                        intakeId = log.id;
                    }
                }
            }

            if (intakeId) {
                resolvedIntakeIds.push(intakeId);
                skipRequests.push(intakeId);
            } else {
                hasErrors = true;
            }
        }

        const handles = await _applyOptimisticHistoryFlip((log) => {
            if (!log || typeof log !== 'object') return log;
            if (resolvedIntakeIds.indexOf(log.id) !== -1) {
                return { ...log, status: 'SKIPPED', _optimistic: true };
            }
            return log;
        });
        handles.push(await _applyOptimisticNextIntakeClear(scheduled));

        try {
            for (const intakeId of skipRequests) {
                const res = await apiCall('/api/medications/skip', 'POST', { intake_id: intakeId });
                if (!res) {
                    hasErrors = true;
                }
            }
        } catch (e) {
            await _rollbackOptimistic(handles);
            throw e;
        }

        if (hasErrors) {
            await _rollbackOptimistic(handles);
        } else {
            await _commitOptimistic(handles);
        }

        refreshMedsAfterMutation();
        if (!hasErrors) {
            safeAlert("Skipped!");
        } else {
            safeAlert("Error skipping some medications.");
        }
        closeMedicationConfirmModal();
    });
}

async function updateIntakeHistory() {
    const checks = document.querySelectorAll('.med-confirm-check');
    const selectedIndices = [];
    const unselectedIndices = [];

    checks.forEach(c => {
        const idx = parseInt(c.value, 10);
        if (c.checked) {
            selectedIndices.push(idx);
        } else {
            unselectedIndices.push(idx);
        }
    });

    const timeInput = document.getElementById('med-confirm-datetime');
    const takenAt = new Date(timeInput.value).toISOString();

    const updates = [];
    const intakeIds = window.PushModalState.getMedConfirmIntakeIds();

    // For selected items (TAKEN)
    selectedIndices.forEach(idx => {
        if (intakeIds[idx]) {
            updates.push({
                id: intakeIds[idx],
                status: 'TAKEN',
                taken_at: takenAt
            });
        }
    });

    // For unselected items (PENDING - Reverting)
    unselectedIndices.forEach(idx => {
        if (intakeIds[idx]) {
            updates.push({
                id: intakeIds[idx],
                status: 'PENDING',
                taken_at: '' // Backend handles null/empty
            });
        }
    });

    if (updates.length === 0) {
        closeMedicationConfirmModal();
        return;
    }

    const btn = document.getElementById('med-confirm-action-btn');
    await withSubmit(btn, async () => {
        // Optimistic: apply each TAKEN/PENDING flip across cached history payloads
        // so the History list reflects the user's choice before the round-trip.
        const updatesById = new Map();
        for (const u of updates) updatesById.set(u.id, u);
        const handles = await _applyOptimisticHistoryFlip((log) => {
            if (!log || typeof log !== 'object') return log;
            const upd = updatesById.get(log.id);
            if (!upd) return log;
            const next = { ...log, status: upd.status, _optimistic: true };
            if (upd.status === 'TAKEN') {
                next.taken_at = upd.taken_at;
            } else {
                next.taken_at = null;
            }
            return next;
        });

        let res;
        try {
            res = await apiCall('/api/intakes/update', 'POST', { updates });
        } catch (e) {
            await _rollbackOptimistic(handles);
            throw e;
        }

        if (res) { // status 200 assumed
            await _commitOptimistic(handles);
            safeAlert("Updated!");
            refreshMedsAfterMutation();
        } else {
            await _rollbackOptimistic(handles);
        }
        closeMedicationConfirmModal();
    });
}

async function confirmLogPast() {
    const timeInput = document.getElementById('med-confirm-datetime');
    const takenAt = new Date(timeInput.value).toISOString();

    // In log_past mode, we only support one med at a time for simplicity in this UI
    const medId = window.PushModalState.getMedConfirmIds()[0];

    const btn = document.getElementById('med-confirm-action-btn');
    await withSubmit(btn, async () => {
        // Optimistic: prepend a synthesised TAKEN log into every cached
        // `history_<range>_<medId>` payload that should contain it (the
        // "all meds" filter and the per-med filter for this medId) so the
        // user sees the new entry before /log-past resolves.
        const optimisticLog = {
            id: `local_optimistic_${Date.now()}`,
            medication_id: Number(medId),
            scheduled_at: takenAt,
            taken_at: takenAt,
            status: 'TAKEN',
            _optimistic: true
        };
        const handles = await _applyOptimisticHistoryAdd(optimisticLog, Number(medId));

        let res;
        try {
            res = await apiCall('/api/medications/log-past', 'POST', {
                medication_id: medId,
                taken_at: takenAt
            });
        } catch (e) {
            await _rollbackOptimistic(handles);
            throw e;
        }

        if (!res) {
            await _rollbackOptimistic(handles);
            closeMedicationConfirmModal();
            return;
        }
        await _commitOptimistic(handles);

        if (res) {
            safeAlert("Intake logged!");
            if (window.DataStore) {
                await window.DataStore.invalidateByTag('history');
                await window.DataStore.invalidateByTag('medications');
            }
            await loadMeds();
            const activeMedTab = document.querySelector('.med-tab.active');
            if (activeMedTab && activeMedTab.dataset.tab === 'inventory' &&
                typeof renderInventory === 'function') {
                renderInventory();
            }
            const historyResult = await loadHistory();
            const newId = res && typeof res.id !== 'undefined' ? res.id : null;
            // Only run the visibility check when the history fetch actually
            // returned an array. If it failed (historyResult.error set or
            // fresh is null), the user is offline/degraded — the POST already
            // succeeded, so don't shout "history did not refresh" at them.
            if (newId !== null && historyResult && Array.isArray(historyResult.fresh)) {
                const found = historyResult.fresh.some((l) => l && typeof l.id === 'number' && l.id === newId);
                if (!found) {
                    if (window.SyncDebug && typeof window.SyncDebug.warn === 'function') {
                        window.SyncDebug.warn('log-past: new intake not visible in history after reload', { id: newId });
                    }
                    if (window.SyncManager && typeof window.SyncManager.showToast === 'function') {
                        window.SyncManager.showToast('Saved, but history did not refresh — pull to refresh', 'error');
                    }
                }
            }
        }

        closeMedicationConfirmModal();
    });
}



function snoozeMedicationConfirm() {
    closeMedicationConfirmModal();
}

function showWorkoutStartModal(sessionId) {
    window.PushModalState.openWorkoutStart({ sessionId });
    window.ModalManager.workoutStart.open();
}

function closeWorkoutStartModal() {
    window.ModalManager.workoutStart.close();
}

function startWorkoutFromModal() {
    closeWorkoutStartModal();
    switchTab('workouts');
}

async function snoozeWorkout(minutes) {
    const sessionId = window.PushModalState.getWorkoutSessionId();
    if (!sessionId) return;
    const btn = document.getElementById(`workout-start-snooze-${minutes}-btn`);
    await withSubmit(btn, async () => {
        // Optimistic: stamp snoozed_until on the cached workout_next.session so
        // the next-card hides the "Start" CTA while we wait on the POST.
        const snoozeUntilIso = new Date(Date.now() + minutes * 60 * 1000).toISOString();
        const handle = window.DataStore && typeof window.DataStore.applyOptimistic === 'function'
            ? await window.DataStore.applyOptimistic('workout_next', (prev) => {
                if (!prev || !prev.session || prev.session.id !== sessionId) return prev;
                return {
                    ...prev,
                    session: {
                        ...prev.session,
                        snoozed_until: snoozeUntilIso,
                        is_snoozed: true
                    }
                };
            }, ['workout'])
            : null;

        try {
            const res = await apiCall(`/api/workout/sessions/${sessionId}/snooze`, 'POST', { minutes: minutes });
            if (res) {
                if (handle) await handle.commit(null);
                if (typeof invalidateWorkoutCache === 'function') {
                    await invalidateWorkoutCache();
                } else if (window.DataStore?.invalidateTags) {
                    await window.DataStore.invalidateTags(['workout']);
                }
                safeAlert(`Snoozed for ${minutes} minutes`);
            } else if (handle) {
                await handle.rollback();
            }
        } catch (error) {
            if (handle) await handle.rollback();
            throw error;
        }
        closeWorkoutStartModal();
    });
}

async function skipWorkout() {
    const sessionId = window.PushModalState.getWorkoutSessionId();
    if (!sessionId) return;
    await safeConfirm("Are you sure you want to skip this workout?", async (ok) => {
        if (!ok) return;

        // Optimistic: null workout_next so the home card vanishes immediately.
        const handle = window.DataStore && typeof window.DataStore.applyOptimistic === 'function'
            ? await window.DataStore.applyOptimistic('workout_next', (prev) => {
                if (prev?.session?.id === sessionId) return { session: null };
                return prev;
            }, ['workout'])
            : null;

        try {
            const res = await apiCall(`/api/workout/sessions/${sessionId}/skip`, 'POST');
            if (res) {
                if (handle) await handle.commit(null);
                if (typeof invalidateWorkoutCache === 'function') {
                    await invalidateWorkoutCache();
                } else if (window.DataStore?.invalidateTags) {
                    await window.DataStore.invalidateTags(['workout']);
                }
                safeAlert("Workout skipped");
                loadWorkouts();
            } else if (handle) {
                await handle.rollback();
            }
        } catch (error) {
            if (handle) await handle.rollback();
            throw error;
        }
        closeWorkoutStartModal();
    });
}

async function skipWorkoutFromModal() {
    await skipWorkout();
}

async function sendTestMedicationNotification() {
    try {
        const res = await fetch('/api/webpush/test-medication', {
            method: 'POST',
            headers: window.makeAuthHeaders()
        });

        const text = await res.text();
        if (res.ok) {
            safeAlert(text || "Test notification sent!");
        } else {
            safeAlert("Error: " + text);
        }
    } catch (e) {
        console.error(e);
        safeAlert("Error sending test notification: " + e.message);
    }
}

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
