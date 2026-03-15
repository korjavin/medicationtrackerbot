// Expose as window property so feature scripts (bp.js, weight.js, etc.)
// loaded in later <script> tags can use `const tg = window.tg` without
// triggering "SyntaxError: Identifier 'tg' has already been declared"
// (which would happen if multiple scripts all tried `const tg = ...`).
window.tg = window.Telegram ? window.Telegram.WebApp : null;
if (window.tg) {
    window.tg.ready();
    window.tg.expand();
}

// Config
const userInitData = window.tg ? window.tg.initData : null;
window.userInitData = userInitData;
let initialAuthLoad = false;

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

async function cacheApiSnapshot(key, value) {
    await window.DataStore.setCached(key, value);
}

function normalizeSettingsBundle(raw) {
    const foodTargetsRaw = raw?.foodTargets || raw?.food_targets || raw?.settings?.food_targets || {};
    const bpReminderRaw = raw?.bpReminderStatus || raw?.bp_reminder_status || raw?.settings?.bp_reminder_status || {};
    const weightReminderRaw = raw?.weightReminderStatus || raw?.weight_reminder_status || raw?.settings?.weight_reminder_status || {};
    const tabOrderRaw = raw?.tabOrder || raw?.tab_order || raw?.settings?.tab_order || null;

    return {
        featureSettings: raw?.featureSettings || raw?.features || {},
        tabOrder: tabOrderRaw,
        foodTargets: {
            calories: Number(foodTargetsRaw.calories) || 0,
            carbs: Number(foodTargetsRaw.carbs) || 0,
            protein: Number(foodTargetsRaw.protein) || 0,
            fat: Number(foodTargetsRaw.fat) || 0
        },
        bpReminderStatus: {
            ...bpReminderRaw,
            enabled: !!bpReminderRaw.enabled
        },
        weightReminderStatus: {
            ...weightReminderRaw,
            enabled: !!weightReminderRaw.enabled
        }
    };
}

function applyTabOrder(orderArray) {
    const container = document.getElementById('tabs');
    if (!container || !Array.isArray(orderArray)) return;

    // Keep track of existing tabs to append any unlisted ones at the end
    const existingTabs = Array.from(container.querySelectorAll('.tab'));
    const unlistedTabs = new Set(existingTabs);

    orderArray.forEach(tabId => {
        const tabEl = existingTabs.find(t => t.dataset.tab === tabId);
        if (tabEl) {
            container.appendChild(tabEl);
            unlistedTabs.delete(tabEl);
        }
    });

    // Append any remaining tabs that weren't in the saved order
    unlistedTabs.forEach(tabEl => {
        container.appendChild(tabEl);
    });
}

// Apply bootstrap payload and warm caches so first tab render can use local data.
async function applyBootstrapPayload(res) {
    if (!res) return false;

    if (typeof res.cursor === 'number') {
        window.DataStore.setChangeCursor(res.cursor);
    }

    if (res.features) {
        featureSettings = { ...featureSettings, ...res.features };
        featureSettingsLoaded = true;
        window.AppStore && window.AppStore.set('featureSettings', featureSettings);
        updateFeatureTabVisibility();
    }

    if (res.settings && res.settings.tab_order) {
        let order = res.settings.tab_order;
        if (typeof order === 'string') {
            try {
                order = JSON.parse(order);
            } catch (e) {
                console.error("Failed to parse tab_order", e);
                order = null;
            }
        }
        if (Array.isArray(order)) {
            applyTabOrder(order);
        }
    }

    if (Array.isArray(res.medications)) {
        medications = res.medications;
        initialAuthLoad = true;
        if (window.MedTrackerDB?.MedicationStore) {
            await window.MedTrackerDB.MedicationStore.saveCache(medications);
        }
        await cacheApiSnapshot('medications', medications);
    }

    if (Array.isArray(res.history_default)) {
        await cacheApiSnapshot('history_3_0', res.history_default);
        if (window.MedTrackerDB?.IntakeHistoryStore) {
            await window.MedTrackerDB.IntakeHistoryStore.saveCache('history_3_0', res.history_default);
        }
    }

    if (res.next_intake) {
        await cacheApiSnapshot('next_intake', res.next_intake);
    }

    if (res.bp) {
        await cacheApiSnapshot('bp', {
            readingsRes: res.bp.readings || [],
            goalRes: res.bp.goal || {},
            statsRes: res.bp.stats || {}
        });
    }

    if (res.weight) {
        await cacheApiSnapshot('weight', {
            logsRes: res.weight.logs || [],
            goalRes: res.weight.goal || {}
        });
    }

    const settingsBundle = normalizeSettingsBundle({
        features: res.features || {},
        settings: res.settings || {},
        food_targets: res.settings?.food_targets,
        bp_reminder_status: res.settings?.bp_reminder_status,
        weight_reminder_status: res.settings?.weight_reminder_status
    });
    await cacheApiSnapshot('settings_bundle', settingsBundle);

    return true;
}

// Load init data (feature settings) needed before first render.
// Falls back gracefully so auth flow is not blocked on failure.
// apiCall() already catches errors and returns null – no try/catch needed here.
async function loadInitData() {
    const res = await apiCall('/api/init', 'GET');
    if (res && res.features) {
        featureSettings = { ...featureSettings, ...res.features };
        featureSettingsLoaded = true;
        window.AppStore && window.AppStore.set('featureSettings', featureSettings);
        updateFeatureTabVisibility();
    }
}

// Check Auth Environment
async function checkAuth() {
    if (userInitData) {
        // We are in Telegram, proceed as normal
        sessionStorage.removeItem('medtracker_auth_reload_in_progress');
        saveAuthState('telegram');
        const bootstrap = await apiCall('/api/bootstrap', 'GET');
        if (bootstrap) {
            await applyBootstrapPayload(bootstrap);
        } else {
            await loadInitData();
        }
        return true;
    }

    // Not in Telegram. Check cached auth state first (for offline support)
    const cachedAuth = getCachedAuthState();

    // Try to access API to see if we have valid Session Cookie
    let serverUnavailable = false;
    try {
        const res = await fetch('/api/bootstrap', { method: 'GET' });
        if (res.status === 200) {
            // Authorized via Cookie!
            const data = await res.json();
            await applyBootstrapPayload(data);
            sessionStorage.removeItem('medtracker_auth_reload_in_progress');
            saveAuthState('cookie');

            return true;
        } else if (res.status === 401 || res.status === 403) {
            // Definitely not authorized, clear cache
            clearAuthState();
        } else if (res.status >= 500) {
            // Server error (e.g. 502 from reverse proxy when container is down)
            console.log('[Auth] Server error', res.status, '- will try cached auth');
            serverUnavailable = true;
        }
    } catch (e) {
        console.log("[Auth] Network check failed:", e);
        serverUnavailable = true;
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
            if (cachedBundle && Array.isArray(cachedBundle.tabOrder)) {
                applyTabOrder(cachedBundle.tabOrder);
            }
        }

        return true; // Trust cached state when server is down
    }

    // Not authorized and no valid cache. Show login options
    const loginContainer = document.createElement('div');
    loginContainer.style.cssText = "display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:60vh; gap: 20px; padding: 20px;";

    // Check if we're offline
    const isOffline = !navigator.onLine;

    if (isOffline) {
        // Show offline message instead of login widgets
        const title = document.createElement('h2');
        title.innerText = "Offline";
        title.style.cssText = "color: var(--text-color, #333); margin-bottom: 10px;";
        loginContainer.appendChild(title);

        const message = document.createElement('p');
        message.appendChild(document.createTextNode("You need an internet connection to log in for the first time."));
        message.appendChild(document.createElement('br'));
        message.appendChild(document.createElement('br'));
        message.appendChild(document.createTextNode("If you have logged in before, your session will be available once you're back online."));
        message.style.cssText = "color: var(--text-color, #666); text-align: center; max-width: 400px; line-height: 1.6;";
        loginContainer.appendChild(message);

        // Retry button
        const retryBtn = document.createElement('button');
        retryBtn.innerText = "Retry";
        retryBtn.onclick = () => location.reload();
        retryBtn.style.cssText = "padding: 12px 24px; font-size: 16px; background: var(--primary-color, #007bff); color: white; border: none; border-radius: 5px; cursor: pointer; margin-top: 10px;";
        loginContainer.appendChild(retryBtn);

        // Listen for online event to auto-retry
        window.addEventListener('online', () => {
            console.log('[Auth] Back online, reloading...');
            location.reload();
        });
    } else {
        // Normal login page with widgets
        const title = document.createElement('h2');
        title.innerText = "Login to Med Tracker";
        title.style.cssText = "color: var(--text-color, #333); margin-bottom: 10px;";
        loginContainer.appendChild(title);

        // Create a container for the Telegram widget
        const tgWidgetContainer = document.createElement('div');
        tgWidgetContainer.id = 'telegram-login-container';

        // Add the Telegram widget script
        const tgScript = document.createElement('script');
        tgScript.async = true;
        tgScript.src = "https://telegram.org/js/telegram-widget.js?22";
        tgScript.setAttribute('data-telegram-login', window.BOT_USERNAME);
        tgScript.setAttribute('data-size', 'large');
        tgScript.setAttribute('data-onauth', 'onTelegramAuth(user)');
        tgScript.setAttribute('data-request-access', 'write');

        tgWidgetContainer.appendChild(tgScript);
        loginContainer.appendChild(tgWidgetContainer);

        const oidcConfig = window.OIDC_CONFIG || { enabled: false };
        if (oidcConfig.enabled) {
            // Divider
            const divider = document.createElement('div');
            divider.style.cssText = "display:flex; align-items:center; gap:10px; color: #999; margin: 10px 0;";
            const line1 = document.createElement('span');
            line1.style.cssText = "flex:1; height:1px; background:#ddd;";
            const textSpan = document.createElement('span');
            textSpan.textContent = "or";
            const line2 = document.createElement('span');
            line2.style.cssText = "flex:1; height:1px; background:#ddd;";
            divider.appendChild(line1);
            divider.appendChild(textSpan);
            divider.appendChild(line2);
            loginContainer.appendChild(divider);

            // OIDC login button
            const oidcBtn = document.createElement('button');
            oidcBtn.innerText = oidcConfig.label || "Login";
            oidcBtn.onclick = () => window.location.href = (oidcConfig.loginUrl || "/auth/oidc/login");
            const oidcBg = oidcConfig.buttonColor || "var(--button-color, #2481cc)";
            const oidcText = oidcConfig.buttonText || "var(--button-text-color, #fff)";
            oidcBtn.style.cssText = `padding: 12px 24px; font-size: 16px; background: ${oidcBg}; color: ${oidcText}; border: none; border-radius: 5px; cursor: pointer;`;
            loginContainer.appendChild(oidcBtn);

            // Setup helper link
            const setupLink = document.createElement('a');
            setupLink.href = '/oidc-setup';
            setupLink.innerText = 'Need setup info?';
            setupLink.style.cssText = 'margin-top: 4px; font-size: 13px; color: var(--link-color, #2481cc);';
            loginContainer.appendChild(setupLink);
        }
    }

    document.body.replaceChildren();
    document.body.appendChild(loginContainer);

    // Define global callback for Telegram Login Widget
    window.onTelegramAuth = async function (user) {
        console.log("Telegram auth callback received:", user);
        try {
            const res = await fetch('/auth/telegram/callback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(user)
            });
            if (res.ok) {
                window.location.reload();
            } else {
                const err = await res.text();
                console.error("Telegram login failed:", err);
                safeAlert("Login failed: " + err);
            }
        } catch (e) {
            console.error("Telegram login error:", e);
            safeAlert("Login error: " + e.message);
        }
    };

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

    const wrapper = document.createElement('div');
    wrapper.className = 'setting-item';
    wrapper.style.marginBottom = '16px';

    const textWrap = document.createElement('div');
    const title = document.createElement('h3');
    title.innerText = 'OIDC Setup';
    const desc = document.createElement('p');
    desc.className = 'setting-desc';
    desc.innerText = 'Copy redirect URIs for Pocket-ID / OIDC clients.';
    textWrap.appendChild(title);
    textWrap.appendChild(desc);

    const actionBtn = document.createElement('button');
    actionBtn.className = 'secondary';
    actionBtn.style.margin = '0';
    actionBtn.innerText = 'Open';
    actionBtn.onclick = () => window.location.href = '/oidc-setup';

    wrapper.appendChild(textWrap);
    wrapper.appendChild(actionBtn);
    container.replaceChildren();
    container.appendChild(wrapper);
}

// Bootstrap orchestration lives in features/bootstrap.js (loaded after all feature scripts).

async function sendTestBPNotification() {
    const res = await apiCall('/api/bp/reminder/test', 'POST');
    if (res) {
        safeAlert("Notification sent! Check your device.");
    }
}

// Settings Toggle Handler
document.getElementById('webpush-toggle').addEventListener('change', async function () {
    const status = document.getElementById('webpush-status');
    status.style.display = 'block';

    if (this.checked) {
        status.innerText = "Requesting permission...";
        status.className = "info";
        const success = await window.MedTrackerPush.subscribe();
        if (success) {
            status.innerText = "Notifications enabled";
            status.style.color = "green";
        } else {
            status.innerText = "Failed to enable notifications. Please check permissions.";
            status.style.color = "red";
            this.checked = false;
        }
    } else {
        const success = await window.MedTrackerPush.unsubscribe();
        if (success) {
            status.innerText = "Notifications disabled";
            status.style.color = "gray";
        } else {
            status.innerText = "Failed to disable notifications";
            status.style.color = "red";
            this.checked = true; // revert
        }
    }

    // Hide status after delay
    setTimeout(() => {
        status.style.display = 'none';
    }, 3000);
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
        loadMeds();
        loadHistory();
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
let medications = [];
let editingMedId = null;
var currentFoodLogs = {};
var foodTargets = {
    calories: 0,
    carbs: 0,
    protein: 0,
    fat: 0
};
let featureSettings = {
    food: false,
    bp: true,
    weight: true,
    medication: true,
    workout: true,
    health: true
};
let featureSettingsLoaded = false;
// Expose via AppStore so feature modules can read without tight coupling.
window.AppStore && window.AppStore.set('featureSettings', featureSettings);
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
function activateTabGroup(tab, options) {
    const { buttonSelector, contentSelector, contentIdFromTab } = options;
    // Validate target exists BEFORE clearing active state to avoid blank-page on unknown tabs
    const tabButton = document.querySelector(`${buttonSelector}[data-tab="${tab}"]`);
    const tabContent = document.getElementById(contentIdFromTab(tab));
    if (!tabButton || !tabContent) return false;

    document.querySelectorAll(buttonSelector).forEach((el) => el.classList.remove('active'));
    document.querySelectorAll(contentSelector).forEach((el) => el.classList.remove('active'));
    tabButton.classList.add('active');
    tabContent.classList.add('active');
    return true;
}

function bindTabGroup(options) {
    const { container, buttonSelector, onTabSelect } = options;
    if (!container || container.dataset.tabBound === '1') return;
    container.dataset.tabBound = '1';

    container.addEventListener('click', (event) => {
        const button = event.target.closest(buttonSelector);
        if (!button || !container.contains(button)) return;
        const tab = button.dataset.tab;
        if (!tab) return;
        onTabSelect(tab);
    });
}

function switchTab(tab) {
    const tabToFeature = {
        food: 'food',
        bp: 'bp',
        weight: 'weight',
        meds: 'medication',
        workouts: 'workout'
    };
    const feature = tabToFeature[tab];
    if (feature && featureSettingsLoaded && !featureSettings[feature]) {
        switchTab('settings');
        return;
    }

    const activated = activateTabGroup(tab, {
        buttonSelector: '.tab',
        contentSelector: '.view',
        contentIdFromTab: (tabName) => `${tabName}-view`
    });
    if (!activated) return;

    if (tab === 'meds') {
        if (!document.querySelector('.med-tab.active')) {
            switchMedTab('history');
        } else {
            reloadCurrentTab();
        }
    } else if (tab === 'bp') { loadBPReadings(); }
    else if (tab === 'weight') { loadWeightLogs(); }
    else if (tab === 'health') { loadHealthOverview(); }
    else if (tab === 'workouts') { loadWorkouts(); }
    else if (tab === 'food') { loadFoodLogs(); }
    else if (tab === 'settings') { loadSettings(); }
}

bindTabGroup({
    container: document.getElementById('tabs'),
    buttonSelector: '.tab',
    onTabSelect: switchTab
});

let medicationControlsBound = false;

function bindMedicationControls() {
    if (medicationControlsBound) return;
    medicationControlsBound = true;

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
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindMedicationControls, { once: true });
}
bindMedicationControls();

let measurementControlsBound = false;

function bindMeasurementControls() {
    if (measurementControlsBound) return;
    measurementControlsBound = true;

    const bindClick = (id, handler) => {
        const element = document.getElementById(id);
        if (element) element.addEventListener('click', handler);
    };

    bindClick('add-bp-btn', () => showBPRecordModal());
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
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindMeasurementControls, { once: true });
}
bindMeasurementControls();

let notificationControlsBound = false;

function bindNotificationControls() {
    if (notificationControlsBound) return;
    notificationControlsBound = true;

    const bindClick = (id, handler) => {
        const element = document.getElementById(id);
        if (element) element.addEventListener('click', handler);
    };

    bindClick('test-med-notification-btn', () => sendTestMedicationNotification());
    bindClick('test-bp-notification-btn', () => sendTestBPNotification());

    bindClick('med-confirm-dismiss-btn', () => closeMedicationConfirmModal());
    bindClick('med-confirm-action-btn', () => confirmSelectedMedications());
    bindClick('med-confirm-snooze-btn', () => snoozeMedicationConfirm());

    bindClick('workout-start-now-btn', () => startWorkoutFromModal());
    bindClick('workout-start-snooze-60-btn', () => snoozeWorkout(60));
    bindClick('workout-start-snooze-120-btn', () => snoozeWorkout(120));
    bindClick('workout-start-skip-btn', () => skipWorkout());
    bindClick('workout-start-dismiss-btn', () => closeWorkoutStartModal());
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

    if (tab === 'schedule') { loadMeds(); }
    else if (tab === 'history') { loadHistory(); }
}

bindTabGroup({
    container: document.querySelector('.med-tabs'),
    buttonSelector: '.med-tab',
    onTabSelect: switchMedTab
});

// Load settings (BP reminders status, etc.)
async function loadSettings() {
    const applyBundle = async (rawBundle) => {
        const bundle = normalizeSettingsBundle(rawBundle);
        featureSettings = { ...featureSettings, ...bundle.featureSettings };
        featureSettingsLoaded = true;
        window.AppStore && window.AppStore.set('featureSettings', featureSettings);
        updateFeatureToggles();
        updateFeatureTabVisibility();

        foodTargets = { ...bundle.foodTargets };
        const calsInput = document.getElementById('food-target-calories');
        const carbsInput = document.getElementById('food-target-carbs');
        const protInput = document.getElementById('food-target-protein');
        const fatInput = document.getElementById('food-target-fat');
        if (calsInput) calsInput.value = foodTargets.calories || '';
        if (carbsInput) carbsInput.value = foodTargets.carbs || '';
        if (protInput) protInput.value = foodTargets.protein || '';
        if (fatInput) fatInput.value = foodTargets.fat || '';

        document.getElementById('bp-reminders-toggle').checked = !!bundle.bpReminderStatus.enabled;
        document.getElementById('weight-reminders-toggle').checked = !!bundle.weightReminderStatus.enabled;
    };

    const fetchBundle = async () => {
        const [featureSettingsRes, foodTargetsRes, bpReminderStatus, weightReminderStatus] = await Promise.all([
            apiCall('/api/settings/features', 'GET'),
            apiCall('/api/food/settings/targets', 'GET'),
            apiCall('/api/bp/reminder/status', 'GET'),
            apiCall('/api/weight/reminder/status', 'GET')
        ]);
        return {
            featureSettings: featureSettingsRes || {},
            foodTargets: {
                calories: foodTargetsRes?.calories || 0,
                carbs: foodTargetsRes?.carbs || 0,
                protein: foodTargetsRes?.protein || 0,
                fat: foodTargetsRes?.fat || 0
            },
            bpReminderStatus: bpReminderStatus || { enabled: false },
            weightReminderStatus: weightReminderStatus || { enabled: false }
        };
    };

    try {
        await window.DataStore.loadSWR({
            key: 'settings_bundle',
            tags: ['settings', 'food_targets', 'feature_settings'],
            fetcher: fetchBundle,
            onCached: applyBundle,
            onFresh: applyBundle,
            onError: async (error) => {
                console.error('Failed to load settings:', error);
            }
        });
    } catch (error) {
        console.error('Failed to load settings:', error);
    }
}

function updateFeatureToggles() {
    document.getElementById('food-intake-toggle').checked = !!featureSettings.food;
    document.getElementById('bp-feature-toggle').checked = !!featureSettings.bp;
    document.getElementById('weight-feature-toggle').checked = !!featureSettings.weight;
    document.getElementById('health-feature-toggle').checked = !!featureSettings.health;
    document.getElementById('medication-feature-toggle').checked = !!featureSettings.medication;
    document.getElementById('workout-feature-toggle').checked = !!featureSettings.workout;
}

function updateFoodTargetsVisibility() {
    const settingsBlock = document.getElementById('food-target-settings');
    if (!settingsBlock) return;
    settingsBlock.style.display = featureSettings.food ? 'flex' : 'none';
}

async function toggleFeatureSetting(feature, enabled) {
    try {
        await apiCall(`/api/settings/features/${feature}`, 'POST', { enabled });
        featureSettings[feature] = enabled;
        window.AppStore && window.AppStore.set('featureSettings', featureSettings);
        await window.DataStore.invalidateTags(['settings', 'feature_settings']);
        updateFeatureTabVisibility();
    } catch (e) {
        console.error(`Failed to toggle ${feature} feature:`, e);
        updateFeatureToggles();
        safeAlert('Failed to update setting.');
    }
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

    Object.entries(tabToFeature).forEach(([tab, feature]) => {
        const tabBtn = document.querySelector(`.tab[data-tab="${tab}"]`);
        if (tabBtn) {
            tabBtn.style.display = featureSettings[feature] ? 'inline-block' : 'none';
        }
    });

    const activeTab = document.querySelector('.tab.active');
    if (activeTab && activeTab.style.display === 'none') {
        const fallback = ['meds', 'bp', 'weight', 'workouts', 'food', 'settings']
            .find(tab => {
                if (tab === 'settings') return true;
                const feature = tabToFeature[tab];
                return !!featureSettings[feature];
            }) || 'settings';
        switchTab(fallback);
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
    const activeTab = document.querySelector('.tab.active');
    if (!activeTab) return;

    const tab = activeTab.dataset.tab;
    if (tab === 'meds') {
        const activeMedTab = document.querySelector('.med-tab.active');
        const medTab = activeMedTab ? activeMedTab.dataset.tab : 'history';
        if (medTab === 'schedule') { loadMeds(); }
        else { loadHistory(); }
    } else if (tab === 'bp') { loadBPReadings(); }
    else if (tab === 'weight') { loadWeightLogs(); }
    else if (tab === 'workouts') { loadWorkouts(); }
    else if (tab === 'food') { loadFoodLogs(); }
    else if (tab === 'health') { loadHealthOverview(); }
    else if (tab === 'settings') { loadSettings(); }
}

// Expose for sync manager
window.reloadCurrentTab = reloadCurrentTab;


function showAddModal() {
    editingMedId = null;
    window.ModalManager.med.open();

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
    toggleScheduleFields();

    const timeContainer = document.getElementById('time-inputs');
    timeContainer.replaceChildren();
    addTimeInput(); // One empty input

    // Clear days
    document.querySelectorAll('#days-container .days-select span').forEach(s => s.classList.remove('selected'));
}

function showEditModal(id) {
    editingMedId = id;
    const med = medications.find(m => m.id === id);
    if (!med) return;

    window.ModalManager.med.open();

    // Fill inputs
    document.getElementById('med-name').value = med.name;
    document.getElementById('med-dosage').value = med.dosage;
    document.getElementById('med-archived').checked = med.archived || false;
    document.getElementById('med-supplement').checked = med.supplement || false;

    // Show RxNorm
    const rxDisplay = document.getElementById('med-rx-display');
    if (med.normalized_name) {
        rxDisplay.innerText = "Rx: " + med.normalized_name;
        rxDisplay.style.display = 'block';
    } else {
        rxDisplay.style.display = 'none';
    }

    // Dates (ISO string to YYYY-MM-DD)
    document.getElementById('med-start-date').value = med.start_date ? med.start_date.split('T')[0] : '';
    document.getElementById('med-end-date').value = med.end_date ? med.end_date.split('T')[0] : '';

    // Inventory tracking
    const hasInventory = med.inventory_count !== null && med.inventory_count !== undefined;
    document.getElementById('med-track-inventory').checked = hasInventory;
    document.getElementById('med-inventory-count').value = hasInventory ? med.inventory_count : '';
    if (hasInventory) {
        document.getElementById('inventory-fields').classList.remove('hidden');
        document.getElementById('restock-section').style.display = 'block';
        loadRestockHistory(id);
    } else {
        document.getElementById('inventory-fields').classList.add('hidden');
        document.getElementById('restock-section').style.display = 'none';
        document.getElementById('restock-history').replaceChildren();
    }

    // Parse schedule
    let sched;
    try {
        sched = JSON.parse(med.schedule);
    } catch (e) {
        // Legacy format
        sched = { type: 'daily', times: [med.schedule] };
    }

    document.getElementById('schedule-type').value = sched.type;
    toggleScheduleFields();

    // Set times
    const timeContainer = document.getElementById('time-inputs');
    timeContainer.replaceChildren();
    if (sched.times && sched.times.length > 0) {
        sched.times.forEach(t => addTimeInput(t));
    } else {
        addTimeInput();
    }

    // Set days
    document.querySelectorAll('#days-container .days-select span').forEach(s => s.classList.remove('selected'));
    if (sched.days) {
        sched.days.forEach(d => {
            const span = document.querySelector(`#days-container .days-select span[data-day="${d}"]`);
            if (span) span.classList.add('selected');
        });
    }
}

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
    div.className = 'time-row';

    const input = document.createElement('input');
    input.type = 'time';
    input.className = 'med-time-input';
    input.value = value;

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'remove-time';
    removeButton.textContent = '×';
    removeButton.addEventListener('click', () => {
        removeTime(removeButton);
    });

    div.appendChild(input);
    div.appendChild(removeButton);
    container.appendChild(div);
}

function removeTime(btn) {
    btn.parentElement.remove();
}

function parseMedicationSchedule(rawSchedule) {
    try {
        return JSON.parse(rawSchedule);
    } catch (e) {
        return null;
    }
}

function getNextScheduledDate(schedule, now = new Date()) {
    if (!schedule) return null;

    const parseCandidate = (baseDate, timeStr) => {
        const [h, min] = String(timeStr).split(':').map(Number);
        if (Number.isNaN(h) || Number.isNaN(min)) return null;
        const candidate = new Date(baseDate);
        candidate.setHours(h, min, 0, 0);
        return candidate;
    };

    if (schedule.type === 'daily' && Array.isArray(schedule.times)) {
        const candidates = schedule.times
            .map((timeStr) => {
                const candidate = parseCandidate(now, timeStr);
                if (!candidate) return null;
                if (candidate <= now) {
                    candidate.setDate(candidate.getDate() + 1);
                }
                return candidate;
            })
            .filter(Boolean);
        return candidates.sort((a, b) => a - b)[0] || null;
    }

    if (schedule.type === 'weekly' && Array.isArray(schedule.days) && Array.isArray(schedule.times)) {
        const candidates = [];
        for (let i = 0; i < 8; i++) {
            const dayBase = new Date(now);
            dayBase.setDate(now.getDate() + i);
            if (!schedule.days.includes(dayBase.getDay())) continue;

            schedule.times.forEach((timeStr) => {
                const candidate = parseCandidate(dayBase, timeStr);
                if (candidate && candidate > now) {
                    candidates.push(candidate);
                }
            });
        }
        return candidates.sort((a, b) => a - b)[0] || null;
    }

    return null;
}

function getMedicationScheduleText(med, schedule) {
    if (!schedule) {
        return escapeHtml(med.schedule);
    }

    if (schedule.type === 'daily') {
        const times = Array.isArray(schedule.times) ? schedule.times : [];
        return `Daily: ${times.join(', ')}`;
    }

    if (schedule.type === 'weekly') {
        const daysMap = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const days = Array.isArray(schedule.days) ? schedule.days : [];
        const times = Array.isArray(schedule.times) ? schedule.times : [];
        const dayNames = days.map((day) => daysMap[day]);
        return `Weekly (${dayNames.join(', ')}): ${times.join(', ')}`;
    }

    return 'As Needed';
}

function getLastTakenTimeMs(medication) {
    return medication.last_taken_at ? new Date(medication.last_taken_at).getTime() : 0;
}

// Render
// Render
function renderMeds() {
    const list = document.getElementById('med-list');
    list.replaceChildren();
    const now = new Date();

    // Buckets
    const scheduledSoon = [];
    const recentTaken = []; // Recurring but not soon (taken today/yesterday)
    const asNeeded = [];
    const archived = [];

    medications.forEach((med) => {
        const schedule = parseMedicationSchedule(med.schedule);
        const scheduleType = schedule?.type || 'daily';

        if (med.archived) {
            archived.push({ med, schedule, next: null });
            return;
        }

        if (scheduleType === 'as_needed') {
            asNeeded.push({ med, schedule, next: null });
        } else {
            const next = getNextScheduledDate(schedule, now);
            const hoursUntil = next ? (next - new Date()) / (1000 * 60 * 60) : 999;

            if (hoursUntil < 14) {
                scheduledSoon.push({ med, schedule, next });
            } else {
                recentTaken.push({ med, schedule, next });
            }
        }
    });

    // Sort Buckets
    scheduledSoon.sort((a, b) => (a.next || 0) - (b.next || 0));

    // Recent Taken: Recent logs first
    const sortByTaken = (a, b) => {
        return getLastTakenTimeMs(b.med) - getLastTakenTimeMs(a.med);
    };

    recentTaken.sort(sortByTaken);
    asNeeded.sort(sortByTaken);
    archived.sort(sortByTaken);

    // Combine
    const sorted = [...scheduledSoon, ...recentTaken, ...asNeeded, ...archived];

    sorted.forEach(({ med, schedule: parsedSchedule }) => {
        const div = document.createElement('div');
        div.className = 'med-item';
        if (med.archived) div.classList.add('archived');

        const scheduleText = getMedicationScheduleText(med, parsedSchedule);

        const info = document.createElement('div');
        info.className = 'med-info';
        info.style.cursor = 'pointer';
        info.addEventListener('click', () => {
            showEditModal(med.id);
        });

        const title = document.createElement('h4');
        title.textContent = `${med.name} `;
        const dosage = document.createElement('small');
        dosage.textContent = `(${med.dosage})`;
        title.appendChild(dosage);
        if (med.supplement) {
            const supplementBadge = document.createElement('small');
            supplementBadge.style.cssText = 'margin-left:6px;color:var(--hint-color);';
            supplementBadge.textContent = '[Supplement]';
            title.appendChild(supplementBadge);
        }
        info.appendChild(title);

        if (med.normalized_name) {
            const normalized = document.createElement('p');
            normalized.style.cssText = 'font-size:0.85em;color:var(--hint-color);margin-top:-5px;margin-bottom:4px;';
            normalized.textContent = `Rx: ${med.normalized_name}`;
            info.appendChild(normalized);
        }

        const scheduleLine = document.createElement('p');
        scheduleLine.textContent = `Schedule: ${scheduleText}`;
        info.appendChild(scheduleLine);

        if (med.start_date || med.end_date) {
            const start = med.start_date ? formatDate(med.start_date).split(' ')[0] : 'N/A';
            const end = med.end_date ? formatDate(med.end_date).split(' ')[0] : 'N/A';
            const dates = document.createElement('p');
            dates.textContent = `Dates: ${start} - ${end}`;
            info.appendChild(dates);
        }

        if (med.inventory_count !== null && med.inventory_count !== undefined) {
            const isLow = isLowOnStock(med);
            const inventory = document.createElement('p');
            inventory.className = `inventory-badge ${isLow ? 'low' : ''}`.trim();
            inventory.textContent = `📦 ${med.inventory_count} doses${isLow ? ' ⚠️' : ''}`;
            info.appendChild(inventory);
        }

        const actions = document.createElement('div');
        actions.className = 'med-actions';
        const logBtn = document.createElement('button');
        logBtn.type = 'button';
        logBtn.className = 'small-btn secondary';
        logBtn.textContent = 'Log';
        logBtn.addEventListener('click', () => {
            logMedicationPast(med.id, med.name);
        });

        const editBtn = createEditButton(() => {
            showEditModal(med.id);
        });

        const deleteBtn = createDeleteButton(() => {
            deleteMed(med.id);
        });

        const actionIcons = document.createElement('div');
        actionIcons.style.display = 'flex';
        actionIcons.style.gap = '8px';
        actionIcons.appendChild(editBtn);
        actionIcons.appendChild(deleteBtn);

        actions.appendChild(logBtn);
        actions.appendChild(actionIcons);
        div.appendChild(info);
        div.appendChild(actions);
        list.appendChild(div);
    });
}

function logMedicationPast(id, name) {
    showMedicationConfirmModal([id], [name], new Date(), 'log_past');
}


function renderHistory(logs) {
    const list = document.getElementById('history-list');
    list.replaceChildren();

    if (!logs || logs.length === 0) {
        const empty = document.createElement('p');
        empty.style.cssText = 'text-align:center;color:var(--hint-color)';
        empty.textContent = 'No history yet.';
        list.appendChild(empty);
        return;
    }

    // Group logs by taken_at timestamp (formatted to minute precision)
    const groups = [];
    // Helper for European Date Format (DD.MM.YYYY HH:MM)
    /* formatDate is now global */

    logs.forEach(l => {
        let key = l.scheduled_at; // Default key
        let timeLabel = formatDate(l.scheduled_at);

        // If taken, use taken_at as grouping key
        if (l.status === 'TAKEN' && l.taken_at) {
            const d = new Date(l.taken_at);
            // Key is string to minute precision
            key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()} ${d.getHours()}:${d.getMinutes()}`;
            timeLabel = formatDate(l.taken_at);
        }

        // Check if group exists
        let grp = groups.find(g => g.key === key && g.status === l.status);
        if (!grp) {
            grp = { key, status: l.status, timeLabel, items: [], sortTime: 0 };

            // Determine sort time
            if (l.status === 'TAKEN' && l.taken_at) {
                grp.sortTime = new Date(l.taken_at).getTime();
            } else {
                grp.sortTime = new Date(l.scheduled_at).getTime();
            }

            groups.push(grp);
        }
        grp.items.push(l);
    });

    // Sort Groups Descending (Most Recent First)
    groups.sort((a, b) => b.sortTime - a.sortTime);

    // Render Groups
    groups.forEach(g => {
        const div = document.createElement('div');
        div.className = 'history-group';

        // Make PENDING and TAKEN items clickable
        if (g.status === 'PENDING' || g.status === 'TAKEN') {
            div.style.cursor = 'pointer';
            div.onclick = () => {
                // Collect med ids and names
                const ids = g.items.map(i => i.medication_id);
                const names = g.items.map(i => {
                    const med = medications.find(m => m.id === i.medication_id);
                    return med ? med.name : 'Unknown';
                });

                // Collect intake IDs for updating specific rows
                const intakeIds = g.items.map(i => i.id);

                // Determine mode and time
                const mode = g.status === 'TAKEN' ? 'edit' : 'confirm';
                // Use the group key (which is formatted time) or a raw timestamp if available
                // For editing, we want the actual taken time to populate the input
                let time = g.key;
                if (mode === 'edit' && g.items[0].taken_at) {
                    time = g.items[0].taken_at;
                } else if (g.items[0].scheduled_at) {
                    time = g.items[0].scheduled_at;
                }

                showMedicationConfirmModal(ids, names, time, mode, intakeIds);
            };
        }

        const statusIcon = g.status === 'TAKEN' ? '✅' : (g.status === 'PENDING' ? '⏳' : '❌');
        // Better header formatting
        let headerTime = g.timeLabel;
        if (g.status === 'TAKEN') {
            // If taken, maybe show "Taken at HH:MM"
            // But timeLabel is already formatted.
        }

        const header = document.createElement('div');
        header.className = 'history-header';
        const strong = document.createElement('strong');
        strong.textContent = `${statusIcon} ${headerTime}`;
        header.appendChild(strong);

        const items = document.createElement('div');
        items.className = 'history-items';
        g.items.forEach((l) => {
            const med = medications.find(m => m.id === l.medication_id);
            const medName = med ? med.name : 'Unknown Med';
            const subitem = document.createElement('div');
            subitem.className = 'history-subitem';
            subitem.textContent = medName;
            items.appendChild(subitem);
        });

        div.appendChild(header);
        div.appendChild(items);
        list.appendChild(div);
    });
}

function escapeHtml(text) {
    if (!text) return "";
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Logic
async function loadMeds() {
    if (initialAuthLoad) {
        initialAuthLoad = false;
        // medications already set from auth; cache and render immediately
        await window.DataStore.setCached('medications', medications);
        if (window.MedTrackerDB?.MedicationStore) {
            await window.MedTrackerDB.MedicationStore.saveCache(medications);
        }
        renderMeds();
        populateMedFilter();
        // Refresh in background to ensure up-to-date data
        const res = await window.DataStore.fetchFresh(
            'medications',
            async () => await apiCall('/api/medications?archived=true'),
            ['medications']
        );
        if (res) {
            medications = res;
            await window.DataStore.setCached('medications', medications);
            if (window.MedTrackerDB?.MedicationStore) {
                await window.MedTrackerDB.MedicationStore.saveCache(medications);
            }
            renderMeds();
            populateMedFilter();
        }
        return;
    }

    await window.DataStore.loadSWR({
        key: 'medications',
        tags: ['medications'],
        fetcher: async () => await apiCall('/api/medications?archived=true'),
        onCached: async (cached) => {
            medications = cached;
            renderMeds();
            populateMedFilter();
        },
        onFresh: async (fresh) => {
            medications = fresh;
            if (window.MedTrackerDB?.MedicationStore) {
                await window.MedTrackerDB.MedicationStore.saveCache(medications);
            }
            renderMeds();
            populateMedFilter();
        },
        onError: async (_err, cached) => {
            if (cached) return;
            // API failed and no ApiCache hit; fall back to offline cache
            if (window.MedTrackerDB?.MedicationStore) {
                const offlineCached = await window.MedTrackerDB.MedicationStore.getCache();
                if (offlineCached) {
                    console.log('[Meds] Loaded from offline cache:', offlineCached.length);
                    medications = offlineCached;
                    renderMeds();
                    populateMedFilter();
                }
            }
        }
    });
}

function populateMedFilter() {
    const select = document.getElementById('history-filter-med');
    if (!select) return;
    const currentVal = select.value;

    // Keep "All Medications"
    const allOpt = document.createElement('option');
    allOpt.value = "0";
    allOpt.textContent = "All Medications";
    select.replaceChildren(allOpt);

    // Filter to only include meds taken in the last 7 days
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 7);

    const activeMeds = medications.filter(m => {
        if (!m.last_taken_at) return false;
        const lastTaken = new Date(m.last_taken_at);
        return lastTaken >= cutoffDate;
    });

    // Sort alphabetically
    const sorted = activeMeds.sort((a, b) => a.name.localeCompare(b.name));

    sorted.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name + (m.archived ? ' (Archived)' : '');
        select.appendChild(opt);
    });

    if (Array.from(select.options).some(o => o.value === currentVal)) {
        select.value = currentVal;
    } else {
        select.value = "0";
    }
}

async function saveMedication() {
    const name = document.getElementById('med-name').value;
    const dosage = document.getElementById('med-dosage').value;
    const type = document.getElementById('schedule-type').value;
    const archived = document.getElementById('med-archived').checked;
    const supplement = document.getElementById('med-supplement').checked;

    const startDateRaw = document.getElementById('med-start-date').value;
    const endDateRaw = document.getElementById('med-end-date').value;

    // Inventory tracking
    const trackInventory = document.getElementById('med-track-inventory').checked;
    const inventoryCountRaw = document.getElementById('med-inventory-count').value;
    let inventoryCount = null;
    if (trackInventory && inventoryCountRaw !== '') {
        inventoryCount = parseInt(inventoryCountRaw);
    }

    if (!name) { safeAlert("Name is required!"); return; }

    const schedule = { type: type };

    if (type !== 'as_needed') {
        const times = Array.from(document.querySelectorAll('.med-time-input'))
            .map(i => i.value)
            .filter(v => v !== "");

        if (times.length === 0) {
            safeAlert("At least one time is required!");
            return;
        }
        schedule.times = times;
    }

    if (type === 'weekly') {
        const days = Array.from(document.querySelectorAll('.days-select span.selected'))
            .map(s => parseInt(s.dataset.day));

        if (days.length === 0) {
            safeAlert("Select at least one day!");
            return;
        }
        schedule.days = days;
    }

    const payload = {
        name,
        dosage,
        schedule: JSON.stringify(schedule),
        archived,
        supplement,
        start_date: startDateRaw ? new Date(startDateRaw).toISOString() : null,
        end_date: endDateRaw ? new Date(endDateRaw).toISOString() : null,
        inventory_count: inventoryCount
    };

    const btn = document.getElementById('med-modal-save-btn');
    await withSubmit(btn, async () => {
        let res;
        if (editingMedId) {
            res = await apiCall(`/api/medications/${editingMedId}`, 'POST', payload);
        } else {
            res = await apiCall('/api/medications', 'POST', payload);
        }

        if (res && res.warning) {
            safeAlert("⚠️ " + res.warning);
        }

        await window.DataStore.invalidateTags(['medications', 'history']);
        await window.DataStore.invalidateKey('next_intake');

        closeModal();
        loadMeds();
    });
}

async function deleteMed(id) {
    const med = medications.find(m => m.id === id);
    if (!med) return;

    if (med.archived) {
        const confirmMsg = "Delete this medication permanently?";
        await safeConfirm(confirmMsg, async (ok) => {
            if (ok) {
                const res = await apiCall(`/api/medications/${id}`, 'DELETE');
                if (res !== null) { // Success
                    await window.DataStore.invalidateTags(['medications', 'history']);
                    await window.DataStore.invalidateKey('next_intake');
                    loadMeds();
                } else {
                    // It returns null on error and safeAlert is already handled by apiCall
                    // However, we can add a specific catch-all just in case, or trust apiCall.
                    // Let's trust apiCall since it already alerts the error message.
                }
            }
        });
    } else {
        const confirmMsg = "Archive this medication?";
        await safeConfirm(confirmMsg, async (ok) => {
            if (ok) await _archiveMedApi(id);
        });
    }
}

async function _archiveMedApi(id) {
    // Fetch current med data first to preserve other fields
    const med = medications.find(m => m.id === id);
    if (!med) return;

    const payload = {
        name: med.name,
        dosage: med.dosage,
        schedule: med.schedule,
        supplement: !!med.supplement,
        archived: true // Set archived to true
    };

    const res = await apiCall(`/api/medications/${id}`, 'POST', payload);
    if (res && res.warning) {
        safeAlert("⚠️ " + res.warning);
    }
    await window.DataStore.invalidateTags(['medications', 'history']);
    await window.DataStore.invalidateKey('next_intake');
    loadMeds();
}

async function loadHistory() {
    // Ensure medications are loaded for name resolution
    // populateMedFilter() is called inside loadMeds(), so only call it explicitly
    // when loadMeds() is skipped (medications pre-loaded from bootstrap)
    if (medications.length === 0) await loadMeds();
    else populateMedFilter();

    const days = document.getElementById('history-filter-days').value;
    const medId = document.getElementById('history-filter-med').value;

    const cacheKey = `history_${days}_${medId}`;

    await window.DataStore.loadSWR({
        key: cacheKey,
        tags: ['history'],
        fetcher: async () => await apiCall(`/api/history?days=${days}&med_id=${medId}`),
        allowNullFresh: true,
        onCached: async (cached) => {
            renderHistory(cached);
        },
        onFresh: async (fresh) => {
            if (fresh && window.MedTrackerDB?.IntakeHistoryStore) {
                await window.MedTrackerDB.IntakeHistoryStore.saveCache(cacheKey, fresh);
            }
            renderHistory(fresh || []);
        },
        onError: async (_err, cached) => {
            if (!cached) renderHistory([]);
        }
    });
    renderNextIntakeTrigger();
}

async function renderNextIntakeTrigger() {
    const container = document.getElementById('next-intake-trigger');
    if (!container) return;

    try {
        const res = await window.DataStore.fetchFresh(
            'next_intake',
            async () => await apiCall('/api/medications/next-intake', 'GET'),
            ['history', 'medications']
        );

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

        const card = document.createElement('div');
        card.style.cssText = 'background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center;';

        const body = document.createElement('div');
        const title = document.createElement('div');
        title.style.cssText = 'font-size: 14px; font-weight: 600; margin-bottom: 4px;';
        title.textContent = 'Next scheduled intake';
        const details = document.createElement('div');
        details.style.cssText = 'font-size: 12px; opacity: 0.9;';
        details.textContent = `${medNamesStr} at ${timeStr}`;
        body.appendChild(title);
        body.appendChild(details);

        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'btn-pill';
        action.style.cssText = 'background: rgba(255,255,255,0.25); color: white; white-space: nowrap;';
        action.textContent = 'Take Now';
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
        const ids = params.get('ids') ? params.get('ids').split(',') : [];
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

let pendingMedConfirmIds = [];
let pendingMedConfirmScheduled = null;
let pendingWorkoutSessionId = null;
let pendingMedConfirmMode = 'confirm'; // 'confirm' or 'edit'
let pendingMedConfirmIntakeIds = []; // For edit mode

function showMedicationConfirmModal(ids, names, scheduledAt, mode = 'confirm', intakeIds = []) {
    pendingMedConfirmIds = ids;
    pendingMedConfirmScheduled = scheduledAt;
    pendingMedConfirmMode = mode;
    pendingMedConfirmIntakeIds = intakeIds;

    window.ModalManager.medConfirm.open();

    const titleEl = document.getElementById('med-confirm-title');
    const subtitleEl = document.getElementById('med-confirm-subtitle');
    const timeEditEl = document.getElementById('med-confirm-time-edit');
    const timeInput = document.getElementById('med-confirm-datetime');
    const actionBtn = document.getElementById('med-confirm-action-btn');
    const snoozeBtn = document.getElementById('med-confirm-snooze-btn');

    // UI based on mode
    if (mode === 'edit' || mode === 'log_past') {
        titleEl.innerText = mode === 'edit' ? "Edit Intake" : "Log Intake";
        subtitleEl.innerText = "";
        timeEditEl.style.display = 'block';

        // Set time input (handling both ISO strings and formatted strings if parsable)
        try {
            timeInput.value = formatDateTimeLocalForInput(scheduledAt);
        } catch (e) {
            console.error("Error formatting date for input", e);
        }

        actionBtn.innerText = mode === 'edit' ? "Update" : "Log Intake";
        actionBtn.onclick = mode === 'edit' ? updateIntakeHistory : confirmLogPast;
        snoozeBtn.style.display = 'none';

    } else {

        // Confirm Mode
        titleEl.innerText = "Time for Meds!";
        timeEditEl.style.display = 'none';

        // Format time display
        let timeStr = scheduledAt;
        try {
            const d = new Date(scheduledAt);
            timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch (e) { }
        subtitleEl.innerText = "Scheduled for: " + timeStr;

        actionBtn.innerText = "Confirm Selected";
        actionBtn.onclick = confirmSelectedMedications;
        snoozeBtn.style.display = 'inline-block';
    }

    const list = document.getElementById('med-confirm-list');
    list.replaceChildren();

    ids.forEach((id, index) => {
        const name = names[index] || ('Medication ' + id);

        const div = document.createElement('div');
        div.className = 'form-row';
        div.style.marginBottom = '10px';

        const label = document.createElement('label');
        label.className = 'checkbox-label';
        label.style.fontWeight = '500';

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = String(id);
        input.checked = true;
        input.className = 'med-confirm-check';

        label.appendChild(input);
        label.appendChild(document.createTextNode(` ${name}`));
        div.appendChild(label);
        list.appendChild(div);
    });
}

function closeMedicationConfirmModal() {
    window.ModalManager.medConfirm.close();
}

async function confirmSelectedMedications() {
    const checks = document.querySelectorAll('.med-confirm-check:checked');
    const selectedIds = Array.from(checks).map(c => parseInt(c.value));

    const btn = document.getElementById('med-confirm-action-btn');
    await withSubmit(btn, async () => {
        const res = await apiCall('/api/medications/confirm-schedule', 'POST', {
            scheduled_at: pendingMedConfirmScheduled,
            medication_ids: selectedIds
        });

        if (res) {
            safeAlert("Confirmed!");
            loadMeds();
            loadHistory();
        }

        closeMedicationConfirmModal();
    });
}

async function updateIntakeHistory() {
    const checks = document.querySelectorAll('.med-confirm-check');
    const selectedIds = [];
    const unselectedIds = [];

    checks.forEach(c => {
        const medId = parseInt(c.value);
        if (c.checked) {
            selectedIds.push(medId);
        } else {
            unselectedIds.push(medId);
        }
    });

    const timeInput = document.getElementById('med-confirm-datetime');
    const takenAt = new Date(timeInput.value).toISOString();

    const updates = [];

    // Map medication IDs back to intake IDs if possible. 
    // We have pendingMedConfirmIds (order matches pendingMedConfirmIntakeIds)
    // We need to find the intake ID for each medication ID.

    // For selected items (TAKEN)
    selectedIds.forEach(medId => {
        const idx = pendingMedConfirmIds.indexOf(medId);
        if (idx !== -1 && pendingMedConfirmIntakeIds[idx]) {
            updates.push({
                id: pendingMedConfirmIntakeIds[idx],
                status: 'TAKEN',
                taken_at: takenAt
            });
        }
    });

    // For unselected items (PENDING - Reverting)
    unselectedIds.forEach(medId => {
        const idx = pendingMedConfirmIds.indexOf(medId);
        if (idx !== -1 && pendingMedConfirmIntakeIds[idx]) {
            updates.push({
                id: pendingMedConfirmIntakeIds[idx],
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
        const res = await apiCall('/api/intakes/update', 'POST', { updates });
        if (res) { // status 200 assumed
            safeAlert("Updated!");
            loadMeds(); // Stocks might change
            loadHistory();
        }
        closeMedicationConfirmModal();
    });
}

async function confirmLogPast() {
    const timeInput = document.getElementById('med-confirm-datetime');
    const takenAt = new Date(timeInput.value).toISOString();

    // In log_past mode, we only support one med at a time for simplicity in this UI
    const medId = pendingMedConfirmIds[0];

    const btn = document.getElementById('med-confirm-action-btn');
    await withSubmit(btn, async () => {
        const res = await apiCall('/api/medications/log-past', 'POST', {
            medication_id: medId,
            taken_at: takenAt
        });

        if (res) {
            safeAlert("Intake logged!");
            loadMeds();
            loadHistory();
        }

        closeMedicationConfirmModal();
    });
}



function snoozeMedicationConfirm() {
    closeMedicationConfirmModal();
}

function showWorkoutStartModal(sessionId) {
    pendingWorkoutSessionId = sessionId;
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
    if (!pendingWorkoutSessionId) return;
    const btn = document.getElementById(`workout-start-snooze-${minutes}-btn`);
    await withSubmit(btn, async () => {
        const res = await apiCall(`/api/workout/sessions/${pendingWorkoutSessionId}/snooze`, 'POST', { minutes: minutes });
        if (res) safeAlert(`Snoozed for ${minutes} minutes`);
        closeWorkoutStartModal();
    });
}

async function skipWorkout() {
    if (!pendingWorkoutSessionId) return;
    await safeConfirm("Are you sure you want to skip this workout?", async (ok) => {
        if (!ok) return;

        const res = await apiCall(`/api/workout/sessions/${pendingWorkoutSessionId}/skip`, 'POST');
        if (res) {
            safeAlert("Workout skipped");
            loadWorkouts();
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
            headers: { 'X-Telegram-Init-Data': userInitData }
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
    if (res && window.DataStore) {
        const cached = await window.DataStore.getCached('settings_bundle');
        if (cached) {
            cached.tabOrder = order;
            await window.DataStore.setCached('settings_bundle', cached);
        }
    }
};

// Initialize drag and drop for tabs if loaded
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        if (typeof window.initTabsDragAndDrop === 'function') {
            window.initTabsDragAndDrop(document.getElementById('tabs'), async (order) => {
                if (typeof window.saveTabOrder === 'function') {
                    await window.saveTabOrder(order);
                }
            });
        }
    }, { once: true });
} else {
    if (typeof window.initTabsDragAndDrop === 'function') {
        window.initTabsDragAndDrop(document.getElementById('tabs'), async (order) => {
            if (typeof window.saveTabOrder === 'function') {
                await window.saveTabOrder(order);
            }
        });
    }
}

// Swipe gesture navigation between tabs
(function initSwipeNav() {
    const MIN_SWIPE_X = 60;  // minimum horizontal distance to trigger tab switch
    const MAX_SWIPE_Y = 80;  // maximum vertical drift allowed (to avoid hijacking scroll)
    let touchStartX = 0;
    let touchStartY = 0;

    function getVisibleTabs() {
        return Array.from(document.querySelectorAll('#tabs .tab'))
            .filter(t => t.style.display !== 'none');
    }

    document.addEventListener('touchstart', (e) => {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
    }, { passive: true });

    document.addEventListener('touchend', (e) => {
        const dx = e.changedTouches[0].clientX - touchStartX;
        const dy = e.changedTouches[0].clientY - touchStartY;

        if (Math.abs(dx) < MIN_SWIPE_X || Math.abs(dy) > MAX_SWIPE_Y) return;

        // Ignore swipes that start inside a modal or scrollable list
        const target = e.target;
        if (target.closest('.modal, .modal-overlay, select, input, textarea')) return;

        const tabs = getVisibleTabs();
        const activeTab = document.querySelector('#tabs .tab.active');
        if (!activeTab) return;

        const currentIndex = tabs.indexOf(activeTab);
        if (currentIndex === -1) return;

        // Swipe left → next tab; swipe right → previous tab
        const nextIndex = dx < 0 ? currentIndex + 1 : currentIndex - 1;
        if (nextIndex < 0 || nextIndex >= tabs.length) return;

        switchTab(tabs[nextIndex].dataset.tab);
    }, { passive: true });
})();

// Modal back-gesture integration lives in features/modal-history.js.

// --- Health Overview ---
function renderHealthOverviewContent(content, data) {
    content.replaceChildren();

    const renderVitalGroup = (id, title, history, color, min, max, stat7d, stat30d, unit) => {
        if (history && history.length > 0) {
            const wrapper = document.createElement('div');
            wrapper.style.cssText = 'margin-top: 25px; padding: 10px 0;';

            const h3 = document.createElement('h3');
            h3.style.marginBottom = '5px';
            h3.textContent = title;

            const chartContainer = document.createElement('div');
            chartContainer.id = id + 'ChartContainer';
            chartContainer.style.cssText = 'height: 200px; width: 100%;';

            const statDiv = document.createElement('div');
            statDiv.style.cssText = 'font-size: 12px; color: var(--hint-color); text-align: center; margin-top: 5px;';
            statDiv.textContent = `${stat7d} ${unit} (7d avg) | ${stat30d} ${unit} (30d avg)`;

            wrapper.appendChild(h3);
            wrapper.appendChild(chartContainer);
            wrapper.appendChild(statDiv);
            content.appendChild(wrapper);

            setTimeout(() => renderVitalsLineChart(id + 'ChartContainer', history, color, min, max), 0);
        }
    };

    if (data.sleep_stats_7d && data.sleep_stats_7d.length > 0) {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'margin-top: 25px; padding: 10px 0;';

        const h3 = document.createElement('h3');
        h3.style.marginBottom = '5px';
        h3.textContent = 'Sleep';

        const chartContainer = document.createElement('div');
        chartContainer.id = 'sleepChartContainer';
        chartContainer.style.cssText = 'height: 250px; width: 100%;';

        const legend = document.createElement('div');
        legend.style.cssText = 'font-size: 11px; display: flex; justify-content: center; gap: 10px; margin-top: 5px; color: var(--hint-color);';

        const createLegendItem = (color, text, isLine = false) => {
            const item = document.createElement('div');
            item.style.cssText = 'display:flex; align-items:center; gap:4px;';
            const badge = document.createElement('span');
            if (isLine) {
                badge.style.cssText = `display:inline-block; width:10px; height:2px; background:${color};`;
            } else {
                badge.style.cssText = `display:inline-block; width:10px; height:10px; background:${color}; border-radius:2px;`;
            }
            item.appendChild(badge);
            item.appendChild(document.createTextNode(text));
            return item;
        };

        legend.appendChild(createLegendItem('#5a2d9c', 'Deep'));
        legend.appendChild(createLegendItem('#2481cc', 'Light'));
        legend.appendChild(createLegendItem('#c161d9', 'REM'));
        legend.appendChild(createLegendItem('#e5b220', 'Awake'));
        legend.appendChild(createLegendItem('#ff3b30', 'HR', true));

        const statDiv = document.createElement('div');
        statDiv.style.cssText = 'font-size: 12px; color: var(--hint-color); text-align: center; margin-top: 10px;';
        statDiv.textContent = `${data.average_sleep_hours_7d.toFixed(1)} hrs (7d avg) | ${data.average_sleep_hours_30d.toFixed(1)} hrs (30d avg)`;

        wrapper.appendChild(h3);
        wrapper.appendChild(chartContainer);
        wrapper.appendChild(legend);
        wrapper.appendChild(statDiv);
        content.appendChild(wrapper);

        setTimeout(() => renderSleepChart(data.sleep_stats_7d), 0);
    }

    if (data.step_stats_7d && data.step_stats_7d.length > 0) {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'margin-top: 25px; padding: 10px 0;';

        const h3 = document.createElement('h3');
        h3.style.marginBottom = '5px';
        h3.textContent = 'Steps';

        const chartContainer = document.createElement('div');
        chartContainer.id = 'stepsChartContainer';
        chartContainer.style.cssText = 'height: 250px; width: 100%;';

        const statDiv = document.createElement('div');
        statDiv.style.cssText = 'font-size: 12px; color: var(--hint-color); text-align: center; margin-top: 10px;';
        statDiv.textContent = `${data.average_steps_7d.toLocaleString()} steps (7d avg) | ${data.average_steps_30d.toLocaleString()} steps (30d avg)`;

        wrapper.appendChild(h3);
        wrapper.appendChild(chartContainer);
        wrapper.appendChild(statDiv);
        content.appendChild(wrapper);

        setTimeout(() => renderStepsChart(data.step_stats_7d), 0);
    }

    renderVitalGroup('heartRate', 'Heart Rate', data.heart_rate_history_7d, '#ff3b30', 40, 160, data.average_heart_rate_7d, data.average_heart_rate_30d, 'bpm');
    renderVitalGroup('spo2', 'SpO2', data.spo2_history_7d, '#32ade6', 85, 100, data.average_spo2_7d, data.average_spo2_30d, '%');
    renderVitalGroup('stress', 'Stress Level', data.stress_history_7d, '#ff9500', 0, 100, data.average_stress_7d, data.average_stress_30d, '/ 100');

    const disclaimer = document.createElement('p');
    disclaimer.style.cssText = 'font-size: 12px; color: var(--hint-color); text-align: center; margin-top: 30px;';
    disclaimer.textContent = 'This data is gathered from your synced .nxk backups.';
    content.appendChild(disclaimer);
}

function renderHealthOverviewError(content) {
    const errP = document.createElement('p');
    errP.style.color = 'red';
    errP.textContent = 'Failed to load health metrics';
    content.replaceChildren(errP);
    content.classList.remove('hidden');
}

async function loadHealthOverview() {
    const content = document.getElementById('health-overview-content');
    const loading = document.getElementById('health-overview-loading');
    if (!content || !loading) return;

    loading.style.display = 'block';

    await window.DataStore.loadSWR({
        key: 'health_overview',
        tags: ['health'],
        fetcher: async () => await apiCall('/api/health/overview', 'GET'),
        allowNullFresh: true,
        onCached: async (cached) => {
            if (!cached) return;
            renderHealthOverviewContent(content, cached);
            loading.style.display = 'none';
            content.classList.remove('hidden');
        },
        onFresh: async (fresh, cached) => {
            loading.style.display = 'none';
            if (!fresh) {
                if (!cached) {
                    renderHealthOverviewError(content);
                }
                return;
            }

            renderHealthOverviewContent(content, fresh);
            content.classList.remove('hidden');
        },
        onError: async (e, cached) => {
            console.error('Failed to load health overview:', e);
            loading.style.display = 'none';
            if (!cached) {
                renderHealthOverviewError(content);
            }
        }
    });
}

// Render generic line chart with min/max shaded area 
function renderVitalsLineChart(containerId, data, color, yMin, yMax) {
    const container = document.getElementById(containerId);
    if (!container || !data || data.length === 0) return;

    const totalWidth = container.clientWidth;
    const leftPadding = 35;
    const rightPadding = 10;
    const topPadding = 20;
    const bottomPadding = 30;

    const chartWidth = totalWidth - leftPadding - rightPadding;
    const chartHeight = container.clientHeight - topPadding - bottomPadding;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("viewBox", `0 0 ${totalWidth} ${container.clientHeight}`);
    svg.style.overflow = "visible";

    const minTime = data[0].timestamp;
    const maxTime = data[data.length - 1].timestamp;
    const timeRange = Math.max(maxTime - minTime, 1);
    const valRange = Math.max(yMax - yMin, 1);

    // Y-Axis
    const ySteps = 4;
    for (let i = 0; i <= ySteps; i++) {
        const val = Math.round(yMin + (i / ySteps) * valRange);
        const y = topPadding + chartHeight - (i / ySteps) * chartHeight;

        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("x", leftPadding - 8);
        text.setAttribute("y", y + 4);
        text.setAttribute("text-anchor", "end");
        text.setAttribute("fill", "var(--hint-color)");
        text.setAttribute("font-size", "10px");
        text.textContent = val;
        svg.appendChild(text);

        const gridLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
        gridLine.setAttribute("x1", leftPadding);
        gridLine.setAttribute("y1", y);
        gridLine.setAttribute("x2", leftPadding + chartWidth);
        gridLine.setAttribute("y2", y);
        gridLine.setAttribute("stroke", "var(--hint-color)");
        gridLine.setAttribute("stroke-opacity", i === 0 ? "0.6" : "0.2");
        svg.appendChild(gridLine);
    }

    const getX = (ts) => leftPadding + ((ts - minTime) / timeRange) * chartWidth;
    const getY = (val) => {
        const clamped = Math.max(yMin, Math.min(yMax, val));
        return topPadding + chartHeight - ((clamped - yMin) / valRange) * chartHeight;
    };

    // Min/Max Area Shadow
    const areaPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    let dArea = "";
    // Forward path (Max)
    data.forEach((pt, i) => {
        const cx = getX(pt.timestamp);
        const cy = getY(pt.max);
        dArea += (i === 0 ? `M ${cx},${cy}` : ` L ${cx},${cy}`);
    });
    // Return path (Min)
    for (let i = data.length - 1; i >= 0; i--) {
        const cx = getX(data[i].timestamp);
        const cy = getY(data[i].min);
        dArea += ` L ${cx},${cy}`;
    }
    dArea += " Z";

    areaPath.setAttribute("d", dArea);
    areaPath.setAttribute("fill", color);
    areaPath.setAttribute("fill-opacity", "0.2");
    svg.appendChild(areaPath);

    // Average Line
    const avgLine = document.createElementNS("http://www.w3.org/2000/svg", "path");
    let dAvg = "";
    data.forEach((pt, i) => {
        const cx = getX(pt.timestamp);
        const cy = getY(pt.avg);
        dAvg += (i === 0 ? `M ${cx},${cy}` : ` L ${cx},${cy}`);
    });
    avgLine.setAttribute("d", dAvg);
    avgLine.setAttribute("fill", "none");
    avgLine.setAttribute("stroke", color);
    avgLine.setAttribute("stroke-width", "2");

    // Handle gaps if necessary: if consecutive points are > 3 hours apart, break line
    let currentPath = "";
    let paths = [];
    let lastTs = null;
    data.forEach((pt, i) => {
        const cx = getX(pt.timestamp);
        const cy = getY(pt.avg);

        if (lastTs !== null && (pt.timestamp - lastTs) > 3 * 3600 * 1000) {
            paths.push(currentPath);
            currentPath = `M ${cx},${cy}`;
        } else {
            currentPath += (currentPath === "" ? `M ${cx},${cy}` : ` L ${cx},${cy}`);
        }
        lastTs = pt.timestamp;
    });
    if (currentPath !== "") paths.push(currentPath);

    paths.forEach(p => {
        const pathObj = document.createElementNS("http://www.w3.org/2000/svg", "path");
        pathObj.setAttribute("d", p);
        pathObj.setAttribute("fill", "none");
        pathObj.setAttribute("stroke", color);
        pathObj.setAttribute("stroke-width", "2");
        // Optional: add linecap rounded
        pathObj.setAttribute("stroke-linecap", "round");
        pathObj.setAttribute("stroke-linejoin", "round");
        svg.appendChild(pathObj);
    });

    // X-Axis Date Labels 
    // Show around 4-5 labels along the axis
    const labelCount = 4;
    for (let i = 0; i <= labelCount; i++) {
        const ts = minTime + (timeRange * (i / labelCount));
        const dt = new Date(ts);
        const txt = `${dt.getMonth() + 1}/${dt.getDate()}`;

        const x = getX(ts);
        const y = topPadding + chartHeight + 15;

        const xLbl = document.createElementNS("http://www.w3.org/2000/svg", "text");
        xLbl.setAttribute("x", x);
        xLbl.setAttribute("y", y);
        xLbl.setAttribute("text-anchor", "middle");
        xLbl.setAttribute("fill", "var(--hint-color)");
        xLbl.setAttribute("font-size", "11px");
        xLbl.textContent = txt;
        svg.appendChild(xLbl);
    }

    container.appendChild(svg);
}

// Render stacked bar chart for sleep
function renderSleepChart(stats) {
    const container = document.getElementById('sleepChartContainer');
    if (!container) return;

    const totalWidth = container.clientWidth;
    const leftPadding = 35;
    const rightPadding = 20;
    const topPadding = 20;
    const bottomPadding = 30;

    const chartWidth = totalWidth - leftPadding - rightPadding;
    const chartHeight = container.clientHeight - topPadding - bottomPadding;

    const maxMins = Math.max(...stats.map(d => d.total_mins || 0), 1);
    const hrValues = stats.map(d => d.heart_rate_avg || 0).filter(v => v > 0);
    const minHR = hrValues.length ? Math.min(...hrValues) - 5 : 40;
    const maxHR = hrValues.length ? Math.max(...hrValues) + 5 : 100;
    const hrRange = Math.max(maxHR - minHR, 1);

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("viewBox", `0 0 ${totalWidth} ${container.clientHeight}`);
    svg.style.overflow = "visible";

    const barWidth = Math.min((chartWidth / stats.length) * 0.8, 40);
    const spacing = (chartWidth - (barWidth * stats.length)) / (stats.length || 1);

    const colors = {
        deep: '#5a2d9c',
        light: '#2481cc',
        rem: '#c161d9',
        awake: '#e5b220'
    };

    const yAxisLabels = [1, 3, 5, 8, 10];
    yAxisLabels.forEach(h => {
        const mins = h * 60;
        if (mins > maxMins + 60) return;
        const y = topPadding + chartHeight - (mins / maxMins) * chartHeight;

        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("x", leftPadding - 8);
        text.setAttribute("y", y + 4);
        text.setAttribute("text-anchor", "end");
        text.setAttribute("fill", "var(--hint-color)");
        text.setAttribute("font-size", "10px");
        text.textContent = h + "h";
        svg.appendChild(text);

        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", leftPadding);
        line.setAttribute("y1", y);
        line.setAttribute("x2", leftPadding - 3);
        line.setAttribute("y2", y);
        line.setAttribute("stroke", "var(--hint-color)");
        svg.appendChild(line);

        const gridLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
        gridLine.setAttribute("x1", leftPadding);
        gridLine.setAttribute("y1", y);
        gridLine.setAttribute("x2", leftPadding + chartWidth);
        gridLine.setAttribute("y2", y);
        gridLine.setAttribute("stroke", "var(--hint-color)");
        gridLine.setAttribute("stroke-opacity", "0.2");
        svg.appendChild(gridLine);
    });

    const daysMap = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    let hrPoints = [];

    stats.forEach((dayStat, i) => {
        const xCenter = leftPadding + (spacing / 2) + (i * (barWidth + spacing)) + barWidth / 2;
        const xLeft = xCenter - barWidth / 2;

        let currentY = topPadding + chartHeight;

        const drawSegment = (mins, color) => {
            if (!mins) return;
            const h = (mins / maxMins) * chartHeight;
            const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            rect.setAttribute("x", xLeft);
            rect.setAttribute("y", currentY - h);
            rect.setAttribute("width", barWidth);
            rect.setAttribute("height", h);
            rect.setAttribute("fill", color);
            svg.appendChild(rect);
            currentY -= h;
        };

        drawSegment(dayStat.deep_mins, colors.deep);
        drawSegment(dayStat.awake_mins, colors.awake);
        drawSegment(dayStat.light_mins, colors.light);
        drawSegment(dayStat.rem_mins, colors.rem);

        if (dayStat.total_mins > 0) {
            const hrs = Math.floor(dayStat.total_mins / 60);
            const ms = dayStat.total_mins % 60;
            const lbl = document.createElementNS("http://www.w3.org/2000/svg", "text");
            lbl.setAttribute("x", xCenter);
            lbl.setAttribute("y", currentY - 5);
            lbl.setAttribute("text-anchor", "middle");
            lbl.setAttribute("fill", "var(--text-color)");
            lbl.setAttribute("font-size", "11px");
            lbl.textContent = `${hrs}:${ms.toString().padStart(2, '0')}`;
            svg.appendChild(lbl);
        }

        const dateObj = new Date(dayStat.date + 'T12:00:00');
        let dayName = daysMap[dateObj.getDay()];
        if (i === stats.length - 1) dayName = "Today";

        const xLbl = document.createElementNS("http://www.w3.org/2000/svg", "text");
        xLbl.setAttribute("x", xCenter);
        xLbl.setAttribute("y", topPadding + chartHeight + 15);
        xLbl.setAttribute("text-anchor", "middle");
        xLbl.setAttribute("fill", "var(--hint-color)");
        xLbl.setAttribute("font-size", "11px");
        xLbl.textContent = dayName;
        svg.appendChild(xLbl);

        if (dayStat.heart_rate_avg > 0) {
            const yHR = topPadding + chartHeight - ((dayStat.heart_rate_avg - minHR) / hrRange) * chartHeight;
            hrPoints.push({ x: xCenter, y: yHR, val: dayStat.heart_rate_avg });
        }
    });

    if (hrPoints.length > 1) {
        const pathLine = document.createElementNS("http://www.w3.org/2000/svg", "path");
        const pathData = hrPoints.map((p, i) => (i === 0 ? `M ${p.x},${p.y}` : `L ${p.x},${p.y}`)).join(" ");
        pathLine.setAttribute("d", pathData);
        pathLine.setAttribute("fill", "none");
        pathLine.setAttribute("stroke", "#ff3b30");
        pathLine.setAttribute("stroke-width", "2");
        svg.appendChild(pathLine);
    }

    hrPoints.forEach(p => {
        const circleOut = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circleOut.setAttribute("cx", p.x);
        circleOut.setAttribute("cy", p.y);
        circleOut.setAttribute("r", "4");
        circleOut.setAttribute("fill", "var(--bg-color)");
        svg.appendChild(circleOut);

        const circleIn = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circleIn.setAttribute("cx", p.x);
        circleIn.setAttribute("cy", p.y);
        circleIn.setAttribute("r", "2");
        circleIn.setAttribute("fill", "#ff3b30");
        svg.appendChild(circleIn);

        const bg = document.createElementNS("http://www.w3.org/2000/svg", "text");
        bg.setAttribute("x", p.x);
        bg.setAttribute("y", p.y - 8);
        bg.setAttribute("text-anchor", "middle");
        bg.setAttribute("stroke", "var(--bg-color)");
        bg.setAttribute("stroke-width", "3");
        bg.setAttribute("font-size", "10px");
        bg.setAttribute("font-weight", "bold");
        bg.textContent = p.val;

        const lbl = document.createElementNS("http://www.w3.org/2000/svg", "text");
        lbl.setAttribute("x", p.x);
        lbl.setAttribute("y", p.y - 8);
        lbl.setAttribute("text-anchor", "middle");
        lbl.setAttribute("fill", "#ff3b30");
        lbl.setAttribute("font-size", "10px");
        lbl.setAttribute("font-weight", "bold");
        lbl.textContent = p.val;

        svg.appendChild(bg);
        svg.appendChild(lbl);
    });

    container.appendChild(svg);
}

// Render bar chart for steps
function renderStepsChart(stats) {
    const container = document.getElementById('stepsChartContainer');
    if (!container) return;

    const totalWidth = container.clientWidth;
    const leftPadding = 35;
    const rightPadding = 20;
    const topPadding = 20;
    const bottomPadding = 30;

    const chartWidth = totalWidth - leftPadding - rightPadding;
    const chartHeight = container.clientHeight - topPadding - bottomPadding;

    const maxSteps = Math.max(...stats.map(d => d.steps || 0), 1000);
    // Add 10% headroom
    const yMax = maxSteps * 1.1;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("viewBox", `0 0 ${totalWidth} ${container.clientHeight}`);
    svg.style.overflow = "visible";

    const barWidth = Math.min((chartWidth / stats.length) * 0.8, 40);
    const spacing = (chartWidth - (barWidth * stats.length)) / (stats.length || 1);

    const stepColor = '#34c759'; // Apple-like green for activity

    // Y Axis Labels
    const ySteps = 4;
    for (let i = 0; i <= ySteps; i++) {
        const val = Math.round((i / ySteps) * yMax);
        const y = topPadding + chartHeight - (i / ySteps) * chartHeight;

        // format to string (e.g. 10k instead of 10000)
        let valStr = val.toString();
        if (val >= 1000) {
            valStr = Math.round(val / 1000) + 'k';
        }

        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("x", leftPadding - 8);
        text.setAttribute("y", y + 4);
        text.setAttribute("text-anchor", "end");
        text.setAttribute("fill", "var(--hint-color)");
        text.setAttribute("font-size", "10px");
        text.textContent = valStr;
        svg.appendChild(text);

        const gridLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
        gridLine.setAttribute("x1", leftPadding);
        gridLine.setAttribute("y1", y);
        gridLine.setAttribute("x2", leftPadding + chartWidth);
        gridLine.setAttribute("y2", y);
        gridLine.setAttribute("stroke", "var(--hint-color)");
        gridLine.setAttribute("stroke-opacity", "0.2");
        if (i === 0) gridLine.setAttribute("stroke-opacity", "0.6");
        svg.appendChild(gridLine);
    }

    const daysMap = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    stats.forEach((dayStat, i) => {
        const xCenter = leftPadding + (spacing / 2) + (i * (barWidth + spacing)) + barWidth / 2;
        const xLeft = xCenter - barWidth / 2;
        const h = Math.max((dayStat.steps / yMax) * chartHeight, 2); // At least 2px height if > 0
        const yTop = topPadding + chartHeight - h;

        const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("x", xLeft);
        rect.setAttribute("y", yTop);
        rect.setAttribute("width", barWidth);
        rect.setAttribute("height", h);
        rect.setAttribute("fill", stepColor);
        rect.setAttribute("rx", "3"); // Rounded corners
        svg.appendChild(rect);

        // Step Count Label (Vertical)
        if (dayStat.steps > 0) {
            const stepLbl = document.createElementNS("http://www.w3.org/2000/svg", "text");
            // Position above the bar if too short, or inside the bar if tall enough
            let textY = yTop - 4;
            let textFill = "var(--text-color)";
            let textAnchor = "start";

            if (h > 40) {
                textY = yTop + 8;
                textFill = "#ffffff";
                textAnchor = "end";
            }

            stepLbl.setAttribute("x", xCenter + 3);
            stepLbl.setAttribute("y", textY);
            stepLbl.setAttribute("text-anchor", textAnchor);
            stepLbl.setAttribute("fill", textFill);
            stepLbl.setAttribute("font-size", "11px");
            stepLbl.setAttribute("font-weight", "500");
            stepLbl.setAttribute("transform", `rotate(-90 ${xCenter + 3} ${textY})`);
            stepLbl.textContent = dayStat.steps.toLocaleString();
            svg.appendChild(stepLbl);
        }

        // Date Label
        const dateObj = new Date(dayStat.day + 'T12:00:00');
        let dayName = daysMap[dateObj.getDay()];
        if (i === stats.length - 1) dayName = "Today";

        const xLbl = document.createElementNS("http://www.w3.org/2000/svg", "text");
        xLbl.setAttribute("x", xCenter);
        xLbl.setAttribute("y", topPadding + chartHeight + 15);
        xLbl.setAttribute("text-anchor", "middle");
        xLbl.setAttribute("fill", "var(--hint-color)");
        xLbl.setAttribute("font-size", "11px");
        xLbl.textContent = dayName;
        svg.appendChild(xLbl);
    });

    container.appendChild(svg);
}
