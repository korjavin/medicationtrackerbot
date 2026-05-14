// Auth bootstrap + initial hydration extracted from app.js.
//
// Public surface (also re-exposed as the original window.X names for
// backwards compatibility with existing tests and feature modules):
//   - AuthBootstrap.applyBootstrapPayload(res)
//   - AuthBootstrap.verifyAuthInBackground()
//   - AuthBootstrap.clearSwBootstrapCache()
//   - AuthBootstrap.bootstrapURL()
//   - AuthBootstrap.hydrateFeatureSettingsFromBundle(bundle)
//   - AuthBootstrap.hydrateMedicationsFromDexie()
//   - AuthBootstrap.hydrateSectionsFromDexie()
//   - AuthBootstrap.cacheApiSnapshot(key, value, tags)
//   - AuthBootstrap.normalizeSettingsBundle(raw)
//
// `checkAuth()` itself stays in app.js for now — it orchestrates these
// helpers, and extracting it requires moving the login UI builders too
// (out of scope for this extraction).
//
// SettingsState (also defined in this file) owns the previously-racy
// featureSettings cluster: three call sites in app.js used to race —
// applyBootstrapPayload, loadInitData, and hydrateFeatureSettingsFromBundle
// each wrote `featureSettings`, `featureSettingsLoaded`, `window.featureSettings`,
// `window.featureSettingsLoaded`, and `AppStore.set('featureSettings', ...)`
// independently. The reducer below collapses them into one writer with an
// explicit precedence: bootstrap/init/settings-fresh marks loaded=true and
// wins, Dexie hydration only applies when nothing fresh has landed yet.

window.SettingsState = (function () {
    const DEFAULT_FEATURES = Object.freeze({
        food: false,
        bp: true,
        weight: true,
        medication: true,
        workout: true,
        health: true,
    });

    let _state = {
        features: { ...DEFAULT_FEATURES },
        loaded: false,
    }; // module-state: settings reducer; bootstrap/loadInitData/loadSettings own
       // `applyBootstrapFeatures`; Dexie-cache hydration owns `applyDexieFeatures`
       // and is skipped once loaded=true so stale-cache cannot stomp fresh values.

    function _mirror() {
        window.featureSettings = _state.features;
        window.featureSettingsLoaded = _state.loaded;
        if (window.AppStore && typeof window.AppStore.set === 'function') {
            window.AppStore.set('featureSettings', _state.features);
        }
    }

    function getFeatureSettings() {
        return _state.features;
    }

    function isLoaded() {
        return _state.loaded;
    }

    // Fresh-server-data writer. Bootstrap, /api/init, and loadSettings all
    // call here — anything that came directly from the server in this session
    // is authoritative and marks the state as loaded.
    function applyBootstrapFeatures(flags) {
        if (!flags || typeof flags !== 'object') return;
        _state.features = { ..._state.features, ...flags };
        _state.loaded = true;
        _mirror();
    }

    // Cache-only writer. Skipped once fresh data has landed so a stale
    // settings_bundle row cannot overwrite the bootstrap-confirmed feature
    // map after a slow Dexie read resolves late.
    function applyDexieFeatures(flags) {
        if (_state.loaded) return;
        if (!flags || typeof flags !== 'object') return;
        _state.features = { ..._state.features, ...flags };
        _state.loaded = true;
        _mirror();
    }

    function setFeature(feature, enabled) {
        _state.features = { ..._state.features, [feature]: !!enabled };
        _mirror();
    }

    function _resetForTesting() {
        _state.features = { ...DEFAULT_FEATURES };
        _state.loaded = false;
        _mirror();
    }

    function _stateForTesting() {
        return { features: { ..._state.features }, loaded: _state.loaded };
    }

    _mirror();

    return {
        getFeatureSettings,
        isLoaded,
        applyBootstrapFeatures,
        applyDexieFeatures,
        setFeature,
        _resetForTesting,
        _stateForTesting,
    };
})();

window.AuthBootstrap = (function () {
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
        const weightUnitRaw = raw?.weightUnitPreference || raw?.weight_unit_preference || raw?.settings?.weight_unit_preference || 'kg';
        const weightUnit = weightUnitRaw === 'lb' ? 'lb' : 'kg';

        return {
            featureSettings: raw?.featureSettings || raw?.features || {},
            tabOrder: tabOrderRaw,
            timezone: raw?.timezone || raw?.settings?.timezone || '',
            serverTime: raw?.serverTime || raw?.server_time || raw?.settings?.server_time || '',
            serverTimezone: raw?.serverTimezone || raw?.server_timezone || raw?.settings?.server_timezone || '',
            weightUnitPreference: weightUnit,
            foodTargets: {
                calories: Number(foodTargetsRaw.calories) || 0,
                carbs: Number(foodTargetsRaw.carbs) || 0,
                protein: Number(foodTargetsRaw.protein) || 0,
                fat: Number(foodTargetsRaw.fat) || 0,
            },
            bpReminderStatus: {
                ...bpReminderRaw,
                enabled: !!bpReminderRaw.enabled,
            },
            weightReminderStatus: {
                ...weightReminderRaw,
                enabled: !!weightReminderRaw.enabled,
            },
        };
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
            window.SettingsState.applyBootstrapFeatures(res.features);
            if (typeof window.updateFeatureTabVisibility === 'function') {
                window.updateFeatureTabVisibility();
            }
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
                    console.error('Failed to parse tab_order', e);
                    order = null;
                }
            }
            if (Array.isArray(order)) {
                if (typeof window.persistTabOrder === 'function') {
                    window.persistTabOrder(order);
                }
            } else if ('tab_order' in res.settings) {
                // Server returned settings with tab_order explicitly null/missing —
                // clear any stale localStorage fallback so a previous user's saved
                // order on this browser can't leak into the current session and a
                // server-side reset can actually restore the default layout.
                if (typeof window.clearPersistedTabOrder === 'function') {
                    window.clearPersistedTabOrder();
                }
            }
        }

        if (Array.isArray(res.medications)) {
            window.medications = res.medications;
            window.initialAuthLoad = true;
            if (window.MedTrackerDB?.MedicationStore) {
                await window.MedTrackerDB.MedicationStore.saveCache(window.medications);
            }
            await cacheApiSnapshot('medications', window.medications, ['medications']);
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
                statsRes: res.bp.stats || {},
            }, ['bp']);
        }

        if (res.weight) {
            await cacheApiSnapshot('weight', {
                logsRes: res.weight.logs || [],
                goalRes: res.weight.goal || {},
            }, ['weight']);
        }

        // Today's food log groups, scoped to the date the server computed in the
        // user's timezone. Mirroring BP/weight here is what makes the bootstrap-
        // advances-cursor-without-food race fixable: any external write that lands
        // before the next change-poll is now reflected in the cache as soon as
        // bootstrap returns, instead of being stranded behind the cursor.
        if (res.food && typeof res.food.date === 'string' && res.food.date.length > 0) {
            const groups = Array.isArray(res.food.groups) ? res.food.groups : [];
            await cacheApiSnapshot(`food_${res.food.date}_day`, { groups }, ['food']);
        }

        const settingsBundle = normalizeSettingsBundle({
            features: res.features || {},
            settings: res.settings || {},
            food_targets: res.settings?.food_targets,
            bp_reminder_status: res.settings?.bp_reminder_status,
            weight_reminder_status: res.settings?.weight_reminder_status,
        });
        // Reconcile the bundle's unit before caching: if this payload is a stale
        // SW BOOTSTRAP_UPDATED (server fetch pre-dates a successful local PATCH),
        // overwrite its unit with the locally-committed truth so loadSettings can't
        // later read the stale value back from the cache.
        const effectiveBootstrapUnit = window.WeightUnitState.applyAuthoritative(settingsBundle.weightUnitPreference);
        if (effectiveBootstrapUnit) {
            settingsBundle.weightUnitPreference = effectiveBootstrapUnit;
        }
        await cacheApiSnapshot('settings_bundle', settingsBundle, ['settings', 'food_targets', 'feature_settings']);

        return true;
    }

    // Background auth verification for non-blocking cached-auth path.
    // Fires /auth/status without blocking the UI. If the session has expired,
    // clears auth state and reloads so the user sees the login screen.
    function verifyAuthInBackground() {
        fetch('/auth/status', { method: 'GET', credentials: 'same-origin' })
            .then((res) => {
                if (res.status === 200) {
                    return res.json().then((data) => {
                        if (!data.authenticated) {
                            console.log('[Auth] Background check: session expired');
                            if (typeof window.clearAuthState === 'function') {
                                window.clearAuthState();
                            }
                            clearSwBootstrapCache().then(() => location.reload());
                        }
                    });
                } else if (res.status < 500) {
                    // 4xx (not server error) means auth is invalid
                    console.log('[Auth] Background check: auth invalid', res.status);
                    if (typeof window.clearAuthState === 'function') {
                        window.clearAuthState();
                    }
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
        return caches.keys().then((names) => {
            const dynamicName = names.find((n) => n.startsWith('medtracker-dynamic-'));
            if (!dynamicName) return;
            // ignoreSearch covers the tz query param now appended to /api/bootstrap.
            return caches.open(dynamicName).then((cache) =>
                cache.delete(new Request('/api/bootstrap'), { ignoreSearch: true })
            );
        }).catch(() => { /* best-effort */ });
    }

    // Build the /api/bootstrap URL with the client's timezone hint. The handler
    // uses this to scope today's food log groups it bundles into the response —
    // keeping the cache key the server writes (`food_<date>_day`) aligned with
    // the one loadToday() reads via todayFoodKey(new Date()).
    function bootstrapURL() {
        const tzName = (typeof Intl !== 'undefined' && Intl.DateTimeFormat
            && Intl.DateTimeFormat().resolvedOptions().timeZone) || '';
        if (tzName) return `/api/bootstrap?tz=${encodeURIComponent(tzName)}`;
        const tzOffset = new Date().getTimezoneOffset();
        return `/api/bootstrap?tz_offset=${tzOffset}`;
    }

    // Hydrate in-memory feature settings from a cached settings_bundle so deep-link
    // and start_param guards (isDeepLinkFeatureEnabled) see the user's real flags
    // on cache-only boot paths, not the default-on fallback. Also restores the
    // saved weight unit so Today/Weight render in the user's preferred unit
    // without waiting for a fresh bootstrap.
    function hydrateFeatureSettingsFromBundle(bundle) {
        if (!bundle || typeof bundle !== 'object') return;
        const cachedUnit = bundle.weightUnitPreference === 'lb'
            ? 'lb'
            : (bundle.weightUnitPreference === 'kg' ? 'kg' : null);
        if (cachedUnit) {
            window.WeightUnitState.applyAuthoritative(cachedUnit);
        }
        const cachedFeatures = bundle.featureSettings;
        if (!cachedFeatures || typeof cachedFeatures !== 'object') return;
        window.SettingsState.applyDexieFeatures(cachedFeatures);
    }

    // Cold-start preflight: seed DataStore with the previous session's
    // medications list from Dexie so any view that mounts before /api/bootstrap
    // resolves (offline relaunch, slow first response) renders planned doses
    // immediately. Gated on auth presence — Telegram initData OR a cached auth
    // state from a prior session — so a fully unauthenticated cold start does
    // not surface a former user's meds.
    async function hydrateMedicationsFromDexie() {
        if (!window.DataStore?.hydrateFromDexie) return;
        if (!window.MedTrackerDB?.MedicationStore?.loadCache) return;
        const hasAuthPresence = !!window.userInitData
            || (typeof window.getCachedAuthState === 'function' && !!window.getCachedAuthState());
        if (!hasAuthPresence) return;
        try {
            const result = await window.DataStore.hydrateFromDexie(
                'medications',
                () => window.MedTrackerDB.MedicationStore.loadCache(),
                { tags: ['medications'] }
            );
            if (result?.hydrated) {
                // Keep the let-scoped `medications` mirror in sync so feature
                // modules that read it directly (rather than via DataStore)
                // see the seeded list before bootstrap returns.
                const seeded = await window.DataStore.getCached('medications');
                if (Array.isArray(seeded)) {
                    window.medications = seeded;
                    window.initialAuthLoad = true;
                }
            }
        } catch (e) {
            // Hydration must not block the auth flow, but swallowing silently leaves
            // a diagnostic blind spot when IndexedDB itself is in a broken state
            // (quota, schema mismatch, private-mode block). Log once and continue.
            console.warn('[Hydrate] Dexie medications hydration failed', e);
        }
    }

    // Cold-start preflight for section-level api_cache keys (BP, Weight, Workouts,
    // Health, Food, Settings). Runs alongside hydrateMedicationsFromDexie so any
    // section that mounts before /api/bootstrap resolves can render its last-known
    // data immediately. Each entry hydrates DataStore.api_cache from the matching
    // ApiCache row in Dexie via DataStore.hydrateFromDexie. Hydration is a no-op
    // when Dexie is empty for the key, so safely covers first-run users too. Gated
    // on auth presence to avoid surfacing a former user's cache on a logged-out
    // cold start.
    async function hydrateSectionsFromDexie() {
        if (!window.DataStore?.hydrateFromDexie) return;
        const apiCache = window.MedTrackerDB?.ApiCache;
        if (!apiCache || typeof apiCache.getWithMeta !== 'function') return;
        const hasAuthPresence = !!window.userInitData
            || (typeof window.getCachedAuthState === 'function' && !!window.getCachedAuthState());
        if (!hasAuthPresence) return;
        // Each entry: { key, tags }. The Dexie loader is the same shape for every
        // entry — read the {data, timestamp} record by key from ApiCache. Tags
        // mirror what cacheApiSnapshot writes during the bootstrap apply path so
        // a later invalidateByTag evicts the hydrated row alongside fresh ones.
        const healthOverviewKey = window.healthOverviewCacheKey();
        const todayFoodCacheKey = typeof window.todayFoodKey === 'function'
            ? window.todayFoodKey(new Date())
            : null;
        const entries = [
            { key: 'bp', tags: ['bp'] },
            { key: 'weight', tags: ['weight'] },
            // Workout subtab caches — match the keys + tags features/workout.js
            // writes via loadSWR. workout_next also feeds Today's next-workout
            // tile so a cold-start offline relaunch paints it synchronously.
            { key: 'workout_next', tags: ['workout'] },
            { key: 'workout_history', tags: ['workout'] },
            { key: 'workout_groups', tags: ['workout'] },
            { key: 'workout_stats', tags: ['workout'] },
            { key: 'exercise_library', tags: ['exercise_library'] },
            // Vitals/Health Overview — TZ-qualified key (e.g. health_overview_Europe/Berlin).
            // The TZ fallback below handles the case where the current TZ has no
            // cached row but an older TZ does (user changed timezone offline).
            { key: healthOverviewKey, tags: ['health'] },
            // Diary notes — the actual cache key features/health.js writes via
            // loadSWR is 'diary_notes' (not 'health_notes'). Two tags so either a
            // notes mutation OR a health-wide invalidation evicts the row.
            { key: 'diary_notes', tags: ['notes', 'health-notes'] },
            // Settings bundle — the canonical key written by applyBootstrapPayload
            // (cacheApiSnapshot 'settings_bundle') and read by loadSettings()'
            // loadSWR. Hydrating it lets the Settings screen's onCached callback
            // paint toggles, food targets, reminder status, and weight-unit
            // segmented state synchronously on cold-start offline relaunch instead
            // of leaving the screen blank. The production Settings UI is owned
            // by loadSettings() in this file, keyed on 'settings_bundle'.
            { key: 'settings_bundle', tags: ['settings', 'food_targets', 'feature_settings'] },
        ];
        // Today's food daily-log — already read directly from ApiCache.getWithMeta
        // by _todayReadCaches() for the Today render, so the dashboard tile already
        // surfaces cached data on cold start. Hydration additionally seeds
        // DataStore's in-memory cache + tag index so any caller using
        // DataStore.getCached(`food_<today>_day`) resolves synchronously — and
        // cachedFetch's offline branch (loadFoodLogs in features/food.js) sees a
        // pre-warmed entry instead of triggering OfflineNoCacheError on the very
        // first paint after a cold-start-offline relaunch.
        if (todayFoodCacheKey) {
            entries.push({ key: todayFoodCacheKey, tags: ['food'] });
        }
        await Promise.all(entries.map(async ({ key, tags }) => {
            try {
                await window.DataStore.hydrateFromDexie(
                    key,
                    () => apiCache.getWithMeta(key),
                    { tags }
                );
            } catch (e) {
                console.warn('[Hydrate] Dexie section hydration failed', key, e);
            }
        }));

        // TZ-mismatch fallback for Vitals/Health Overview. If the current TZ key
        // has no cached row (user changed timezone since the last sync, or the
        // device clock jumped to a TZ without prior data), look up the most
        // recently written health_overview_* entry and seed the current TZ key
        // with that data. The original (older) timestamp is preserved so the
        // stale chip surfaces the real age rather than "Updated just now".
        // Skip `health_overview_offset_<n>` rows when the current key is a real
        // IANA TZ key: an offset-keyed row is a geography-less fallback written
        // when Intl.DateTimeFormat returned no zone, and using it to seed an
        // IANA-keyed row would mislabel a numeric-offset bucket as that zone.
        try {
            const currentSeed = await window.DataStore.getCached(healthOverviewKey);
            if (currentSeed === null
                && typeof apiCache.findMostRecentByPrefix === 'function') {
                const currentIsOffsetKey = healthOverviewKey.startsWith('health_overview_offset_');
                const fallback = await apiCache.findMostRecentByPrefix('health_overview_', {
                    exclude: (key) => !currentIsOffsetKey && key.startsWith('health_overview_offset_'),
                });
                if (fallback && fallback.data) {
                    await apiCache.setWithMeta(healthOverviewKey, fallback.data, fallback.timestamp);
                    if (typeof window.DataStore.registerTags === 'function') {
                        window.DataStore.registerTags(healthOverviewKey, ['health']);
                    }
                }
            }
        } catch (e) {
            console.warn('[Hydrate] health_overview TZ fallback failed', e);
        }
    }

    return {
        cacheApiSnapshot,
        normalizeSettingsBundle,
        applyBootstrapPayload,
        verifyAuthInBackground,
        clearSwBootstrapCache,
        bootstrapURL,
        hydrateFeatureSettingsFromBundle,
        hydrateMedicationsFromDexie,
        hydrateSectionsFromDexie,
    };
})();

// Backwards-compatible globals. Existing tests and feature modules call
// these by name; the shims keep the contract while the implementation
// moves behind AuthBootstrap. cached-fetch.js looks up
// window.cacheApiSnapshot at call time, so the assignment below is what
// keeps its bootstrap-cache plumbing alive after the extraction.
window.cacheApiSnapshot = window.AuthBootstrap.cacheApiSnapshot;
window.normalizeSettingsBundle = window.AuthBootstrap.normalizeSettingsBundle;
window.applyBootstrapPayload = window.AuthBootstrap.applyBootstrapPayload;
window.verifyAuthInBackground = window.AuthBootstrap.verifyAuthInBackground;
window.clearSwBootstrapCache = window.AuthBootstrap.clearSwBootstrapCache;
window.bootstrapURL = window.AuthBootstrap.bootstrapURL;
window.hydrateFeatureSettingsFromBundle = window.AuthBootstrap.hydrateFeatureSettingsFromBundle;
window.hydrateMedicationsFromDexie = window.AuthBootstrap.hydrateMedicationsFromDexie;
window.hydrateSectionsFromDexie = window.AuthBootstrap.hydrateSectionsFromDexie;
