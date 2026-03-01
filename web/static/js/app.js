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

    // Start polling for changes
    if (window.DataStore) window.DataStore.startChangePolling();

    // Try OIDC or Cookie auth
    const cached = getCachedAuthState();
    if (cached) {
        console.log('[Auth] Using cached session');
        await onAuth();
    } else {
        try {
            const auth = await window.apiCallDirect('/api/auth/session', 'GET');
            if (auth.authenticated) {
                saveAuthState('cookie');
                await onAuth();
                return;
            }
        } catch (e) { console.warn('[Auth] Session check failed'); }

        // Show login options
        document.getElementById('login-view')?.classList.add('active');
    }
});

async function onAuth() {
    document.getElementById('login-view')?.classList.remove('active');
    document.getElementById('main-view')?.classList.remove('hidden');

    // Initial data load
    window.initialAuthLoad = true;
    await Promise.all([
        window.loadMeds(),
        window.loadFeatureSettings(),
        window.loadWeeklyHub()
    ]);
    if (typeof window.switchTab === 'function') window.switchTab('meds');
}

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
    const medId = document.getElementById('history-filter-med')?.value || '0';
    const days = document.getElementById('history-filter-days')?.value || '7';
    const key = `history_${days}_${medId}`;

    if (window.DataStore) {
        await window.DataStore.loadSWR({
            key, tags: ['history'],
            fetcher: async () => await window.apiCall(`/api/history?days=${days}&med_id=${medId}`),
            onCached: (cached) => window.renderHistory(cached),
            onFresh: (fresh) => window.renderHistory(fresh)
        });
    }
};

window.loadSettings = async function () {
    await Promise.all([
        window.loadFeatureSettings(),
        window.loadFoodTargets()
    ]);
};

// Global handlers
window.onDataStoreUnauthorized = function () {
    localStorage.removeItem(AUTH_CACHE_KEY);
    window.location.reload();
};

window.requestTabRefresh = function ({ changedTags }) {
    const activeTab = document.querySelector('#tabs .tab.active')?.dataset.tab;
    if (!activeTab) return;

    const tagMatch = (tags) => tags.some(t => changedTags.includes(t));

    if (activeTab === 'meds' && tagMatch(['medications', 'history'])) window.loadMeds(), window.loadHistory();
    else if (activeTab === 'bp' && tagMatch(['bp'])) window.loadBPReadings();
    else if (activeTab === 'weight' && tagMatch(['weight'])) window.loadWeightLogs();
    else if (activeTab === 'workouts' && tagMatch(['workout'])) window.loadWorkouts();
    else if (activeTab === 'food' && tagMatch(['food'])) window.loadFoodLogs();
    else if (activeTab === 'health' && tagMatch(['health'])) window.loadHealthOverview();
    else if (activeTab === 'settings' && tagMatch(['settings'])) window.loadSettings();
};

// ... remaining minimal UI logic (swipe, history) ...
