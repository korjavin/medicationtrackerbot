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
var initialAuthLoad = false;

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
    if (!window.DataStore) return;
    if (tags.length > 0 && typeof window.DataStore.setCachedWithTags === 'function') {
        // setCachedWithTags writes the authoritative value directly and
        // bumps the key's generation so any older fetchFresh still in flight
        // (which could have been issued before the server-side change that
        // produced `value`) cannot overwrite this snapshot when it resolves.
        await window.DataStore.setCachedWithTags(key, value, tags);
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
        window.featureSettings = featureSettings;
        window.featureSettingsLoaded = true;
        window.AppStore && window.AppStore.set('featureSettings', featureSettings);
        updateFeatureTabVisibility();
        // When fresh features arrive after the canonical nav is already mounted
        // (e.g. SW BOOTSTRAP_UPDATED from another device's toggle), rebuild so
        // the nav filters disabled slots rather than bouncing on tap.
        // Skipped during initial boot — the nav hasn't mounted yet there.
        if (document.querySelector('.wg-bottom-nav') && typeof window.rebuildCanonicalBottomNav === 'function') {
            window.rebuildCanonicalBottomNav();
        }
    }

    if (res.settings) {
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
            persistTabOrder(order);
        } else if ('tab_order' in res.settings) {
            // Server returned settings with tab_order explicitly null/missing —
            // clear any stale localStorage fallback so a previous user's saved
            // order on this browser can't leak into the current session and a
            // server-side reset can actually restore the default layout.
            clearPersistedTabOrder();
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
    } else if ('next_intake' in res && window.DataStore) {
        // Key present with falsy value = backend confirmed no upcoming dose;
        // clear any stale cache so Today doesn't keep showing the last reminder
        // after the final pending dose is taken or the schedule is removed.
        // Key absent = backend's compute step errored; preserve cache instead
        // of wiping it on a transient subquery failure.
        await window.DataStore.clearCached('next_intake');
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
        window.featureSettings = featureSettings;
        window.featureSettingsLoaded = true;
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

// Hydrate in-memory feature settings from a cached settings_bundle so deep-link
// and start_param guards (isDeepLinkFeatureEnabled) see the user's real flags
// on cache-only boot paths, not the default-on fallback.
function hydrateFeatureSettingsFromBundle(bundle) {
    if (!bundle || typeof bundle !== 'object') return;
    const cachedFeatures = bundle.featureSettings;
    if (!cachedFeatures || typeof cachedFeatures !== 'object') return;
    featureSettings = { ...featureSettings, ...cachedFeatures };
    featureSettingsLoaded = true;
    window.featureSettings = featureSettings;
    window.featureSettingsLoaded = true;
    if (window.AppStore) window.AppStore.set('featureSettings', featureSettings);
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
            // Both bootstrap and /api/init failed — hydrate features from the
            // cached settings_bundle so the start_param BP/weight deep-link
            // guard sees real flags instead of defaulting to ON and bypassing
            // the user's disabled-feature preference when the backend is down.
            if (!featureSettingsLoaded && window.DataStore) {
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
// Also mirror onto window so early consumers (e.g. deeplink-router's
// start_param branch) can observe the loaded state without depending on AppStore.
window.featureSettings = featureSettings;
window.featureSettingsLoaded = featureSettingsLoaded;
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
    const { buttonSelector, contentSelector, contentIdFromTab, ariaCurrent } = options;
    // Validate target exists BEFORE clearing active state to avoid blank-page on unknown tabs.
    // tabButton is optional: the top-level view group has no button strip after the
    // Wandergeek bottom-nav rework (buttonSelector is omitted), so the button-side
    // toggle is a no-op when missing.
    const tabButton = buttonSelector ? document.querySelector(`${buttonSelector}[data-tab="${tab}"]`) : null;
    const tabContent = document.getElementById(contentIdFromTab(tab));
    if (!tabContent) return false;

    if (buttonSelector) {
        document.querySelectorAll(buttonSelector).forEach((el) => {
            el.classList.remove('active');
            if (ariaCurrent) el.removeAttribute('aria-current');
        });
    }
    document.querySelectorAll(contentSelector).forEach((el) => el.classList.remove('active'));
    if (tabButton) {
        tabButton.classList.add('active');
        if (ariaCurrent) tabButton.setAttribute('aria-current', ariaCurrent);
    }
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
        health: 'health',
        bp: 'bp',
        weight: 'weight',
        meds: 'medication',
        workouts: 'workout'
    };
    const feature = tabToFeature[tab];
    if (feature && featureSettingsLoaded && !featureSettings[feature]) {
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
    let cardOrder = null;
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
        const hoKey = healthOverviewCacheKey();
        if (readMeta) {
            const keys = ['settings_bundle', 'next_intake', 'bp', 'weight', 'workout_next', hoKey, foodKey];
            const metas = await Promise.all(keys.map(readMeta));
            const [bundleM, nextIntakeM, bpM, weightM, workoutM, healthM, foodM] = metas;
            if (bundleM?.data) {
                bootstrap.features = bundleM.data.featureSettings || bootstrap.features;
                bootstrap.settings = { food_targets: bundleM.data.foodTargets };
                if (Array.isArray(bundleM.data.tabOrder)) cardOrder = bundleM.data.tabOrder;
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
            const keys = ['settings_bundle', 'next_intake', 'bp', 'weight', 'workout_next', hoKey, foodKey];
            const [bundle, nextIntake, bp, weight, workout, health, food] = await Promise.all(
                keys.map((k) => window.DataStore.getCached(k).catch(() => null))
            );
            if (bundle) {
                bootstrap.features = bundle.featureSettings || bootstrap.features;
                bootstrap.settings = { food_targets: bundle.foodTargets };
                if (Array.isArray(bundle.tabOrder)) cardOrder = bundle.tabOrder;
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
    // Register key→tag mappings for every Today cache we just read directly
    // from IndexedDB. Without this, `tagToKeys` is empty for these keys on
    // cached-start / reload paths, so a feature save's
    // `invalidateTags(['food'])` etc. silently no-ops and the visible Today
    // dashboard stays stale until a full bootstrap re-fetch. todayFetchSpecs
    // owns the canonical key→tags map; reusing it keeps registration in sync
    // with fetcher tags in one place.
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
    return { bootstrap, swrCaches, latestCacheTimestamp, cardOrder };
}

async function _todayRender(foodKey) {
    const root = document.getElementById('today-content');
    if (!root || !window.TodayDashboard) return { rendered: false };
    const { bootstrap, swrCaches, latestCacheTimestamp, cardOrder } = await _todayReadCaches(foodKey);
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
            if (featureSettingsLoaded) {
                return !featureSettings[feature];
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
            next_intake: !!(bootstrap.next_intake && bootstrap.next_intake.scheduled_at),
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
        if (missing.length === 0) return;
        await Promise.allSettled(
            missing.map((k) => window.DataStore.fetchFresh(k, specs[k].fetch, specs[k].tags))
        );
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
        const bundle = normalizeSettingsBundle(rawBundle);
        featureSettings = { ...featureSettings, ...bundle.featureSettings };
        featureSettingsLoaded = true;
        window.featureSettings = featureSettings;
        window.featureSettingsLoaded = true;
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
        // tab_order is delivered via /api/bootstrap (no standalone GET endpoint);
        // preserve it from the existing cache so SWR re-writes don't drop the
        // user's saved Today card order. Fall back to localStorage so invalidations
        // of settings_bundle don't wipe tabOrder before this fetch runs.
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
    const result = await apiCall(`/api/settings/features/${feature}`, 'POST', { enabled });
    if (!result) {
        // apiCall returns null on failure and has already surfaced the error.
        // Revert the DOM toggle to the last-known state so the UI doesn't lie.
        updateFeatureToggles();
        return;
    }
    featureSettings[feature] = enabled;
    window.AppStore && window.AppStore.set('featureSettings', featureSettings);
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
    if (currentFeature && !featureSettings[currentFeature]) {
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

// renderMeds(), logMedicationPast(), renderHistory() moved to features/meds.js (Phase 5 Task 1)

function escapeHtml(text) {
    if (!text) return "";
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// loadMeds(), populateMedFilter(), saveMedication(), deleteMed() moved to features/meds.js (Phase 5 Task 1)

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

var pendingMedConfirmIds = [];
var pendingMedConfirmScheduled = null;
var pendingWorkoutSessionId = null;
var pendingMedConfirmMode = 'confirm'; // 'confirm' or 'edit'
var pendingMedConfirmIntakeIds = []; // For edit mode

// showMedicationConfirmModal() moved to features/meds.js (Phase 5 Task 1)

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
            refreshMedsAfterMutation();
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
            refreshMedsAfterMutation();
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
