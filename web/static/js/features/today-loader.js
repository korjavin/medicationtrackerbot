// ==================== Today view loading orchestration ====================
// Extracted from app.js (Plan 2026-06-10 "finish-app-js-split", Task 3).
//
// This file owns the *impure* loading layer for the Today dashboard: reading
// every Today cache from IndexedDB (_todayReadCaches), feeding the pure
// aggregator/renderer in features/today.js (window.TodayDashboard) via
// _todayRender, and the loadToday() refetch loop that revalidates each cache
// and re-renders. features/today.js stays a pure, side-effect-free contract
// (zero module-level state); this file is its orchestration shell.
//
// These functions remain global (script-tag loading) and rely on app.js +
// sibling globals at call time: apiCall, apiCallDirect, readPersistedTabOrder,
// window.DataStore, window.MedTrackerDB, window.TodayDashboard,
// window.MedicationUtils, window.WeightUnitState, window.cachedFetch,
// window.OfflineNoCacheError, window.featureSettings, window.featureSettingsLoaded,
// window.AppStore, window.weightUnitPreference. switchTab()/reloadCurrentTab()
// (app.js) call loadToday() by bare name, resolved at call time.
//
// Shared helpers used outside the Today view keep their original global names:
// window.healthOverviewCacheKey (health.js, auth-bootstrap.js), todayFoodKey
// (food/*.js, auth-bootstrap.js), fetchNextIntakePayload (meds-history.js),
// and fetchSettingsBundle (tests). Public surface is mirrored on
// window.TodayLoader for discoverability; the bare function names are the live
// call path.

// module-state: the Today subscription handle (unsubscribe), the refetch
// in-flight guard (refreshInFlight) that coalesces concurrent loadToday() runs,
// and the wall-clock repaint interval handle (repaintTick).
let _todayLoaderState = { unsubscribe: null, refreshInFlight: false, repaintTick: null }; // module-state: Today subscription handle + refetch in-flight guard + repaint tick handle

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
        },
        gamification_rings: {
            feature: 'gamification',
            tags: ['gamification'],
            // Slim Today payload: { enabled, level, today_hp, rings:[{ring,hp}] }.
            // apiCall returns null on failure so fetchFresh leaves the cache alone.
            fetch: () => apiCall('/api/gamification/rings', 'GET')
        }
    };
}

// Shared settings-bundle fetcher — used by Today's refetch loop so that
// invalidations of `settings_bundle` re-hydrate food_targets and cross-device
// feature flags even when the user never opens the Settings tab.
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
            const keys = ['settings_bundle', 'next_intake', 'medications', 'bp', 'weight', 'workout_next', hoKey, foodKey, 'gamification_rings'];
            const metas = await Promise.all(keys.map(readMeta));
            const [bundleM, nextIntakeM, medsM, bpM, weightM, workoutM, healthM, foodM, gamM] = metas;
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
            if (gamM?.data) swrCaches.gamification_rings = gamM.data;
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
                [foodKey]: 'food',
                gamification_rings: 'gamification'
            };
            for (let i = 0; i < keys.length; i++) {
                const m = metas[i];
                if (!m) continue;
                trackTs(m.timestamp, { includeInOldest: isFeatureOn(keyFeatures[keys[i]]) });
            }
        } else if (window.DataStore && typeof window.DataStore.getCached === 'function') {
            const keys = ['settings_bundle', 'next_intake', 'medications', 'bp', 'weight', 'workout_next', hoKey, foodKey, 'gamification_rings'];
            const [bundle, nextIntake, meds, bp, weight, workout, health, food, gam] = await Promise.all(
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
            if (gam) swrCaches.gamification_rings = gam;
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
    // `__offline` drives the three offline-framed strings in today.js (the meds
    // kicker "Next dose data unavailable offline", the "Offline — showing cached
    // data" banner, and the firstRun "Offline — reconnect to load your day").
    // All three are BOT-MODE concepts: data fetched from a server can genuinely
    // go stale behind a dead network. In CLOUD mode reads are served from the
    // local E2EE vault via web/cloud/js/apishim.js — authoritative and always
    // current regardless of connectivity — so a flaky-wifi navigator.onLine=false
    // must not make Today claim the user's own data is stale. Gate centrally
    // here (the impure loader shell) rather than at each call site, mirroring
    // how wg-stale-badge.js suppresses the freshness chip in cloud mode; that
    // keeps today.js a pure, env-free render contract.
    if (!window.__MEDTRACKER_CLOUD__
        && window.TodayDashboard.isOfflineStale({ online, cacheTimestamp: latestCacheTimestamp, now: nowMs })) {
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

// Today is full of time-derived UI that no data change ever invalidates: the
// "in Xh Ym" next-dose kicker, the timezone-transition card past its last step,
// dose-boundary states. Nothing dispatches an event when the wall clock simply
// moves, so a tab left open keeps painting the past. One minute-ish tick
// re-renders from the caches already in hand — _todayRender, never loadToday,
// so a tick can never trigger a refetch (revalidation stays event-driven).
const TODAY_REPAINT_INTERVAL_MS = 60 * 1000;

async function loadToday() {
    const foodKey = todayFoodKey(new Date());
    const ctx = await _todayRender(foodKey);
    if (!ctx.rendered) return;

    if (!_todayLoaderState.unsubscribe && typeof window.TodayDashboard.subscribe === 'function') {
        _todayLoaderState.unsubscribe = window.TodayDashboard.subscribe({
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

    // Wall-clock repaint tick — see TODAY_REPAINT_INTERVAL_MS above. Set up once
    // alongside the subscription and kept for the life of the page (the
    // subscription is never torn down either). Inert while the tab is hidden or
    // another tab is current; the visibilitychange re-render covers the ticks a
    // backgrounded tab's throttled timers slept through. The food key is
    // recomputed per tick so a repaint across midnight reads the new day.
    if (!_todayLoaderState.repaintTick) {
        const repaint = () => {
            if (typeof document !== 'undefined' && document.hidden) return;
            if (!window.AppStore || window.AppStore.get('currentTab') !== 'today') return;
            _todayRender(todayFoodKey(new Date()));
        };
        _todayLoaderState.repaintTick = setInterval(repaint, TODAY_REPAINT_INTERVAL_MS);
        document.addEventListener('visibilitychange', repaint);
    }

    // Refetch any cache that's missing — e.g. just evicted by a change poll.
    // Without this, a local mutation that clears next_intake would leave Today
    // showing "missing" until the user navigates away and back. fetchFresh
    // also registers tags so future invalidations work correctly.
    if (!ctx.online || _todayLoaderState.refreshInFlight || !window.DataStore) return;
    const specs = todayFetchSpecs(foodKey);
    _todayLoaderState.refreshInFlight = true;
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
            [foodKey]: !!swrCaches.food_today,
            gamification_rings: !!swrCaches.gamification_rings
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
        _todayLoaderState.refreshInFlight = false;
    }
    if (window.AppStore && window.AppStore.get('currentTab') === 'today') {
        await _todayRender(foodKey);
    }
}

// Public surface mirror for discoverability. The bare function names above are
// the live call path: app.js switchTab()/reloadCurrentTab() call loadToday();
// food/*.js + auth-bootstrap.js call todayFoodKey()/loadToday(); health.js +
// auth-bootstrap.js call window.healthOverviewCacheKey(); meds-history.js calls
// fetchNextIntakePayload(); tests reach fetchSettingsBundle() by name.
window.TodayLoader = {
    loadToday,
    fetchNextIntakePayload,
    loadNextIntakeCached,
    fetchSettingsBundle,
    todayFetchSpecs,
    todayFoodKey,
    healthOverviewCacheKey,
    _todayRender,
    _todayReadCaches
};
