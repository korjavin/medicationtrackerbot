// Today view loading orchestration — features/today-loader.js (Plan 2026-06-10
// finish-app-js-split, Task 3). The loader is the *impure* shell around the
// pure features/today.js (window.TodayDashboard) contract: it reads every
// Today cache from IndexedDB, feeds the aggregator/renderer, and runs the
// refetch loop. These tests load today.js + today-loader.js together (mirroring
// the sibling today.*.test.js standalone pattern) with stubbed DataStore /
// MedTrackerDB / apiCall, and exercise:
//   1. offline render straight from caches,
//   2. the refetch in-flight guard coalescing concurrent loadToday() calls,
//   3. the next-intake fetch error paths (204 sentinel, OfflineNoCacheError,
//      generic-error rethrow, cachedFetch-absent fallback),
//   4. the wall-clock repaint tick (bd med-pn8g) that keeps time-derived UI
//      from going stale on a Today tab left open with no data changes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const EMPTY_STATE_JS = path.join(REPO_ROOT, 'web/static/js/components/empty-state.js');
const WG_ICONS_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-icons.js');
const WG_SPARKLINE_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-sparkline.js');
const TODAY_JS = path.join(REPO_ROOT, 'web/static/js/features/today.js');
const TODAY_LOADER_JS = path.join(REPO_ROOT, 'web/static/js/features/today-loader.js');

const FEATURES_MED_ONLY = {
    medication: true, bp: false, weight: false, food: false, workout: false, health: false
};

function makeDeferred() {
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    return { promise, resolve };
}

function setOnline(window, value) {
    Object.defineProperty(window.navigator, 'onLine', { value, configurable: true });
}

// A minimal MedTrackerDB.ApiCache.getWithMeta backed by a plain map of
// key → { data, timestamp }. Unlisted keys resolve to null (cache miss).
function makeApiCache(entries) {
    return {
        ApiCache: {
            getWithMeta: async (key) => (Object.prototype.hasOwnProperty.call(entries, key) ? entries[key] : null)
        }
    };
}

function loadLoaderEnv() {
    const dom = new JSDOM('<!DOCTYPE html><html><body><div id="today-content"></div></body></html>', {
        url: 'https://example.test/',
        pretendToBeVisual: true,
        runScripts: 'outside-only'
    });
    const { window } = dom;

    // Component dependencies the renderer reaches at draw time.
    window.eval(fs.readFileSync(EMPTY_STATE_JS, 'utf8') + '\nwindow.createEmptyState = createEmptyState;');
    window.eval(fs.readFileSync(WG_ICONS_JS, 'utf8'));
    window.eval(fs.readFileSync(WG_SPARKLINE_JS, 'utf8'));

    // Globals the loader resolves by bare name (normally provided by app.js +
    // sibling feature modules). Stubbed to no-ops/defaults so each test can
    // override the cache + fetch surfaces it cares about.
    window.apiCall = vi.fn(async () => null);
    window.readPersistedTabOrder = () => null;
    window.weightUnitPreference = 'kg';
    window.WeightUnitState = { applyAuthoritative: vi.fn() };
    window.MedicationUtils = { getNextScheduledDate: () => null, parseMedicationSchedule: () => null };
    window.AppStore = { get: () => 'today' };
    window.featureSettings = { ...FEATURES_MED_ONLY };
    window.featureSettingsLoaded = true;
    window.DataStore = {
        registerTags: vi.fn(),
        getCached: vi.fn(async () => null),
        fetchFresh: vi.fn(async () => null)
    };
    window.MedTrackerDB = makeApiCache({});

    window.eval(fs.readFileSync(TODAY_JS, 'utf8'));
    window.eval(fs.readFileSync(TODAY_LOADER_JS, 'utf8') + `\n//# sourceURL=file://${TODAY_LOADER_JS}`);

    return {
        window,
        document: window.document,
        cleanup: () => dom.window.close()
    };
}

describe('Today loader — features/today-loader.js', () => {
    let env;
    let window;
    beforeEach(() => { env = loadLoaderEnv(); window = env.window; });
    afterEach(() => { env.cleanup(); });

    describe('loadToday renders from caches offline', () => {
        it('paints the Today meds card from cached next_intake with no refetch', async () => {
            setOnline(window, false);
            const ts = Date.now() - 10 * 60 * 1000; // cached 10 min ago
            const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
            window.MedTrackerDB = makeApiCache({
                settings_bundle: {
                    data: {
                        featureSettings: { ...FEATURES_MED_ONLY },
                        foodTargets: { calories: 0, carbs: 0, protein: 0, fat: 0 },
                        tabOrder: ['today', 'meds'],
                        weightUnitPreference: 'kg'
                    },
                    timestamp: ts
                },
                next_intake: {
                    data: { scheduled_at: scheduledAt, medication_names: ['Aspirin'], medication_ids: [11] },
                    timestamp: ts
                }
            });

            await window.loadToday();

            const root = env.document.getElementById('today-content');
            const row = root.querySelector('[data-section="next-up"] [data-next="med"]');
            expect(row).not.toBeNull();
            expect(row.querySelector('.wg-row__title').textContent).toBe('Aspirin');
            // A cached start renders from cache — never the cold-start skeleton.
            expect(root.querySelector('.wg-skel')).toBeNull();

            // Offline short-circuits the refetch loop entirely.
            expect(window.DataStore.fetchFresh).not.toHaveBeenCalled();
            expect(window.apiCall).not.toHaveBeenCalled();
        });

        it('renders the offline first-run state (no Next up) when no cache exists at all', async () => {
            setOnline(window, false);
            window.MedTrackerDB = makeApiCache({}); // every key misses

            await window.loadToday();

            const root = env.document.getElementById('today-content');
            expect(root.querySelector('[data-section="next-up"]')).toBeNull();
            expect(root.querySelector('.wg-skel')).toBeNull();
            expect(root.querySelector('.wg-empty__title').textContent).toBe('No cached data yet');
        });

        it('cloud mode suppresses the offline banner and the "unavailable offline" kicker on a stale cache', async () => {
            window.__MEDTRACKER_CLOUD__ = true;
            setOnline(window, false);
            const ts = Date.now() - 2 * 60 * 60 * 1000; // stale cache: banner/kicker stay in online copy
            window.MedTrackerDB = makeApiCache({
                settings_bundle: {
                    data: {
                        featureSettings: { ...FEATURES_MED_ONLY },
                        foodTargets: { calories: 0, carbs: 0, protein: 0, fat: 0 },
                        tabOrder: ['today', 'meds'],
                        weightUnitPreference: 'kg'
                    },
                    timestamp: ts
                }
            });

            await window.loadToday();

            const root = env.document.getElementById('today-content');
            expect(root.querySelector('.today-offline-banner')).toBeNull();
            const nextUp = root.querySelector('[data-section="next-up"]');
            expect(nextUp).not.toBeNull();
            // Normal (non-offline) copy — the vault simply has no scheduled dose.
            expect(nextUp.querySelector('.wg-empty__title').textContent).toBe('Nothing scheduled');
            expect(root.textContent).not.toContain('Offline —');
            expect(root.textContent).not.toContain('unavailable offline');
        });

        it('cloud mode renders the shared offline first-run state when offline with no cache at all', async () => {
            window.__MEDTRACKER_CLOUD__ = true;
            setOnline(window, false);
            window.MedTrackerDB = makeApiCache({}); // every key misses

            await window.loadToday();

            const root = env.document.getElementById('today-content');
            expect(root.querySelector('.wg-empty__title').textContent).toBe('No cached data yet');
            expect(root.textContent).not.toContain('Offline —');
        });
    });

    // Kit T6: the skeleton shows only on a cold start (no cache of any kind)
    // while the first fetch is in flight; a refetch that still leaves nothing
    // turns into an error with Retry instead of an endless skeleton.
    describe('cold start (no cache, online)', () => {
        it('paints the skeleton first, then an error with Retry once the refetch settles empty', async () => {
            setOnline(window, true);
            window.MedTrackerDB = makeApiCache({}); // every key misses, fetches cache nothing
            const realRender = window.TodayDashboard.renderToday;
            const painted = [];
            window.TodayDashboard.renderToday = (state, root, opts) => {
                const out = realRender(state, root, opts);
                painted.push({
                    skeleton: !!root.querySelector('.wg-skel'),
                    error: !!root.querySelector('.wg-error'),
                    settled: opts.settled,
                    offline: opts.offline
                });
                return out;
            };

            await window.loadToday();

            expect(painted.length).toBe(2);
            expect(painted[0]).toEqual({ skeleton: true, error: false, settled: false, offline: false });
            expect(painted[1]).toEqual({ skeleton: false, error: true, settled: true, offline: false });
            const root = env.document.getElementById('today-content');
            const retry = root.querySelector('.wg-error .wg-btn');
            expect(retry.textContent).toBe('Retry');
        });

        it('a repaint while the first refetch is still in flight keeps the skeleton (no error flash)', async () => {
            setOnline(window, true);
            window.MedTrackerDB = makeApiCache({});
            const gate = makeDeferred();
            window.DataStore.fetchFresh = vi.fn(() => gate.promise); // first refetch never settles until released
            let tick = null;
            window.setInterval = (fn) => { tick = fn; return 42; };
            const realRender = window.TodayDashboard.renderToday;
            const painted = [];
            let signal = null;
            window.TodayDashboard.renderToday = (state, root, opts) => {
                const out = realRender(state, root, opts);
                painted.push({ skeleton: !!root.querySelector('.wg-skel'), error: !!root.querySelector('.wg-error') });
                if (signal) signal();
                return out;
            };

            const loading = window.loadToday();
            await vi.waitFor(() => expect(window.DataStore.fetchFresh).toHaveBeenCalled());
            const repainted = new Promise((resolve) => { signal = resolve; });
            tick();
            await repainted;
            expect(painted[painted.length - 1]).toEqual({ skeleton: true, error: false });

            signal = null;
            gate.resolve(null);
            await loading;
            expect(painted[painted.length - 1]).toEqual({ skeleton: false, error: true });
        });
    });

    // Next up's missed doses read the cached 24h intake history (history_1_,
    // the Meds badge's GET /api/history?days=1) and refetch it on every load.
    describe('missed doses from intake history', () => {
        it('renders a Missed row from cached history_1_ and refetches it online', async () => {
            setOnline(window, true);
            const ts = Date.now() - 60 * 1000;
            const slot = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
            window.MedTrackerDB = makeApiCache({
                settings_bundle: {
                    data: {
                        featureSettings: { ...FEATURES_MED_ONLY },
                        foodTargets: { calories: 0, carbs: 0, protein: 0, fat: 0 },
                        tabOrder: ['today', 'meds'],
                        weightUnitPreference: 'kg'
                    },
                    timestamp: ts
                },
                medications: { data: [{ id: 11, name: 'Aspirin' }], timestamp: ts },
                history_1_: {
                    data: [{ id: 'i1', medication_id: 11, scheduled_at: slot, status: 'PENDING' }],
                    timestamp: ts
                }
            });

            await window.loadToday();

            const root = env.document.getElementById('today-content');
            const row = root.querySelector('[data-section="next-up"] [data-next="med-missed"]');
            expect(row).not.toBeNull();
            expect(row.querySelector('.wg-row__title').textContent).toBe('Aspirin');
            expect(window.DataStore.fetchFresh).toHaveBeenCalledWith('history_1_', expect.any(Function), ['history', 'medications']);
            const spec = window.DataStore.fetchFresh.mock.calls.find((c) => c[0] === 'history_1_');
            await spec[1]();
            expect(window.apiCall).toHaveBeenCalledWith('/api/history?days=1');
        });
    });

    describe('refetch in-flight guard coalesces concurrent loadToday calls', () => {
        it('a second loadToday() while the first is refetching does not issue a duplicate next-intake fetch', async () => {
            setOnline(window, true);
            const ts = Date.now() - 10 * 60 * 1000;
            // settings_bundle present ⇒ bootstrap.settings set ⇒ Phase-1 refresh skipped.
            // Only `medication` is enabled, so the only refetch work is the
            // next-intake fetch (no cachedFetch ⇒ falls through to apiCall).
            window.MedTrackerDB = makeApiCache({
                settings_bundle: {
                    data: { featureSettings: { ...FEATURES_MED_ONLY }, foodTargets: {}, tabOrder: [], weightUnitPreference: 'kg' },
                    timestamp: ts
                },
                next_intake: {
                    data: { scheduled_at: new Date(Date.now() + 3600e3).toISOString(), medication_names: ['Aspirin'], medication_ids: [11] },
                    timestamp: ts
                }
            });

            const deferred = makeDeferred();
            let nextIntakeCalls = 0;
            window.apiCall = vi.fn(async (url) => {
                if (typeof url === 'string' && url.includes('/api/medications/next-intake')) {
                    nextIntakeCalls += 1;
                    return deferred.promise;
                }
                return null;
            });

            const p1 = window.loadToday();
            // Flush microtasks so p1 reaches the awaiting refetch with the
            // in-flight guard set before the second call starts.
            await new Promise((r) => setTimeout(r, 0));
            expect(nextIntakeCalls).toBe(1);

            const p2 = window.loadToday();
            await new Promise((r) => setTimeout(r, 0));
            // p2 short-circuited on the in-flight guard — no duplicate fetch.
            expect(nextIntakeCalls).toBe(1);

            deferred.resolve({ scheduled_at: null, medication_names: [] });
            await Promise.all([p1, p2]);
            expect(nextIntakeCalls).toBe(1);

            // The guard is released after the first refetch completes, so a
            // subsequent visit can refetch again.
            const p3 = window.loadToday();
            await new Promise((r) => setTimeout(r, 0));
            expect(nextIntakeCalls).toBe(2);
            deferred.resolve({ scheduled_at: null, medication_names: [] });
            await p3;
        });
    });

    // bd med-pn8g: Today is full of time-derived UI ("in Xh Ym", the tz
    // transition card, dose boundaries) that no data change ever invalidates.
    // loadToday installs a one-minute repaint tick that re-renders from the
    // caches already in hand. These tests capture the interval callback by
    // stubbing the JSDOM window's setInterval (vitest fake timers patch the
    // outer realm, not this nested window).
    describe('wall-clock repaint tick', () => {
        // Renders Today offline from a warm cache and returns the captured tick
        // callback plus a spy wrapping renderToday (installed after the first
        // render, so it only sees repaints).
        async function loadAndCaptureTick() {
            setOnline(window, false);
            const ts = Date.now() - 10 * 60 * 1000;
            window.MedTrackerDB = makeApiCache({
                settings_bundle: {
                    data: {
                        featureSettings: { ...FEATURES_MED_ONLY },
                        foodTargets: { calories: 0, carbs: 0, protein: 0, fat: 0 },
                        tabOrder: ['today', 'meds'],
                        weightUnitPreference: 'kg'
                    },
                    timestamp: ts
                },
                next_intake: {
                    data: {
                        scheduled_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                        medication_names: ['Aspirin'],
                        medication_ids: [11]
                    },
                    timestamp: ts
                }
            });

            let tick = null;
            let intervalMs = null;
            window.setInterval = (fn, ms) => { tick = fn; intervalMs = ms; return 42; };

            await window.loadToday();

            // Spy installed after the first render, so it only sees repaints.
            // `nextRender()` resolves on the next renderToday call: the tick
            // fires _todayRender without awaiting it, so there is no promise to
            // await and microtask-spinning would be flaky.
            const realRender = window.TodayDashboard.renderToday;
            let signal = null;
            const renderToday = vi.fn((state, root, opts) => {
                const out = realRender(state, root, opts);
                if (signal) signal();
                return out;
            });
            window.TodayDashboard.renderToday = renderToday;
            const nextRender = () => new Promise((resolve) => { signal = resolve; });
            return { tick, intervalMs, renderToday, nextRender };
        }

        it('re-renders about once a minute with a later now, without refetching', async () => {
            const { tick, intervalMs, renderToday, nextRender } = await loadAndCaptureTick();
            expect(typeof tick).toBe('function');
            expect(intervalMs).toBe(60 * 1000);

            // Advance the clock the loader reads so the repaint's `now` is
            // provably later than the initial render's.
            const realNow = window.Date.now;
            window.Date.now = () => realNow() + 90 * 60 * 1000;
            const painted = nextRender();
            tick();
            await painted;
            window.Date.now = realNow;

            expect(renderToday).toHaveBeenCalledTimes(1);
            expect(renderToday.mock.calls[0][2].now).toBeGreaterThan(realNow());
            // A tick repaints from cache only — revalidation stays event-driven.
            expect(window.DataStore.fetchFresh).not.toHaveBeenCalled();
            expect(window.apiCall).not.toHaveBeenCalled();
        });

        it('is inert while a voice call is connecting or live', async () => {
            const { tick, renderToday } = await loadAndCaptureTick();

            // A repaint mid-connect would swap the call card back to an idle
            // trigger the user can tap into a second session.
            window.WGCallAgent = { getState: () => ({ state: 'connecting' }) };
            tick();
            await new Promise((r) => setTimeout(r, 0));
            expect(renderToday).not.toHaveBeenCalled();

            window.WGCallAgent = { getState: () => ({ state: 'idle' }) };
            tick();
            await new Promise((r) => setTimeout(r, 0));
            expect(renderToday).toHaveBeenCalledTimes(1);
        });

        it('is inert while the tab is hidden or another tab is current', async () => {
            const { tick, renderToday } = await loadAndCaptureTick();

            Object.defineProperty(env.document, 'hidden', { value: true, configurable: true });
            tick();
            await new Promise((r) => setTimeout(r, 0));
            expect(renderToday).not.toHaveBeenCalled();

            Object.defineProperty(env.document, 'hidden', { value: false, configurable: true });
            window.AppStore = { get: () => 'meds' };
            tick();
            await new Promise((r) => setTimeout(r, 0));
            expect(renderToday).not.toHaveBeenCalled();
        });

        it('repaints on visibilitychange so a backgrounded tab is current again immediately', async () => {
            const { renderToday, nextRender } = await loadAndCaptureTick();

            const painted = nextRender();
            env.document.dispatchEvent(new window.Event('visibilitychange'));
            await painted;

            expect(renderToday).toHaveBeenCalledTimes(1);
        });
    });

    describe('next-intake payload fetch error paths', () => {
        it('fetchNextIntakePayload maps a 204 (apiCall → true) to the empty-state sentinel and null otherwise', async () => {
            window.apiCall = vi.fn(async () => true);
            expect(await window.fetchNextIntakePayload()).toEqual({ scheduled_at: null, medication_names: [] });

            window.apiCall = vi.fn(async () => null);
            expect(await window.fetchNextIntakePayload()).toBeNull();

            const payload = { scheduled_at: '2026-06-10T09:00:00Z', medication_names: ['A'] };
            window.apiCall = vi.fn(async () => payload);
            expect(await window.fetchNextIntakePayload()).toEqual(payload);
        });

        it('loadNextIntakeCached swallows OfflineNoCacheError to null but rethrows other errors', async () => {
            window.OfflineNoCacheError = class OfflineNoCacheError extends Error {};

            window.cachedFetch = vi.fn(async () => { throw new window.OfflineNoCacheError('offline'); });
            expect(await window.loadNextIntakeCached()).toBeNull();

            window.cachedFetch = vi.fn(async () => { throw new Error('boom'); });
            await expect(window.loadNextIntakeCached()).rejects.toThrow('boom');
        });

        it('loadNextIntakeCached falls back to fetchNextIntakePayload when cachedFetch is unavailable', async () => {
            delete window.cachedFetch;
            window.apiCall = vi.fn(async () => ({ scheduled_at: '2026-06-10T09:00:00Z', medication_names: ['A'] }));

            const result = await window.loadNextIntakeCached();
            expect(result.data).toEqual({ scheduled_at: '2026-06-10T09:00:00Z', medication_names: ['A'] });
            expect(result.isFromCache).toBe(false);
            expect(window.apiCall).toHaveBeenCalledWith('/api/medications/next-intake');
        });
    });

    // med-8tur.2: the Goal Line payload is day-relative (weighed_today, cta,
    // BP recorded today) and no tag fires at midnight, so a payload whose day
    // key (getGoalLine's `day`, bucketed in its `time_zone` — the pinned
    // settings timezone) is not today in that zone counts as missing.
    describe('Goal Line day-relative refetch', () => {
        const GAM_ONLY = { medication: false, bp: false, weight: true, food: false, workout: false, health: false, gamification: true };
        const dayIn = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
        function cacheWithGoalLine(day, timeZone) {
            return makeApiCache({
                settings_bundle: {
                    data: { featureSettings: { ...GAM_ONLY }, foodTargets: {}, tabOrder: [], weightUnitPreference: 'kg' },
                    timestamp: Date.now()
                },
                gamification_goal_line: {
                    data: { enabled: true, goal: { status: 'no_goal', coverage: {} }, workouts: { feature_on: false }, bp: { feature_on: false }, cta: 'weigh_in', day, time_zone: timeZone },
                    timestamp: Date.now()
                }
            });
        }
        const goalLineFetches = () => window.DataStore.fetchFresh.mock.calls.filter((c) => c[0] === 'gamification_goal_line');
        async function run(day, timeZone) {
            setOnline(window, true);
            window.featureSettings = { ...GAM_ONLY };
            window.MedTrackerDB = cacheWithGoalLine(day, timeZone);
            await window.loadToday();
        }

        it('refetches a Goal Line from an earlier day', async () => {
            await run('2000-01-01', null);
            expect(env.document.querySelector('[data-section="goal-line"]')).not.toBeNull();
            expect(goalLineFetches().length).toBe(1);
            expect(goalLineFetches()[0][2]).toEqual(['gamification', 'weight', 'workout', 'bp', 'settings', 'medications', 'history']);
        });

        it('keeps a Goal Line whose day is today in its pinned zone', async () => {
            await run(dayIn('Pacific/Kiritimati'), 'Pacific/Kiritimati');
            expect(goalLineFetches().length).toBe(0);
        });

        it('judges the day in the pinned zone, not the device zone', async () => {
            // UTC+14 vs UTC-11: their calendar days never coincide.
            await run(dayIn('Pacific/Pago_Pago'), 'Pacific/Kiritimati');
            expect(goalLineFetches().length).toBe(1);
        });
    });
});
