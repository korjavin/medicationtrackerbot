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

async function cacheApiSnapshot(key, value, tags = []) {
    if (tags.length > 0 && window.DataStore) {
        await window.DataStore.fetchFresh(key, () => Promise.resolve(value), tags);
    } else {
        await window.DataStore.setCached(key, value);
    }
}

function normalizeSettingsBundle(raw) {
    const foodTargetsRaw = raw?.foodTargets || raw?.food_targets || raw?.settings?.food_targets || {};
    const bpReminderRaw = raw?.bpReminderStatus || raw?.bp_reminder_status || raw?.settings?.bp_reminder_status || {};
    const weightReminderRaw = raw?.weightReminderStatus || raw?.weight_reminder_status || raw?.settings?.weight_reminder_status || {};
    const tabOrderRaw = raw?.tabOrder || raw?.tab_order || raw?.settings?.tab_order || null;

    return {
        featureSettings: raw?.featureSettings || raw?.features || {},
        tabOrder: tabOrderRaw,
        timezone: raw?.timezone || raw?.settings?.timezone || '',
        serverTime: raw?.serverTime || raw?.server_time || raw?.settings?.server_time || '',
        serverTimezone: raw?.serverTimezone || raw?.server_timezone || raw?.settings?.server_timezone || '',
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

let settingsTimeInfo = {
    timezone: '',
    serverTime: '',
    serverTimezone: '',
    serverOffsetMinutes: null,
    serverBaseMs: null,
    syncedAtMs: null
};
let settingsTimeInfoTimer = null;

function formatSettingsDateTime(date, timeZone) {
    const options = {
        dateStyle: 'medium',
        timeStyle: 'medium'
    };
    if (timeZone) options.timeZone = timeZone;
    try {
        return new Intl.DateTimeFormat(undefined, options).format(date);
    } catch (_) {
        return date.toLocaleString();
    }
}

function parseRFC3339OffsetMinutes(value) {
    if (!value || typeof value !== 'string') return null;
    if (value.endsWith('Z')) return 0;
    const match = value.match(/([+-])(\d{2}):(\d{2})$/);
    if (!match) return null;
    const sign = match[1] === '-' ? -1 : 1;
    return sign * (Number(match[2]) * 60 + Number(match[3]));
}

function formatFixedOffsetDateTime(date, offsetMinutes) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime()) || typeof offsetMinutes !== 'number') {
        return 'Unavailable';
    }
    const shifted = new Date(date.getTime() + offsetMinutes * 60 * 1000);
    try {
        return new Intl.DateTimeFormat(undefined, {
            dateStyle: 'medium',
            timeStyle: 'medium',
            timeZone: 'UTC'
        }).format(shifted);
    } catch (_) {
        return shifted.toISOString().replace('T', ' ').replace('Z', '');
    }
}

function updateSettingsTimeInfoState(bundle) {
    settingsTimeInfo.timezone = bundle?.timezone || '';
    settingsTimeInfo.serverTimezone = bundle?.serverTimezone || '';
    if (bundle?.serverTime) {
        const parsed = Date.parse(bundle.serverTime);
        settingsTimeInfo.serverTime = bundle.serverTime;
        settingsTimeInfo.serverOffsetMinutes = parseRFC3339OffsetMinutes(bundle.serverTime);
        if (!Number.isNaN(parsed)) {
            settingsTimeInfo.serverBaseMs = parsed;
            settingsTimeInfo.syncedAtMs = Date.now();
        }
    }
}

function getLiveServerTime() {
    if (typeof settingsTimeInfo.serverBaseMs !== 'number' || typeof settingsTimeInfo.syncedAtMs !== 'number') {
        return null;
    }
    return new Date(settingsTimeInfo.serverBaseMs + (Date.now() - settingsTimeInfo.syncedAtMs));
}

function renderSettingsTimeInfo(bundle) {
    if (bundle) updateSettingsTimeInfoState(bundle);

    const timezoneValue = document.getElementById('settings-timezone-value');
    const savedTimeValue = document.getElementById('settings-saved-time-value');
    const localTimeValue = document.getElementById('settings-local-time-value');
    const serverTimeValue = document.getElementById('settings-server-time-value');
    const timezoneNote = document.getElementById('settings-timezone-note');
    if (!timezoneValue || !savedTimeValue || !localTimeValue || !serverTimeValue || !timezoneNote) return;

    timezoneValue.textContent = settingsTimeInfo.timezone || 'Not set';
    savedTimeValue.textContent = settingsTimeInfo.timezone
        ? formatSettingsDateTime(new Date(), settingsTimeInfo.timezone)
        : 'Unavailable until a timezone is saved';
    localTimeValue.textContent = formatSettingsDateTime(new Date());

    const serverNow = getLiveServerTime();
    serverTimeValue.textContent = serverNow
        ? `${formatFixedOffsetDateTime(serverNow, settingsTimeInfo.serverOffsetMinutes)}${settingsTimeInfo.serverTimezone ? ` • ${settingsTimeInfo.serverTimezone}` : ''}`
        : 'Unavailable';

    timezoneNote.textContent = settingsTimeInfo.timezone
        ? 'Saved timezone affects all reminders and medication schedules. Changing timezone may trigger a transition plan for gradual dose adjustment.'
        : 'No saved timezone yet. If the browser-detected timezone looks wrong, it will be visible here after the next confirmation.';
}

function ensureSettingsTimeInfoTimer() {
    if (settingsTimeInfoTimer) return;
    settingsTimeInfoTimer = window.setInterval(() => {
        renderSettingsTimeInfo();
    }, 1000);
}

window.renderSettingsTimeInfo = renderSettingsTimeInfo;

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

// Migrate a user's saved tab_order so the Today tab becomes the default
// landing surface.  Returns the input array when:
//   - today is already included, or
//   - the user has explicitly opted out (localStorage 'today_opt_out' = '1').
// Otherwise prepends 'today' so it sorts to the front after applyTabOrder.
function migrateTabOrderForToday(order) {
    if (!Array.isArray(order)) return order;
    if (order.includes('today')) return order;
    try {
        if (localStorage.getItem('today_opt_out') === '1') return order;
    } catch (_) { /* localStorage unavailable — fall through and prepend */ }
    return ['today', ...order];
}

// Apply bootstrap payload and warm caches so first tab render can use local data.
// Idempotent: safe to call multiple times (e.g. once from SW cache, once from
// fresh network response via BOOTSTRAP_UPDATED). Every field is a full replacement.
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
            applyTabOrder(migrateTabOrderForToday(order));
        }
    }

    if (Array.isArray(res.medications)) {
        medications = res.medications;
        initialAuthLoad = true;
        if (window.MedTrackerDB?.MedicationStore) {
            await window.MedTrackerDB.MedicationStore.saveCache(medications);
        }
        await cacheApiSnapshot('medications', medications, ['medications']);
    }

    if (Array.isArray(res.history_default)) {
        await cacheApiSnapshot('history_3_0', res.history_default, ['history']);
        if (window.MedTrackerDB?.IntakeHistoryStore) {
            await window.MedTrackerDB.IntakeHistoryStore.saveCache('history_3_0', res.history_default);
        }
    }

    if (res.next_intake) {
        await cacheApiSnapshot('next_intake', res.next_intake, ['history', 'medications']);
    }

    if (res.bp) {
        await cacheApiSnapshot('bp', {
            readingsRes: res.bp.readings || [],
            goalRes: res.bp.goal || {},
            statsRes: res.bp.stats || {}
        }, ['bp']);
    }

    if (res.weight) {
        await cacheApiSnapshot('weight', {
            logsRes: res.weight.logs || [],
            goalRes: res.weight.goal || {}
        }, ['weight']);
    }

    const settingsBundle = normalizeSettingsBundle({
        features: res.features || {},
        settings: res.settings || {},
        food_targets: res.settings?.food_targets,
        bp_reminder_status: res.settings?.bp_reminder_status,
        weight_reminder_status: res.settings?.weight_reminder_status
    });
    await cacheApiSnapshot('settings_bundle', settingsBundle, ['settings', 'food_targets', 'feature_settings']);

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

// Background auth verification for non-blocking cached-auth path.
// Fires /auth/status without blocking the UI. If the session has expired,
// clears auth state and reloads so the user sees the login screen.
function verifyAuthInBackground() {
    fetch('/auth/status', { method: 'GET', credentials: 'same-origin' })
        .then(res => {
            if (res.status === 200) {
                return res.json().then(data => {
                    if (!data.authenticated) {
                        console.log('[Auth] Background check: session expired');
                        clearAuthState();
                        clearSwBootstrapCache().then(() => location.reload());
                    }
                });
            } else if (res.status < 500) {
                // 4xx (not server error) means auth is invalid
                console.log('[Auth] Background check: auth invalid', res.status);
                clearAuthState();
                clearSwBootstrapCache().then(() => location.reload());
            }
            // 5xx — server is down, keep using cached auth silently
        })
        .catch(() => {
            // Network error — server unreachable, keep using cached auth
        });
}

// Clear the SW dynamic cache bootstrap entry so stale user data
// is not served after logout or session expiry.
function clearSwBootstrapCache() {
    return caches.keys().then(names => {
        const dynamicName = names.find(n => n.startsWith('medtracker-dynamic-'));
        if (!dynamicName) return;
        return caches.open(dynamicName).then(cache =>
            cache.delete(new Request('/api/bootstrap'))
        );
    }).catch(() => { /* best-effort */ });
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
                fetch('/api/bootstrap', { method: 'GET', credentials: 'same-origin' }),
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
                    if (cachedBundle && Array.isArray(cachedBundle.tabOrder)) {
                        applyTabOrder(migrateTabOrderForToday(cachedBundle.tabOrder));
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
            if (cachedBundle && Array.isArray(cachedBundle.tabOrder)) {
                applyTabOrder(migrateTabOrderForToday(cachedBundle.tabOrder));
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

    const wrapper = document.createElement('div');
    wrapper.className = 'setting-item';
    wrapper.classList.add('mb-lg');

    const textWrap = document.createElement('div');
    const title = document.createElement('h3');
    title.innerText = 'OIDC Setup';
    const desc = document.createElement('p');
    desc.className = 'setting-desc';
    desc.innerText = 'Copy redirect URIs for Pocket-ID / OIDC clients.';
    textWrap.appendChild(title);
    textWrap.appendChild(desc);

    const actionBtn = document.createElement('button');
    actionBtn.className = 'btn btn-secondary';
    actionBtn.classList.add('m-0');
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
        status.className = '';
        const success = await window.MedTrackerPush.subscribe();
        if (success) {
            status.innerText = "Notifications enabled";
            status.className = 'status-success';
        } else {
            status.innerText = "Failed to enable notifications. Please check permissions.";
            status.className = 'status-error';
            this.checked = false;
        }
    } else {
        const success = await window.MedTrackerPush.unsubscribe();
        if (success) {
            status.innerText = "Notifications disabled";
            status.className = 'status-muted';
        } else {
            status.innerText = "Failed to disable notifications";
            status.className = 'status-error';
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
    else if (tab === 'health') {
        const activeHealthTab = document.querySelector('.health-tab.active');
        const currentSubTab = activeHealthTab ? activeHealthTab.dataset.tab : 'overview';
        switchHealthTab(currentSubTab);
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
            fetch: () => apiCall('/api/medications/next-intake')
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
                    apiCall('/api/weight?days=35'),
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
            // Wrap a legitimate `null` server response ("no next workout") as
            // `{session: null}` so fetchFresh caches it. Without this, null is
            // filtered by hasValue() and Today re-probes /sessions/next on
            // every tab switch. A transient API error also surfaces as null
            // here; we accept that tradeoff — the next `workout` tag
            // invalidation evicts the sentinel.
            fetch: async () => {
                const res = await apiCall('/api/workout/sessions/next');
                return res || { session: null };
            }
        },
        health_overview: {
            feature: 'health',
            tags: ['health'],
            fetch: () => apiCall('/api/health/overview', 'GET')
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
    return {
        featureSettings: featureSettingsRes || {},
        timezone: settingsRes?.timezone || '',
        serverTime: settingsRes?.server_time || '',
        serverTimezone: settingsRes?.server_timezone || '',
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
    const bootstrap = { features: featureSettings || {} };
    const swrCaches = {};
    // Tracks the *most recent* write among all caches we read. The offline-stale
    // banner ("cached data is >1h old") should fire only when nothing we have
    // is fresh. Using the oldest timestamp would let a single rarely-updated
    // cache (e.g. health_overview) pin the window even after bootstrap just
    // refreshed.
    let latestCacheTimestamp = null;
    const trackTs = (ts) => {
        if (Number.isFinite(ts) && (latestCacheTimestamp === null || ts > latestCacheTimestamp)) {
            latestCacheTimestamp = ts;
        }
    };
    try {
        const cacheStore = window.MedTrackerDB?.ApiCache;
        const readMeta = cacheStore && typeof cacheStore.getWithMeta === 'function'
            ? (key) => cacheStore.getWithMeta(key).catch(() => null)
            : null;
        if (readMeta) {
            const keys = ['settings_bundle', 'next_intake', 'bp', 'weight', 'workout_next', 'health_overview', foodKey];
            const metas = await Promise.all(keys.map(readMeta));
            const [bundleM, nextIntakeM, bpM, weightM, workoutM, healthM, foodM] = metas;
            if (bundleM?.data) {
                bootstrap.features = bundleM.data.featureSettings || bootstrap.features;
                bootstrap.settings = { food_targets: bundleM.data.foodTargets };
            }
            if (nextIntakeM?.data) bootstrap.next_intake = nextIntakeM.data;
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
            for (const m of metas) {
                if (m) trackTs(m.timestamp);
            }
        } else if (window.DataStore && typeof window.DataStore.getCached === 'function') {
            const keys = ['settings_bundle', 'next_intake', 'bp', 'weight', 'workout_next', 'health_overview', foodKey];
            const [bundle, nextIntake, bp, weight, workout, health, food] = await Promise.all(
                keys.map((k) => window.DataStore.getCached(k).catch(() => null))
            );
            if (bundle) {
                bootstrap.features = bundle.featureSettings || bootstrap.features;
                bootstrap.settings = { food_targets: bundle.foodTargets };
            }
            if (nextIntake) bootstrap.next_intake = nextIntake;
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
    return { bootstrap, swrCaches, latestCacheTimestamp };
}

async function _todayRender(foodKey) {
    const root = document.getElementById('today-content');
    if (!root || !window.TodayDashboard) return { rendered: false };
    const { bootstrap, swrCaches, latestCacheTimestamp } = await _todayReadCaches(foodKey);
    const online = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
    const nowMs = Date.now();
    const state = window.TodayDashboard.aggregateToday(bootstrap, swrCaches, nowMs);
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
    window.TodayDashboard.renderToday(state, root, { now: nowMs });
    return { rendered: true, bootstrap, swrCaches, online };
}

async function loadToday() {
    const foodKey = todayFoodKey(new Date());
    const ctx = await _todayRender(foodKey);
    if (!ctx.rendered) return;

    if (!todayUnsubscribe && typeof window.TodayDashboard.subscribe === 'function') {
        todayUnsubscribe = window.TodayDashboard.subscribe({
            onRefresh: (payload) => {
                // The app-level BOOTSTRAP_UPDATED handler already calls reloadCurrentTab();
                // skip that source here so we don't render twice.
                if (payload && payload.source === 'bootstrap') return;
                const active = document.querySelector('.tab.active');
                if (active && active.dataset && active.dataset.tab === 'today') {
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
    const presence = {
        settings_bundle: !!ctx.bootstrap.settings,
        next_intake: !!ctx.bootstrap.next_intake,
        bp: !!ctx.bootstrap.bp,
        weight: !!ctx.bootstrap.weight,
        workout_next: !!ctx.swrCaches.workout_next,
        health_overview: !!ctx.swrCaches.health_overview,
        [foodKey]: !!ctx.swrCaches.food_today
    };
    const missing = Object.keys(presence).filter((k) => !presence[k]);
    if (missing.length === 0) return;
    const specs = todayFetchSpecs(foodKey);
    todayRefreshInFlight = true;
    try {
        await Promise.allSettled(
            missing
                .filter((k) => specs[k])
                .map((k) => window.DataStore.fetchFresh(k, specs[k].fetch, specs[k].tags))
        );
    } finally {
        todayRefreshInFlight = false;
    }
    const active = document.querySelector('.tab.active');
    if (active && active.dataset && active.dataset.tab === 'today') {
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
    if (tab === 'overview') { loadHealthOverview(); }
    else if (tab === 'notes') { loadNotes(); }
}

bindTabGroup({
    container: document.querySelector('.health-tabs'),
    buttonSelector: '.health-tab',
    onTabSelect: switchHealthTab
});

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
    bindClick('med-confirm-skip-btn', () => skipSelectedMedications());

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
        renderSettingsTimeInfo(bundle);
        ensureSettingsTimeInfoTimer();
    };

    const fetchBundle = async () => {
        const [featureSettingsRes, foodTargetsRes, bpReminderStatus, weightReminderStatus, settingsRes] = await Promise.all([
            apiCall('/api/settings/features', 'GET'),
            apiCall('/api/food/settings/targets', 'GET'),
            apiCall('/api/bp/reminder/status', 'GET'),
            apiCall('/api/weight/reminder/status', 'GET'),
            apiCall('/api/settings', 'GET')
        ]);
        return {
            featureSettings: featureSettingsRes || {},
            timezone: settingsRes?.timezone || '',
            serverTime: settingsRes?.server_time || '',
            serverTimezone: settingsRes?.server_timezone || '',
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
            onError: async (error, cached) => {
                console.error('Failed to load settings:', error);
                if (cached) applyBundle(cached);
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
            tabBtn.style.display = featureSettings[feature] ? '' : 'none';
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
    else if (tab === 'today') { loadToday(); }
    else if (tab === 'health') {
        const activeHealthTab = document.querySelector('.health-tab.active');
        const currentSubTab = activeHealthTab ? activeHealthTab.dataset.tab : 'overview';
        switchHealthTab(currentSubTab);
    }
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
    document.getElementById('med-tz-policy').value = 'flexible';
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

    // Timezone adjustment policy
    document.getElementById('med-tz-policy').value = med.tz_shift_policy || 'flexible';
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
    removeButton.className = 'btn btn-danger btn-icon remove-time';
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
        info.classList.add('cursor-pointer');
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
            supplementBadge.className = 'med-supplement-badge';
            supplementBadge.textContent = '[Supplement]';
            title.appendChild(supplementBadge);
        }
        info.appendChild(title);

        if (med.normalized_name) {
            const normalized = document.createElement('p');
            normalized.className = 'med-normalized-name';
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
        logBtn.className = 'btn btn-sm btn-secondary';
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
        actionIcons.className = 'med-action-icons';
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
        empty.className = 'med-empty-text';
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
            div.classList.add('cursor-pointer');
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
            if (l.id !== undefined && l.id !== null) {
                subitem.dataset.intakeId = String(l.id);
            }
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

    const tzShiftPolicy = document.getElementById('med-tz-policy').value || 'flexible';

    const payload = {
        name,
        dosage,
        schedule: JSON.stringify(schedule),
        archived,
        supplement,
        start_date: startDateRaw ? new Date(startDateRaw).toISOString() : null,
        end_date: endDateRaw ? new Date(endDateRaw).toISOString() : null,
        inventory_count: inventoryCount,
        tz_shift_policy: tzShiftPolicy
    };

    const btn = document.getElementById('med-modal-save-btn');
    await withSubmit(btn, async () => {
        let res;
        try {
            if (editingMedId) {
                res = await apiCallDirect(`/api/medications/${editingMedId}`, 'POST', payload);
            } else {
                res = await apiCallDirect('/api/medications', 'POST', payload);
            }
        } catch (e) {
            if (e.status === 409) {
                safeAlert("A medication with this name and dosage already exists. Please use a different name or dosage.");
            } else {
                safeAlert("Error: " + e.message);
            }
            return;
        }

        if (res === null) return; // offline or error — apiCall already showed alert

        if (res.warning) {
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
    if (res === null) return; // Offline or error — apiCall already alerted if needed
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

    const result = await window.DataStore.loadSWR({
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
    return result;
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
        card.className = 'next-intake-card';

        const body = document.createElement('div');
        const title = document.createElement('div');
        title.className = 'next-intake-title';
        title.textContent = 'Next scheduled intake';

        const countdown = document.createElement('div');
        countdown.className = 'next-intake-countdown';
        function updateCountdown() {
            countdown.textContent = _formatCountdown(nextTime - Date.now());
        }
        updateCountdown();
        _nextIntakeTimerInterval = setInterval(updateCountdown, 30000);

        const details = document.createElement('div');
        details.className = 'next-intake-details';
        details.textContent = `${medNamesStr} at ${timeStr}`;
        body.appendChild(title);
        body.appendChild(countdown);
        body.appendChild(details);

        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'btn btn-pill';
        action.classList.add('next-intake-action');
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

        // Show skip button only for PENDING intakes
        const skipBtn = document.getElementById('med-confirm-skip-btn');
        if (skipBtn) {
            skipBtn.style.display = 'inline-block';
        }
    }

    // Hide skip button if we're not in 'confirm' mode
    if (mode !== 'confirm') {
        const skipBtn = document.getElementById('med-confirm-skip-btn');
        if (skipBtn) {
            skipBtn.style.display = 'none';
        }
    }

    const list = document.getElementById('med-confirm-list');
    list.replaceChildren();

    ids.forEach((id, index) => {
        const name = names[index] || ('Medication ' + id);

        const div = document.createElement('div');
        div.className = 'form-row';
        div.classList.add('mb-sm');

        const label = document.createElement('label');
        label.className = 'checkbox-label';
        label.classList.add('fw-medium');

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = String(index);
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
    const selectedIndices = Array.from(checks).map(c => parseInt(c.value, 10));
    const selectedIds = selectedIndices.map(idx => Number(pendingMedConfirmIds[idx]));
    const selectedIntakeIds = selectedIndices
        .map(idx => pendingMedConfirmIntakeIds[idx])
        .filter(id => id != null);

    const btn = document.getElementById('med-confirm-action-btn');
    await withSubmit(btn, async () => {
        const body = {
            scheduled_at: pendingMedConfirmScheduled,
            medication_ids: selectedIds
        };
        if (selectedIntakeIds.length > 0) {
            body.intake_ids = selectedIntakeIds;
        }
        const res = await apiCall('/api/medications/confirm-schedule', 'POST', body);

        if (res) {
            safeAlert("Confirmed!");
            loadMeds();
            loadHistory();
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
        for (const idx of selectedIndices) {
            const medId = Number(pendingMedConfirmIds[idx]);
            let intakeId = pendingMedConfirmIntakeIds[idx];

            if (!intakeId) {
                // If opened from a push notification where intakeIds weren't passed directly,
                // fetch pending intakes for the scheduled time to find the correct intake ID
                const pendingLogs = await apiCall(`/api/history?days=1`);
                if (pendingLogs && pendingLogs.length > 0) {
                    const scheduledTime = new Date(pendingMedConfirmScheduled).getTime();
                    const log = pendingLogs.find(l =>
                        l.medication_id === medId &&
                        l.status === 'PENDING' &&
                        Math.abs(new Date(l.scheduled_at).getTime() - scheduledTime) < 60000 // Within 1 min
                    );
                    if (log) {
                        intakeId = log.id;
                    }
                }
            }

            if (intakeId) {
                const res = await apiCall('/api/medications/skip', 'POST', { intake_id: intakeId });
                if (!res) {
                    hasErrors = true;
                }
            } else {
                hasErrors = true;
            }
        }

        loadMeds();
        loadHistory();
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

    // For selected items (TAKEN)
    selectedIndices.forEach(idx => {
        if (pendingMedConfirmIntakeIds[idx]) {
            updates.push({
                id: pendingMedConfirmIntakeIds[idx],
                status: 'TAKEN',
                taken_at: takenAt
            });
        }
    });

    // For unselected items (PENDING - Reverting)
    unselectedIndices.forEach(idx => {
        if (pendingMedConfirmIntakeIds[idx]) {
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
            if (window.DataStore) {
                await window.DataStore.invalidateByTag('history');
                await window.DataStore.invalidateByTag('medications');
            }
            await loadMeds();
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

// Health Overview functions live in features/health.js.
// ---- Diary Notes ----

const NOTES_PAGE_SIZE = 50;
// Keyset cursor: ID of the last note currently shown. 0 means page 1 not yet loaded.
let _notesCursor = 0;
// In-flight guard to prevent concurrent load-more requests.
let _notesLoadingMore = false;
// True once the user has clicked "Load more" at least once in the current view.
let _notesHasLoadedMore = false;
// Incremented each time loadNotes() starts a fresh load; lets stale loadMoreNotes() calls self-cancel.
let _notesGeneration = 0;
// Fresh page-1 data parked while _notesHasLoadedMore is true. Applied if load-more fails so the
// page-1 view stays consistent with the latest server state.
let _notesPendingFresh = null;

async function loadNotes() {
    const list = document.getElementById('notes-list');
    const loading = document.getElementById('notes-loading');
    if (!list) return;

    _notesCursor = 0;
    _notesLoadingMore = false;
    _notesHasLoadedMore = false;
    _notesPendingFresh = null;
    _notesGeneration++;
    // Capture the generation at call time. The onFresh callback closes over this
    // value so that a stale in-flight response (from before a write invalidated
    // the cache) cannot repaint the list after a newer loadNotes() has started.
    const myGeneration = _notesGeneration;

    if (loading) loading.style.display = 'block';

    await window.DataStore.loadSWR({
        key: 'diary_notes',
        tags: ['notes'],
        fetcher: async () => await apiCall(`/api/notes?limit=${NOTES_PAGE_SIZE}`, 'GET'),
        allowNullFresh: true,
        onCached: async (cached) => {
            if (!cached) return;
            renderNotes(list, cached);
            if (cached.length > 0) _notesCursor = cached[cached.length - 1].id;
            if (loading) loading.style.display = 'none';
        },
        onFresh: async (fresh) => {
            if (loading) loading.style.display = 'none';
            // Discard the result if a newer loadNotes() call has already taken
            // over (e.g. the user added/deleted a note while this fetch was in
            // flight and the post-write refresh incremented _notesGeneration).
            if (myGeneration !== _notesGeneration) return;
            if (!fresh) return;
            // Only replace page 1 if the user has not yet clicked "Load more".
            // When _notesHasLoadedMore is true, the list contains pages 2+ that we
            // must not wipe; a full reload requires an explicit loadNotes() call anyway.
            if (!_notesHasLoadedMore) {
                const page1LastID = fresh.length > 0 ? fresh[fresh.length - 1].id : 0;
                renderNotes(list, fresh);
                _notesCursor = page1LastID;
            } else {
                // Page-2 fetch is in flight. Stash the fresh page-1 data so we can
                // apply it if that fetch fails and no page was actually appended.
                _notesPendingFresh = { data: fresh, generation: _notesGeneration };
            }
        },
        onError: async (e, cached) => {
            console.error('Failed to load notes:', e);
            if (loading) loading.style.display = 'none';
            if (!cached) {
                const list = document.getElementById('notes-list');
                if (list) list.replaceChildren(createEmptyState('No cached data \u2014 will load when online'));
            }
        }
    });

    const saveBtn = document.getElementById('notes-save-btn');
    if (saveBtn && !saveBtn._noteHandlerAttached) {
        saveBtn._noteHandlerAttached = true;
        saveBtn.addEventListener('click', addNote);
    }
}

async function loadMoreNotes() {
    if (_notesLoadingMore) return;
    const list = document.getElementById('notes-list');
    if (!list) return;

    const myGeneration = _notesGeneration;
    _notesLoadingMore = true;
    // Set immediately so that any in-flight onFresh callback from the initial
    // loadNotes() SWR call does not replace page 1 while we are fetching page 2.
    _notesHasLoadedMore = true;
    // Snapshot the page-1 end cursor so we can later tell whether fresh page-1
    // data represents a real change or is just an identical revalidation response.
    const page1EndCursor = _notesCursor;
    try {
        const url = _notesCursor > 0
            ? `/api/notes?limit=${NOTES_PAGE_SIZE}&before_id=${_notesCursor}`
            : `/api/notes?limit=${NOTES_PAGE_SIZE}`;
        const notes = await apiCall(url, 'GET');
        if (!notes) {
            // Fetch failed — no page 2 was actually appended. Only roll back for
            // the current generation to avoid clobbering a newer loadMoreNotes().
            if (myGeneration === _notesGeneration) {
                _notesHasLoadedMore = false;
                // Apply the deferred fresh page-1 data that onFresh skipped while
                // the flag was set, so the UI shows the latest server state.
                if (_notesPendingFresh && _notesPendingFresh.generation === myGeneration) {
                    const pending = _notesPendingFresh.data;
                    _notesPendingFresh = null;
                    renderNotes(list, pending);
                    _notesCursor = pending && pending.length > 0 ? pending[pending.length - 1].id : 0;
                }
            }
            return;
        }

        // Bail out if loadNotes() started a fresh load while this fetch was in-flight.
        if (myGeneration !== _notesGeneration) return;

        // Remove existing load-more button before appending.
        const existing = list.querySelector('.notes-load-more');
        if (existing) existing.remove();
        if (notes.length === 0 && _notesPendingFresh && _notesPendingFresh.generation === myGeneration) {
            // Server returned an empty page 2 — the dataset no longer extends past
            // page 1 (e.g. notes were deleted since caching). Apply the deferred
            // fresh page-1 data to show the correct current state.
            _notesHasLoadedMore = false;
            const pending = _notesPendingFresh.data;
            _notesPendingFresh = null;
            renderNotes(list, pending);
            _notesCursor = pending && pending.length > 0 ? pending[pending.length - 1].id : 0;
            return;
        }
        if (notes.length > 0) _notesCursor = notes[notes.length - 1].id;
        // Page 2 was appended successfully.
        if (_notesPendingFresh && _notesPendingFresh.generation === myGeneration) {
            const freshData = _notesPendingFresh.data;
            const freshLastID = freshData && freshData.length > 0 ? freshData[freshData.length - 1].id : 0;
            _notesPendingFresh = null;
            if (freshLastID !== page1EndCursor) {
                // Page-1 actually changed on the server (e.g. a new note was added
                // that shifted the cursor boundary). The page-2 we just fetched may
                // now overlap or have a gap, so trigger a full reload for a
                // contiguous, accurate list.
                loadNotes();
                return;
            }
            // The page-1 boundary (last ID) is unchanged, so page-2 is still
            // contiguous. However, page-1 content may have changed in the middle
            // (e.g. a note was deleted and a new one added with the same resulting
            // boundary). Re-render page-1 from the fresh server data, then fall
            // through to append page-2 so both pages are up-to-date.
            renderNotes(list, freshData);
            // Do not update _notesCursor here — it was already advanced to the last
            // page-2 ID at line 3170. Overwriting with freshLastID (page-1 boundary)
            // would cause the next "load more" to re-fetch page-2.
            // renderNotes may have added a "Load more" button at the end of page-1;
            // remove it before appending the page-2 items below.
            list.querySelector('.notes-load-more')?.remove();
        }
        _notesPendingFresh = null;
        appendNotes(list, notes);
    } finally {
        // Only clear the guard for the current generation. An old-generation
        // request finishing after loadNotes() reset and a new loadMoreNotes()
        // set the guard must not clobber the new generation's in-flight state.
        if (myGeneration === _notesGeneration) {
            _notesLoadingMore = false;
        }
    }
}

function renderNotes(list, notes) {
    list.replaceChildren();
    if (!notes || notes.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'notes-empty';
        empty.textContent = 'No notes yet.';
        list.appendChild(empty);
        return;
    }
    appendNotes(list, notes);
}

function appendNotes(list, notes) {
    notes.forEach(note => {
        const li = document.createElement('li');
        li.className = 'notes-item';

        const meta = document.createElement('div');
        meta.className = 'notes-meta';
        const d = new Date(note.created_at);
        meta.textContent = d.toLocaleString();

        const content = document.createElement('div');
        content.className = 'notes-content';
        content.textContent = note.content;

        const delBtn = createDeleteButton(() => deleteNote(note.id));

        li.appendChild(meta);
        li.appendChild(content);
        li.appendChild(delBtn);
        list.appendChild(li);
    });

    if (notes.length === NOTES_PAGE_SIZE) {
        const li = document.createElement('li');
        li.className = 'notes-load-more';
        const btn = document.createElement('button');
        btn.textContent = 'Load more';
        btn.addEventListener('click', loadMoreNotes);
        li.appendChild(btn);
        list.appendChild(li);
    }
}

async function addNote() {
    const textarea = document.getElementById('notes-textarea');
    if (!textarea) return;
    const content = textarea.value.trim();
    if (!content) return;
    if (content.length > 10000) {
        safeAlert('Note is too long (max 10,000 characters).');
        return;
    }

    const res = await apiCall('/api/notes', 'POST', { content });
    if (res) {
        textarea.value = '';
        await window.DataStore.invalidateTags(['notes']);
        loadNotes();
    }
}

async function deleteNote(id) {
    await safeConfirm('Delete this note?', async (ok) => {
        if (ok) {
            const res = await apiCall(`/api/notes/${id}`, 'DELETE');
            if (res !== null) {
                await window.DataStore.invalidateTags(['notes']);
                loadNotes();
            }
        }
    });
}
