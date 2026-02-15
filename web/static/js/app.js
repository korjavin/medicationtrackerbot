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

// Check Auth Environment
async function checkAuth() {
    if (userInitData) {
        // We are in Telegram, proceed as normal
        saveAuthState('telegram');
        return true;
    }

    // Not in Telegram. Check cached auth state first (for offline support)
    const cachedAuth = getCachedAuthState();

    // Try to access API to see if we have valid Session Cookie
    try {
        // Optimization: Fetch full data here to avoid second request
        const res = await fetch('/api/medications?archived=true', { method: 'GET' });
        if (res.status === 200) {
            // Authorized via Cookie!
            const data = await res.json();
            medications = data;
            initialAuthLoad = true;
            saveAuthState('cookie');

            // Cache medications for offline use
            if (window.MedTrackerDB && window.MedTrackerDB.MedicationStore) {
                await window.MedTrackerDB.MedicationStore.saveCache(medications);
            }

            return true;
        } else if (res.status === 401 || res.status === 403) {
            // Definitely not authorized, clear cache
            clearAuthState();
        }
    } catch (e) {
        console.log("[Auth] Network check failed:", e);

        // Network error - check if we're offline and have cached auth
        if (cachedAuth && cachedAuth.authenticated) {
            console.log('[Auth] Offline but using cached auth state');

            // Load medications from cache for offline use
            if (window.MedTrackerDB && window.MedTrackerDB.MedicationStore) {
                const cached = await window.MedTrackerDB.MedicationStore.getCache();
                if (cached) {
                    console.log('[Auth] Loaded medications from cache:', cached.length);
                    medications = cached;
                    initialAuthLoad = true;
                }
            }

            return true; // Trust cached state when offline
        }
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
        message.innerHTML = "You need an internet connection to log in for the first time.<br><br>If you have logged in before, your session will be available once you're back online.";
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

        // Divider
        const divider = document.createElement('div');
        divider.style.cssText = "display:flex; align-items:center; gap:10px; color: #999; margin: 10px 0;";
        divider.innerHTML = '<span style="flex:1; height:1px; background:#ddd;"></span><span>or</span><span style="flex:1; height:1px; background:#ddd;"></span>';
        loginContainer.appendChild(divider);

        // Google login button
        const googleBtn = document.createElement('button');
        googleBtn.innerText = "Login with Google";
        googleBtn.onclick = () => window.location.href = "/auth/google/login";
        googleBtn.style.cssText = "padding: 12px 24px; font-size: 16px; background: #4285F4; color: white; border: none; border-radius: 5px; cursor: pointer;";
        loginContainer.appendChild(googleBtn);
    }

    document.body.innerHTML = "";
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

// Initial Load
checkAuth().then(authorized => {
    if (authorized) {
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
        console.log('BP reminders toggled:', enabled);
    } catch (error) {
        console.error('Failed to toggle BP reminders:', error);
        // Revert toggle on error
        this.checked = !enabled;
        alert('Failed to update BP reminder settings. Please try again.');
    }
});

// Weight Reminders Toggle Handler
document.getElementById('weight-reminders-toggle').addEventListener('change', async function () {
    const enabled = this.checked;
    try {
        const response = await apiCall('/api/weight/reminder/toggle', 'POST', { enabled });
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
    if (res.status === 204 || method === "DELETE") return true;
    const txt = await res.text();
    if (!txt) return true;
    try {
        return JSON.parse(txt);
    } catch (e) {
        console.log("Response is not JSON:", txt);
        return true;
    }
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

// Helper for European Date Format (DD.MM.YYYY HH:MM)
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

// UI Functions
function switchTab(tab) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));

    document.querySelector(`.tab[data-tab="${tab}"]`).classList.add('active');
    document.getElementById(`${tab}-view`).classList.add('active');

    if (tab === 'meds') {
        if (!document.querySelector('.med-tab.active')) {
            switchMedTab('history');
        } else {
            reloadCurrentTab();
        }
    } else if (tab === 'bp') { loadBPReadings(); }
    else if (tab === 'weight') { loadWeightLogs(); }
    else if (tab === 'workouts') { loadWorkouts(); }
    else if (tab === 'settings') { loadSettings(); }
}

function switchMedTab(tab) {
    document.querySelectorAll('.med-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.med-tab-content').forEach(c => c.classList.remove('active'));

    document.querySelector(`.med-tab[data-tab="${tab}"]`).classList.add('active');
    document.getElementById(`med-${tab}-tab`).classList.add('active');

    if (tab === 'schedule') { loadMeds(); }
    else if (tab === 'history') { loadHistory(); }
}

// Load settings (BP reminders status, etc.)
async function loadSettings() {
    try {
        // Load BP reminder status
        const bpReminderStatus = await apiCall('/api/bp/reminder/status', 'GET');
        document.getElementById('bp-reminders-toggle').checked = bpReminderStatus.enabled;

        // Load weight reminder status
        const weightReminderStatus = await apiCall('/api/weight/reminder/status', 'GET');
        document.getElementById('weight-reminders-toggle').checked = weightReminderStatus.enabled;
    } catch (error) {
        console.error('Failed to load settings:', error);
    }
}

// Reload current active tab data (called when coming back online)
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
}

// Expose for sync manager
window.reloadCurrentTab = reloadCurrentTab;


function showAddModal() {
    editingMedId = null;
    document.getElementById('modal-overlay').classList.remove('hidden');
    document.getElementById('med-modal').classList.remove('hidden');

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
    document.getElementById('restock-history').innerHTML = '';

    // Default: Daily, 1 time input
    document.getElementById('schedule-type').value = 'daily';
    toggleScheduleFields();

    const timeContainer = document.getElementById('time-inputs');
    timeContainer.innerHTML = '';
    addTimeInput(); // One empty input

    // Clear days
    document.querySelectorAll('.days-select span').forEach(s => s.classList.remove('selected'));
}

function showEditModal(id) {
    editingMedId = id;
    const med = medications.find(m => m.id === id);
    if (!med) return;

    document.getElementById('modal-overlay').classList.remove('hidden');
    document.getElementById('med-modal').classList.remove('hidden');

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
        document.getElementById('restock-history').innerHTML = '';
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
    timeContainer.innerHTML = '';
    if (sched.times && sched.times.length > 0) {
        sched.times.forEach(t => addTimeInput(t));
    } else {
        addTimeInput();
    }

    // Set days
    document.querySelectorAll('.days-select span').forEach(s => s.classList.remove('selected'));
    if (sched.days) {
        sched.days.forEach(d => {
            const span = document.querySelector(`span[data-day="${d}"]`);
            if (span) span.classList.add('selected');
        });
    }
}

function closeModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
    document.getElementById('med-modal').classList.add('hidden');
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

    if (!restocks || restocks.length === 0) {
        container.innerHTML = '<p class="hint">No restock history</p>';
        return;
    }

    let html = '<p class="hint">Recent restocks:</p><ul>';
    restocks.slice(0, 5).forEach(r => {
        const date = formatDate(r.restocked_at);
        html += `<li>+${r.quantity} on ${date}${r.note ? ' - ' + escapeHtml(r.note) : ''}</li>`;
    });
    html += '</ul>';
    container.innerHTML = html;
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
    div.innerHTML = `
        <input type="time" class="med-time-input" value="${escapeHtml(value)}">
        <button class="remove-time" onclick="removeTime(this)">×</button>
    `;
    container.appendChild(div);
}

function removeTime(btn) {
    btn.parentElement.remove();
}

// Render
// Render
function renderMeds() {
    const list = document.getElementById('med-list');
    list.innerHTML = '';

    // Helper to calculate next scheduled time
    const getNextScheduled = (m) => {
        try {
            const sched = JSON.parse(m.schedule);
            const now = new Date();

            if (sched.type === 'daily' && sched.times) {
                // Find next time today or tomorrow
                let candidates = [];
                sched.times.forEach(t => {
                    const [h, min] = t.split(':').map(Number);
                    let d = new Date(now);
                    d.setHours(h, min, 0, 0);
                    if (d <= now) d.setDate(d.getDate() + 1); // Tomorrow
                    candidates.push(d);
                });
                return candidates.sort((a, b) => a - b)[0];
            }
            if (sched.type === 'weekly' && sched.days && sched.times) {
                // Complex weekly logic, fallback to far future if hard
                // Simple implementation: check next 7 days
                let candidates = [];
                for (let i = 0; i < 8; i++) {
                    let dBase = new Date(now);
                    dBase.setDate(now.getDate() + i);
                    const day = dBase.getDay(); // 0-6
                    if (sched.days.includes(day)) {
                        sched.times.forEach(t => {
                            const [h, min] = t.split(':').map(Number);
                            let d = new Date(dBase);
                            d.setHours(h, min, 0, 0);
                            if (d > now) candidates.push(d);
                        });
                    }
                }
                return candidates.sort((a, b) => a - b)[0];
            }
        } catch (e) { }
        return null;
    };

    // Buckets
    const scheduledSoon = [];
    const recentTaken = []; // Recurring but not soon (taken today/yesterday)
    const asNeeded = [];
    const archived = [];

    medications.forEach(m => {
        if (m.archived) {
            archived.push(m);
            return;
        }

        let type = 'daily';
        try { type = JSON.parse(m.schedule).type; } catch (e) { }

        if (type === 'as_needed') {
            asNeeded.push(m);
        } else {
            // Recurring
            const next = getNextScheduled(m);
            m._next = next; // Cache for sort

            // "Scheduled Soon" definition:
            // If next is within 18 hours? Or just sort all by next?
            // User: "then from recent to oldest that were taken"
            // This implies a group that is NOT "Scheduled Soon".
            // If I took my morning med, next is tomorrow morning (24h away).
            // That fits "Recent Taken".
            // If I have a med tonight, it is "Soon".

            // Threshold: Let's say 14 hours.
            const hoursUntil = next ? (next - new Date()) / (1000 * 60 * 60) : 999;

            if (hoursUntil < 14) {
                scheduledSoon.push(m);
            } else {
                recentTaken.push(m);
            }
        }
    });

    // Sort Buckets
    scheduledSoon.sort((a, b) => (a._next || 0) - (b._next || 0));

    // Recent Taken: Recent logs first
    const sortByTaken = (a, b) => {
        const tA = a.last_taken_at ? new Date(a.last_taken_at) : 0;
        const tB = b.last_taken_at ? new Date(b.last_taken_at) : 0;
        return tB - tA;
    };

    recentTaken.sort(sortByTaken);
    asNeeded.sort(sortByTaken);
    archived.sort(sortByTaken);

    // Combine
    const sorted = [...scheduledSoon, ...recentTaken, ...asNeeded, ...archived];

    sorted.forEach(m => {
        const div = document.createElement('div');
        div.className = 'med-item';
        if (m.archived) div.classList.add('archived');

        let scheduleText = '';
        try {
            const sched = JSON.parse(m.schedule);
            if (sched.type === 'daily') {
                scheduleText = `Daily: ${sched.times.join(', ')}`;
            } else if (sched.type === 'weekly') {
                // Convert [1,2] -> ["Mon", "Tue"]
                const daysMap = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
                const dayNames = (sched.days || []).map(d => daysMap[d]);
                scheduleText = `Weekly (${dayNames.join(', ')}): ${sched.times.join(', ')}`;
            } else {
                scheduleText = 'As Needed';
            }
        } catch (e) {
            // Legacy fallback
            scheduleText = escapeHtml(m.schedule);
        }

        let dateRangeText = '';
        if (m.start_date || m.end_date) {
            const start = m.start_date ? formatDate(m.start_date).split(' ')[0] : 'N/A';
            const end = m.end_date ? formatDate(m.end_date).split(' ')[0] : 'N/A';
            dateRangeText = `<p>Dates: ${start} - ${end}</p>`;
        }
        let inventoryText = '';
        if (m.inventory_count !== null && m.inventory_count !== undefined) {
            const isLow = isLowOnStock(m);
            inventoryText = `<p class="inventory-badge ${isLow ? 'low' : ''}">📦 ${m.inventory_count} doses${isLow ? ' ⚠️' : ''}</p>`;
        }

        div.innerHTML = `
            <div class="med-info" onclick="showEditModal(${m.id})" style="cursor: pointer;">
                <h4>${escapeHtml(m.name)} <small>(${escapeHtml(m.dosage)})</small></h4>
                ${m.normalized_name ? `<p style="font-size:0.85em;color:var(--hint-color);margin-top:-5px;margin-bottom:4px;">Rx: ${escapeHtml(m.normalized_name)}</p>` : ''}
                <p>Schedule: ${scheduleText}</p>
                ${dateRangeText}
                ${inventoryText}
            </div>
            <button class="delete-btn" onclick="deleteMed(${m.id})">&times;</button>
        `;
        list.appendChild(div);
    });
}

function renderHistory(logs) {
    const list = document.getElementById('history-list');
    list.innerHTML = '';

    if (!logs || logs.length === 0) {
        list.innerHTML = '<p style="text-align:center;color:var(--hint-color)">No history yet.</p>';
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

        let headerHTML = `<div class="history-header"><strong>${statusIcon} ${escapeHtml(headerTime)}</strong></div>`;

        let itemsHTML = '<div class="history-items">';
        g.items.forEach(l => {
            const med = medications.find(m => m.id === l.medication_id);
            const medName = med ? med.name : 'Unknown Med';
            itemsHTML += `<div class="history-subitem">${escapeHtml(medName)}</div>`;
        });
        itemsHTML += '</div>';

        div.innerHTML = headerHTML + itemsHTML;
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
        // Cache medications from initial auth load
        if (window.MedTrackerDB && window.MedTrackerDB.MedicationStore) {
            await window.MedTrackerDB.MedicationStore.saveCache(medications);
        }
        renderMeds();
        populateMedFilter();
        return;
    }

    // Try to load from API
    const res = await apiCall('/api/medications?archived=true');
    if (res) {
        medications = res;

        // Cache successful response for offline use
        if (window.MedTrackerDB && window.MedTrackerDB.MedicationStore) {
            await window.MedTrackerDB.MedicationStore.saveCache(medications);
        }

        renderMeds();
        populateMedFilter();
    } else {
        // Failed to load from API (likely offline), try cache
        console.log('[Meds] API failed, trying cache...');
        if (window.MedTrackerDB && window.MedTrackerDB.MedicationStore) {
            const cached = await window.MedTrackerDB.MedicationStore.getCache();
            if (cached) {
                console.log('[Meds] Loaded from cache:', cached.length, 'medications');
                medications = cached;
                renderMeds();
                populateMedFilter();
            } else {
                console.log('[Meds] No cache available');
                // Show empty state or offline message in UI
            }
        }
    }
}

function populateMedFilter() {
    const select = document.getElementById('history-filter-med');
    if (!select) return;
    const currentVal = select.value;

    // Keep "All Medications"
    select.innerHTML = '<option value="0">All Medications</option>';

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
        const days = Array.from(document.querySelectorAll('.days-select span.selected'))
            .map(s => parseInt(s.dataset.day));

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
    loadMeds();
}

async function loadHistory() {
    // Ensure medications are loaded for name resolution
    if (medications.length === 0) await loadMeds();

    const days = document.getElementById('history-filter-days').value;
    const medId = document.getElementById('history-filter-med').value;

    const res = await apiCall(`/api/history?days=${days}&med_id=${medId}`);
    // If res is null (not found or error), pass empty array to clear list
    renderHistory(res || []);
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
    let html = `
        <h3 class="weekly-header">Last 7 Days</h3>
        <div class="weekly-days">
    `;

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

        let backgroundStyle = '';
        if (segments.length > 0) {
            backgroundStyle = `background: conic-gradient(${segments.join(', ')});`;
        }

        html += `
            <div class="day-column">
                <div class="day-label">${dayName}</div>
                <div class="day-circle" style="${backgroundStyle}"></div>
                <div class="day-date">${dayNum}</div>
            </div>
        `;
    });

    html += `</div>`;
    container.innerHTML = html;
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
    document.getElementById('modal-overlay').classList.remove('hidden');
    document.getElementById('bp-modal').classList.remove('hidden');

    // Set default datetime to now
    const now = new Date();
    const offset = now.getTimezoneOffset() * 60000;
    const localISOTime = (new Date(now - offset)).toISOString().slice(0, 16);
    document.getElementById('bp-datetime').value = localISOTime;

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
    document.getElementById('modal-overlay').classList.add('hidden');
    document.getElementById('bp-modal').classList.add('hidden');
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
        closeBPRecordModal();
        loadBPReadings();
    }
}

// Load BP readings from API (with offline support)
async function loadBPReadings() {
    const list = document.getElementById('bp-list');
    list.innerHTML = '<li style="text-align:center;color:var(--hint-color);padding:20px;">Loading...</li>';

    let readingsRes, goalRes, statsRes;

    try {
        [readingsRes, goalRes, statsRes] = await Promise.all([
            apiCall('/api/bp?days=60'),  // Fetch 60 days for chart
            apiCall('/api/bp/goal'),
            apiCall('/api/bp/stats')     // Backend-calculated stats
        ]);
    } catch (e) {
        console.error('Failed to load BP data:', e);
    }

    // If we got server data, merge with pending local data
    let allReadings = readingsRes || [];

    // Get pending local readings that haven't been synced yet
    if (window.MedTrackerDB) {
        try {
            const pendingReadings = await window.MedTrackerDB.BPStore.getPending();
            // Add pending readings with isLocal flag
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
        list.innerHTML = '<li style="text-align:center;color:var(--hint-color);padding:20px;">Failed to load readings</li>';
        return;
    }

    renderBPChart(allReadings, goalRes || {});
    renderBPAverages(statsRes || {});  // Use backend stats

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

    container.innerHTML = '';

    if (!readings || readings.length === 0) {
        container.innerHTML = '<span style="color:var(--hint-color);font-size:14px;">No data available</span>';
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
        container.innerHTML = '';
        return;
    }

    let html = '<div class="bp-avg-row">';

    if (stats.stats_14) {
        html += `<div class="bp-avg-item"><span class="bp-avg-label">14d (${stats.stats_14.days}d)</span><span class="bp-avg-value">${stats.stats_14.systolic}/${stats.stats_14.diastolic}</span></div>`;
    }
    if (stats.stats_30) {
        html += `<div class="bp-avg-item"><span class="bp-avg-label">30d (${stats.stats_30.days}d)</span><span class="bp-avg-value">${stats.stats_30.systolic}/${stats.stats_30.diastolic}</span></div>`;
    }
    if (stats.stats_60) {
        html += `<div class="bp-avg-item"><span class="bp-avg-label">60d (${stats.stats_60.days}d)</span><span class="bp-avg-value">${stats.stats_60.systolic}/${stats.stats_60.diastolic}</span></div>`;
    }

    html += '</div>';
    container.innerHTML = html;
}

// Render BP readings grouped by date
function renderBPReadings(readings) {
    const list = document.getElementById('bp-list');
    list.innerHTML = '';

    if (!readings || readings.length === 0) {
        list.innerHTML = '';
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
    const renderGroup = (headerText, readings) => {
        if (readings.length === 0) return '';

        // Sort readings within this group by time (newest first)
        const sortedReadings = [...readings].sort((a, b) =>
            new Date(b.measured_at) - new Date(a.measured_at)
        );

        let html = `<li class="bp-date-group">
            <div class="bp-date-header">${headerText}</div>
            <ul style="list-style:none;padding:0;margin:0;">`;

        sortedReadings.forEach(r => {
            const category = getBPCategory(r.systolic, r.diastolic);
            const timeStr = formatDate(r.measured_at).split(' ')[1]; // Get HH:MM part
            const pendingClass = r.isLocal ? ' pending-sync' : '';

            html += `<li class="bp-item${pendingClass}">
                <div class="bp-reading">
                    <div class="bp-values">
                        <span class="bp-sys">${r.systolic}</span>
                        <span class="bp-dia">/${r.diastolic}</span>
                        ${r.isLocal ? '<span class="sync-pending-badge">Pending</span>' : ''}
                    </div>
                    <div class="bp-meta">
                        <span>${timeStr}</span>`;

            if (r.pulse) {
                html += `<span class="bp-pulse">${r.pulse} bpm</span>`;
            }

            html += `<span class="bp-category ${category.class}">${category.label}</span>
                    </div>
                </div>
                <button class="delete-btn" onclick="deleteBPReading('${r.id}')" title="Delete">&times;</button>
            </li>`;
        });

        html += '</ul></li>';
        return html;
    };

    // Render groups in order
    let html = '';
    html += renderGroup('Today', groups.today);
    html += renderGroup('Yesterday', groups.yesterday);

    if (groups.older.length > 0) {
        // Format older dates
        const olderGroups = {};
        groups.older.forEach(r => {
            const d = new Date(r.measured_at);
            const key = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
            if (!olderGroups[key]) olderGroups[key] = [];
            olderGroups[key].push(r);
        });

        Object.keys(olderGroups).forEach(dateKey => {
            html += renderGroup(dateKey, olderGroups[dateKey]);
        });
    }

    list.innerHTML = html;
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
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'blood_pressure_export.csv';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
    } catch (err) {
        console.error('Export error:', err);
        tg.showAlert('Failed to export data');
    }
}

// ==================== Weight Tracking Functions ====================

// Global variable to store weight logs for ruler component
let cachedWeightLogs = [];

function showWeightModal() {
    document.getElementById('modal-overlay').classList.remove('hidden');
    document.getElementById('weight-modal').classList.remove('hidden');

    // Set default datetime to now
    const now = new Date();
    const offset = now.getTimezoneOffset() * 60000;
    const localISOTime = (new Date(now - offset)).toISOString().slice(0, 16);
    document.getElementById('weight-datetime').value = localISOTime;

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
    document.getElementById('modal-overlay').classList.add('hidden');
    document.getElementById('weight-modal').classList.add('hidden');
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
    ruler.innerHTML = ''; // Clear existing ticks

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

    container.innerHTML = ''; // Clear previous

    if (!logs || logs.length === 0) {
        container.innerHTML = '<span style="color:var(--hint-color);font-size:14px;">No data available</span>';
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
        container.innerHTML = '<span style="color:var(--hint-color);font-size:14px;">No data in current period</span>';
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

    let html = '<div class="weight-stats-container">';

    // Left column
    html += '<div class="weight-stats-column">';
    html += `<div class="weight-stat-item"><span class="weight-stat-label">Trend:</span> <span class="weight-stat-value">${escapeHtml(stats.trendWeight.toFixed(1))} kg</span></div>`;

    if (stats.weeklyRate !== undefined) {
        const rateStr = stats.weeklyRate >= 0
            ? `+${stats.weeklyRate.toFixed(1)} kg/week`
            : `${stats.weeklyRate.toFixed(1)} kg/week`;
        html += `<div class="weight-stat-item"><span class="weight-stat-label">Rate:</span> <span class="weight-stat-value">${escapeHtml(rateStr)}</span></div>`;
    }

    if (stats.forecastDate) {
        const dateStr = stats.forecastDate.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
        html += `<div class="weight-stat-item"><span class="weight-stat-label">Forecast:</span> <span class="weight-stat-value">${escapeHtml(dateStr)}</span></div>`;
    } else {
        html += `<div class="weight-stat-item"><span class="weight-stat-label">Forecast:</span> <span class="weight-stat-value">Unknown</span></div>`;
    }

    html += '</div>';

    // Right column
    html += '<div class="weight-stats-column">';

    if (stats.goalWeight !== undefined) {
        html += `<div class="weight-stat-item"><span class="weight-stat-label">Goal:</span> <span class="weight-stat-value">${escapeHtml(stats.goalWeight.toFixed(1))} kg</span></div>`;

        const deltaStr = stats.deltaFromGoal >= 0
            ? `+${stats.deltaFromGoal.toFixed(1)} kg`
            : `${stats.deltaFromGoal.toFixed(1)} kg`;
        html += `<div class="weight-stat-item"><span class="weight-stat-label">Δ from goal:</span> <span class="weight-stat-value">${escapeHtml(deltaStr)}</span></div>`;
    }

    html += '</div>';
    html += '</div>';

    statsContainer.innerHTML = html;
}


async function loadWeightLogs() {
    const list = document.getElementById('weight-list');
    list.innerHTML = '<li style="text-align:center;color:var(--hint-color);padding:20px;">Loading...</li>';

    let logsRes, goalRes;

    try {
        [logsRes, goalRes] = await Promise.all([
            apiCall('/api/weight?days=35'),  // Fetch 35 days to cover chart period (-30 to +2)
            apiCall('/api/weight/goal')
        ]);
    } catch (e) {
        console.error('Failed to load weight data:', e);
    }

    // If we got server data, merge with pending local data
    let allLogs = logsRes || [];

    // Get pending local logs that haven't been synced yet
    if (window.MedTrackerDB) {
        try {
            const pendingLogs = await window.MedTrackerDB.WeightStore.getPending();
            // Add pending logs with isLocal flag
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
        list.innerHTML = '<li style="text-align:center;color:var(--hint-color);padding:20px;">Failed to load weight logs</li>';
        return;
    }

    // Cache logs globally for ruler component
    cachedWeightLogs = allLogs;

    renderWeightLogs(allLogs);
    renderWeightChart(allLogs, goalRes || {});
}

function renderWeightLogs(logs) {
    const list = document.getElementById('weight-list');
    list.innerHTML = '';

    if (!logs || logs.length === 0) {
        list.innerHTML = '';
        return;
    }

    // Limit to 30 most recent
    if (logs.length > 30) {
        logs = logs.slice(0, 30);
    }

    let html = '';
    logs.forEach(w => {
        const dateStr = escapeHtml(formatDate(w.measured_at));
        const trendDiff = w.weight_trend ? (w.weight - w.weight_trend).toFixed(1) : '0.0';
        const trendIcon = trendDiff > 0 ? '📈' : (trendDiff < 0 ? '📉' : '➡️');
        const pendingClass = w.isLocal ? ' pending-sync' : '';

        html += `<li class="weight-item${pendingClass}">
            <div class="weight-data">
                <div class="weight-value">${escapeHtml(w.weight.toFixed(1))} kg ${w.isLocal ? '<span class="sync-pending-badge">Pending</span>' : ''}</div>
                <div class="weight-trend">${trendIcon} Trend: ${w.weight_trend ? escapeHtml(w.weight_trend.toFixed(1)) : escapeHtml(w.weight.toFixed(1))} kg</div>
                <div class="weight-meta">${dateStr}</div>
            </div>
            <button class="delete-btn" onclick="deleteWeightLog('${w.id}')" title="Delete">&times;</button>
        </li>`;
    });

    list.innerHTML = html;
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
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'weight_export.csv';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
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

    document.getElementById('modal-overlay').classList.remove('hidden');
    document.getElementById('med-confirm-modal').classList.remove('hidden');

    const titleEl = document.getElementById('med-confirm-title');
    const subtitleEl = document.getElementById('med-confirm-subtitle');
    const timeEditEl = document.getElementById('med-confirm-time-edit');
    const timeInput = document.getElementById('med-confirm-datetime');
    const actionBtn = document.getElementById('med-confirm-action-btn');
    const snoozeBtn = document.getElementById('med-confirm-snooze-btn');

    // UI based on mode
    if (mode === 'edit') {
        titleEl.innerText = "Edit Intake";
        subtitleEl.innerText = "";
        timeEditEl.style.display = 'block';

        // Set time input (handling both ISO strings and formatted strings if parsable)
        // We expect scheduledAt/takenAt to be a Date object or parsable string
        try {
            const d = new Date(scheduledAt);
            // datetime-local needs YYYY-MM-DDTHH:mm
            const isoLocal = new Date(d.getTime() - (d.getTimezoneOffset() * 60000)).toISOString().slice(0, 16);
            timeInput.value = isoLocal;
        } catch (e) {
            console.error("Error formatting date for input", e);
        }

        actionBtn.innerText = "Update";
        actionBtn.onclick = updateIntakeHistory;
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
    list.innerHTML = '';

    ids.forEach((id, index) => {
        const name = names[index] || ('Medication ' + id);

        const div = document.createElement('div');
        div.className = 'form-row';
        div.style.marginBottom = '10px';
        div.innerHTML = `
            <label class="checkbox-label" style="font-weight: 500;">
                <input type="checkbox" value="${id}" checked class="med-confirm-check">
                ${escapeHtml(name)}
            </label>
        `;
        list.appendChild(div);
    });
}

function closeMedicationConfirmModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
    document.getElementById('med-confirm-modal').classList.add('hidden');
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


function snoozeMedicationConfirm() {
    closeMedicationConfirmModal();
}

function showWorkoutStartModal(sessionId) {
    pendingWorkoutSessionId = sessionId;
    document.getElementById('modal-overlay').classList.remove('hidden');
    document.getElementById('workout-start-modal').classList.remove('hidden');
}

function closeWorkoutStartModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
    document.getElementById('workout-start-modal').classList.add('hidden');
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
