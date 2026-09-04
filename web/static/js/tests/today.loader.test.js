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
const WG_STALE_BADGE_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-stale-badge.js');
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
    window.eval(fs.readFileSync(WG_STALE_BADGE_JS, 'utf8'));

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
        it('paints the Today meds card from cached next_intake and mounts the offline stale chip', async () => {
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
            const medsCard = root.querySelector('.wg-today-meds');
            expect(medsCard).not.toBeNull();
            const names = Array.from(medsCard.querySelectorAll('.wg-today-meds__name')).map((n) => n.textContent);
            expect(names).toEqual(['Aspirin']);

            // Offline + a finite oldest-cache timestamp ⇒ the worst-case freshness
            // chip mounts with the offline tone.
            const badge = root.querySelector('.today-stale-badge-row .wg-stale-badge');
            expect(badge).not.toBeNull();
            expect(badge.classList.contains('wg-stale-badge--offline')).toBe(true);

            // Offline short-circuits the refetch loop entirely.
            expect(window.DataStore.fetchFresh).not.toHaveBeenCalled();
            expect(window.apiCall).not.toHaveBeenCalled();
        });

        it('renders the first-run placeholder (no meds card) when no cache exists at all', async () => {
            setOnline(window, false);
            window.MedTrackerDB = makeApiCache({}); // every key misses

            await window.loadToday();

            const root = env.document.getElementById('today-content');
            expect(root.querySelector('.today-empty-firstrun')).not.toBeNull();
            expect(root.querySelector('.wg-today-meds')).toBeNull();
            // Bot mode: no cache + navigator offline is a real "we never fetched
            // your day" situation, so the offline-framed first-run copy stands.
            expect(root.querySelector('.today-empty-firstrun').textContent)
                .toBe('Offline — reconnect to load your day');
        });

        // med-eas.81 — `state.__offline` (offline AND the Today cache older than
        // FRESHNESS_MS) is a BOT-MODE concept: data fetched from a server can
        // genuinely go stale behind a dead network. In CLOUD mode reads are
        // served from the local E2EE vault (web/cloud/js/apishim.js), which is
        // authoritative and always current regardless of connectivity — so a
        // flaky-wifi navigator.onLine=false must not make Today tell the user
        // their own data is stale. today-loader.js gates the flag centrally on
        // !window.__MEDTRACKER_CLOUD__, which transitively suppresses all three
        // of today.js's offline-framed strings without today.js knowing about
        // cloud mode at all. Sibling of med-eas.68 (the wg-stale-badge chip).
        it('bot mode renders the offline banner and the "unavailable offline" kicker on a stale cache', async () => {
            setOnline(window, false);
            const ts = Date.now() - 2 * 60 * 60 * 1000; // 2h old ⇒ past FRESHNESS_MS (1h)
            // settings_bundle present (so not firstRun) but next_intake missing
            // ⇒ the meds cell is `missing` and takes the kicker's offline branch.
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
            expect(root.querySelector('.today-empty-firstrun')).toBeNull();
            const banner = root.querySelector('.today-offline-banner');
            expect(banner).not.toBeNull();
            expect(banner.textContent).toBe('Offline — showing cached data');
            const kicker = root.querySelector('.wg-today-meds .wg-next-action-card__kicker');
            expect(kicker).not.toBeNull();
            expect(kicker.textContent).toBe('Next dose data unavailable offline');
        });

        it('cloud mode suppresses the offline banner and the "unavailable offline" kicker on a stale cache', async () => {
            window.__MEDTRACKER_CLOUD__ = true;
            setOnline(window, false);
            const ts = Date.now() - 2 * 60 * 60 * 1000; // same stale cache as the bot-mode case
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
            const kicker = root.querySelector('.wg-today-meds .wg-next-action-card__kicker');
            expect(kicker).not.toBeNull();
            // Normal (non-offline) copy — the vault simply has no scheduled dose.
            expect(kicker.textContent).toBe('No scheduled doses');
            expect(root.textContent).not.toContain('Offline —');
            expect(root.textContent).not.toContain('unavailable offline');
        });

        it('cloud mode renders the plain first-run copy when offline with no cache at all', async () => {
            window.__MEDTRACKER_CLOUD__ = true;
            setOnline(window, false);
            window.MedTrackerDB = makeApiCache({}); // every key misses

            await window.loadToday();

            const root = env.document.getElementById('today-content');
            const firstRun = root.querySelector('.today-empty-firstrun');
            expect(firstRun).not.toBeNull();
            expect(firstRun.textContent).toBe('Connect to load your day');
            expect(root.textContent).not.toContain('Offline —');
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
});
