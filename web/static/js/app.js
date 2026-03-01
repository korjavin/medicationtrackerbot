const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();

// Configuration & Global State
window.userInitData = tg.initData;
let initialAuthLoad = false;
const AUTH_CACHE_KEY = 'medtracker_auth_state';
const AUTH_CACHE_TTL = 30 * 24 * 60 * 60 * 1000;

// Auth logic
function saveAuthState(authMethod = 'cookie') {
    localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify({ authenticated: true, authMethod, timestamp: Date.now(), ttl: AUTH_CACHE_TTL }));
}

function getCachedAuthState() {
    try {
        const cached = localStorage.getItem(AUTH_CACHE_KEY);
        if (!cached) return null;
        const state = JSON.parse(cached);
        if (Date.now() - state.timestamp < state.ttl) return state;
        localStorage.removeItem(AUTH_CACHE_KEY);
    } catch (e) { console.error(e); }
    return null;
}

function clearAuthState() {
    localStorage.removeItem(AUTH_CACHE_KEY);
}

async function cacheApiSnapshot(key, value) {
    if (window.DataStore) await window.DataStore.setCached(key, value);
}
window.cacheApiSnapshot = cacheApiSnapshot;

async function applyBootstrapPayload(res) {
    if (!res) return false;

    if (typeof res.cursor === 'number') {
        if (window.DataStore) window.DataStore.setChangeCursor(res.cursor);
    }

    if (res.features) {
        window.featureSettings = { ...(window.featureSettings || {}), ...res.features };
        window.featureSettingsLoaded = true;
        if (typeof window.applyFeatureSettings === 'function') window.applyFeatureSettings(window.featureSettings);
    }

    if (Array.isArray(res.medications)) {
        window.medications = res.medications;
        initialAuthLoad = true;
        if (window.MedTrackerDB?.MedicationStore) {
            await window.MedTrackerDB.MedicationStore.saveCache(window.medications);
        }
        await cacheApiSnapshot('medications', window.medications);
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

    const settingsBundle = (typeof window.normalizeSettingsBundle === 'function')
        ? window.normalizeSettingsBundle({
            features: res.features || {},
            settings: res.settings || {},
            food_targets: res.settings?.food_targets,
            bp_reminder_status: res.settings?.bp_reminder_status,
            weight_reminder_status: res.settings?.weight_reminder_status
        })
        : null;
    if (settingsBundle) await cacheApiSnapshot('settings_bundle', settingsBundle);

    return true;
}
window.applyBootstrapPayload = applyBootstrapPayload;

async function loadInitData() {
    try {
        const res = await window.apiCall('/api/init', 'GET');
        if (res && res.features) {
            window.featureSettings = { ...(window.featureSettings || {}), ...res.features };
            window.featureSettingsLoaded = true;
            if (typeof window.applyFeatureSettings === 'function') window.applyFeatureSettings(window.featureSettings);
        }
    } catch (e) {
        console.error('[Init] Failed to load init data:', e);
    }
}

async function checkAuth() {
    if (window.userInitData) {
        sessionStorage.removeItem('medtracker_auth_reload_in_progress');
        saveAuthState('telegram');
        const bootstrap = await window.apiCall('/api/bootstrap', 'GET');
        if (bootstrap) {
            await applyBootstrapPayload(bootstrap);
        } else {
            await loadInitData();
        }
        return true;
    }

    const cachedAuth = getCachedAuthState();

    let serverUnavailable = false;
    try {
        const res = await fetch('/api/bootstrap', { method: 'GET' });
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
        console.log("[Auth] Network check failed:", e);
        serverUnavailable = true;
    }

    if (serverUnavailable && cachedAuth && cachedAuth.authenticated) {
        console.log('[Auth] Server unavailable, using cached auth state');
        sessionStorage.removeItem('medtracker_auth_reload_in_progress');
        if (window.MedTrackerDB && window.MedTrackerDB.MedicationStore) {
            const cached = await window.MedTrackerDB.MedicationStore.getCache();
            if (cached) {
                console.log('[Auth] Loaded medications from cache:', cached.length);
                window.medications = cached;
                initialAuthLoad = true;
            }
        }
        return true;
    }

    // Not authorized. Show login UI.
    const loginContainer = document.createElement('div');
    loginContainer.style.cssText = "display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:60vh; gap: 20px; padding: 20px;";

    const isOffline = !navigator.onLine;

    if (isOffline) {
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

        const retryBtn = document.createElement('button');
        retryBtn.innerText = "Retry";
        retryBtn.onclick = () => location.reload();
        retryBtn.style.cssText = "padding: 12px 24px; font-size: 16px; background: var(--primary-color, #007bff); color: white; border: none; border-radius: 5px; cursor: pointer; margin-top: 10px;";
        loginContainer.appendChild(retryBtn);

        window.addEventListener('online', () => {
            console.log('[Auth] Back online, reloading...');
            location.reload();
        });
    } else {
        const title = document.createElement('h2');
        title.innerText = "Login to Med Tracker";
        title.style.cssText = "color: var(--text-color, #333); margin-bottom: 10px;";
        loginContainer.appendChild(title);

        const tgWidgetContainer = document.createElement('div');
        tgWidgetContainer.id = 'telegram-login-container';

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

            const oidcBtn = document.createElement('button');
            oidcBtn.innerText = oidcConfig.label || "Login";
            oidcBtn.onclick = () => window.location.href = (oidcConfig.loginUrl || "/auth/oidc/login");
            const oidcBg = oidcConfig.buttonColor || "var(--button-color, #2481cc)";
            const oidcText = oidcConfig.buttonText || "var(--button-text-color, #fff)";
            oidcBtn.style.cssText = `padding: 12px 24px; font-size: 16px; background: ${oidcBg}; color: ${oidcText}; border: none; border-radius: 5px; cursor: pointer;`;
            loginContainer.appendChild(oidcBtn);

            const setupLink = document.createElement('a');
            setupLink.href = '/oidc-setup';
            setupLink.innerText = 'Need setup info?';
            setupLink.style.cssText = 'margin-top: 4px; font-size: 13px; color: var(--link-color, #2481cc);';
            loginContainer.appendChild(setupLink);
        }
    }

    document.body.replaceChildren();
    document.body.appendChild(loginContainer);

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
window.checkAuth = checkAuth;

// Global initialization
document.addEventListener('DOMContentLoaded', async () => {
    console.log('[App] Starting initialization...');

    // Bind tab groups via custom tabchange events as early as possible.
    document.getElementById('tabs')?.addEventListener('tabchange', (e) => {
        if (typeof window.switchTab === 'function') window.switchTab(e.detail.tabId);
    });
    document.querySelector('.med-tabs')?.addEventListener('tabchange', (e) => {
        if (typeof window.switchMedTab === 'function') window.switchMedTab(e.detail.tabId);
    });

    // BP & Weight Submit
    const bpForm = document.getElementById('bp-form');
    if (bpForm) bpForm.onsubmit = window.handleBPSubmit;
    const weightForm = document.getElementById('weight-form');
    if (weightForm) weightForm.onsubmit = window.handleWeightSubmit;
    const foodForm = document.getElementById('food-form');
    if (foodForm) foodForm.onsubmit = window.saveFoodLog;

    const authorized = await checkAuth();
    if (authorized) {
        await onAuth();
    }
});

async function onAuth() {
    document.getElementById('login-view')?.classList.remove('active');
    document.getElementById('main-view')?.classList.remove('hidden');

    // Initial data load
    window.initialAuthLoad = true;
    await Promise.allSettled([
        typeof window.loadMeds === 'function' ? window.loadMeds() : Promise.resolve(),
        typeof window.loadFeatureSettings === 'function' ? window.loadFeatureSettings() : Promise.resolve(),
        typeof window.loadWeeklyHub === 'function' ? window.loadWeeklyHub() : Promise.resolve()
    ]);
    if (window.SyncManager && typeof window.SyncManager.init === 'function') {
        window.SyncManager.init();
    }
    if (window.MedTrackerPush && typeof window.MedTrackerPush.initialize === 'function') {
        window.MedTrackerPush.initialize().catch(() => { /* non-fatal */ });
    }
    if (window.DataStore && typeof window.DataStore.startChangePolling === 'function') {
        window.DataStore.startChangePolling();
    }
    if (typeof window.switchTab === 'function') window.switchTab('meds');
}

// Wrap loadMeds to also refresh weekly hub
(function wrapLoadMeds() {
    const _origLoadMeds = window.loadMeds;
    if (!_origLoadMeds) return;
    window.loadMeds = async function () {
        await _origLoadMeds();
        try {
            if (typeof window.renderWeeklyHub === 'function') await window.renderWeeklyHub();
        } catch (_e) { /* guard against DOM teardown in tests */ }
    };
})();

// Swipe gesture navigation between tabs
(function initSwipeNav() {
    const MIN_SWIPE_X = 60;
    const MAX_SWIPE_Y = 80;
    let startX = 0, startY = 0;
    document.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; startY = e.touches[0].clientY; }, { passive: true });
    document.addEventListener('touchend', (e) => {
        const dx = e.changedTouches[0].clientX - startX, dy = e.changedTouches[0].clientY - startY;
        if (Math.abs(dx) < MIN_SWIPE_X || Math.abs(dy) > MAX_SWIPE_Y || e.target.closest('.modal, .modal-overlay, select, input, textarea')) return;
        const tabs = Array.from(document.querySelectorAll('#tabs .tab')).filter(t => t.style.display !== 'none');
        const activeIdx = tabs.indexOf(document.querySelector('#tabs .tab.active'));
        if (activeIdx === -1) return;
        const nextIdx = dx < 0 ? activeIdx + 1 : activeIdx - 1;
        if (nextIdx >= 0 && nextIdx < tabs.length) window.switchTab(tabs[nextIdx].dataset.tab);
    }, { passive: true });
})();

// Back gesture / hardware-back closes the topmost open modal
(function initModalHistory() {
    const backButton = tg.BackButton;
    const isBackSupported = !!backButton && (typeof tg.isVersionAtLeast !== 'function' || tg.isVersionAtLeast('6.1'));
    let modalPushed = false, popping = false;

    function onShow() { if (!modalPushed) { modalPushed = true; history.pushState({ modal: true }, ''); if (isBackSupported) backButton.show(); } }
    function onHide() { if (modalPushed && !popping) { modalPushed = false; history.back(); if (isBackSupported) backButton.hide(); } }

    window.addEventListener('popstate', () => {
        if (!modalPushed) return;
        popping = true; window.ModalManager.closeTopMostVisibleModal(); popping = false; modalPushed = false;
        const overlay = document.getElementById('modal-overlay');
        if (overlay && !overlay.classList.contains('hidden')) { modalPushed = true; history.pushState({ modal: true }, ''); }
        else if (isBackSupported) backButton.hide();
    });

    if (isBackSupported) backButton.onClick(() => { popping = true; window.ModalManager.closeTopMostVisibleModal(); popping = false; modalPushed = false; if (isBackSupported) backButton.hide(); history.back(); });

    const observer = new MutationObserver(() => {
        const overlay = document.getElementById('modal-overlay');
        if (!overlay) return;
        overlay.classList.contains('hidden') ? onHide() : onShow();
    });
    const ov = document.getElementById('modal-overlay'); if (ov) observer.observe(ov, { attributes: true, attributeFilter: ['class'] });
})();

window.switchMedTab = function (tab) {
    document.querySelector('.med-tabs')?.setActiveTab?.(tab);
    document.querySelectorAll('.med-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));

    document.getElementById('med-history-tab')?.classList.toggle('active', tab === 'history');
    document.getElementById('med-schedule-tab')?.classList.toggle('active', tab === 'schedule');

    if (tab === 'history') window.loadHistory();
    else if (tab === 'schedule') window.loadMeds();
};

window.loadHistory = async function () {
    if (window.medications && window.medications.length === 0) {
        await window.loadMeds();
    }
    const medId = document.getElementById('history-filter-med')?.value || '0';
    const days = document.getElementById('history-filter-days')?.value || '7';
    const key = `history_${days}_${medId}`;

    if (window.DataStore) {
        await window.DataStore.loadSWR({
            key, tags: ['history'],
            fetcher: async () => await window.apiCall(`/api/history?days=${days}&med_id=${medId}`),
            onCached: (cached) => window.renderHistory(cached),
            onFresh: (fresh) => {
                if (fresh && window.MedTrackerDB?.IntakeHistoryStore) {
                    window.MedTrackerDB.IntakeHistoryStore.saveCache(key, fresh);
                }
                window.renderHistory(fresh || []);
            },
            onError: async (_err, cached) => {
                if (!cached) window.renderHistory([]);
            }
        });
    }

    if (typeof window.renderNextIntakeTrigger === 'function') {
        await window.renderNextIntakeTrigger();
    }
};

if (typeof window.loadSettings !== 'function') {
    window.loadSettings = async function () {
        await Promise.allSettled([
            typeof window.loadFeatureSettings === 'function' ? window.loadFeatureSettings() : Promise.resolve(),
            typeof window.loadFoodTargets === 'function' ? window.loadFoodTargets() : Promise.resolve()
        ]);
    };
}

// Global handlers
window.onDataStoreUnauthorized = function () {
    localStorage.removeItem(AUTH_CACHE_KEY);
    window.location.reload();
};

// Tab refresh with debouncing and deferral
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
        if (!el || el.classList.contains('hidden')) return false;
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
    window.reloadCurrentTab();
}

window.requestTabRefresh = function (meta) {
    if (meta === undefined) meta = {};
    const source = meta.source || 'changes';
    if (!isSafeToAutoRefresh()) {
        pendingRefreshReason = source;
        showRefreshBanner();
        return;
    }

    if (refreshDebounceTimer) {
        clearTimeout(refreshDebounceTimer);
    }
    refreshDebounceTimer = setTimeout(() => {
        refreshDebounceTimer = null;
        window.reloadCurrentTab();
    }, 500);
};

window.applyPendingTabRefresh = applyPendingTabRefresh;

document.addEventListener('visibilitychange', () => {
    if (document.hidden || !pendingRefreshReason) return;
    if (!isSafeToAutoRefresh()) return;
    applyPendingTabRefresh();
});

window.reloadCurrentTab = function () {
    const activeTab = document.querySelector('.tab.active');
    if (!activeTab) return;

    const tab = activeTab.dataset.tab;
    if (tab === 'meds') {
        const activeMedTab = document.querySelector('.med-tab.active');
        const medTab = activeMedTab ? activeMedTab.dataset.tab : 'history';
        if (medTab === 'schedule') { window.loadMeds(); }
        else { window.loadHistory(); }
    } else if (tab === 'bp') { window.loadBPReadings(); }
    else if (tab === 'weight') { window.loadWeightLogs(); }
    else if (tab === 'workouts') { window.loadWorkouts(); }
    else if (tab === 'food') { window.loadFoodLogs(); }
    else if (tab === 'health') { window.loadHealthOverview(); }
    else if (tab === 'settings') { window.loadSettings(); }
};

// Push notification action handler
let pendingWorkoutSessionId = null;

window.handlePushAction = function (action, params) {
    if (action === 'medication_confirm') {
        const ids = params.get('ids') ? params.get('ids').split(',') : [];
        const names = params.get('names') ? params.get('names').split(',') : [];
        const scheduled = params.get('scheduled');
        setTimeout(() => {
            window.showMedicationConfirmModal(ids, names, scheduled);
        }, 500);
    } else if (action === 'workout_start') {
        const sessionId = params.get('session_id');
        setTimeout(() => {
            window.showWorkoutStartModal(sessionId);
        }, 500);
    }
};

window.showWorkoutStartModal = function (sessionId) {
    pendingWorkoutSessionId = sessionId;
    window.ModalManager.workoutStart.open();
};

window.closeWorkoutStartModal = function () {
    window.ModalManager.workoutStart.close();
};

window.startWorkoutFromModal = function () {
    window.closeWorkoutStartModal();
    window.switchTab('workouts');
};

window.snoozeWorkout = async function (minutes) {
    if (!pendingWorkoutSessionId) return;
    try {
        await window.apiCall(`/api/workout/sessions/${pendingWorkoutSessionId}/snooze`, 'POST', { minutes: minutes });
        window.safeAlert(`Snoozed for ${minutes} minutes`);
    } catch (e) {
        window.safeAlert("Error snoozing");
    }
    window.closeWorkoutStartModal();
};

window.skipWorkoutFromModal = async function () {
    if (!pendingWorkoutSessionId) return;
    if (!confirm("Are you sure you want to skip this workout?")) return;
    try {
        await window.apiCall(`/api/workout/sessions/${pendingWorkoutSessionId}/skip`, 'POST');
        window.safeAlert("Workout skipped");
        window.loadWorkouts();
    } catch (e) {
        window.safeAlert("Error skipping");
    }
    window.closeWorkoutStartModal();
};

// Bind workout start modal buttons
(function bindWorkoutStartControls() {
    function setup() {
        var el;
        el = document.getElementById('workout-start-now-btn');
        if (el) el.addEventListener('click', function () { window.startWorkoutFromModal(); });
        el = document.getElementById('workout-start-dismiss-btn');
        if (el) el.addEventListener('click', function () { window.closeWorkoutStartModal(); });
        el = document.getElementById('workout-start-snooze-60-btn');
        if (el) el.addEventListener('click', function () { window.snoozeWorkout(60); });
        el = document.getElementById('workout-start-snooze-120-btn');
        if (el) el.addEventListener('click', function () { window.snoozeWorkout(120); });
        el = document.getElementById('workout-start-skip-btn');
        if (el) el.addEventListener('click', function () { window.skipWorkoutFromModal(); });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setup, { once: true });
    } else {
        setup();
    }
})();

window.sendTestMedicationNotification = async function () {
    try {
        const res = await fetch('/api/webpush/test-medication', {
            method: 'POST',
            headers: { 'X-Telegram-Init-Data': window.userInitData }
        });
        const text = await res.text();
        if (res.ok) {
            window.safeAlert(text || "Test notification sent!");
        } else {
            window.safeAlert("Error: " + text);
        }
    } catch (e) {
        console.error(e);
        window.safeAlert("Error sending test notification: " + e.message);
    }
};

window.sendTestBPNotification = async function () {
    try {
        const res = await window.apiCall('/api/bp/reminder/test', 'POST');
        if (res) {
            window.safeAlert("Notification sent! Check your device.");
        }
    } catch (e) {
        console.error(e);
        window.safeAlert("Failed to send test notification: " + e.message);
    }
};

// Check for Telegram start_param
if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initDataUnsafe && window.Telegram.WebApp.initDataUnsafe.start_param === 'bp_add') {
    const checkInterval = setInterval(() => {
        if (typeof window.showBPRecordModal === 'function') {
            clearInterval(checkInterval);
            window.switchTab('bp');
            setTimeout(window.showBPRecordModal, 500);
        }
    }, 100);
}
