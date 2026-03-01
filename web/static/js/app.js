const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();

// Safe Alert Helper
function safeAlert(msg) {
    console.log("Alert:", msg);
    if (tg && tg.showAlert) {
        try {
            tg.showAlert(msg);
        } catch (e) {
            alert(msg);
        }
    } else {
        alert(msg);
    }
}

// Config
// Config
// Config
const userInitData = tg.initData;
window.userInitData = userInitData;
let initialAuthLoad = false;

// Auth state cache configuration (matches server cookie TTL: 30 days)
const AUTH_CACHE_KEY = 'medtracker_auth_state';
const AUTH_CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days in ms

// Save auth state to localStorage
function saveAuthState(authMethod = 'cookie') {
    const authState = {
        authenticated: true,
        authMethod: authMethod,
        timestamp: Date.now(),
        ttl: AUTH_CACHE_TTL
    };
    localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify(authState));
    console.log('[Auth] Saved auth state to cache');
}

// Get cached auth state from localStorage
function getCachedAuthState() {
    try {
        const cached = localStorage.getItem(AUTH_CACHE_KEY);
        if (!cached) return null;

        const authState = JSON.parse(cached);

        // Check if cache is still valid (within TTL)
        if (Date.now() - authState.timestamp < authState.ttl) {
            return authState;
        }

        // Expired, clear it
        localStorage.removeItem(AUTH_CACHE_KEY);
        console.log('[Auth] Auth state cache expired');
        return null;
    } catch (e) {
        console.error('[Auth] Failed to read auth state cache:', e);
        return null;
    }
}

// Clear auth state (for logout)
function clearAuthState() {
    localStorage.removeItem(AUTH_CACHE_KEY);
    console.log('[Auth] Cleared auth state cache');
}

if (!window.DataStore) {
    throw new Error('DataStore is not available. Ensure data-store.js loads before app.js');
}

function formatDateTimeLocalForInput(dateValue = new Date()) {
    const localDate = dateValue instanceof Date ? new Date(dateValue.getTime()) : new Date(dateValue);
    localDate.setMinutes(localDate.getMinutes() - localDate.getTimezoneOffset());
    return localDate.toISOString().slice(0, 16);
}

function downloadBlobAsFile(blob, filename) {
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(link);
}


const ModalManager = {
    open(modalId) {
        const overlay = document.getElementById('modal-overlay');
        if (overlay) overlay.classList.remove('hidden');

        const modal = document.getElementById(modalId);
        if (!modal) return;
        if (typeof modal.open === 'function') {
            modal.open();
        } else {
            modal.classList.remove('hidden');
        }
    },

    close(modalId) {
        const overlay = document.getElementById('modal-overlay');
        if (overlay) overlay.classList.add('hidden');

        const modal = document.getElementById(modalId);
        if (!modal) return;
        if (typeof modal.close === 'function') {
            modal.close();
        } else {
            modal.classList.add('hidden');
        }
    },

    bp: {
        open() { ModalManager.open('bp-modal'); },
        close() { ModalManager.close('bp-modal'); }
    },
    weight: {
        open() { ModalManager.open('weight-modal'); },
        close() { ModalManager.close('weight-modal'); }
    },
    food: {
        open() { ModalManager.open('food-modal'); },
        close() {
            if (typeof closeFoodScannerModal === 'function') closeFoodScannerModal();
            ModalManager.close('food-modal');
        }
    },
    med: {
        open() { ModalManager.open('med-modal'); },
        close() { ModalManager.close('med-modal'); }
    },
    medConfirm: {
        open() { ModalManager.open('med-confirm-modal'); },
        close() { ModalManager.close('med-confirm-modal'); }
    },
    workoutStart: {
        open() { ModalManager.open('workout-start-modal'); },
        close() { ModalManager.close('workout-start-modal'); }
    },
    workoutGroup: {
        open() { ModalManager.open('workout-group-modal'); },
        close() { ModalManager.close('workout-group-modal'); }
    },
    workoutVariant: {
        open() { ModalManager.open('workout-variant-modal'); },
        close() { ModalManager.close('workout-variant-modal'); }
    },
    workoutExercise: {
        open() { ModalManager.open('workout-exercise-modal'); },
        close() { ModalManager.close('workout-exercise-modal'); }
    },
    exerciseLibrary: {
        open() { ModalManager.open('exercise-library-modal'); },
        close() { ModalManager.close('exercise-library-modal'); }
    },
    workoutSession: {
        open() { ModalManager.open('workout-session-modal'); },
        close() { ModalManager.close('workout-session-modal'); }
    },
    workoutAddExerciseToSession: {
        open() { ModalManager.open('workout-add-exercise-to-session-modal'); },
        close() { ModalManager.close('workout-add-exercise-to-session-modal'); }
    },
    foodProduct: {
        open() { ModalManager.open('food-product-modal'); },
        close() { ModalManager.close('food-product-modal'); }
    },
    foodScanner: {
        open() {
            ModalManager.open('food-scanner-modal');
            setFoodScannerStatus('Point camera at barcode or QR.');
            startFoodScanner();
        },
        close() {
            stopFoodScanner();
            ModalManager.close('food-scanner-modal');
        }
    },

    getTopModalDefs() {
        return [
            { id: 'med-modal', fn: () => ModalManager.close('med-modal') },
            { id: 'med-confirm-modal', fn: () => ModalManager.close('med-confirm-modal') },
            { id: 'bp-modal', fn: () => ModalManager.close('bp-modal') },
            { id: 'weight-modal', fn: () => ModalManager.close('weight-modal') },
            { id: 'food-modal', fn: () => { if (typeof closeFoodScannerModal === 'function') closeFoodScannerModal(); ModalManager.close('food-modal'); } },
            { id: 'workout-group-modal', fn: () => typeof closeWorkoutGroupModal === 'function' ? closeWorkoutGroupModal() : ModalManager.close('workout-group-modal') },
            { id: 'workout-variant-modal', fn: () => typeof closeVariantModal === 'function' ? closeVariantModal() : ModalManager.close('workout-variant-modal') },
            { id: 'workout-exercise-modal', fn: () => typeof closeExerciseModal === 'function' ? closeExerciseModal() : ModalManager.close('workout-exercise-modal') },
            { id: 'exercise-library-modal', fn: () => typeof closeExerciseLibraryModal === 'function' ? closeExerciseLibraryModal() : ModalManager.close('exercise-library-modal') },
            { id: 'workout-session-modal', fn: () => typeof closeWorkoutSessionModal === 'function' ? closeWorkoutSessionModal() : ModalManager.close('workout-session-modal') },
            { id: 'workout-start-modal', fn: () => ModalManager.close('workout-start-modal') },
        ];
    },

    getSubModalDefs() {
        return [
            { id: 'workout-add-exercise-to-session-modal', fn: () => typeof closeAddExerciseToSessionModal === 'function' ? closeAddExerciseToSessionModal() : ModalManager.close('workout-add-exercise-to-session-modal') },
            { id: 'food-scanner-modal', fn: () => { stopFoodScanner(); ModalManager.close('food-scanner-modal'); } },
            { id: 'food-product-modal', fn: () => ModalManager.close('food-product-modal') },
        ];
    },

    getClosePriorityModalDefs() {
        return [...ModalManager.getSubModalDefs(), ...ModalManager.getTopModalDefs()];
    },

    closeTopMostVisibleModal() {
        for (const modalDef of ModalManager.getClosePriorityModalDefs()) {
            const modal = document.getElementById(modalDef.id);
            if (modal && !modal.classList.contains('hidden')) {
                modalDef.fn();
                return true;
            }
        }
        return false;
    }
};

window.ModalManager = ModalManager;

// Overlay backdrop click — close topmost visible modal
(function bindOverlayBackdrop() {
    function setup() {
        const overlay = document.getElementById('modal-overlay');
        if (!overlay) return;
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) window.ModalManager.closeTopMostVisibleModal();
        });
    }
    document.readyState === 'loading'
        ? document.addEventListener('DOMContentLoaded', setup, { once: true })
        : setup();
})();

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

    return {
        featureSettings: raw?.featureSettings || raw?.features || {},
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

// Apply bootstrap payload and warm caches so first tab render can use local data.
async function applyBootstrapPayload(res) {
    if (!res) return false;

    if (typeof res.cursor === 'number') {
        window.DataStore.setChangeCursor(res.cursor);
    }

    if (res.features) {
        featureSettings = { ...featureSettings, ...res.features };
        featureSettingsLoaded = true;
        updateFeatureTabVisibility();
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
async function loadInitData() {
    try {
        const res = await apiCall('/api/init', 'GET');
        if (res && res.features) {
            featureSettings = { ...featureSettings, ...res.features };
            featureSettingsLoaded = true;
            updateFeatureTabVisibility();
        }
    } catch (e) {
        console.error('[Init] Failed to load init data:', e);
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
                alert("Login failed: " + err);
            }
        } catch (e) {
            console.error("Telegram login error:", e);
            alert("Login error: " + e.message);
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

// Initial Load
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

        // Only load data if authorized
        // Determine start tab? default bp
        switchTab('bp');

        // Handle deep links (supported: /bp_add, /weight_add)
        const deepLinkRoutes = {
            '/bp_add': { tab: 'bp', open: showBPRecordModal },
            '/weight_add': { tab: 'weight', open: showWeightModal }
        };
        const path = window.location.pathname;
        const deepLink = deepLinkRoutes[path];
        if (deepLink) {
            if (deepLink.tab) {
                switchTab(deepLink.tab);
            }
            // Wait for data to load, then open modal
            setTimeout(() => {
                deepLink.open();
                // Clean up URL without reload
                window.history.replaceState({}, '', '/');
            }, 100);
        }

        // Handle Push Actions via Query Params
        const urlParams = new URLSearchParams(window.location.search);
        const action = urlParams.get('action');
        if (action) {
            handlePushAction(action, urlParams);
            // Clean URL
            window.history.replaceState({}, '', '/');
        }
    }
});

// Check for Telegram start_param
if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initDataUnsafe && window.Telegram.WebApp.initDataUnsafe.start_param === 'bp_add') {
    // Wait for auth then open
    const checkInterval = setInterval(() => {
        if (typeof showBPRecordModal === 'function') {
            clearInterval(checkInterval);
            switchTab('bp');
            setTimeout(showBPRecordModal, 500);
        }
    }, 100);
}

async function sendTestBPNotification() {
    try {
        const res = await apiCall('/api/bp/reminder/test', 'POST');
        if (res) {
            safeAlert("Notification sent! Check your device.");
        }
    } catch (e) {
        console.error(e);
        safeAlert("Failed to send test notification: " + e.message);
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
    try {
        const response = await apiCall('/api/bp/reminder/toggle', 'POST', { enabled });
        await window.DataStore.invalidateTags(['settings']);
        console.log('BP reminders toggled:', enabled);
    } catch (error) {
        console.error('Failed to toggle BP reminders:', error);
        // Revert toggle on error
        this.checked = !enabled;
        alert('Failed to update BP reminder settings. Please try again.');
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
    try {
        const response = await apiCall('/api/weight/reminder/toggle', 'POST', { enabled });
        await window.DataStore.invalidateTags(['settings']);
        console.log('Weight reminders toggled:', enabled);
    } catch (error) {
        console.error('Failed to toggle weight reminders:', error);
        // Revert toggle on error
        this.checked = !enabled;
        alert('Failed to update weight reminder settings. Please try again.');
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

// Direct API Client (used by sync layer, bypasses offline handling)
async function apiCallDirect(endpoint, method = "GET", body = null) {
    const headers = { "X-Telegram-Init-Data": userInitData };
    if (body) headers["Content-Type"] = "application/json";

    const res = await fetch(endpoint, { method, headers, body: body ? JSON.stringify(body) : null });
    if (res.status === 401 || res.status === 403) { throw new Error("Unauthorized"); }

    // Check if this is a service worker offline response
    if (res.status === 503) {
        const txt = await res.text();
        try {
            const json = JSON.parse(txt);
            if (json.error === 'offline') {
                // This is the service worker's offline response
                // Throw a network error instead of the JSON string
                throw new Error('Network request failed');
            }
        } catch (e) {
            // If it's not JSON or not the offline error, fall through
            if (e.message === 'Network request failed') throw e;
        }
    }

    if (!res.ok) { const txt = await res.text(); throw new Error(txt); }
    let result;
    if (res.status === 204 || method === "DELETE") {
        result = true;
    } else {
        const txt = await res.text();
        if (!txt) {
            result = true;
        } else {
            try {
                result = JSON.parse(txt);
            } catch (e) {
                console.log("Response is not JSON:", txt);
                result = true;
            }
        }
    }

    // After a successful write, advance the change cursor so that the
    // next poll does not show a refresh banner for our own mutations.
    if (method !== 'GET' && window.DataStore?.advanceCursorSilently) {
        window.DataStore.advanceCursorSilently(); // fire-and-forget
    }

    return result;
}

// Expose for sync.js
window.apiCallDirect = apiCallDirect;

// API Client (offline-aware wrapper)
async function apiCall(endpoint, method = "GET", body = null) {
    // Use offline-aware wrapper if available for all API endpoints
    if (window.offlineAwareApiCall) {
        try {
            return await window.offlineAwareApiCall(endpoint, method, body);
        } catch (e) {
            console.error(e);
            // Only show alerts for write operations that fail
            // GET requests failing is expected when offline - UI will handle empty state
            if (method !== 'GET') {
                safeAlert("Error: " + e.message);
            }
            return null;
        }
    }

    // Fallback to direct API call if offline wrapper not available
    try {
        return await apiCallDirect(endpoint, method, body);
    } catch (e) {
        console.error(e);
        // Only show alerts for write operations that fail
        if (method !== 'GET') {
            safeAlert("Error: " + e.message);
        }
        return null;
    }
}

// State
let medications = [];
let editingMedId = null;
let currentFoodLogs = {};
let foodTargets = {
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
const formatDate = (dateStr) => {
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

    document.getElementById('tabs')?.setActiveTab?.(tab);
    const tabContent = document.getElementById(`${tab}-view`);
    if (!tabContent) return;

    document.querySelectorAll('.view').forEach((el) => el.classList.remove('active'));
    tabContent.classList.add('active');

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

document.getElementById('tabs')?.addEventListener('tabchange', (e) => {
    switchTab(e.detail.tabId);
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
    bindClick('workout-start-skip-btn', () => skipWorkoutFromModal());
    bindClick('workout-start-dismiss-btn', () => closeWorkoutStartModal());
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindNotificationControls, { once: true });
}
bindNotificationControls();

let foodControlsBound = false;

function bindFoodControls() {
    if (foodControlsBound) return;
    foodControlsBound = true;

    const bindClick = (id, handler) => {
        const element = document.getElementById(id);
        if (element) element.addEventListener('click', handler);
    };
    const bindChange = (id, handler) => {
        const element = document.getElementById(id);
        if (element) element.addEventListener('change', handler);
    };
    const bindInput = (id, handler) => {
        const element = document.getElementById(id);
        if (element) element.addEventListener('input', handler);
    };
    const bindFocus = (id, handler) => {
        const element = document.getElementById(id);
        if (element) element.addEventListener('focus', handler);
    };

    bindClick('food-period-day-link', () => window.setFoodStatsPeriod('day'));
    bindClick('food-period-week-link', () => window.setFoodStatsPeriod('week'));
    bindClick('add-food-btn', () => showAddFoodModal());
    bindClick('food-date-prev-btn', () => shiftFoodDate(-1));
    bindClick('food-date-next-btn', () => shiftFoodDate(1));
    bindChange('food-date-filter', () => loadFoodLogs());

    bindClick('food-modal-cancel-btn', () => closeFoodModal());
    bindClick('food-modal-save-btn', () => saveFoodLog());
    bindInput('food-weight', () => calculateFoodCalories());
    bindInput('food-barcode', () => onFoodBarcodeChange());
    bindClick('food-scan-btn', () => openFoodScannerModal());
    bindInput('food-name', () => onFoodNameChange());
    bindFocus('food-name', () => onFoodNameFocus());
    bindInput('food-carbs', () => calculateFoodCalories());
    bindInput('food-protein', () => calculateFoodCalories());
    bindInput('food-fat', () => calculateFoodCalories());
    bindChange('food-per-100g', () => onFoodPer100gChange());
    bindFocus('food-calories', () => onFoodCaloriesFocus());

    bindClick('food-scanner-use-photo-btn', () => openPhotoPickerAndDecode());
    bindClick('food-scanner-close-btn', () => closeFoodScannerModal());
    bindClick('food-product-cancel-btn', () => closeFoodProductModal());
    bindClick('food-product-save-btn', () => saveFoodProduct());
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindFoodControls, { once: true });
}
bindFoodControls();

// -- Food Intake Autocomplete & Logic --

let foodAutoCompleteSuggestions = [];
let foodProductsCache = [];
let foodSearchTimeout;
let foodSearchRequestId = 0;
let lastFoodSearchQueryNormalized = '';
let foodScannerStream = null;
let foodScannerRunning = false;
let foodScanLoopTimer = null;
let foodBarcodeDetector = null;
const FOOD_SCAN_THROTTLE_MS = 200;
const FOOD_NUMERIC_BARCODE_MIN_LEN = 8;

function normalizeFoodSearchQuery(value) {
    return (value || '').trim().toLowerCase();
}

function decodeFoodDisplayText(value) {
    const raw = (value || '').toString();
    if (!raw) return '';

    const textarea = document.createElement('textarea');
    textarea.textContent = raw;
    let decoded = textarea.value.trim();

    if (decoded.includes('%')) {
        try {
            decoded = decodeURIComponent(decoded);
        } catch (e) { }
    }
    return decoded;
}

async function initFoodProductsCache() {
    if (window.MedTrackerDB) {
        foodProductsCache = await window.MedTrackerDB.FoodProductsStore.getCache();
    }
    if (!foodProductsCache) {
        try {
            foodProductsCache = await apiCall('/api/food/products', 'GET') || [];
            if (window.MedTrackerDB && foodProductsCache.length > 0) {
                await window.MedTrackerDB.FoodProductsStore.saveCache(foodProductsCache);
            }
        } catch (e) {
            console.error('Failed to load food products', e);
            foodProductsCache = [];
        }
    }
}

async function onFoodNameChange() {
    const foodNameInput = document.getElementById('food-name');
    const query = foodNameInput.value;
    const normalizedQuery = normalizeFoodSearchQuery(query);

    if (normalizedQuery.length >= 2 && normalizedQuery === lastFoodSearchQueryNormalized) {
        const list = document.getElementById('food-autocomplete-list');
        if (list && foodAutoCompleteSuggestions.length > 0) {
            list.classList.remove('hidden');
        }
        return;
    }

    // Check if user selected something from the datalist
    const selected = foodAutoCompleteSuggestions.find(p => decodeFoodDisplayText(p.name) === query);
    if (selected) {
        autofillFoodProduct(selected);
        setFoodSearchStatus('success', 'Product selected.');
        return;
    }

    if (query.length < 2) {
        renderFoodAutocomplete(foodProductsCache);
        lastFoodSearchQueryNormalized = '';
        setFoodSearchStatus();
        return;
    }

    // Debounce search
    clearTimeout(foodSearchTimeout);
    foodSearchTimeout = setTimeout(async () => {
        const requestId = ++foodSearchRequestId;
        lastFoodSearchQueryNormalized = normalizedQuery;
        setFoodSearchStatus('loading', 'Searching local database...');
        try {
            if (!navigator.onLine) throw new Error("Network request failed");

            // First pass: local fast search
            const endpoint = `/api/food/products/search?q=${encodeURIComponent(query)}`;
            const headers = { "X-Telegram-Init-Data": userInitData };
            const res = await fetch(endpoint, { method: "GET", headers });

            if (res.status === 503) throw new Error("Network request failed");
            if (!res.ok) throw new Error("Search failed");
            if (requestId !== foodSearchRequestId) return;

            const reader = res.body.getReader();
            const decoder = new TextDecoder("utf-8");
            let buffer = "";
            let localResults = [];

            while (true) {
                const { done, value } = await reader.read();
                if (value) {
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop();

                    for (const line of lines) {
                        if (!line.trim()) continue;
                        try {
                            const results = JSON.parse(line);
                            if (requestId !== foodSearchRequestId) return;
                            localResults = results || [];
                        } catch (e) { console.error("Parse error on stream chunk", e); }
                    }
                }
                if (done) {
                    if (buffer.trim()) {
                        try {
                            const results = JSON.parse(buffer);
                            if (requestId === foodSearchRequestId) {
                                localResults = results || [];
                            }
                        } catch (e) { }
                    }
                    break;
                }
            }

            if (requestId !== foodSearchRequestId) return;

            const unique = [];
            const seen = new Set();
            for (const p of localResults) {
                if (!seen.has(p.name)) {
                    seen.add(p.name);
                    unique.push(p);
                }
            }

            // Define the callback for loading remote OpenFoodFacts
            const loadMoreCallback = async () => {
                if (requestId !== foodSearchRequestId) return;
                setFoodSearchStatus('loading', 'Searching OpenFoodFacts...');
                try {
                    const remoteEndpoint = `/api/food/products/search?q=${encodeURIComponent(query)}&remote=true`;
                    const remoteRes = await fetch(remoteEndpoint, { method: "GET", headers });
                    if (!remoteRes.ok) throw new Error("Remote search failed");
                    if (requestId !== foodSearchRequestId) return;

                    const remoteReader = remoteRes.body.getReader();
                    const remoteDecoder = new TextDecoder("utf-8");
                    let remoteBuffer = "";
                    let remoteResults = [];

                    while (true) {
                        const { done, value } = await remoteReader.read();
                        if (value) {
                            remoteBuffer += remoteDecoder.decode(value, { stream: true });
                            const lines = remoteBuffer.split('\n');
                            remoteBuffer = lines.pop();
                            for (const line of lines) {
                                if (!line.trim()) continue;
                                try {
                                    remoteResults = JSON.parse(line) || [];
                                } catch (e) { }
                            }
                        }
                        if (done) {
                            if (remoteBuffer.trim()) {
                                try {
                                    remoteResults = JSON.parse(remoteBuffer) || [];
                                } catch (e) { }
                            }
                            break;
                        }
                    }

                    if (requestId !== foodSearchRequestId) return;

                    // Merge remote on top of local
                    const mergedUnique = [...unique];
                    for (const p of remoteResults) {
                        if (!seen.has(p.name)) {
                            seen.add(p.name);
                            mergedUnique.push(p);
                        }
                    }

                    renderFoodAutocomplete(mergedUnique, false, null); // Hide load more
                    setFoodSearchStatus('success', `Found ${mergedUnique.length} result(s).`);

                } catch (e) {
                    console.error("Load more failed", e);
                    setFoodSearchStatus('success', `Found ${unique.length} local result(s). Remote fetch failed.`);
                    renderFoodAutocomplete(unique, false, null); // remove loading state
                }
            };

            renderFoodAutocomplete(unique, navigator.onLine, loadMoreCallback);

            if (unique.length > 0) {
                setFoodSearchStatus('success', `Found ${unique.length} local result(s).`);
            } else {
                setFoodSearchStatus('empty', 'No local products found.');
                loadMoreCallback(); // Auto-trigger openfoodfacts fallback if local is empty
            }

        } catch (e) {
            if (requestId !== foodSearchRequestId) return;
            console.error('Search failed', e);
            if (e.name === 'TypeError' || e.message.includes('fetch') || e.message === 'Network request failed' || e.message === 'Failed to fetch' || !navigator.onLine) {
                setFoodSearchStatus('empty', 'Search finished: no products found.');
                return;
            }
            setFoodSearchStatus('error', 'Search finished with an error. Please try again.');
        }
    }, 800);
}

async function onFoodBarcodeChange() {
    const barcode = document.getElementById('food-barcode').value;
    if (barcode.length < 5) {
        setFoodSearchStatus();
        return;
    }

    clearTimeout(foodSearchTimeout);
    foodSearchTimeout = setTimeout(async () => {
        const requestId = ++foodSearchRequestId;
        setFoodSearchStatus('loading', 'Searching by barcode...');
        try {
            if (!navigator.onLine) throw new Error("Network request failed");

            const endpoint = `/api/food/products/search?q=${encodeURIComponent(barcode)}`;
            const headers = { "X-Telegram-Init-Data": window.userInitData };
            const res = await fetch(endpoint, { method: "GET", headers });

            if (res.status === 503) throw new Error("Network request failed");
            if (!res.ok) throw new Error("Search failed");
            if (requestId !== foodSearchRequestId) return;

            const reader = res.body.getReader();
            const decoder = new TextDecoder("utf-8");
            let buffer = "";
            let matchFoundAndFilled = false;
            let localResults = [];

            while (true) {
                const { done, value } = await reader.read();
                if (value) {
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop(); // keep incomplete line

                    for (const line of lines) {
                        if (!line.trim()) continue;
                        try {
                            const results = JSON.parse(line);
                            if (requestId !== foodSearchRequestId) return;
                            localResults = results || [];
                        } catch (e) { console.error("Parse error on stream chunk", e); }
                    }
                }
                if (done) {
                    if (buffer.trim()) {
                        try {
                            const results = JSON.parse(buffer);
                            if (requestId === foodSearchRequestId) {
                                localResults = results || [];
                            }
                        } catch (e) { }
                    }
                    break;
                }
            }

            if (requestId !== foodSearchRequestId) return;

            // Check for direct barcode match first
            const match = localResults.find(p => p.barcode === barcode);
            if (match) {
                document.getElementById('food-name').value = decodeFoodDisplayText(match.name);
                autofillFoodProduct(match);
                setFoodSearchStatus('success', 'Product found and filled in.');
                return;
            }

            const unique = [];
            const seen = new Set();
            for (const p of localResults) {
                if (!seen.has(p.name)) {
                    seen.add(p.name);
                    unique.push(p);
                }
            }

            // Define the callback for loading remote OpenFoodFacts
            const loadMoreCallback = async () => {
                if (requestId !== foodSearchRequestId) return;
                setFoodSearchStatus('loading', 'Searching OpenFoodFacts...');
                try {
                    const remoteEndpoint = `/api/food/products/search?q=${encodeURIComponent(barcode)}&remote=true`;
                    const remoteRes = await fetch(remoteEndpoint, { method: "GET", headers });
                    if (!remoteRes.ok) throw new Error("Remote search failed");
                    if (requestId !== foodSearchRequestId) return;

                    const remoteReader = remoteRes.body.getReader();
                    const remoteDecoder = new TextDecoder("utf-8");
                    let remoteBuffer = "";
                    let remoteResults = [];

                    while (true) {
                        const { done, value } = await remoteReader.read();
                        if (value) {
                            remoteBuffer += remoteDecoder.decode(value, { stream: true });
                            const lines = remoteBuffer.split('\n');
                            remoteBuffer = lines.pop();
                            for (const line of lines) {
                                if (!line.trim()) continue;
                                try {
                                    remoteResults = JSON.parse(line) || [];
                                } catch (e) { }
                            }
                        }
                        if (done) {
                            if (remoteBuffer.trim()) {
                                try {
                                    remoteResults = JSON.parse(remoteBuffer) || [];
                                } catch (e) { }
                            }
                            break;
                        }
                    }

                    if (requestId !== foodSearchRequestId) return;

                    // Check if remote found a direct match not seen locally
                    const remoteMatch = remoteResults.find(p => p.barcode === barcode);
                    if (remoteMatch) {
                        document.getElementById('food-name').value = decodeFoodDisplayText(remoteMatch.name);
                        autofillFoodProduct(remoteMatch);
                        // Hide autocomplete list totally if we auto-filled from remote
                        const list = document.getElementById('food-autocomplete-list');
                        if (list) list.classList.add('hidden');
                        setFoodSearchStatus('success', 'Product found and filled in.');
                        return;
                    }

                    // Merge remote on top of local
                    const mergedUnique = [...unique];
                    for (const p of remoteResults) {
                        if (!seen.has(p.name)) {
                            seen.add(p.name);
                            mergedUnique.push(p);
                        }
                    }

                    renderFoodAutocomplete(mergedUnique, false, null); // Hide load more
                    setFoodSearchStatus('success', `Found ${mergedUnique.length} result(s).`);

                } catch (e) {
                    console.error("Load more failed", e);
                    setFoodSearchStatus('success', `Found ${unique.length} local result(s). Remote fetch failed.`);
                    renderFoodAutocomplete(unique, false, null); // remove loading state
                }
            };

            renderFoodAutocomplete(unique, navigator.onLine, loadMoreCallback);

            if (unique.length > 0) {
                setFoodSearchStatus('success', `Found ${unique.length} local result(s).`);
            } else {
                setFoodSearchStatus('empty', 'No local products found.');
                loadMoreCallback(); // Auto-fetch OFF if local barcode misses
            }

        } catch (e) {
            if (requestId !== foodSearchRequestId) return;
            console.error('Barcode search failed', e);
            if (e.name === 'TypeError' || e.message.includes('fetch') || e.message === 'Network request failed' || e.message === 'Failed to fetch' || !navigator.onLine) {
                setFoodSearchStatus('empty', 'Search finished: no products found.');
                return;
            }
            setFoodSearchStatus('error', 'Search finished with an error. Please try again.');
        }
    }, 800);
}

function setFoodSearchStatus(type, message) {
    const status = document.getElementById('food-search-status');
    if (!status) return;

    status.className = 'food-search-status';
    if (!type || !message) {
        status.classList.add('hidden');
        status.innerText = '';
        return;
    }

    status.classList.remove('hidden');
    status.classList.add(type);
    status.innerText = message;
}

function setFoodScannerStatus(message) {
    const status = document.getElementById('food-scanner-status');
    if (status) status.innerText = message;
}

function createFoodBarcodeDetector() {
    if (!window.BarcodeDetector) return null;
    if (foodBarcodeDetector) return foodBarcodeDetector;

    const formats = [
        'qr_code',
        'ean_13',
        'ean_8',
        'upc_a',
        'upc_e',
        'code_128',
        'code_39',
        'itf'
    ];
    try {
        foodBarcodeDetector = new BarcodeDetector({ formats });
    } catch (e) {
        console.error('Failed to create BarcodeDetector with formats, retrying default:', e);
        foodBarcodeDetector = new BarcodeDetector();
    }
    return foodBarcodeDetector;
}

function sanitizeScannedValue(rawValue) {
    if (!rawValue) return { text: '', numeric: '' };
    const text = String(rawValue).replace(/\u200B/g, '').trim();
    const digitsOnly = text.replace(/\D/g, '');
    const numeric = digitsOnly.length >= FOOD_NUMERIC_BARCODE_MIN_LEN ? digitsOnly : '';
    return { text, numeric };
}

function handleDecodedValue(rawValue) {
    const { text, numeric } = sanitizeScannedValue(rawValue);
    if (!text) return false;

    if (numeric) {
        const barcodeInput = document.getElementById('food-barcode');
        barcodeInput.value = numeric;
        onFoodBarcodeChange();
    } else {
        const nameInput = document.getElementById('food-name');
        nameInput.value = text;
        safeAlert('Scanned QR text was added to Food Name.');
    }
    closeFoodScannerModal();
    return true;
}

async function scanFrameLoop() {
    if (!foodScannerRunning) return;

    const video = document.getElementById('food-scanner-video');
    const detector = createFoodBarcodeDetector();
    if (!video || !detector || video.readyState < 2) {
        foodScanLoopTimer = setTimeout(scanFrameLoop, FOOD_SCAN_THROTTLE_MS);
        return;
    }

    try {
        const results = await detector.detect(video);
        if (results && results.length > 0) {
            const first = results.find(r => r && r.rawValue) || results[0];
            if (first && handleDecodedValue(first.rawValue)) return;
        }
    } catch (e) {
        console.error('Food scanner frame decode failed:', e);
    }

    foodScanLoopTimer = setTimeout(scanFrameLoop, FOOD_SCAN_THROTTLE_MS);
}

async function startFoodScanner() {
    const modal = document.getElementById('food-scanner-modal');
    if (!modal) return;

    if (!window.isSecureContext) {
        setFoodScannerStatus('Camera requires HTTPS (or localhost). Use "Use Photo" or manual entry.');
        return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setFoodScannerStatus('Camera is unavailable. Use "Use Photo" or manual entry.');
        return;
    }

    if (!window.BarcodeDetector) {
        setFoodScannerStatus('Live scan is unavailable on this browser. Use "Use Photo".');
        return;
    }

    const video = document.getElementById('food-scanner-video');
    try {
        setFoodScannerStatus('Requesting camera access...');
        foodScannerStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: { ideal: 'environment' } }
        });
        video.srcObject = foodScannerStream;
        await video.play();
        setFoodScannerStatus('Point camera at barcode or QR.');
        foodScannerRunning = true;
        scanFrameLoop();
    } catch (e) {
        console.error('Failed to start food scanner:', e);
        setFoodScannerStatus('Camera access denied or unavailable. Use "Use Photo".');
    }
}

function stopFoodScanner() {
    foodScannerRunning = false;

    if (foodScanLoopTimer) {
        clearTimeout(foodScanLoopTimer);
        foodScanLoopTimer = null;
    }

    const video = document.getElementById('food-scanner-video');
    if (video) {
        video.pause();
        video.srcObject = null;
    }

    if (foodScannerStream) {
        foodScannerStream.getTracks().forEach(track => track.stop());
        foodScannerStream = null;
    }
}

window.addEventListener('pagehide', stopFoodScanner);
window.addEventListener('beforeunload', stopFoodScanner);

function openFoodScannerModal() {
    window.ModalManager.foodScanner.open();
}

function closeFoodScannerModal() {
    window.ModalManager.foodScanner.close();
}

function decodeBarcodeFromImageFallback(image) {
    return new Promise((resolve, reject) => {
        const ZXingGlobal = window.ZXing;
        if (!ZXingGlobal || !ZXingGlobal.BrowserMultiFormatReader) {
            reject(new Error('Fallback decoder is not available.'));
            return;
        }

        const reader = new ZXingGlobal.BrowserMultiFormatReader();
        reader.decodeFromImageElement(image)
            .then(result => {
                reader.reset();
                resolve(result && result.text ? result.text : '');
            })
            .catch(err => {
                reader.reset();
                reject(err);
            });
    });
}

async function decodeFromImageWithDetector(image) {
    const detector = createFoodBarcodeDetector();
    if (!detector) return '';

    const results = await detector.detect(image);
    if (!results || results.length === 0) return '';
    const first = results.find(r => r && r.rawValue) || results[0];
    return first && first.rawValue ? first.rawValue : '';
}

async function openPhotoPickerAndDecode() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';

    input.onchange = async (event) => {
        const file = event.target.files && event.target.files[0];
        if (!file) return;

        setFoodScannerStatus('Decoding image...');
        try {
            const imageURL = URL.createObjectURL(file);
            const image = new Image();
            image.src = imageURL;
            await image.decode();

            let decoded = '';
            try {
                decoded = await decodeFromImageWithDetector(image);
            } catch (e) {
                console.log('Native image decode failed, using fallback:', e);
            }

            if (!decoded) {
                decoded = await decodeBarcodeFromImageFallback(image);
            }

            URL.revokeObjectURL(imageURL);

            if (!decoded || !handleDecodedValue(decoded)) {
                setFoodScannerStatus('No barcode/QR found in photo. Try another image.');
                safeAlert('No barcode or QR code found in the selected photo.');
            }
        } catch (e) {
            console.error('Failed to decode from photo:', e);
            setFoodScannerStatus('Failed to decode image. Try another photo or manual entry.');
            safeAlert('Could not decode barcode/QR from image.');
        }
    };

    input.click();
}

function renderFoodAutocomplete(products, showLoadMore = false, loadMoreCallback = null, showList = true) {
    foodAutoCompleteSuggestions = products || [];
    const list = document.getElementById('food-autocomplete-list');
    if (!list) return;

    list.replaceChildren();

    if (foodAutoCompleteSuggestions.length === 0) {
        list.classList.add('hidden');
        return;
    }

    // Add a close button at the top
    const closeBtn = document.createElement('div');
    closeBtn.className = 'autocomplete-close';
    const closeSpan = document.createElement('span');
    closeSpan.textContent = '▲ Close';
    closeBtn.appendChild(closeSpan);
    closeBtn.onclick = function (e) {
        e.stopPropagation(); // prevent document click listener
        list.classList.add('hidden');
    };
    list.appendChild(closeBtn);

    // Limit datalist options so browser doesn't choke
    const displayList = foodAutoCompleteSuggestions.slice(0, 50);

    displayList.forEach(p => {
        const displayName = decodeFoodDisplayText(p.name);
        const item = document.createElement('div');
        item.className = 'autocomplete-item';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'autocomplete-item-name';
        nameSpan.textContent = displayName;
        if (p.barcode) {
            nameSpan.textContent += ` (${p.barcode})`;
        }
        nameSpan.onclick = function () {
            document.getElementById('food-name').value = displayName;
            autofillFoodProduct(p);
            setFoodSearchStatus('success', 'Product selected.');
            list.classList.add('hidden');
        };
        item.appendChild(nameSpan);

        // Show edit/delete buttons only for user's own food products (id > 0)
        if (p.id && p.id > 0) {
            const actions = document.createElement('span');
            actions.className = 'autocomplete-item-actions';

            const editBtn = document.createElement('button');
            editBtn.className = 'autocomplete-action-btn';
            editBtn.textContent = '✎'; // pencil
            editBtn.title = 'Edit product';
            editBtn.onclick = function (e) {
                e.stopPropagation();
                list.classList.add('hidden');
                showEditFoodProductModal(p);
            };
            actions.appendChild(editBtn);

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'autocomplete-action-btn autocomplete-action-delete';
            deleteBtn.textContent = '✕'; // x mark
            deleteBtn.title = 'Delete product';
            deleteBtn.onclick = function (e) {
                e.stopPropagation();
                deleteFoodProduct(p.id, displayName);
            };
            actions.appendChild(deleteBtn);

            item.appendChild(actions);
        }

        list.appendChild(item);
    });

    if (showLoadMore && loadMoreCallback) {
        const loadMoreBtn = document.createElement('div');
        loadMoreBtn.className = 'autocomplete-load-more';
        loadMoreBtn.textContent = '... Load more from OpenFoodFacts ...';
        loadMoreBtn.onclick = function (e) {
            e.stopPropagation();
            loadMoreBtn.textContent = 'Loading...';
            loadMoreBtn.classList.add('loading');
            loadMoreCallback();
        };
        list.appendChild(loadMoreBtn);
    }

    if (showList) {
        list.classList.remove('hidden');
    } else {
        list.classList.add('hidden');
    }
}

function onFoodNameFocus() {
    const list = document.getElementById('food-autocomplete-list');
    if (!list) return;
    if (foodAutoCompleteSuggestions.length > 0) {
        list.classList.remove('hidden');
    }
}

// Close autocomplete when clicking outside
document.addEventListener("click", function (e) {
    const list = document.getElementById("food-autocomplete-list");
    const input = document.getElementById("food-name");
    if (list && e.target !== input && e.target !== list && !list.contains(e.target)) {
        list.classList.add('hidden');
    }
});

function autofillFoodProduct(product) {
    const displayName = decodeFoodDisplayText(product.name);
    const input = document.getElementById('food-name');
    if (input && input.value !== displayName) {
        input.value = displayName;
    }

    if (product.barcode) {
        document.getElementById('food-barcode').value = product.barcode;
    }

    // Check per 100g to auto-fill macros directly
    document.getElementById('food-per-100g').checked = true;
    document.getElementById('food-carbs').value = product.carbs_100g;
    document.getElementById('food-protein').value = product.protein_100g;
    document.getElementById('food-fat').value = product.fat_100g;
    document.getElementById('food-calories').value = product.energy_kcal_100g;

    // Focus weight input
    document.getElementById('food-weight').focus();
    calculateFoodCalories();
}

// -- Food Product Management --

function showEditFoodProductModal(product) {
    document.getElementById('food-product-id').value = product.id;
    document.getElementById('food-product-name').value = decodeFoodDisplayText(product.name);
    document.getElementById('food-product-barcode').value = product.barcode || '';
    document.getElementById('food-product-carbs').value = product.carbs_100g || '';
    document.getElementById('food-product-protein').value = product.protein_100g || '';
    document.getElementById('food-product-fat').value = product.fat_100g || '';
    document.getElementById('food-product-calories').value = product.energy_kcal_100g || '';
    window.ModalManager.foodProduct.open();
}

function closeFoodProductModal() {
    window.ModalManager.foodProduct.close();
}

async function saveFoodProduct() {
    const id = document.getElementById('food-product-id').value;
    const name = document.getElementById('food-product-name').value.trim();
    if (!name) {
        safeAlert('Please enter a product name.');
        return;
    }

    const payload = {
        name: name,
        barcode: document.getElementById('food-product-barcode').value.trim(),
        carbs_100g: parseFloat(document.getElementById('food-product-carbs').value) || 0,
        protein_100g: parseFloat(document.getElementById('food-product-protein').value) || 0,
        fat_100g: parseFloat(document.getElementById('food-product-fat').value) || 0,
        energy_kcal_100g: parseFloat(document.getElementById('food-product-calories').value) || 0,
    };

    try {
        await apiCall(`/api/food/products/${id}`, 'PUT', payload);
        closeFoodProductModal();
        // Refresh the cache
        foodProductsCache = null;
        if (window.MedTrackerDB) {
            await window.MedTrackerDB.FoodProductsStore.clearCache();
        }
        await initFoodProductsCache();
        renderFoodAutocomplete(foodProductsCache, false, null, false);
        safeAlert('Product updated.');
    } catch (e) {
        console.error('Failed to update food product', e);
        safeAlert('Failed to update product.');
    }
}

async function deleteFoodProduct(id, displayName) {
    if (!confirm(`Delete "${displayName}" from your food database?`)) return;

    try {
        await apiCall(`/api/food/products/${id}`, 'DELETE');
        // Refresh the cache
        foodProductsCache = null;
        if (window.MedTrackerDB) {
            await window.MedTrackerDB.FoodProductsStore.clearCache();
        }
        await initFoodProductsCache();
        renderFoodAutocomplete(foodProductsCache);
    } catch (e) {
        console.error('Failed to delete food product', e);
        safeAlert('Failed to delete product.');
    }
}

// -- Food Intake Functions --

function calculateFoodCalories() {
    const weight = parseFloat(document.getElementById('food-weight').value) || 0;
    const carbs = parseFloat(document.getElementById('food-carbs').value) || 0;
    const protein = parseFloat(document.getElementById('food-protein').value) || 0;
    const fat = parseFloat(document.getElementById('food-fat').value) || 0;
    const per100g = document.getElementById('food-per-100g').checked;
    const caloriesInput = document.getElementById('food-calories');

    let totalCarbs = carbs;
    let totalProt = protein;
    let totalFat = fat;
    if (per100g) {
        totalCarbs = (carbs * weight) / 100;
        totalProt = (protein * weight) / 100;
        totalFat = (fat * weight) / 100;
    }

    const totalCals = Math.round((4 * totalCarbs) + (4 * totalProt) + (9 * totalFat));
    if (per100g || caloriesInput.value === '') {
        caloriesInput.value = totalCals;
    }
}

function onFoodPer100gChange() {
    const per100gCheckbox = document.getElementById('food-per-100g');
    if (!per100gCheckbox.checked) {
        const weight = parseFloat(document.getElementById('food-weight').value) || 0;
        if (weight > 0) {
            const carbsInput = document.getElementById('food-carbs');
            const proteinInput = document.getElementById('food-protein');
            const fatInput = document.getElementById('food-fat');
            const carbsPer100 = parseFloat(carbsInput.value);
            const proteinPer100 = parseFloat(proteinInput.value);
            const fatPer100 = parseFloat(fatInput.value);
            if (!Number.isNaN(carbsPer100)) carbsInput.value = +((carbsPer100 * weight) / 100).toFixed(1);
            if (!Number.isNaN(proteinPer100)) proteinInput.value = +((proteinPer100 * weight) / 100).toFixed(1);
            if (!Number.isNaN(fatPer100)) fatInput.value = +((fatPer100 * weight) / 100).toFixed(1);
        }
    }
    calculateFoodCalories();
}

function onFoodCaloriesFocus() {
    const per100gCheckbox = document.getElementById('food-per-100g');
    if (per100gCheckbox.checked) {
        per100gCheckbox.checked = false;
        onFoodPer100gChange();
    }
}

function parseOptionalNumber(rawValue) {
    const v = String(rawValue || '').trim();
    if (v === '') return null;
    const n = parseFloat(v);
    if (Number.isNaN(n)) return null;
    return n;
}

function computeFoodTotals() {
    const carbsInput = parseOptionalNumber(document.getElementById('food-carbs').value);
    const proteinInput = parseOptionalNumber(document.getElementById('food-protein').value);
    const fatInput = parseOptionalNumber(document.getElementById('food-fat').value);
    const caloriesInput = parseOptionalNumber(document.getElementById('food-calories').value);
    const weightInput = parseOptionalNumber(document.getElementById('food-weight').value);
    const per100g = document.getElementById('food-per-100g').checked;
    const weight = weightInput && weightInput > 0 ? weightInput : 0;
    const multiplier = per100g && weight > 0 ? weight / 100 : 1;

    let totalCarbs = carbsInput === null ? null : carbsInput * multiplier;
    let totalProtein = proteinInput === null ? null : proteinInput * multiplier;
    let totalFat = fatInput === null ? null : fatInput * multiplier;
    let totalCalories = caloriesInput;
    if (per100g && caloriesInput !== null && weight > 0) {
        totalCalories = caloriesInput * multiplier;
    }

    const missing = [];
    if (totalCarbs === null) missing.push('carbs');
    if (totalProtein === null) missing.push('protein');
    if (totalFat === null) missing.push('fat');
    if (totalCalories === null) missing.push('calories');

    if (missing.length === 1) {
        const missingField = missing[0];
        if (missingField === 'calories' && totalCarbs !== null && totalProtein !== null && totalFat !== null) {
            totalCalories = (4 * totalCarbs) + (4 * totalProtein) + (9 * totalFat);
        } else if (missingField === 'carbs' && totalCalories !== null && totalProtein !== null && totalFat !== null) {
            totalCarbs = (totalCalories - (4 * totalProtein) - (9 * totalFat)) / 4;
        } else if (missingField === 'protein' && totalCalories !== null && totalCarbs !== null && totalFat !== null) {
            totalProtein = (totalCalories - (4 * totalCarbs) - (9 * totalFat)) / 4;
        } else if (missingField === 'fat' && totalCalories !== null && totalCarbs !== null && totalProtein !== null) {
            totalFat = (totalCalories - (4 * totalCarbs) - (4 * totalProtein)) / 9;
        }
    }

    return {
        weight: Math.round(weight),
        carbs: Math.round(Math.max(0, totalCarbs || 0)),
        protein: Math.round(Math.max(0, totalProtein || 0)),
        fat: Math.round(Math.max(0, totalFat || 0)),
        calories: Math.round(Math.max(0, totalCalories || 0)),
        per100g
    };
}

function toISODateLocal(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function shiftFoodDate(deltaDays) {
    const dateFilter = document.getElementById('food-date-filter');
    if (!dateFilter) return;

    const period = currentFoodStatsPeriod || 'day';
    const multiplier = period === 'week' ? 7 : 1;

    const baseDate = dateFilter.value ? new Date(`${dateFilter.value}T00:00:00`) : new Date();
    baseDate.setDate(baseDate.getDate() + (deltaDays * multiplier));
    dateFilter.value = toISODateLocal(baseDate);
    loadFoodLogs();
}

function showAddFoodModal() {
    window.ModalManager.food.open();
    document.getElementById('food-modal-title').innerText = 'Log Food';

    // Set default date/time
    document.getElementById('food-datetime').value = formatDateTimeLocalForInput();

    // Clear inputs
    document.getElementById('food-id').value = '';
    document.getElementById('food-name').value = '';
    document.getElementById('food-barcode').value = '';
    document.getElementById('food-weight').value = '';
    document.getElementById('food-carbs').value = '';
    document.getElementById('food-protein').value = '';
    document.getElementById('food-fat').value = '';
    document.getElementById('food-calories').value = '';
    document.getElementById('food-per-100g').checked = true;
    document.getElementById('food-weight').focus();

    if (foodProductsCache.length === 0) {
        initFoodProductsCache().then(() => renderFoodAutocomplete(foodProductsCache, false, null, false));
    } else {
        renderFoodAutocomplete(foodProductsCache, false, null, false);
    }
}

function editFoodLog(id) {
    const log = currentFoodLogs[id];
    if (!log) return;

    window.ModalManager.food.open();
    document.getElementById('food-modal-title').innerText = 'Edit Food';

    document.getElementById('food-id').value = log.id;
    document.getElementById('food-name').value = log.name || '';
    document.getElementById('food-barcode').value = log.barcode || '';
    document.getElementById('food-weight').value = log.weight || '';

    if (log.weight > 0) {
        // Convert stored totals back to per-100g for display
        document.getElementById('food-per-100g').checked = true;
        document.getElementById('food-carbs').value = +((log.carbs / log.weight) * 100).toFixed(1);
        document.getElementById('food-protein').value = +((log.protein / log.weight) * 100).toFixed(1);
        document.getElementById('food-fat').value = +((log.fat / log.weight) * 100).toFixed(1);
        calculateFoodCalories();
    } else {
        // No weight stored, show raw totals as-is
        document.getElementById('food-per-100g').checked = false;
        document.getElementById('food-carbs').value = log.carbs || '';
        document.getElementById('food-protein').value = log.protein || '';
        document.getElementById('food-fat').value = log.fat || '';
        document.getElementById('food-calories').value = log.calories || '';
    }

    if (log.eaten_at) {
        document.getElementById('food-datetime').value = formatDateTimeLocalForInput(log.eaten_at);
    }
    document.getElementById('food-weight').focus();
}

function closeFoodModal() {
    window.ModalManager.food.close();
}

async function saveFoodLog() {
    const name = document.getElementById('food-name').value;
    const dateStr = document.getElementById('food-datetime').value;

    if (!dateStr) {
        safeAlert("Please enter date.");
        return;
    }
    const totals = computeFoodTotals();
    if (totals.per100g && totals.weight <= 0) {
        safeAlert("Please enter weight for per 100g mode, or uncheck it.");
        return;
    }

    const payload = {
        eaten_at: new Date(dateStr).toISOString(),
        weight: totals.weight,
        carbs: totals.carbs,
        protein: totals.protein,
        fat: totals.fat,
        calories: totals.calories,
        name: name,
        barcode: document.getElementById('food-barcode').value,
        per_100g: false  // values are converted to totals before sending
    };

    const id = document.getElementById('food-id').value;

    try {
        if (id) {
            await apiCall(`/api/food/log/${id}`, 'PUT', payload);
        } else {
            await apiCall('/api/food/log', 'POST', payload);
        }
        closeFoodModal();
        loadFoodLogs();
    } catch (e) {
        console.error(e);
        safeAlert("Failed to save food log.");
    }
}

let currentFoodStatsPeriod = 'day';

window.setFoodStatsPeriod = function (period) {
    currentFoodStatsPeriod = period;
    document.querySelectorAll('#food-stats-period-container .period-link').forEach(el => {
        if (el.dataset.period === period) {
            el.classList.add('active');
        } else {
            el.classList.remove('active');
        }
    });
    loadFoodLogs();
};

async function loadFoodLogs() {
    const list = document.getElementById('food-list');

    // Ensure targets are available even if Settings tab hasn't been opened yet.
    await loadFoodTargets();

    const dateFilter = document.getElementById('food-date-filter');
    let dateStr = dateFilter.value;
    if (!dateStr) {
        dateStr = toISODateLocal(new Date());
        dateFilter.value = dateStr;
    }

    const period = currentFoodStatsPeriod || 'day';
    const weekDisplay = document.getElementById('food-week-display');
    if (period === 'week') {
        const dEnd = new Date(`${dateStr}T00:00:00`);
        const dStart = new Date(dEnd);
        dStart.setDate(dEnd.getDate() - 6);
        const fmt = { month: 'short', day: 'numeric' };
        if (weekDisplay) {
            weekDisplay.innerText = `${dStart.toLocaleDateString(undefined, fmt)} - ${dEnd.toLocaleDateString(undefined, fmt)}`;
            weekDisplay.classList.remove('hidden');
        }
    } else {
        if (weekDisplay) weekDisplay.classList.add('hidden');
    }

    // Show cached data immediately (stale-while-revalidate)
    const cacheKey = `food_${dateStr}_${period}`;
    const cached = await window.DataStore.getCached(cacheKey);
    if (cached) {
        _renderFoodData(cached.groups, cached.weekStats, period, dateStr);
    } else {
        const loadingStr = document.createTextNode('Loading...');
        list.replaceChildren(loadingStr);
    }

    // Always fetch fresh data
    try {
        const daysParam = period === 'week' ? '&days=7' : '';
        const groups = await apiCall(`/api/food/log?date=${dateStr}${daysParam}`, 'GET');

        let weekStats = null;
        if (period === 'week' || period === '2weeks') {
            const daysCount = period === 'week' ? 7 : 14;
            weekStats = await apiCall(`/api/food/stats?date=${dateStr}&days=${daysCount}`, 'GET');
        }

        await window.DataStore.setCached(cacheKey, { groups: groups || [], weekStats });

        _renderFoodData(groups || [], weekStats, period, dateStr);
    } catch (e) {
        console.error(e);
        if (!cached) {
            const errP = document.createElement('p');
            errP.className = 'error';
            errP.textContent = 'Failed to load food logs.';
            list.replaceChildren(errP);
        }
    }
}

function _renderFoodData(groups, weekStats, period, dateStr) {
    const list = document.getElementById('food-list');
    const summary = document.getElementById('food-summary');

    list.replaceChildren();
    let dayCals = 0, dayCarbs = 0, dayProt = 0, dayFat = 0;
    currentFoodLogs = {};

    if (!groups || groups.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'hint';
        empty.style.textAlign = 'center';
        empty.textContent = 'No food logs for this day.';
        list.appendChild(empty);
    } else {
        groups.forEach(group => {
            dayCals += group.calories;
            dayCarbs += group.carbs;
            dayProt += group.protein;
            dayFat += group.fat;

            const groupDiv = document.createElement('div');
            groupDiv.className = 'history-group';

            const header = document.createElement('div');
            header.className = 'history-header';
            const title = document.createElement('strong');
            title.textContent = group.name;
            const time = document.createElement('span');
            time.style.cssText = 'font-weight:normal; color:var(--hint-color);';
            time.textContent = `(${group.time})`;
            const totals = document.createElement('span');
            totals.style.cssText = 'margin-left:auto; font-size:0.9em;';
            totals.textContent = `${group.calories} kcal (C:${group.carbs} P:${group.protein} F:${group.fat})`;
            header.appendChild(title);
            header.appendChild(time);
            header.appendChild(totals);
            groupDiv.appendChild(header);

            group.logs.forEach(log => {
                currentFoodLogs[log.id] = log;

                const item = document.createElement('div');
                item.className = 'history-item';
                item.style.cssText = 'padding: 8px 0; border-bottom: 1px solid rgba(0,0,0,0.05); cursor: pointer;';
                item.addEventListener('click', () => {
                    editFoodLog(log.id);
                });

                const itemBody = document.createElement('div');
                itemBody.style.flex = '1';
                const name = document.createElement('div');
                name.style.fontWeight = '500';
                name.textContent = log.name || 'Food';
                const meta = document.createElement('div');
                meta.style.cssText = 'font-size:0.85em; color:var(--hint-color);';
                meta.textContent = `${log.weight}g • ${log.calories} kcal`;
                itemBody.appendChild(name);
                itemBody.appendChild(meta);

                const deleteButton = document.createElement('button');
                deleteButton.type = 'button';
                deleteButton.className = 'delete-btn';
                deleteButton.style.fontSize = '16px';
                deleteButton.textContent = '×';
                deleteButton.addEventListener('click', (event) => {
                    event.stopPropagation();
                    deleteFoodLog(log.id);
                });

                item.appendChild(itemBody);
                item.appendChild(deleteButton);
                groupDiv.appendChild(item);
            });

            list.appendChild(groupDiv);
        });
    }

    const hasTargets = foodTargets.calories > 0 || foodTargets.protein > 0 || foodTargets.carbs > 0 || foodTargets.fat > 0;
    const periodContainer = document.getElementById('food-stats-period-container');
    if (periodContainer) {
        hasTargets ? periodContainer.classList.remove('hidden') : periodContainer.classList.add('hidden');
    }

    if (period === 'week' || period === '2weeks') {
        const stats = weekStats;
        summary.style.display = 'block';
        const label = period === 'week' ? '7-Day Total' : '14-Day Total';
        renderFoodSummary(summary, label, stats?.calories || 0, stats?.carbs || 0, stats?.protein || 0, stats?.fat || 0);
        renderFoodTargetProgress(stats?.calories || 0, stats?.carbs || 0, stats?.protein || 0, stats?.fat || 0, period);
    } else {
        if (groups && groups.length > 0) {
            summary.style.display = 'block';
            renderFoodSummary(summary, 'Daily Total', dayCals, dayCarbs, dayProt, dayFat);
            renderFoodTargetProgress(dayCals, dayCarbs, dayProt, dayFat, period);
        } else {
            summary.style.display = 'none';
            renderFoodTargetProgress(0, 0, 0, 0, period);
        }
    }
}

function renderFoodSummary(summaryEl, label, calories, carbs, protein, fat) {
    summaryEl.replaceChildren();

    const text = document.createTextNode(`${label}: ${calories} kcal `);
    const details = document.createElement('span');
    details.style.cssText = 'font-weight:normal; font-size:0.9em; margin-left:10px;';
    details.textContent = `(C:${carbs} P:${protein} F:${fat})`;

    summaryEl.appendChild(text);
    summaryEl.appendChild(details);
}

function renderFoodTargetProgress(valCals, valCarbs, valProt, valFat, period = 'day') {
    const container = document.getElementById('food-target-progress');
    if (!container) return;

    const targets = [
        { key: 'calories', label: 'Energy', unit: 'kcal', value: valCals, color: '#60a5fa' },
        { key: 'protein', label: 'Protein', unit: 'g', value: valProt, color: '#4ade80' },
        { key: 'carbs', label: 'Carbs', unit: 'g', value: valCarbs, color: '#22d3ee' },
        { key: 'fat', label: 'Fat', unit: 'g', value: valFat, color: '#f59e0b' }
    ];

    const activeTargets = targets.filter(t => (foodTargets[t.key] || 0) > 0);
    if (activeTargets.length === 0) {
        container.classList.add('hidden');
        container.replaceChildren();
        return;
    }

    container.classList.remove('hidden');
    container.replaceChildren();
    activeTargets.forEach((t) => {
        let targetValue = foodTargets[t.key];
        if (period === 'week') {
            targetValue = targetValue * 7;
        } else if (period === '2weeks') {
            targetValue = targetValue * 14;
        }

        let progress = Math.round((t.value / targetValue) * 100);
        const isExcess = progress > 100;
        const displayProgress = Math.min(100, progress); // Cap the visual bar at 100%

        const excessClass = isExcess ? ' excess' : '';
        const bgColor = isExcess ? 'var(--danger-color, #ef4444)' : t.color; // Red if excess

        const row = document.createElement('div');
        row.className = `food-target-row${excessClass}`;

        const topline = document.createElement('div');
        topline.className = 'food-target-topline';

        const name = document.createElement('span');
        name.className = 'food-target-name';
        name.textContent = t.label;

        const values = document.createElement('span');
        values.className = `food-target-values${isExcess ? ' excess-text' : ''}`;
        values.textContent = `${t.value} / ${targetValue} ${t.unit}`;

        topline.appendChild(name);
        topline.appendChild(values);

        const bar = document.createElement('div');
        bar.className = `food-target-bar${excessClass}`;
        const fill = document.createElement('div');
        fill.className = `food-target-fill${excessClass}`;
        fill.style.width = `${displayProgress}%`;
        fill.style.background = bgColor;
        bar.appendChild(fill);

        row.appendChild(topline);
        row.appendChild(bar);
        container.appendChild(row);
    });
}

async function loadFoodTargets() {
    // Show cached targets immediately so food rendering isn't blocked on network
    const cachedTargets = await window.DataStore.getCached('food_targets');
    if (cachedTargets) {
        foodTargets = cachedTargets;
    }

    try {
        const targets = await apiCall('/api/food/settings/targets', 'GET');
        foodTargets = {
            calories: targets?.calories || 0,
            carbs: targets?.carbs || 0,
            protein: targets?.protein || 0,
            fat: targets?.fat || 0
        };

        await window.DataStore.setCached('food_targets', foodTargets);

        const calsInput = document.getElementById('food-target-calories');
        const carbsInput = document.getElementById('food-target-carbs');
        const protInput = document.getElementById('food-target-protein');
        const fatInput = document.getElementById('food-target-fat');
        if (calsInput) calsInput.value = foodTargets.calories || '';
        if (carbsInput) carbsInput.value = foodTargets.carbs || '';
        if (protInput) protInput.value = foodTargets.protein || '';
        if (fatInput) fatInput.value = foodTargets.fat || '';
    } catch (e) {
        console.error('Failed to load food targets:', e);
    }
}

async function saveFoodTargets() {
    const payload = {
        calories: parseInt(document.getElementById('food-target-calories').value, 10) || 0,
        carbs: parseInt(document.getElementById('food-target-carbs').value, 10) || 0,
        protein: parseInt(document.getElementById('food-target-protein').value, 10) || 0,
        fat: parseInt(document.getElementById('food-target-fat').value, 10) || 0
    };

    try {
        await apiCall('/api/food/settings/targets', 'POST', payload);
        foodTargets = payload;
        await window.DataStore.invalidateTags(['settings', 'food_targets']);
        safeAlert('Food targets saved');
        if (document.querySelector('.tab.active')?.dataset.tab === 'food') {
            loadFoodLogs();
        }
    } catch (e) {
        console.error('Failed to save food targets:', e);
        safeAlert('Failed to save food targets');
    }
}

async function deleteFoodLog(id) {
    if (!confirm("Delete this entry?")) return;
    try {
        await apiCall(`/api/food/log/${id}`, 'DELETE');
        loadFoodLogs();
    } catch (e) {
        console.error(e);
        safeAlert("Failed to delete.");
    }
}


function switchMedTab(tab) {
    document.querySelector('.med-tabs')?.setActiveTab?.(tab);
    const tabContent = document.getElementById(`med-${tab}-tab`);
    if (!tabContent) return;

    document.querySelectorAll('.med-tab-content').forEach((el) => el.classList.remove('active'));
    tabContent.classList.add('active');

    if (tab === 'schedule') { loadMeds(); }
    else if (tab === 'history') { loadHistory(); }
}

document.querySelector('.med-tabs')?.addEventListener('tabchange', (e) => {
    switchMedTab(e.detail.tabId);
});

// Load settings (BP reminders status, etc.)
async function loadSettings() {
    const applyBundle = async (rawBundle) => {
        const bundle = normalizeSettingsBundle(rawBundle);
        featureSettings = { ...featureSettings, ...bundle.featureSettings };
        featureSettingsLoaded = true;
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

async function loadFeatureSettings() {
    try {
        const res = await apiCall('/api/settings/features', 'GET');
        featureSettings = { ...featureSettings, ...res };
        featureSettingsLoaded = true;
        updateFeatureToggles();
        updateFeatureTabVisibility();
    } catch (e) {
        console.error('Failed to load feature settings:', e);
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
        await window.DataStore.invalidateTags(['settings', 'feature_settings']);
        updateFeatureTabVisibility();
    } catch (e) {
        console.error(`Failed to toggle ${feature} feature:`, e);
        updateFeatureToggles();
        alert('Failed to update setting.');
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
window.applyPendingTabRefresh = applyPendingTabRefresh;

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
    document.getElementById('med-days').value = [];
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
    document.getElementById('med-days').value = sched.days || [];
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
        tg.showAlert("Please enter a valid quantity");
        return;
    }

    const res = await apiCall(`/api/medications/${editingMedId}/restock`, 'POST', { quantity: qty });
    if (res) {
        // Update displayed count
        document.getElementById('med-inventory-count').value = res.inventory_count;
        qtyInput.value = '';
        loadRestockHistory(editingMedId);
        tg.showAlert(`Added ${qty} units. New total: ${res.inventory_count}`);
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
        const div = document.createElement('mt-card');
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

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'delete-btn';
        deleteBtn.textContent = '×';
        deleteBtn.addEventListener('click', () => {
            deleteMed(med.id);
        });

        actions.appendChild(logBtn);
        actions.appendChild(deleteBtn);
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
        const container = document.createElement('mt-card');
        container.className = 'history-group';

        // Make PENDING and TAKEN items clickable
        if (g.status === 'PENDING' || g.status === 'TAKEN') {
            container.style.cursor = 'pointer';
            container.onclick = () => {
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

        container.appendChild(header);
        container.appendChild(items);
        list.appendChild(container);
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

    // Sort alphabetically
    const sorted = [...medications].sort((a, b) => a.name.localeCompare(b.name));

    sorted.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.innerText = m.name + (m.archived ? ' (Archived)' : '');
        select.appendChild(opt);
    });

    select.value = currentVal;
}

async function saveMedication() {
    const name = document.getElementById('med-name').value;
    const dosage = document.getElementById('med-dosage').value;
    const type = document.getElementById('schedule-type').value;
    const archived = document.getElementById('med-archived').checked;

    const startDateRaw = document.getElementById('med-start-date').value;
    const endDateRaw = document.getElementById('med-end-date').value;

    // Inventory tracking
    const trackInventory = document.getElementById('med-track-inventory').checked;
    const inventoryCountRaw = document.getElementById('med-inventory-count').value;
    let inventoryCount = null;
    if (trackInventory && inventoryCountRaw !== '') {
        inventoryCount = parseInt(inventoryCountRaw);
    }

    if (!name) { tg.showAlert("Name is required!"); return; }

    const schedule = { type: type };

    if (type !== 'as_needed') {
        const times = Array.from(document.querySelectorAll('.med-time-input'))
            .map(i => i.value)
            .filter(v => v !== "");

        if (times.length === 0) {
            tg.showAlert("At least one time is required!");
            return;
        }
        schedule.times = times;
    }

    if (type === 'weekly') {
        const days = document.getElementById('med-days').value;

        if (days.length === 0) {
            tg.showAlert("Select at least one day!");
            return;
        }
        schedule.days = days;
    }

    const payload = {
        name,
        dosage,
        schedule: JSON.stringify(schedule),
        archived,
        start_date: startDateRaw ? new Date(startDateRaw).toISOString() : null,
        end_date: endDateRaw ? new Date(endDateRaw).toISOString() : null,
        inventory_count: inventoryCount
    };

    let res;
    if (editingMedId) {
        res = await apiCall(`/api/medications/${editingMedId}`, 'POST', payload);
    } else {
        res = await apiCall('/api/medications', 'POST', payload);
    }

    if (res && res.warning) {
        tg.showAlert("⚠️ " + res.warning);
    }

    await window.DataStore.invalidateTags(['medications', 'history']);
    await window.DataStore.invalidateKey('next_intake');

    closeModal();
    loadMeds();
}

async function deleteMed(id) {
    const confirmMsg = "Archive this medication?";

    // Check if we are in Telegram and version supports it
    if (userInitData && tg.showConfirm) {
        try {
            tg.showConfirm(confirmMsg, (ok) => {
                if (ok) _archiveMedApi(id);
            });
            return;
        } catch (e) {
            console.log("tg.showConfirm failed, falling back", e);
        }
    }

    // Fallback for browser
    if (confirm(confirmMsg)) {
        _archiveMedApi(id);
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
        archived: true // Set archived to true
    };

    const res = await apiCall(`/api/medications/${id}`, 'POST', payload);
    if (res && res.warning) {
        tg.showAlert("⚠️ " + res.warning);
    }
    await window.DataStore.invalidateTags(['medications', 'history']);
    await window.DataStore.invalidateKey('next_intake');
    loadMeds();
}

async function loadHistory() {
    // Ensure medications are loaded for name resolution
    if (medications.length === 0) await loadMeds();

    const days = document.getElementById('history-filter-days').value;
    const medId = document.getElementById('history-filter-med').value;

    const cacheKey = `history_${days}_${medId}`;

    await window.DataStore.loadSWR({
        key: cacheKey,
        tags: ['history'],
        fetcher: async () => await apiCall(`/api/history?days=${days}&med_id=${medId}`),
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

        const card = document.createElement('mt-card');
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
    try {
        const res = await apiCall('/api/medications/trigger-next-intake', 'POST');

        if (res && res.status === 'confirmed') {
            await window.DataStore.invalidateTags(['history', 'medications']);
            await window.DataStore.invalidateKey('next_intake');
            const medNamesStr = res.medication_names ? res.medication_names.join(', ') : `${res.medication_count} medication(s)`;
            safeAlert(`✅ Confirmed: ${medNamesStr}\n\nScheduled for: ${formatDate(res.scheduled_at)}\nTaken at: ${formatDate(res.taken_at)}`);

            // Reload history which will also recalculate the next intake trigger
            await loadHistory();
        }
    } catch (error) {
        console.error('Error triggering next intake:', error);
        safeAlert('Failed to trigger next intake. Please try again.');
    }
}

// Init
// loadMeds() removed to avoid redundant call. It is called by checkAuth -> switchTab.


// --- Weekly Adherence Visualization ---

const MED_COLORS = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEEAD',
    '#D4A5A5', '#9B59B6', '#3498DB', '#E67E22', '#2ECC71'
];

function getMedColor(id) {
    // Deterministic color based on ID
    return MED_COLORS[id % MED_COLORS.length];
}

async function renderWeeklyHub() {
    const container = document.getElementById('weekly-hub-container');
    if (!container) return;

    // 1. Calculate last 7 days (including today)
    const days = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(now.getDate() - i);
        days.push(d);
    }

    // 2. Fetch history for this range (7 days)
    // We reuse the existing history API but maybe we need to fetch enough.
    // The existing API defaults to 3 days. We need to force it or add a specific call.
    // Let's just use the history API with days=7 for all meds (med_id=0).
    const res = await apiCall(`/api/history?days=7&med_id=0`);
    const historyLogs = res || [];

    // 3. Build HTML
    const doc = container.ownerDocument || document;
    const fragment = doc.createDocumentFragment();

    const header = doc.createElement('h3');
    header.className = 'weekly-header';
    header.textContent = 'Last 7 Days';
    fragment.appendChild(header);

    const daysContainer = doc.createElement('div');
    daysContainer.className = 'weekly-days';
    fragment.appendChild(daysContainer);

    days.forEach(dateObj => {
        const dateStr = dateObj.toISOString().split('T')[0]; // YYYY-MM-DD
        const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'short' }); // Mon, Tue...
        const dayNum = dateObj.getDate();

        // Find what should have been taken on this day
        // This is tricky because "schedule" logic is complex (weekly, days, etc.)
        // We will simplify: Check all active meds.
        // If a med was scheduled for this day (based on its schedule), we expect a log.
        // OR we just look at the logs? No, logs only show what happened.
        // We need to know what *should* have happened.
        // For now, let's look at logs to see if anything was done.
        // BUT the requirement is: "different scheduled medicine might have different color"
        // So we need to know the schedule.

        let scheduledMeds = [];
        const dayOfWeek = dateObj.getDay(); // 0-6

        medications.forEach(m => {
            if (m.archived) return;
            // Check if m applies to this day
            // Start/End date check
            const start = m.start_date ? new Date(m.start_date) : null;
            const end = m.end_date ? new Date(m.end_date) : null;

            // Normalize dateObj to midnight for comparison
            const checkDate = new Date(dateStr);
            if (start && checkDate < new Date(start.toISOString().split('T')[0])) return;
            if (end && checkDate > new Date(end.toISOString().split('T')[0])) return;

            try {
                const sched = JSON.parse(m.schedule);
                if (sched.type === 'daily') {
                    scheduledMeds.push(m);
                } else if (sched.type === 'weekly') {
                    if (sched.days && sched.days.includes(dayOfWeek)) {
                        scheduledMeds.push(m);
                    }
                }
                // 'as_needed' doesn't count for adherence circles usually
            } catch (e) { }
        });

        // Now check status for these meds on this date
        // We look for logs where scheduled_at (or taken_at if no scheduled_at) matches dateStr
        // Actually, logs store specific timestamps.
        // We'll check if there's a TAKEN log for this med on this day.

        const segments = [];
        if (scheduledMeds.length === 0) {
            // No meds scheduled -> maybe grey or empty?
            // Let's leave it empty (grey default)
        } else {
            const segmentSize = 100 / scheduledMeds.length;
            let currentAngle = 0;

            scheduledMeds.forEach(m => {
                // Did we take it?
                // Look for a log for this med on this date with status TAKEN
                const taken = historyLogs.find(l => {
                    if (l.medication_id !== m.id) return false;
                    if (l.status !== 'TAKEN') return false;
                    // Check date match.
                    // If scheduled_at exists, use it. Else use taken_at.
                    const refIso = l.scheduled_at || l.taken_at;
                    return refIso.startsWith(dateStr);
                });

                const color = taken ? getMedColor(m.id) : '#e0e0e0';
                segments.push(`${color} ${currentAngle}% ${currentAngle + segmentSize}%`);
                currentAngle += segmentSize;
            });
        }

        const dayColumn = doc.createElement('div');
        dayColumn.className = 'day-column';

        const dayLabel = doc.createElement('div');
        dayLabel.className = 'day-label';
        dayLabel.textContent = dayName;
        dayColumn.appendChild(dayLabel);

        const dayCircle = doc.createElement('div');
        dayCircle.className = 'day-circle';
        if (segments.length > 0) {
            dayCircle.style.background = `conic-gradient(${segments.join(', ')})`;
        }
        dayColumn.appendChild(dayCircle);

        const dayDate = doc.createElement('div');
        dayDate.className = 'day-date';
        dayDate.textContent = dayNum;
        dayColumn.appendChild(dayDate);

        daysContainer.appendChild(dayColumn);
    });

    container.replaceChildren(fragment);
}

// Hook into loadMeds to trigger this update
const originalLoadMeds = loadMeds;
loadMeds = async function () {
    await originalLoadMeds();
    renderWeeklyHub();
};

// ==================== Blood Pressure Functions ====================

// Get BP category based on ISH 2020 guidelines (for users < 65 years)
function getBPCategory(sys, dia) {
    // Grade 2 Hypertension: ≥160 and/or ≥100
    if (sys >= 160 || dia >= 100) return { label: 'Grade 2 HTN', class: 'grade2' };
    // Grade 1 Hypertension: 140-159 and/or 90-99
    if (sys >= 140 || dia >= 90) return { label: 'Grade 1 HTN', class: 'grade1' };
    // High-normal: 130-139 and/or 85-89
    if (sys >= 130 || dia >= 85) return { label: 'High-normal', class: 'highnormal' };
    // Normal: <130 and <85
    return { label: 'Normal', class: 'normal' };
}

// Show BP recording modal
function showBPRecordModal() {
    window.ModalManager.bp.open();

    // Set default datetime to now
    document.getElementById('bp-datetime').value = formatDateTimeLocalForInput();

    // Clear other fields
    document.getElementById('bp-systolic').value = '';
    document.getElementById('bp-diastolic').value = '';
    document.getElementById('bp-pulse').value = '';
    document.getElementById('bp-notes').value = '';
    document.getElementById('bp-site').value = 'right_arm';
    document.getElementById('bp-position').value = 'seated';

    // Focus the systolic field
    document.getElementById('bp-systolic').focus();
}

// Close BP modal
function closeBPRecordModal() {
    window.ModalManager.bp.close();
}

// Handle BP form submission
async function handleBPSubmit(event) {
    event.preventDefault();

    const datetime = document.getElementById('bp-datetime').value;
    const systolic = parseInt(document.getElementById('bp-systolic').value);
    const diastolic = parseInt(document.getElementById('bp-diastolic').value);
    const pulse = document.getElementById('bp-pulse').value ? parseInt(document.getElementById('bp-pulse').value) : null;
    const site = document.getElementById('bp-site').value;
    const position = document.getElementById('bp-position').value;
    const notes = document.getElementById('bp-notes').value;

    if (!datetime || !systolic || !diastolic) {
        tg.showAlert('Please fill in all required fields');
        return;
    }

    const payload = {
        measured_at: new Date(datetime).toISOString(),
        systolic,
        diastolic,
        pulse,
        site,
        position,
        notes
    };

    const res = await apiCall('/api/bp', 'POST', payload);

    if (res) {
        await window.DataStore.invalidateTags(['bp']);
        closeBPRecordModal();
        loadBPReadings();
    }
}

// Load BP readings from API (with offline support)
async function loadBPReadings() {
    const list = document.getElementById('bp-list');
    await window.DataStore.loadSWR({
        key: 'bp',
        tags: ['bp'],
        fetcher: async () => {
            const [readingsRes, goalRes, statsRes] = await Promise.all([
                apiCall('/api/bp?days=60'),
                apiCall('/api/bp/goal'),
                apiCall('/api/bp/stats')
            ]);
            if (readingsRes === null) return null;
            return { readingsRes, goalRes, statsRes };
        },
        onCached: async (cached) => {
            await _renderBPData(cached.readingsRes, cached.goalRes, cached.statsRes);
        },
        onFresh: async (fresh) => {
            await _renderBPData(fresh.readingsRes, fresh.goalRes, fresh.statsRes);
        },
        onError: async (e, cached) => {
            console.error('Failed to load BP data:', e);
            if (!cached) {
                const errLi = document.createElement('li');
                errLi.style.cssText = 'text-align:center;color:var(--hint-color);padding:20px;';
                errLi.textContent = 'Failed to load readings';
                list.replaceChildren(errLi);
            }
        }
    });
}

async function _renderBPData(readingsRes, goalRes, statsRes) {
    const list = document.getElementById('bp-list');

    // Merge server data with pending local writes
    let allReadings = readingsRes || [];
    if (window.MedTrackerDB) {
        try {
            const pendingReadings = await window.MedTrackerDB.BPStore.getPending();
            const pendingFormatted = pendingReadings.map(r => ({
                id: `local_${r.localId}`,
                localId: r.localId,
                measured_at: r.measured_at,
                systolic: r.systolic,
                diastolic: r.diastolic,
                pulse: r.pulse,
                site: r.site,
                position: r.position,
                notes: r.notes,
                isLocal: true
            }));
            allReadings = [...pendingFormatted, ...allReadings];
        } catch (e) {
            console.error('Failed to get pending BP readings:', e);
        }
    }

    if (allReadings.length === 0 && readingsRes === null) {
        const errLi = document.createElement('li');
        errLi.style.cssText = 'text-align:center;color:var(--hint-color);padding:20px;';
        errLi.textContent = 'Failed to load readings';
        list.replaceChildren(errLi);
        return;
    }

    renderBPChart(allReadings, goalRes || {});
    renderBPAverages(statsRes || {});

    // Filter list to only show last 3 days (Today, Yesterday, and Day Before)
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 2);
    cutoff.setHours(0, 0, 0, 0);

    const filteredReadings = allReadings.filter(r => new Date(r.measured_at) >= cutoff);
    renderBPReadings(filteredReadings);
}

// Render BP Chart with color-coded points and segments
function renderBPChart(readings, goalData) {
    const container = document.getElementById('bpChart');
    if (!container) return;

    container.replaceChildren();

    if (!readings || readings.length === 0) {
        const noDataSpan = document.createElement('span');
        noDataSpan.style.cssText = "color:var(--hint-color);font-size:14px;";
        noDataSpan.textContent = "No data available";
        container.appendChild(noDataSpan);
        return;
    }

    // Sort by date (oldest first)
    const sorted = [...readings].sort((a, b) => new Date(a.measured_at) - new Date(b.measured_at));

    // Extract data series with classifications
    const data = sorted.map(r => ({
        date: new Date(r.measured_at),
        sys: r.systolic,
        dia: r.diastolic,
        pulse: r.pulse,
        category: getBPCategory(r.systolic, r.diastolic)
    }));

    // Calculate averages
    const avgSys = data.reduce((sum, d) => sum + d.sys, 0) / data.length;
    const avgDia = data.reduce((sum, d) => sum + d.dia, 0) / data.length;

    // Dimensions
    const leftPadding = 40;
    const totalWidth = container.clientWidth;
    const chartWidth = totalWidth - leftPadding - 10;
    const chartHeight = container.clientHeight - 35;

    // Find min/max across all series
    let minVal = Math.min(...data.map(d => d.dia), ...data.filter(d => d.pulse).map(d => d.pulse));
    let maxVal = Math.max(...data.map(d => d.sys), ...data.filter(d => d.pulse).map(d => d.pulse));

    // Include averages in range
    minVal = Math.min(minVal, avgDia);
    maxVal = Math.max(maxVal, avgSys);

    // Round to nice values for Y-axis
    minVal = Math.floor(minVal / 10) * 10;
    maxVal = Math.ceil(maxVal / 10) * 10;

    const range = maxVal - minVal || 1;
    const yPad = 10; // Fixed padding
    const effectiveMin = minVal - yPad;
    const effectiveMax = maxVal + yPad;
    const effectiveRange = effectiveMax - effectiveMin;

    // Determine Y-axis interval (10 or 20)
    const yInterval = (effectiveRange > 80) ? 20 : 10;

    // Date range
    const firstDate = data[0].date;
    const lastDate = data[data.length - 1].date;
    const dateRange = lastDate - firstDate || 1;

    const xScaleByDate = (date) => leftPadding + ((date - firstDate) / dateRange) * chartWidth;
    const yScale = (v) => chartHeight - ((v - effectiveMin) / effectiveRange) * chartHeight;

    // Get color for BP classification
    const getClassColor = (category) => {
        const colorMap = {
            'normal': '#22c55e',
            'highnormal': '#eab308',
            'grade1': '#f97316',
            'grade2': '#ef4444'
        };
        return colorMap[category.class] || '#22c55e';
    };

    // SVG Construction
    const svgNs = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("viewBox", `0 0 ${totalWidth} ${chartHeight + 20}`);

    // Y-Axis Labels at regular intervals
    for (let val = Math.ceil(effectiveMin / yInterval) * yInterval; val <= effectiveMax; val += yInterval) {
        const y = yScale(val);
        const text = document.createElementNS(svgNs, "text");
        text.setAttribute("x", leftPadding - 5);
        text.setAttribute("y", y + 4);
        text.setAttribute("class", "chart-label");
        text.setAttribute("style", "text-anchor: end; fill: var(--hint-color); font-size: 11px;");
        text.textContent = val;
        svg.appendChild(text);

        const gridLine = document.createElementNS(svgNs, "line");
        gridLine.setAttribute("x1", leftPadding);
        gridLine.setAttribute("y1", y);
        gridLine.setAttribute("x2", totalWidth - 10);
        gridLine.setAttribute("y2", y);
        gridLine.setAttribute("class", "chart-grid");
        svg.appendChild(gridLine);
    }

    // Draw average lines (dotted)
    const avgSysY = yScale(avgSys);
    const avgSysLine = document.createElementNS(svgNs, "line");
    avgSysLine.setAttribute("x1", leftPadding);
    avgSysLine.setAttribute("y1", avgSysY);
    avgSysLine.setAttribute("x2", totalWidth - 10);
    avgSysLine.setAttribute("y2", avgSysY);
    avgSysLine.setAttribute("class", "bp-chart-avg-line");
    svg.appendChild(avgSysLine);

    const avgDiaY = yScale(avgDia);
    const avgDiaLine = document.createElementNS(svgNs, "line");
    avgDiaLine.setAttribute("x1", leftPadding);
    avgDiaLine.setAttribute("y1", avgDiaY);
    avgDiaLine.setAttribute("x2", totalWidth - 10);
    avgDiaLine.setAttribute("y2", avgDiaY);
    avgDiaLine.setAttribute("class", "bp-chart-avg-line");
    svg.appendChild(avgDiaLine);

    // Draw color-coded line segments for systolic
    for (let i = 0; i < data.length - 1; i++) {
        const x1 = xScaleByDate(data[i].date);
        const y1 = yScale(data[i].sys);
        const x2 = xScaleByDate(data[i + 1].date);
        const y2 = yScale(data[i + 1].sys);
        const color = getClassColor(data[i].category);

        const line = document.createElementNS(svgNs, "line");
        line.setAttribute("x1", x1);
        line.setAttribute("y1", y1);
        line.setAttribute("x2", x2);
        line.setAttribute("y2", y2);
        line.setAttribute("stroke", color);
        line.setAttribute("stroke-width", "2.5");
        line.setAttribute("fill", "none");
        svg.appendChild(line);
    }

    // Draw color-coded line segments for diastolic
    for (let i = 0; i < data.length - 1; i++) {
        const x1 = xScaleByDate(data[i].date);
        const y1 = yScale(data[i].dia);
        const x2 = xScaleByDate(data[i + 1].date);
        const y2 = yScale(data[i + 1].dia);
        const color = getClassColor(data[i].category);

        const line = document.createElementNS(svgNs, "line");
        line.setAttribute("x1", x1);
        line.setAttribute("y1", y1);
        line.setAttribute("x2", x2);
        line.setAttribute("y2", y2);
        line.setAttribute("stroke", color);
        line.setAttribute("stroke-width", "2.5");
        line.setAttribute("fill", "none");
        svg.appendChild(line);
    }

    // Draw color-coded points for systolic
    data.forEach(d => {
        const x = xScaleByDate(d.date);
        const y = yScale(d.sys);
        const color = getClassColor(d.category);

        const circle = document.createElementNS(svgNs, "circle");
        circle.setAttribute("cx", x);
        circle.setAttribute("cy", y);
        circle.setAttribute("r", 4);
        circle.setAttribute("fill", color);
        circle.setAttribute("stroke", "var(--bg-color)");
        circle.setAttribute("stroke-width", "2");
        svg.appendChild(circle);
    });

    // Draw color-coded points for diastolic
    data.forEach(d => {
        const x = xScaleByDate(d.date);
        const y = yScale(d.dia);
        const color = getClassColor(d.category);

        const circle = document.createElementNS(svgNs, "circle");
        circle.setAttribute("cx", x);
        circle.setAttribute("cy", y);
        circle.setAttribute("r", 4);
        circle.setAttribute("fill", color);
        circle.setAttribute("stroke", "var(--bg-color)");
        circle.setAttribute("stroke-width", "2");
        svg.appendChild(circle);
    });

    // Date labels
    const firstLabel = document.createElementNS(svgNs, "text");
    firstLabel.setAttribute("x", leftPadding);
    firstLabel.setAttribute("y", chartHeight + 15);
    firstLabel.setAttribute("class", "chart-label");
    firstLabel.setAttribute("style", "text-anchor: start;");
    firstLabel.textContent = data[0].date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
    svg.appendChild(firstLabel);

    const lastLabel = document.createElementNS(svgNs, "text");
    lastLabel.setAttribute("x", totalWidth - 10);
    lastLabel.setAttribute("y", chartHeight + 15);
    lastLabel.setAttribute("class", "chart-label");
    lastLabel.setAttribute("style", "text-anchor: end;");
    lastLabel.textContent = data[data.length - 1].date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
    svg.appendChild(lastLabel);

    container.appendChild(svg);
}

// Render BP averages from backend-calculated daily-weighted stats
function renderBPAverages(stats) {
    const container = document.getElementById('bp-averages');
    if (!container) return;

    // Check if stats object has any data
    if (!stats || (!stats.stats_14 && !stats.stats_30 && !stats.stats_60)) {
        container.replaceChildren();
        return;
    }

    const row = document.createElement('div');
    row.className = 'bp-avg-row';

    const appendAverageItem = (label, stat) => {
        const item = document.createElement('div');
        item.className = 'bp-avg-item';
        const labelEl = document.createElement('span');
        labelEl.className = 'bp-avg-label';
        labelEl.textContent = `${label} (${stat.days}d)`;
        const valueEl = document.createElement('span');
        valueEl.className = 'bp-avg-value';
        valueEl.textContent = `${stat.systolic}/${stat.diastolic}`;
        item.appendChild(labelEl);
        item.appendChild(valueEl);
        row.appendChild(item);
    };

    if (stats.stats_14) appendAverageItem('14d', stats.stats_14);
    if (stats.stats_30) appendAverageItem('30d', stats.stats_30);
    if (stats.stats_60) appendAverageItem('60d', stats.stats_60);

    container.replaceChildren(row);
}

// Render BP readings grouped by date
function renderBPReadings(readings) {
    const list = document.getElementById('bp-list');
    list.replaceChildren();

    if (!readings || readings.length === 0) {
        return;
    }

    // Group readings by date
    const groups = { today: [], yesterday: [], older: [] };
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    readings.forEach(r => {
        const date = new Date(r.measured_at);
        date.setHours(0, 0, 0, 0);

        if (date.getTime() === today.getTime()) {
            groups.today.push(r);
        } else if (date.getTime() === yesterday.getTime()) {
            groups.yesterday.push(r);
        } else {
            groups.older.push(r);
        }
    });

    // Helper to render a group
    const renderGroup = (headerText, groupReadings) => {
        if (groupReadings.length === 0) return null;

        // Sort readings within this group by time (newest first)
        const sortedReadings = [...groupReadings].sort((a, b) =>
            new Date(b.measured_at) - new Date(a.measured_at)
        );

        const groupItem = document.createElement('li');
        groupItem.className = 'bp-date-group';

        const header = document.createElement('div');
        header.className = 'bp-date-header';
        header.textContent = headerText;

        const groupList = document.createElement('ul');
        groupList.style.listStyle = 'none';
        groupList.style.padding = '0';
        groupList.style.margin = '0';
        groupItem.appendChild(header);
        groupItem.appendChild(groupList);

        sortedReadings.forEach(r => {
            const category = getBPCategory(r.systolic, r.diastolic);
            const [, timeStr = ''] = formatDate(r.measured_at).split(' '); // Get HH:MM part
            const pendingClass = r.isLocal ? ' pending-sync' : '';

            const item = document.createElement('mt-card');
            item.className = `bp-item${pendingClass}`;

            const reading = document.createElement('div');
            reading.className = 'bp-reading';

            const values = document.createElement('div');
            values.className = 'bp-values';

            const sys = document.createElement('span');
            sys.className = 'bp-sys';
            sys.textContent = String(r.systolic);

            const dia = document.createElement('span');
            dia.className = 'bp-dia';
            dia.textContent = `/${r.diastolic}`;

            values.appendChild(sys);
            values.appendChild(dia);

            if (r.isLocal) {
                const badge = document.createElement('span');
                badge.className = 'sync-pending-badge';
                badge.textContent = 'Pending';
                values.appendChild(badge);
            }

            const meta = document.createElement('div');
            meta.className = 'bp-meta';

            const time = document.createElement('span');
            time.textContent = timeStr;
            meta.appendChild(time);

            if (r.pulse) {
                const pulse = document.createElement('span');
                pulse.className = 'bp-pulse';
                pulse.textContent = `${r.pulse} bpm`;
                meta.appendChild(pulse);
            }

            const categoryEl = document.createElement('span');
            categoryEl.className = `bp-category ${category.class}`;
            categoryEl.textContent = category.label;
            meta.appendChild(categoryEl);

            reading.appendChild(values);
            reading.appendChild(meta);

            const deleteButton = document.createElement('button');
            deleteButton.type = 'button';
            deleteButton.className = 'delete-btn';
            deleteButton.title = 'Delete';
            deleteButton.textContent = '×';
            deleteButton.addEventListener('click', () => {
                deleteBPReading(String(r.id));
            });

            item.appendChild(reading);
            item.appendChild(deleteButton);
            groupList.appendChild(item);
        });

        return groupItem;
    };

    // Render groups in order
    const todayGroup = renderGroup('Today', groups.today);
    const yesterdayGroup = renderGroup('Yesterday', groups.yesterday);

    if (todayGroup) list.appendChild(todayGroup);
    if (yesterdayGroup) list.appendChild(yesterdayGroup);

    if (groups.older.length > 0) {
        // Format older dates
        const olderGroups = new Map();
        groups.older.forEach(r => {
            const d = new Date(r.measured_at);
            const key = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
            if (!olderGroups.has(key)) olderGroups.set(key, []);
            olderGroups.get(key).push(r);
        });

        olderGroups.forEach((olderReadings, dateKey) => {
            const olderGroup = renderGroup(dateKey, olderReadings);
            if (olderGroup) list.appendChild(olderGroup);
        });
    }
}

// Delete a BP reading
async function deleteBPReading(id) {
    const confirmMsg = 'Delete this blood pressure reading?';

    if (userInitData && tg.showConfirm) {
        try {
            tg.showConfirm(confirmMsg, (ok) => {
                if (ok) _deleteBPApi(id);
            });
            return;
        } catch (e) {
            console.log('tg.showConfirm failed, falling back', e);
        }
    }

    if (confirm(confirmMsg)) {
        _deleteBPApi(id);
    }
}

async function _deleteBPApi(id) {
    // Check if this is a local-only reading
    if (typeof id === 'string' && id.startsWith('local_')) {
        const localId = parseInt(id.replace('local_', ''));
        if (window.MedTrackerDB) {
            await window.MedTrackerDB.BPStore.confirmDelete(localId);
            if (window.SyncManager) window.SyncManager.updateStatus();
        }
        loadBPReadings();
        return;
    }

    const res = await apiCall(`/api/bp/${id}`, 'DELETE');
    if (res) {
        await window.DataStore.invalidateTags(['bp']);
        // Also remove from local IndexedDB if it exists there
        if (window.MedTrackerDB) {
            try {
                // Find and delete the local record with this serverId
                const allReadings = await window.MedTrackerDB.BPStore.getAll();
                const localRecord = allReadings.find(r => r.serverId === parseInt(id));
                if (localRecord && localRecord.localId) {
                    await window.MedTrackerDB.BPStore.confirmDelete(localRecord.localId);
                    if (window.SyncManager) window.SyncManager.updateStatus();
                }
            } catch (e) {
                console.error('Failed to delete from local DB:', e);
            }
        }
        loadBPReadings();
    }
}

// Export BP data to CSV
async function exportBPCSV() {
    try {
        const response = await fetch('/api/bp/export', {
            method: 'GET',
            headers: {
                'Authorization': `tma ${userInitData}`
            }
        });

        if (!response.ok) {
            tg.showAlert('Failed to generate export');
            return;
        }

        const blob = await response.blob();
        downloadBlobAsFile(blob, 'blood_pressure_export.csv');
    } catch (err) {
        console.error('Export error:', err);
        tg.showAlert('Failed to export data');
    }
}

// ==================== Weight Tracking Functions ====================

// Global variable to store weight logs for ruler component
let cachedWeightLogs = [];

function showWeightModal() {
    window.ModalManager.weight.open();

    // Set default datetime to now
    document.getElementById('weight-datetime').value = formatDateTimeLocalForInput();

    // Clear notes field
    document.getElementById('weight-notes').value = '';

    // Get last logged weight and initialize ruler
    const lastWeight = cachedWeightLogs && cachedWeightLogs.length > 0
        ? cachedWeightLogs[0].weight
        : 75.0; // Default to 75kg if no history

    // Set default value
    setWeightValue(lastWeight);

    // Initialize the ruler
    initWeightRuler(lastWeight);
}

function closeWeightModal() {
    window.ModalManager.weight.close();
}

async function handleWeightSubmit(event) {
    event.preventDefault();

    const datetime = document.getElementById('weight-datetime').value;
    const weight = parseFloat(document.getElementById('weight-value').value);
    const notes = document.getElementById('weight-notes').value;

    if (!datetime || !weight) {
        tg.showAlert('Please fill in all required fields');
        return;
    }

    const payload = {
        measured_at: new Date(datetime).toISOString(),
        weight,
        notes
    };

    const res = await apiCall('/api/weight', 'POST', payload);

    if (res) {
        await window.DataStore.invalidateTags(['weight']);
        closeWeightModal();
        loadWeightLogs();
    }
}

// ==================== Weight Ruler Component ====================

let rulerState = {
    currentWeight: 75.0,
    isDragging: false,
    startX: 0,
    startWeight: 0,
    pixelsPerKg: 40 // How many pixels = 1 kg
};

function setWeightValue(weight) {
    // Clamp weight between min and max
    weight = Math.max(30, Math.min(300, weight));
    weight = Math.round(weight * 10) / 10; // Round to 1 decimal

    rulerState.currentWeight = weight;

    // Update input field
    document.getElementById('weight-value').value = weight.toFixed(1);
}

function initWeightRuler(initialWeight) {
    setWeightValue(initialWeight);
    renderRulerTicks(initialWeight);
    updateRulerPosition(initialWeight);
    attachRulerEventListeners();

    // Add input event listener for manual typing
    const input = document.getElementById('weight-value');
    input.addEventListener('input', (e) => {
        const value = parseFloat(e.target.value);
        if (!isNaN(value)) {
            rulerState.currentWeight = value;
            updateRulerPosition(value);
        }
    });
}

function renderRulerTicks(centerWeight) {
    const ruler = document.getElementById('weight-ruler');
    ruler.replaceChildren(); // Clear existing ticks

    const container = document.getElementById('weight-ruler-container');
    const containerWidth = container.clientWidth;
    const centerX = containerWidth / 2;

    // Generate ticks for a range around the center weight
    const range = 15; // Show ±15 kg range
    const tickSpacing = rulerState.pixelsPerKg; // pixels between each 1kg tick

    // Calculate offset to center the current weight
    const offset = -(centerWeight - Math.floor(centerWeight - range)) * tickSpacing;

    ruler.style.transform = `translateX(${centerX + offset}px)`;

    // Generate ticks
    for (let kg = Math.floor(centerWeight - range); kg <= Math.ceil(centerWeight + range); kg++) {
        const x = (kg - Math.floor(centerWeight - range)) * tickSpacing;

        // Major tick every 1 kg
        const tick = document.createElement('div');
        tick.className = kg % 5 === 0 ? 'weight-tick major' : 'weight-tick minor';
        tick.style.left = x + 'px';
        ruler.appendChild(tick);

        // Label every 1 kg
        if (kg % 1 === 0) {
            const label = document.createElement('div');
            label.className = 'weight-tick-label';
            label.textContent = kg;
            label.style.left = x + 'px';
            ruler.appendChild(label);
        }
    }
}

function attachRulerEventListeners() {
    const container = document.getElementById('weight-ruler-container');

    // Mouse events
    container.addEventListener('mousedown', handleDragStart);
    document.addEventListener('mousemove', handleDragMove);
    document.addEventListener('mouseup', handleDragEnd);

    // Touch events
    container.addEventListener('touchstart', handleDragStart, { passive: false });
    document.addEventListener('touchmove', handleDragMove, { passive: false });
    document.addEventListener('touchend', handleDragEnd);
}

function handleDragStart(e) {
    rulerState.isDragging = true;
    rulerState.startWeight = rulerState.currentWeight;

    if (e.type === 'touchstart') {
        rulerState.startX = e.touches[0].clientX;
        e.preventDefault(); // Prevent scrolling while dragging
    } else {
        rulerState.startX = e.clientX;
    }
}

function handleDragMove(e) {
    if (!rulerState.isDragging) return;

    let currentX;
    if (e.type === 'touchmove') {
        currentX = e.touches[0].clientX;
        e.preventDefault(); // Prevent scrolling
    } else {
        currentX = e.clientX;
    }

    const deltaX = rulerState.startX - currentX; // Inverted: drag left = increase weight
    const deltaWeight = deltaX / rulerState.pixelsPerKg;

    const newWeight = rulerState.startWeight + deltaWeight;
    setWeightValue(newWeight);

    // Regenerate ticks and update position to keep ruler centered
    renderRulerTicks(newWeight);
}

function handleDragEnd(e) {
    if (!rulerState.isDragging) return;
    rulerState.isDragging = false;
}

function updateRulerPosition(weight) {
    // Simply regenerate the ticks centered on the new weight
    renderRulerTicks(weight);
}


// =================== Helper Functions for Enhanced Weight Chart ===================

// Catmull-Rom spline interpolation for smooth curves
function catmullRomSpline(points, segments = 20) {
    if (points.length < 2) return `M ${points[0][0]},${points[0][1]}`;
    if (points.length === 2) return `M ${points[0][0]},${points[0][1]} L ${points[1][0]},${points[1][1]}`;

    let path = `M ${points[0][0]},${points[0][1]}`;

    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[Math.max(i - 1, 0)];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[Math.min(i + 2, points.length - 1)];

        for (let t = 0; t <= segments; t++) {
            const tt = t / segments;
            const tt2 = tt * tt;
            const tt3 = tt2 * tt;

            const q0 = -tt3 + 2 * tt2 - tt;
            const q1 = 3 * tt3 - 5 * tt2 + 2;
            const q2 = -3 * tt3 + 4 * tt2 + tt;
            const q3 = tt3 - tt2;

            const x = 0.5 * (p0[0] * q0 + p1[0] * q1 + p2[0] * q2 + p3[0] * q3);
            const y = 0.5 * (p0[1] * q0 + p1[1] * q1 + p2[1] * q2 + p3[1] * q3);

            path += ` L ${x},${y}`;
        }
    }

    return path;
}

// Linear regression for trend calculation
function linearRegression(dataPoints) {
    if (dataPoints.length < 2) return null;

    const n = dataPoints.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

    dataPoints.forEach(point => {
        const x = point.x; // Time in days
        const y = point.y; // Weight
        sumX += x;
        sumY += y;
        sumXY += x * y;
        sumX2 += x * x;
    });

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;

    return { slope, intercept };
}

// Calculate appropriate Y-axis tick values
function calculateYAxisTicks(yMin, yMax) {
    const range = yMax - yMin;
    const targetTicks = 6; // Aim for 5-7 ticks

    // Try 5kg intervals first
    const interval5 = 5;
    const ticks5 = Math.ceil(range / interval5);

    if (ticks5 >= 4 && ticks5 <= 8) {
        // 5kg intervals work well
        const start = Math.floor(yMin / interval5) * interval5;
        const ticks = [];
        for (let val = start; val <= yMax; val += interval5) {
            if (val >= yMin) ticks.push(val);
        }
        return ticks;
    }

    // Otherwise, use proportional division
    const niceInterval = Math.ceil(range / targetTicks / 5) * 5; // Round to nearest 5
    const start = Math.floor(yMin / niceInterval) * niceInterval;
    const ticks = [];
    for (let val = start; val <= yMax; val += niceInterval) {
        if (val >= yMin) ticks.push(val);
    }
    return ticks;
}

// Calculate weight statistics
function calculateWeightStats(logs, goalData) {
    if (!logs || logs.length === 0) {
        return null;
    }

    const stats = {};

    // Trend weight from most recent entry
    const mostRecent = logs[0]; // Already sorted DESC by API
    stats.trendWeight = mostRecent.weight_trend || mostRecent.weight;
    stats.currentWeight = mostRecent.weight;

    // Calculate weekly rate using linear regression on last 4 weeks
    const fourWeeksAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000);
    const recentLogs = logs
        .filter(l => new Date(l.measured_at) >= fourWeeksAgo)
        .reverse(); // Oldest first for regression

    if (recentLogs.length >= 2) {
        const now = new Date();
        const regressionData = recentLogs.map(l => {
            const date = new Date(l.measured_at);
            const daysAgo = (now - date) / (1000 * 60 * 60 * 24);
            return { x: -daysAgo, y: l.weight }; // Negative days ago (so slope is positive for weight loss)
        });

        const regression = linearRegression(regressionData);
        if (regression) {
            stats.weeklyRate = regression.slope * 7; // Convert daily rate to weekly
        }
    }

    // Calculate forecasted goal date
    if (goalData && goalData.goal && stats.weeklyRate && stats.weeklyRate < 0) {
        const weightToLose = stats.currentWeight - goalData.goal;
        const weeksNeeded = weightToLose / Math.abs(stats.weeklyRate);
        if (weeksNeeded > 0 && weeksNeeded < 520) { // Max 10 years
            const forecastDate = new Date(Date.now() + weeksNeeded * 7 * 24 * 60 * 60 * 1000);
            stats.forecastDate = forecastDate;
        }
    }

    // Current diff from goal
    if (goalData && goalData.goal) {
        stats.goalWeight = goalData.goal;
        stats.deltaFromGoal = stats.currentWeight - goalData.goal;
    }

    return stats;
}

// Render weight chart
// Enhanced version with smoothing, proper axes, diet plan line, and statistics
function renderWeightChart(logs, goalData) {
    const container = document.getElementById('weightChart');
    if (!container) return;

    container.replaceChildren(); // Clear previous

    if (!logs || logs.length === 0) {
        const noDataSpan = document.createElement('span');
        noDataSpan.style.cssText = "color:var(--hint-color);font-size:14px;";
        noDataSpan.textContent = "No data available";
        container.appendChild(noDataSpan);
        return;
    }

    // Chart period: -30 days to +2 days from now
    const now = new Date();
    const chartStartDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const chartEndDate = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);

    // Filter and sort logs within period (sort oldest first for chart)
    const periodLogs = logs
        .filter(l => {
            const d = new Date(l.measured_at);
            return d >= chartStartDate && d <= chartEndDate;
        })
        .sort((a, b) => new Date(a.measured_at) - new Date(b.measured_at));

    if (periodLogs.length === 0) {
        const noPeriodSpan = document.createElement('span');
        noPeriodSpan.style.cssText = "color:var(--hint-color);font-size:14px;";
        noPeriodSpan.textContent = "No data in current period";
        container.replaceChildren(noPeriodSpan);
        return;
    }

    const data = periodLogs.map(w => ({
        date: new Date(w.measured_at),
        weight: w.weight
    }));

    // Dimensions with left padding for Y-axis
    const leftPadding = 50;
    const rightPadding = 45;
    const totalWidth = container.clientWidth;
    const chartWidth = totalWidth - leftPadding - rightPadding;
    const chartHeight = container.clientHeight - 50;

    // Y-axis range calculation
    const weightsInPeriod = data.map(d => d.weight);
    const maxInPeriod = Math.max(...weightsInPeriod);
    const minInPeriod = Math.min(...weightsInPeriod);

    let yMax = maxInPeriod + 5; // +5kg padding
    let yMin = minInPeriod;

    if (goalData && goalData.goal) {
        yMin = Math.min(goalData.goal - 3, minInPeriod);
    }

    // Calculate Y-axis ticks
    const yTicks = calculateYAxisTicks(yMin, yMax);

    // Date range
    const dateRange = chartEndDate - chartStartDate;

    // Scaling functions
    const xScaleByDate = (date) => leftPadding + ((date - chartStartDate) / dateRange) * chartWidth;
    const yScale = (weight) => chartHeight - ((weight - yMin) / (yMax - yMin)) * chartHeight;

    // SVG Construction
    const svgNs = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("class", "chart-svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("viewBox", `0 0 ${totalWidth} ${chartHeight + 30}`);

    // Y-Axis grid lines and labels
    yTicks.forEach(val => {
        const y = yScale(val);

        // Grid line
        const gridLine = document.createElementNS(svgNs, "line");
        gridLine.setAttribute("x1", leftPadding);
        gridLine.setAttribute("y1", y);
        gridLine.setAttribute("x2", totalWidth - rightPadding);
        gridLine.setAttribute("y2", y);
        gridLine.setAttribute("class", "chart-grid");
        svg.appendChild(gridLine);

        // Label
        const text = document.createElementNS(svgNs, "text");
        text.setAttribute("x", leftPadding - 5);
        text.setAttribute("y", y + 4);
        text.setAttribute("class", "chart-label");
        text.setAttribute("style", "text-anchor: end; fill: var(--hint-color); font-size: 12px;");
        text.textContent = val.toFixed(0);
        svg.appendChild(text);
    });

    // Goal line (horizontal green line with label)
    if (goalData && goalData.goal) {
        const goalY = yScale(goalData.goal);
        const goalLine = document.createElementNS(svgNs, "line");
        goalLine.setAttribute("x1", leftPadding);
        goalLine.setAttribute("y1", goalY);
        goalLine.setAttribute("x2", totalWidth - rightPadding);
        goalLine.setAttribute("y2", goalY);
        goalLine.setAttribute("class", "chart-goal-line");
        goalLine.setAttribute("stroke", "#22c55e");
        goalLine.setAttribute("stroke-width", "2");
        svg.appendChild(goalLine);

        // Goal label on right
        const goalLabel = document.createElementNS(svgNs, "text");
        goalLabel.setAttribute("x", totalWidth - rightPadding + 5);
        goalLabel.setAttribute("y", goalY + 4);
        goalLabel.setAttribute("class", "chart-label");
        goalLabel.setAttribute("style", "text-anchor: start; fill: #22c55e; font-weight: bold; font-size: 11px;");
        goalLabel.textContent = "Goal";
        svg.appendChild(goalLabel);
    }

    // Diet plan line from highest weight (all time) to goal
    if (goalData && goalData.goal && goalData.goal_date && goalData.highest_weight && goalData.highest_date) {
        const highestDate = new Date(goalData.highest_date);
        const highestWeight = goalData.highest_weight;
        const goalDate = new Date(goalData.goal_date);
        const goalWeight = goalData.goal;

        // Calculate line equation
        const totalTimeSpan = goalDate - highestDate;
        const weightDiff = goalWeight - highestWeight;

        if (totalTimeSpan > 0) {
            const getWeightAtDate = (date) => {
                const elapsed = date - highestDate;
                return highestWeight + (weightDiff * elapsed / totalTimeSpan);
            };

            // Clip to chart boundaries
            let startDate = highestDate < chartStartDate ? chartStartDate : highestDate;
            let endDate = goalDate > chartEndDate ? chartEndDate : goalDate;

            const startWeight = getWeightAtDate(startDate);
            const endWeight = getWeightAtDate(endDate);

            const startX = xScaleByDate(startDate);
            const startY = yScale(startWeight);
            const endX = xScaleByDate(endDate);
            const endY = yScale(endWeight);

            const planLine = document.createElementNS(svgNs, "line");
            planLine.setAttribute("x1", startX);
            planLine.setAttribute("y1", startY);
            planLine.setAttribute("x2", endX);
            planLine.setAttribute("y2", endY);
            planLine.setAttribute("stroke", "#06b6d4"); // Cyan
            planLine.setAttribute("stroke-width", "2");
            planLine.setAttribute("stroke-dasharray", "5,5");
            planLine.setAttribute("opacity", "0.6");
            svg.appendChild(planLine);

            // Add label for today's diet plan weight
            // Only show if today is within the diet plan period
            if (now >= highestDate && now <= goalDate) {
                const todayPlanWeight = getWeightAtDate(now);
                const todayX = xScaleByDate(now);
                const todayY = yScale(todayPlanWeight);

                // Add a small circle marker on the diet line for today
                const todayMarker = document.createElementNS(svgNs, "circle");
                todayMarker.setAttribute("cx", todayX);
                todayMarker.setAttribute("cy", todayY);
                todayMarker.setAttribute("r", 4);
                todayMarker.setAttribute("fill", "#06b6d4");
                todayMarker.setAttribute("stroke", "var(--bg-color)");
                todayMarker.setAttribute("stroke-width", "2");
                svg.appendChild(todayMarker);

                // Add label showing today's plan weight
                const todayLabel = document.createElementNS(svgNs, "text");
                todayLabel.setAttribute("x", todayX);
                todayLabel.setAttribute("y", todayY - 12);
                todayLabel.setAttribute("class", "chart-label");
                todayLabel.setAttribute("style", "text-anchor: middle; fill: #06b6d4; font-weight: bold; font-size: 12px;");
                todayLabel.textContent = todayPlanWeight.toFixed(1) + " kg";
                svg.appendChild(todayLabel);
            }
        }
    }

    // Generate points for weight data
    const points = data.map(d => [xScaleByDate(d.date), yScale(d.weight)]);

    // Smoothed weight curve using Catmull-Rom splines
    const smoothPath = catmullRomSpline(points, 15);

    // Area under curve
    const firstPoint = points[0];
    const lastPoint = points[points.length - 1];
    const areaPath = `${smoothPath} L ${lastPoint[0]},${chartHeight} L ${firstPoint[0]},${chartHeight} Z`;

    const pathArea = document.createElementNS(svgNs, "path");
    pathArea.setAttribute("d", areaPath);
    pathArea.setAttribute("class", "chart-area");
    pathArea.setAttribute("fill", "rgba(59, 130, 246, 0.1)");
    svg.appendChild(pathArea);

    // Weight line
    const pathLine = document.createElementNS(svgNs, "path");
    pathLine.setAttribute("d", smoothPath);
    pathLine.setAttribute("class", "chart-line");
    pathLine.setAttribute("stroke", "#3b82f6");
    pathLine.setAttribute("stroke-width", "3");
    pathLine.setAttribute("fill", "none");
    svg.appendChild(pathLine);

    // Data points
    points.forEach((p, i) => {
        const circle = document.createElementNS(svgNs, "circle");
        circle.setAttribute("cx", p[0]);
        circle.setAttribute("cy", p[1]);
        circle.setAttribute("r", 4);
        circle.setAttribute("fill", "#3b82f6");
        circle.setAttribute("stroke", "var(--bg-color)");
        circle.setAttribute("stroke-width", "2");
        svg.appendChild(circle);
    });

    // Current weight label (on most recent point)
    const lastDataPoint = points[points.length - 1];
    const currentLabel = document.createElementNS(svgNs, "text");
    currentLabel.setAttribute("x", lastDataPoint[0]);
    currentLabel.setAttribute("y", lastDataPoint[1] - 12);
    currentLabel.setAttribute("class", "chart-label");
    currentLabel.setAttribute("style", "text-anchor: middle; fill: #3b82f6; font-weight: bold; font-size: 12px;");
    currentLabel.textContent = data[data.length - 1].weight.toFixed(1) + " kg";
    svg.appendChild(currentLabel);

    // Date labels (bottom)
    const firstDateLabel = document.createElementNS(svgNs, "text");
    firstDateLabel.setAttribute("x", leftPadding);
    firstDateLabel.setAttribute("y", chartHeight + 20);
    firstDateLabel.setAttribute("class", "chart-label");
    firstDateLabel.setAttribute("style", "text-anchor: start; fill: var(--hint-color); font-size: 11px;");
    firstDateLabel.textContent = chartStartDate.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
    svg.appendChild(firstDateLabel);

    const lastDateLabel = document.createElementNS(svgNs, "text");
    lastDateLabel.setAttribute("x", totalWidth - rightPadding);
    lastDateLabel.setAttribute("y", chartHeight + 20);
    lastDateLabel.setAttribute("class", "chart-label");
    lastDateLabel.setAttribute("style", "text-anchor: end; fill: var(--hint-color); font-size: 11px;");
    lastDateLabel.textContent = chartEndDate.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
    svg.appendChild(lastDateLabel);

    container.appendChild(svg);

    // Render statistics below the chart
    const stats = calculateWeightStats(logs, goalData);
    if (stats) {
        renderWeightStats(stats);
    }
}

// Render weight statistics below the chart
function renderWeightStats(stats) {
    const statsContainer = document.getElementById('weight-stats');
    if (!statsContainer) return;

    const root = document.createElement('mt-card');
    root.className = 'weight-stats-container';

    const leftColumn = document.createElement('div');
    leftColumn.className = 'weight-stats-column';
    const rightColumn = document.createElement('div');
    rightColumn.className = 'weight-stats-column';

    const appendStatItem = (column, label, value) => {
        const item = document.createElement('div');
        item.className = 'weight-stat-item';
        const labelEl = document.createElement('span');
        labelEl.className = 'weight-stat-label';
        labelEl.textContent = `${label}:`;
        const valueEl = document.createElement('span');
        valueEl.className = 'weight-stat-value';
        valueEl.textContent = value;
        item.appendChild(labelEl);
        item.appendChild(document.createTextNode(' '));
        item.appendChild(valueEl);
        column.appendChild(item);
    };

    appendStatItem(leftColumn, 'Trend', `${stats.trendWeight.toFixed(1)} kg`);

    if (stats.weeklyRate !== undefined) {
        const rateStr = stats.weeklyRate >= 0
            ? `+${stats.weeklyRate.toFixed(1)} kg/week`
            : `${stats.weeklyRate.toFixed(1)} kg/week`;
        appendStatItem(leftColumn, 'Rate', rateStr);
    }

    if (stats.forecastDate) {
        const dateStr = stats.forecastDate.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
        appendStatItem(leftColumn, 'Forecast', dateStr);
    } else {
        appendStatItem(leftColumn, 'Forecast', 'Unknown');
    }

    if (stats.goalWeight !== undefined) {
        appendStatItem(rightColumn, 'Goal', `${stats.goalWeight.toFixed(1)} kg`);

        const deltaStr = stats.deltaFromGoal >= 0
            ? `+${stats.deltaFromGoal.toFixed(1)} kg`
            : `${stats.deltaFromGoal.toFixed(1)} kg`;
        appendStatItem(rightColumn, 'Δ from goal', deltaStr);
    }

    root.appendChild(leftColumn);
    root.appendChild(rightColumn);
    statsContainer.replaceChildren(root);
}


async function loadWeightLogs() {
    const list = document.getElementById('weight-list');
    await window.DataStore.loadSWR({
        key: 'weight',
        tags: ['weight'],
        fetcher: async () => {
            const [logsRes, goalRes] = await Promise.all([
                apiCall('/api/weight?days=35'),
                apiCall('/api/weight/goal')
            ]);
            if (logsRes === null) return null;
            return { logsRes, goalRes };
        },
        onCached: async (cached) => {
            await _renderWeightData(cached.logsRes, cached.goalRes);
        },
        onFresh: async (fresh) => {
            await _renderWeightData(fresh.logsRes, fresh.goalRes);
        },
        onError: async (e, cached) => {
            console.error('Failed to load weight data:', e);
            if (!cached) {
                const errLi = document.createElement('li');
                errLi.style.cssText = 'text-align:center;color:var(--hint-color);padding:20px;';
                errLi.textContent = 'Failed to load weight logs';
                list.replaceChildren(errLi);
            }
        }
    });
}

async function _renderWeightData(logsRes, goalRes) {
    const list = document.getElementById('weight-list');

    // Merge server data with pending local writes
    let allLogs = logsRes || [];
    if (window.MedTrackerDB) {
        try {
            const pendingLogs = await window.MedTrackerDB.WeightStore.getPending();
            const pendingFormatted = pendingLogs.map(l => ({
                id: `local_${l.localId}`,
                localId: l.localId,
                measured_at: l.measured_at,
                weight: l.weight,
                notes: l.notes,
                isLocal: true
            }));
            allLogs = [...pendingFormatted, ...allLogs];
        } catch (e) {
            console.error('Failed to get pending weight logs:', e);
        }
    }

    if (allLogs.length === 0 && logsRes === null) {
        const errLi = document.createElement('li');
        errLi.style.cssText = 'text-align:center;color:var(--hint-color);padding:20px;';
        errLi.textContent = 'Failed to load weight logs';
        list.replaceChildren(errLi);
        return;
    }

    // Cache logs globally for ruler component
    cachedWeightLogs = allLogs;

    renderWeightLogs(allLogs);
    renderWeightChart(allLogs, goalRes || {});
}

function renderWeightLogs(logs) {
    const list = document.getElementById('weight-list');
    list.replaceChildren();

    if (!logs || logs.length === 0) {
        return;
    }

    // Limit to 30 most recent
    if (logs.length > 30) {
        logs = logs.slice(0, 30);
    }

    logs.forEach(w => {
        const dateStr = formatDate(w.measured_at);
        const trendDiff = w.weight_trend ? (w.weight - w.weight_trend).toFixed(1) : '0.0';
        const trendIcon = trendDiff > 0 ? '📈' : (trendDiff < 0 ? '📉' : '➡️');
        const pendingClass = w.isLocal ? ' pending-sync' : '';
        const listItem = document.createElement('mt-card');
        listItem.className = `weight-item${pendingClass}`;

        const data = document.createElement('div');
        data.className = 'weight-data';

        const value = document.createElement('div');
        value.className = 'weight-value';
        value.appendChild(document.createTextNode(`${w.weight.toFixed(1)} kg `));
        if (w.isLocal) {
            const pendingBadge = document.createElement('span');
            pendingBadge.className = 'sync-pending-badge';
            pendingBadge.textContent = 'Pending';
            value.appendChild(pendingBadge);
        }

        const trend = document.createElement('div');
        trend.className = 'weight-trend';
        trend.textContent = `${trendIcon} Trend: ${w.weight_trend ? w.weight_trend.toFixed(1) : w.weight.toFixed(1)} kg`;

        const meta = document.createElement('div');
        meta.className = 'weight-meta';
        meta.textContent = dateStr;

        data.appendChild(value);
        data.appendChild(trend);
        data.appendChild(meta);

        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'delete-btn';
        deleteButton.title = 'Delete';
        deleteButton.textContent = '×';
        deleteButton.addEventListener('click', () => {
            deleteWeightLog(String(w.id));
        });

        listItem.appendChild(data);
        listItem.appendChild(deleteButton);
        list.appendChild(listItem);
    });
}

async function deleteWeightLog(id) {
    const confirmMsg = 'Delete this weight log?';

    if (userInitData && tg.showConfirm) {
        try {
            tg.showConfirm(confirmMsg, (ok) => {
                if (ok) _deleteWeightApi(id);
            });
            return;
        } catch (e) {
            console.log('tg.showConfirm failed, falling back', e);
        }
    }

    if (confirm(confirmMsg)) {
        _deleteWeightApi(id);
    }
}

async function _deleteWeightApi(id) {
    // Check if this is a local-only log
    if (typeof id === 'string' && id.startsWith('local_')) {
        const localId = parseInt(id.replace('local_', ''));
        if (window.MedTrackerDB) {
            await window.MedTrackerDB.WeightStore.confirmDelete(localId);
            if (window.SyncManager) window.SyncManager.updateStatus();
        }
        loadWeightLogs();
        return;
    }

    const res = await apiCall(`/api/weight/${id}`, 'DELETE');
    if (res) {
        await window.DataStore.invalidateTags(['weight']);
        // Also remove from local IndexedDB if it exists there
        if (window.MedTrackerDB) {
            try {
                // Find and delete the local record with this serverId
                const allLogs = await window.MedTrackerDB.WeightStore.getAll();
                const localRecord = allLogs.find(l => l.serverId === parseInt(id));
                if (localRecord && localRecord.localId) {
                    await window.MedTrackerDB.WeightStore.confirmDelete(localRecord.localId);
                    if (window.SyncManager) window.SyncManager.updateStatus();
                }
            } catch (e) {
                console.error('Failed to delete from local DB:', e);
            }
        }
        loadWeightLogs();
    }
}

async function exportWeightCSV() {
    try {
        const response = await fetch('/api/weight/export', {
            method: 'GET',
            headers: {
                'Authorization': `tma ${userInitData}`
            }
        });

        if (!response.ok) {
            tg.showAlert('Failed to generate export');
            return;
        }

        const blob = await response.blob();
        downloadBlobAsFile(blob, 'weight_export.csv');
    } catch (err) {
        console.error('Export error:', err);
        tg.showAlert('Failed to export data');
    }
}
/* Push Notification Modals */

function handlePushAction(action, params) {
    if (action === 'medication_confirm') {
        const ids = params.get('ids') ? params.get('ids').split(',') : [];
        const names = params.get('names') ? params.get('names').split(',') : [];
        const scheduled = params.get('scheduled');

        setTimeout(() => {
            showMedicationConfirmModal(ids, names, scheduled);
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

    if (selectedIds.length === 0) {
        closeMedicationConfirmModal();
        return;
    }

    try {
        const res = await apiCall('/api/medications/confirm-schedule', 'POST', {
            scheduled_at: pendingMedConfirmScheduled,
            medication_ids: selectedIds
        });

        if (res) {
            safeAlert("Confirmed!");
            loadMeds();
            loadHistory();
        }
    } catch (e) {
        console.error(e);
        safeAlert("Error confirming: " + e.message);
    }

    closeMedicationConfirmModal();
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

    try {
        const res = await apiCall('/api/intakes/update', 'POST', { updates });
        if (res) { // status 200 assumed
            safeAlert("Updated!");
            loadMeds(); // Stocks might change
            loadHistory();
        }
    } catch (e) {
        console.error(e);
        safeAlert("Error updating: " + e.message);
    }

    closeMedicationConfirmModal();
}

async function confirmLogPast() {
    const timeInput = document.getElementById('med-confirm-datetime');
    const takenAt = new Date(timeInput.value).toISOString();

    // In log_past mode, we only support one med at a time for simplicity in this UI
    const medId = pendingMedConfirmIds[0];

    try {
        const res = await apiCall('/api/medications/log-past', 'POST', {
            medication_id: medId,
            taken_at: takenAt
        });

        if (res) {
            safeAlert("Intake logged!");
            loadMeds();
            loadHistory();
        }
    } catch (e) {
        console.error(e);
        safeAlert("Error logging: " + e.message);
    }

    closeMedicationConfirmModal();
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

    try {
        await apiCall(`/api/workout/sessions/${pendingWorkoutSessionId}/snooze`, 'POST', { minutes: minutes });
        safeAlert(`Snoozed for ${minutes} minutes`);
    } catch (e) {
        safeAlert("Error snoozing");
    }
    closeWorkoutStartModal();
}

async function skipWorkoutFromModal() {
    if (!pendingWorkoutSessionId) return;

    if (!confirm("Are you sure you want to skip this workout?")) return;

    try {
        await apiCall(`/api/workout/sessions/${pendingWorkoutSessionId}/skip`, 'POST');
        safeAlert("Workout skipped");
        loadWorkouts();
    } catch (e) {
        safeAlert("Error skipping");
    }
    closeWorkoutStartModal();
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

// Back gesture / hardware-back closes the topmost open modal
// iOS edge-swipe fires popstate; Android hardware back fires Telegram BackButton
(function initModalHistory() {
    let modalPushed = false;
    let poppingFromHistory = false;
    const webApp = window.Telegram?.WebApp;
    const backButton = webApp?.BackButton;
    const isBackButtonSupported = !!backButton && (
        typeof webApp?.isVersionAtLeast !== 'function' || webApp.isVersionAtLeast('6.1')
    );

    function onOverlayShown() {
        if (modalPushed) return;
        modalPushed = true;
        history.pushState({ modal: true }, '');
        if (isBackButtonSupported) backButton.show();
    }

    function onOverlayClosed() {
        if (!modalPushed || poppingFromHistory) return;
        modalPushed = false;
        history.back();
        if (isBackButtonSupported) backButton.hide();
    }

    // iOS edge-swipe (and desktop browser back)
    window.addEventListener('popstate', () => {
        if (!modalPushed) return;
        const overlay = document.getElementById('modal-overlay');
        if (!overlay || overlay.classList.contains('hidden')) {
            modalPushed = false;
            if (isBackButtonSupported) backButton.hide();
            return;
        }
        poppingFromHistory = true;
        window.ModalManager.closeTopMostVisibleModal();
        poppingFromHistory = false;
        modalPushed = false;
        // Sub-modal closed but parent still open → re-push so next back also works
        if (!overlay.classList.contains('hidden')) {
            modalPushed = true;
            history.pushState({ modal: true }, '');
        } else {
            if (isBackButtonSupported) backButton.hide();
        }
    });

    // Android hardware back / Telegram header back button
    if (isBackButtonSupported) {
        backButton.onClick(() => {
            const overlay = document.getElementById('modal-overlay');
            if (!overlay || overlay.classList.contains('hidden')) return;
            poppingFromHistory = true;
            window.ModalManager.closeTopMostVisibleModal();
            poppingFromHistory = false;
            modalPushed = false;
            if (!overlay.classList.contains('hidden')) {
                modalPushed = true; // BackButton stays visible
            } else {
                backButton.hide();
                history.back(); // clean up the history entry we pushed
            }
        });
    }

    // Watch modal-overlay for class changes to drive history push/pop
    function setupObserver() {
        const overlay = document.getElementById('modal-overlay');
        if (!overlay) return;
        new MutationObserver(() => {
            overlay.classList.contains('hidden') ? onOverlayClosed() : onOverlayShown();
        }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
    }

    document.readyState === 'loading'
        ? document.addEventListener('DOMContentLoaded', setupObserver)
        : setupObserver();
})();

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
