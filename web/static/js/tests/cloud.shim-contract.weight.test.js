// Plan 2026-07-05 cloud-c1, Task 7 — shim-mode contract run of the weight
// feature flows against web/domain/weight.js. Drives the real feature code
// (handleWeightSubmit / editWeightLog / _deleteWeightApi) through the real
// window.apiCall (core/api.js), which delegates to the cloud shim
// (web/cloud/js/apishim.js) instead of the network, including the
// `?replaces=` edit path. Additive suite — the original (network-mocked)
// features.weight.test.js keeps running unshimmed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    bmi, bmiBand, bmiBordersKg, calculateWeightTrend, createWeightDomain,
} from '../../../domain/weight.js';
import { allowConsoleNoise } from './helpers/setup.js';
import { computeReminderHorizon } from '../../../domain/reminders.js';
import { createInMemoryRecordsPort, loadCloudShimFrontendEnv } from './helpers/cloud-shim-harness.js';

function installApiCache(window, seed = {}) {
    const map = new Map(Object.entries(seed));
    window.MedTrackerDB = {
        ...(window.MedTrackerDB || {}),
        ApiCache: {
            async get(key) { return map.has(key) ? map.get(key) : null; },
            async set(key, value) { map.set(key, value); },
            async clear(key) { map.delete(key); },
            async keys(prefix) {
                const all = [...map.keys()];
                return typeof prefix === 'string' && prefix
                    ? all.filter((k) => k.startsWith(prefix))
                    : all;
            }
        },
        WeightStore: {
            getPending: async () => [],
            getRejected: async () => [],
            getAll: async () => [],
            confirmDelete: async () => undefined
        }
    };
    return map;
}

function daysAgoLocalInput(days, hour = 8) {
    const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hour)}:00`;
}

describe('cloud shim contract — weight flows (features/weight.js over web/domain/weight.js)', () => {
    let env;
    let cache;
    // handleWeightSubmit/_deleteWeightApi fire-and-forget their trailing
    // loadWeightLogs() refresh (not awaited — unlike bp.js's handleBPSubmit).
    // Mock the global so that stray call is a no-op, and drive the real
    // implementation explicitly via this saved reference so cache reads
    // right after a submit/delete are deterministic.
    let realLoadWeightLogs;

    function setupEnv(seedRecords, clock) {
        if (env) env.cleanup();
        env = loadCloudShimFrontendEnv({ seedRecords, ...clock });
        cache = installApiCache(env.window);
        env.window.loadToday = vi.fn();
        env.window.setWeightUnitPreference = vi.fn();
        env.window.SyncManager = { isOnline: true, updateStatus: () => {} };
        realLoadWeightLogs = env.window.loadWeightLogs;
        env.window.loadWeightLogs = vi.fn();
    }

    async function submitWeightLog(window, document, { daysAgo, weight, notes = '' }) {
        window.showWeightModal();
        document.getElementById('weight-datetime').value = daysAgoLocalInput(daysAgo);
        document.getElementById('weight-value').value = String(weight);
        document.getElementById('weight-notes').value = notes;
        await window.handleWeightSubmit({ preventDefault() {} });
        await realLoadWeightLogs();
    }

    beforeEach(() => {
        setupEnv();
    });

    afterEach(() => {
        vi.useRealTimers();
        env.cleanup();
        env = null;
    });

    it('save then list round-trips through the shim, trend seeded to the first weight', async () => {
        const { window, document } = env;
        await submitWeightLog(window, document, { daysAgo: 2, weight: 80.0 });

        const w = cache.get('weight');
        expect(w).toBeTruthy();
        expect(w.logsRes).toHaveLength(1);
        expect(w.logsRes[0].weight).toBe(80.0);
        expect(w.logsRes[0].weight_trend).toBe(calculateWeightTrend(80.0, null));
        expect(w.logsRes[0].weight_trend).toBe(80.0);
    });

    it('a second log computes the EMA trend against the first', async () => {
        const { window, document } = env;
        await submitWeightLog(window, document, { daysAgo: 2, weight: 80.0 });
        await submitWeightLog(window, document, { daysAgo: 1, weight: 79.0 });

        const w = cache.get('weight');
        const newest = w.logsRes.find((l) => l.weight === 79.0);
        expect(newest.weight_trend).toBeCloseTo(calculateWeightTrend(79.0, 80.0), 10);
    });

    it('getGoal merges a synced goal record with the highest-ever weight', async () => {
        // Goal-setting is not part of the ported HTTP surface (server only
        // exposes GET /api/weight/goal — internal/server/server.go:840), so
        // the goal record arrives via sync (recordsPort), not a POST call.
        const now = Date.now();
        const daysAgoIso = (days) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
        setupEnv({
            weight: [
                { recordId: 'w1', clientTs: now - 2, deleted: false, measured_at: daysAgoIso(2), weight: 82.0, weight_trend: 82.0, body_fat: null, muscle_mass: null, notes: '' },
                { recordId: 'w2', clientTs: now - 1, deleted: false, measured_at: daysAgoIso(1), weight: 79.0, weight_trend: 78.7, body_fat: null, muscle_mass: null, notes: '' }
            ],
            weightgoal: [{ recordId: 'g1', clientTs: now, deleted: false, set_at: new Date(now).toISOString(), target_weight: 75.0, target_date: null, start_weight: 82.0 }]
        });

        const getRes = await env.window.apiCall('/api/weight/goal');
        expect(getRes.goal).toBe(75.0);
        expect(getRes.highest_weight).toBe(82.0);
    });

    it('editing the latest log via ?replaces= excludes the replaced row from the trend calc', async () => {
        const { window, document } = env;
        await submitWeightLog(window, document, { daysAgo: 2, weight: 80.0 });
        const original = cache.get('weight').logsRes[0];

        window.editWeightLog(original);
        document.getElementById('weight-value').value = '81.0';
        document.getElementById('weight-datetime').value = daysAgoLocalInput(1);
        await window.handleWeightSubmit({ preventDefault() {} });
        await realLoadWeightLogs();

        const w = cache.get('weight');
        // The replaced row is gone — only the edited entry remains.
        expect(w.logsRes).toHaveLength(1);
        expect(w.logsRes[0].weight).toBe(81.0);
        // No prior trend survives the replace (the only earlier log was the
        // one just replaced), so the new entry seeds to its own weight —
        // exactly the weight_handlers.go:39-45 ?replaces= semantics.
        expect(w.logsRes[0].weight_trend).toBe(calculateWeightTrend(81.0, null));

        const listRes = await window.apiCall('/api/weight?days=0&limit=1000');
        expect(listRes).toHaveLength(1);
        expect(listRes[0].id).not.toBe(original.id);
    });

    it('PATCH /api/settings/weight-unit persists and is echoed by bootstrap (no 404 alert)', async () => {
        const { window } = env;
        // The Settings kg/lb toggle is always present in cloud mode; before the
        // shim mapped this route it fell through to the 404 path, which api.js
        // turns into a user-facing alert + reverted preference.
        const res = await window.apiCall('/api/settings/weight-unit', 'PATCH', { unit: 'lb' });
        expect(res).toEqual({ unit: 'lb' });

        const boot = await window.apiCall('/api/bootstrap');
        expect(boot.settings.weight_unit_preference).toBe('lb');
    });

    // Unmapped-route fallback behavior moved to
    // cloud.shim-contract.catchall.test.js (bd med-9b8.1) — unmapped writes now
    // throw instead of resolving null.

    // med-9bmb: same mechanism as BP (see cloud.shim-contract.bp.test.js) —
    // weighing in inside the app satisfies today's measure reminder, so the
    // Telegram chain the relay already sent has to end rather than sit in the
    // chat with live Snooze/Skip buttons.
    describe('logging a weight cancels the Telegram measure chain', () => {
        // Pinned clock: 18:30 UTC in UTC, so a 09:00 slot is past (sent) and a
        // 20:00 slot is still ahead (nothing to cancel).
        const NOW = Date.parse('2026-09-05T18:30:00Z');
        const PAST_HOUR = 9;
        const PAST_SLOT_UNIX = Date.parse('2026-09-05T09:00:00Z') / 1000;
        const FUTURE_HOUR = 20;

        let fetchMock;

        function withWeightPref(pref) {
            setupEnv(
                pref ? { weightreminderpref: [{ recordId: 'weightreminderpref', clientTs: 1, deleted: false, ...pref }] } : undefined,
                { now: () => NOW, timeZone: 'UTC' }
            );
            fetchMock = vi.fn().mockResolvedValue({ ok: true });
            globalThis.fetch = fetchMock;
        }

        function cancelCallbacks() {
            return fetchMock.mock.calls
                .filter(([url]) => url === '/api/telegram/cancel-refire')
                .map(([, init]) => JSON.parse(init.body).callback);
        }

        afterEach(() => {
            delete globalThis.fetch;
        });

        const log = (measuredAtMs = NOW) => ({
            weight: 80.0, measured_at: new Date(measuredAtMs).toISOString()
        });

        it('posts exactly one cancel-refire for the stem the horizon would have pushed', async () => {
            withWeightPref({ enabled: true, preferred_reminder_hour: PAST_HOUR });

            await env.window.apiCall('/api/weight', 'POST', log());

            expect(cancelCallbacks()).toEqual([`wt:${PAST_SLOT_UNIX}`]);
            const horizon = computeReminderHorizon({
                timeZone: 'UTC',
                now: NOW - 24 * 60 * 60 * 1000,
                weightStatus: { enabled: true, preferred_reminder_hour: PAST_HOUR }
            });
            expect(horizon.some((e) => e.callback === `wt:${PAST_SLOT_UNIX}`)).toBe(true);
        });

        it('does not cancel when today\'s slot has not fired yet', async () => {
            withWeightPref({ enabled: true, preferred_reminder_hour: FUTURE_HOUR });

            await env.window.apiCall('/api/weight', 'POST', log());

            expect(cancelCallbacks()).toEqual([]);
        });

        it('does not cancel for a log backdated past the 7d window', async () => {
            // Same reason as BP: a catch-up entry has not answered today's
            // reminder, and the message cannot be restored once deleted.
            withWeightPref({ enabled: true, preferred_reminder_hour: PAST_HOUR });

            await env.window.apiCall('/api/weight', 'POST', log(NOW - 9 * 24 * 60 * 60 * 1000));

            expect(cancelCallbacks()).toEqual([]);
        });

        // med-8tur.6: a DAILY weigh-in slot is satisfied only by a reading on its
        // own local day — yesterday's reading (inside the weekly 7d window) is not.
        it('daily cadence: cancels for a same-day reading, not for yesterday\'s', async () => {
            withWeightPref({ enabled: true, preferred_reminder_hour: PAST_HOUR, cadence: 'daily' });
            await env.window.apiCall('/api/weight', 'POST', log(NOW - 24 * 60 * 60 * 1000));
            expect(cancelCallbacks()).toEqual([]);

            withWeightPref({ enabled: true, preferred_reminder_hour: PAST_HOUR, cadence: 'daily' });
            await env.window.apiCall('/api/weight', 'POST', log(Date.parse('2026-09-05T07:00:00Z')));
            expect(cancelCallbacks()).toEqual([`wt:${PAST_SLOT_UNIX}`]);
        });

        it('does not cancel when weight reminders are disabled or unconfigured', async () => {
            withWeightPref({ enabled: false, preferred_reminder_hour: PAST_HOUR });
            await env.window.apiCall('/api/weight', 'POST', log());
            expect(cancelCallbacks()).toEqual([]);

            withWeightPref(null);
            await env.window.apiCall('/api/weight', 'POST', log());
            expect(cancelCallbacks()).toEqual([]);
        });
    });

    it('_deleteWeightApi removes the log from the shim-backed store', async () => {
        const { window, document } = env;
        await submitWeightLog(window, document, { daysAgo: 1, weight: 80.0 });
        const id = cache.get('weight').logsRes[0].id;

        await window._deleteWeightApi(id);
        await realLoadWeightLogs();

        expect(cache.get('weight').logsRes).toHaveLength(0);
        const listRes = await window.apiCall('/api/weight?days=0&limit=1000');
        expect(listRes).toHaveLength(0);
    });

    // med-8tur.3: the Weight tab goal card reads the Goal Line episode progress
    // (the same GET /api/gamification/goal-line Today renders), not lifetime
    // highest + latest raw reading; the frontend-regression prognosis is gone.
    it('goal card renders the Goal Line distance/progress; prognosis stays hidden on a preliminary line', async () => {
        // Pinned midday UTC: the Goal Line buckets readings by day, so the
        // window must not depend on the wall-clock time the suite runs at.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-05T12:00:00Z'));
        const now = Date.now();
        // Halfway into today (UTC), not a fixed hour back: from 00:00 to 01:00
        // UTC that put today's reading on yesterday and widened the ± range.
        const ago = (days) => new Date(now - days * 24 * 60 * 60 * 1000 - (now % 86400000) / 2).toISOString();
        const w = (id, days, weight) => ({ recordId: id, clientTs: 1, deleted: false, measured_at: ago(days), weight, weight_trend: weight, body_fat: null, muscle_mass: null, notes: '' });
        setupEnv({
            // A lifetime high of 95 a year ago: the legacy card measured from it.
            weight: [w('w0', 400, 95), w('w1', 6, 85), w('w2', 3, 84.4), w('w3', 0, 84)],
            weightgoal: [{ recordId: 'g1', clientTs: 1, deleted: false, set_at: ago(6), target_weight: 78, target_date: null, start_weight: 85 }],
        });
        const { window, document } = env;
        window.weightUnitPreference = 'kg';
        await realLoadWeightLogs();

        const line = (await window.apiCall('/api/gamification/goal-line')).goal;
        expect(line.status).toBe('preliminary');
        expect(line.distance_to_goal).toBe(6);
        expect(line.progress).toEqual({ done_kg: 1, total_kg: 7, fraction: 0.143 });

        const texts = [...document.querySelectorAll('.wg-weight-goal-card__delta')].map((n) => n.textContent);
        expect(texts).toContain('6.0 kg to goal');
        expect(texts).toContain('1.0 kg of 7.0 kg since your first reading');
        expect(texts).toContain('Current 84.0 kg'); // preliminary: a reading, no trend
        const fill = document.querySelector('.wg-weight-goal-card__fill');
        expect(fill.style.getPropertyValue('--fill-pct')).toBe('14.3%');
        expect(document.getElementById('weight-prognosis-card').hidden).toBe(true);
    });

    // med-8tur.7: the prognosis card renders goal.projected from the same
    // Goal Line payload — a date with a ± weeks range, or "more than a year",
    // or nothing at all.
    it('prognosis card shows the projected date ± weeks, "more than a year", or stays hidden', async () => {
        // Pinned midday UTC: the Goal Line buckets readings by day, so the
        // window must not depend on the wall-clock time the suite runs at.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-05T12:00:00Z'));
        const now = Date.now();
        // Halfway into today (UTC), not a fixed hour back: from 00:00 to 01:00
        // UTC that put today's reading on yesterday and widened the ± range.
        const ago = (days) => new Date(now - days * 24 * 60 * 60 * 1000 - (now % 86400000) / 2).toISOString();
        const seed = (perDay, target) => ({
            weight: Array.from({ length: 60 }, (_, d) => ({ recordId: `w${d}`, clientTs: 1, deleted: false, measured_at: ago(d), weight: 87 + perDay * d, weight_trend: null, body_fat: null, muscle_mass: null, notes: '' })),
            weightgoal: [{ recordId: 'g1', clientTs: 1, deleted: false, set_at: ago(30), target_weight: target, target_date: null, start_weight: 88.5 }],
        });
        const card = () => env.document.getElementById('weight-prognosis-card');

        setupEnv(seed(0.05, 80)); // steady 0.35 kg/week, 7.45 kg to go
        env.window.weightUnitPreference = 'kg';
        await realLoadWeightLogs();
        expect(card().hidden).toBe(false);
        expect(card().querySelector('.wg-weight-prognosis-card__label').textContent).toBe('Projected goal date');
        expect(card().querySelector('.wg-weight-prognosis-card__value').textContent).toMatch(/^Around .+ \u00b1 1 week$/);

        setupEnv(seed(0.01, 70)); // 0.07 kg/week toward a goal 17 kg away
        env.window.weightUnitPreference = 'kg';
        await realLoadWeightLogs();
        expect(card().hidden).toBe(false);
        expect(card().textContent).toContain('More than a year at this pace');

        setupEnv(seed(-0.05, 80)); // trending away from the goal: no guess
        env.window.weightUnitPreference = 'kg';
        await realLoadWeightLogs();
        expect(card().hidden).toBe(true);
        expect(card().textContent).toBe('');
    });

    it('setGoal rejects non-finite, non-positive and absurd targets', async () => {
        const records = createInMemoryRecordsPort({});
        const weight = createWeightDomain({ records, now: () => Date.now(), timeZone: 'UTC' });
        for (const bad of [0, -5, NaN, Infinity, '80', null, undefined, 5, 900]) {
            await expect(weight.setGoal({ target_weight: bad })).rejects.toMatchObject({ code: 'invalid_request' });
        }
        expect(await records.list('weightgoal')).toHaveLength(0);
        const ok = await weight.setGoal({ target_weight: 72.5 });
        expect(ok.goal).toBe(72.5);
    });

    // Epic med-a6fb (.1): BMI helpers + routes. ED-safe is decided by the route.
    describe('BMI', () => {
        it('pure helpers: 180 cm / 82.4 kg → 25.4 overweight, WHO borders', () => {
            expect(bmi(82.4, 180)).toBe(25.4);
            expect(bmiBand(25.4)).toBe('overweight');
            expect(bmiBordersKg(180)).toEqual([59.9, 81.0, 97.2, 113.4, 129.6]);
            expect([18.4, 18.5, 24.9, 25, 29.9, 30, 35, 40].map(bmiBand))
                .toEqual(['underweight', 'healthy', 'healthy', 'overweight', 'overweight', 'obesity_1', 'obesity_2', 'obesity_3']);
            // The rounded one-decimal BMI decides the class: 24.95 → 25.0 → overweight.
            expect(bmi(99.8, 200)).toBe(25);
            expect(bmiBand(bmi(99.8, 200))).toBe('overweight');
            expect(bmi(82.4, null)).toBeNull();
            expect(bmiBand(null)).toBeNull();
            expect(bmiBordersKg(undefined)).toBeNull();
        });

        const DEFAULT_BODY = { height_unit: 'cm', show_bmi: true, nudge_dismissed: false };
        const patchBody = (window, body) => window.apiCall('/api/settings/body', 'PATCH', body);
        const getBmi = (window) => window.apiCall('/api/weight/bmi');

        it('GET /api/weight/bmi: no height → bmi null + nudge; height + latest log → read-out; null clears', async () => {
            const { window, document } = env;
            await submitWeightLog(window, document, { daysAgo: 3, weight: 90 });
            await submitWeightLog(window, document, { daysAgo: 1, weight: 82.4 });

            // latest_kg is reported without a height: the Settings field's live hint.
            expect(await getBmi(window)).toEqual({
                height_cm: null, latest_kg: 82.4, bmi: null, band: null, borders_kg: null, ...DEFAULT_BODY, ed_safe: false, nudge: true,
            });

            expect(await patchBody(window, { height_cm: 180 })).toEqual({
                height_cm: 180, height_unit: 'cm', show_bmi: true, bmi_nudge_dismissed: false,
            });
            expect(await getBmi(window)).toEqual({
                height_cm: 180, latest_kg: 82.4, bmi: 25.4, band: 'overweight', borders_kg: [59.9, 81.0, 97.2, 113.4, 129.6],
                ...DEFAULT_BODY, ed_safe: false, nudge: false,
            });

            // Stored in whole cm.
            expect((await patchBody(window, { height_cm: 180.4 })).height_cm).toBe(180);

            await patchBody(window, { height_cm: null });
            expect((await getBmi(window)).height_cm).toBeNull();
            const general = (await env.records.list('settings')).find((r) => r.recordId === 'settings');
            expect(general).not.toHaveProperty('height_cm');
        });

        it('latest_kg is the newest log by measured_at, and null with no log', async () => {
            const { window, document } = env;
            await patchBody(window, { height_cm: 180 });
            expect(await getBmi(window)).toMatchObject({ latest_kg: null, bmi: null });
            await submitWeightLog(window, document, { daysAgo: 1, weight: 80 });
            await submitWeightLog(window, document, { daysAgo: 5, weight: 95 });
            expect(await getBmi(window)).toMatchObject({ latest_kg: 80, bmi: 24.7 });
        });

        it('a partial patch touches only the fields sent; show_bmi=false still reports bmi', async () => {
            const { window, document } = env;
            await submitWeightLog(window, document, { daysAgo: 1, weight: 82.4 });
            await patchBody(window, { height_cm: 180, height_unit: 'ftin' });
            await patchBody(window, { show_bmi: false });
            const res = await getBmi(window);
            expect(res).toMatchObject({ height_cm: 180, height_unit: 'ftin', show_bmi: false, bmi: 25.4, band: 'overweight' });
            await patchBody(window, { bmi_nudge_dismissed: true });
            expect(await getBmi(window)).toMatchObject({ height_cm: 180, height_unit: 'ftin', show_bmi: false, nudge_dismissed: true });
        });

        it('overlapping disjoint writes to the settings singleton keep every field', async () => {
            const { window } = env;
            await Promise.all([
                patchBody(window, { height_cm: 180 }),
                patchBody(window, { show_bmi: false }),
                patchBody(window, { height_unit: 'ftin' }),
                window.apiCall('/api/tz-suggestion/dismiss', 'POST', { detected_tz: 'Europe/Berlin' }),
            ]);
            expect(await getBmi(window)).toMatchObject({ height_cm: 180, show_bmi: false, height_unit: 'ftin' });
            expect((await window.apiCall('/api/settings')).dismissed_tz_suggestion).toBe('Europe/Berlin');
        });

        it('nudge turns off for height set, dismissed, show_bmi off and ED-safe', async () => {
            const { window } = env;
            expect((await getBmi(window)).nudge).toBe(true);
            await patchBody(window, { height_cm: 175 });
            expect((await getBmi(window)).nudge).toBe(false);
            await patchBody(window, { height_cm: null, bmi_nudge_dismissed: true });
            expect((await getBmi(window)).nudge).toBe(false);
            await patchBody(window, { bmi_nudge_dismissed: false, show_bmi: false });
            expect((await getBmi(window)).nudge).toBe(false);
            await patchBody(window, { show_bmi: true });
            expect((await getBmi(window)).nudge).toBe(true);
            await window.apiCall('/api/gamification/mode', 'PUT', { ed_safe: true });
            expect((await getBmi(window)).nudge).toBe(false);
        });

        it('PATCH /api/settings/body rejects invalid values and unknown keys, writing nothing', async () => {
            allowConsoleNoise();
            const { window } = env;
            const bad = [
                { height_cm: 99 }, { height_cm: 251 }, { height_cm: '180' }, { height_cm: NaN },
                { height_unit: 'in' }, { show_bmi: 'no' }, { bmi_nudge_dismissed: 1 }, { weight: 80 }, {},
                { height_cm: 180, show_bmi: 'no' },
            ];
            for (const body of bad) {
                await expect(patchBody(window, body)).rejects.toMatchObject({ code: 'invalid_request' });
            }
            expect((await getBmi(window)).height_cm).toBeNull();
        });

        it('ED-safe on (even with Journey off) → every value null, ed_safe true; weight summary omits BMI', async () => {
            const { window, document } = env;
            await submitWeightLog(window, document, { daysAgo: 1, weight: 82.4 });
            await patchBody(window, { height_cm: 180 });
            expect(await window.apiCall('/api/weight/goal')).toMatchObject({ height_cm: 180, bmi: 25.4, bmi_band: 'overweight' });
            await window.apiCall('/api/gamification/mode', 'PUT', { ed_safe: true });
            await window.apiCall('/api/settings/features/gamification', 'POST', { enabled: false });
            expect(await getBmi(window)).toEqual({
                height_cm: null, latest_kg: null, bmi: null, band: null, borders_kg: null, ...DEFAULT_BODY, ed_safe: true, nudge: false,
            });
            const summary = await window.apiCall('/api/weight/goal');
            for (const k of ['height_cm', 'bmi', 'bmi_band']) expect(summary).not.toHaveProperty(k);
        });

        it('GET /api/settings reports the body fields as stored, even under ED-safe', async () => {
            const { window } = env;
            expect(await window.apiCall('/api/settings')).toMatchObject({
                height_cm: null, height_unit: 'cm', show_bmi: true, bmi_nudge_dismissed: false,
            });
            await patchBody(window, { height_cm: 180, height_unit: 'ftin', bmi_nudge_dismissed: true });
            await window.apiCall('/api/gamification/mode', 'PUT', { ed_safe: true });
            const expected = { height_cm: 180, height_unit: 'ftin', show_bmi: true, bmi_nudge_dismissed: true };
            expect(await window.apiCall('/api/settings')).toMatchObject(expected);
            expect((await window.apiCall('/api/bootstrap')).settings).toMatchObject(expected);
        });

        it('weight summary (MCP health.weight.goal.read) omits BMI without height', async () => {
            const { window, document } = env;
            await submitWeightLog(window, document, { daysAgo: 1, weight: 82.4 });
            const summary = await window.apiCall('/api/weight/goal');
            expect(summary.highest_weight).toBe(82.4);
            for (const k of ['height_cm', 'bmi', 'bmi_band']) expect(summary).not.toHaveProperty(k);
        });
    });
});
