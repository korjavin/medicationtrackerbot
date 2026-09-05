import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// push.js reaches the network + WebCrypto; the shim's reminder routes only need
// to prove they reach it. pushSchedule is what the (debounced) recompute would
// call, so stubbing both keeps this suite offline.
vi.mock('../../../cloud/js/push.js', () => ({
    pushSchedule: vi.fn(async () => {}),
    sendTestPush: vi.fn(async () => {}),
}));
import { pushSchedule, sendTestPush } from '../../../cloud/js/push.js';
import { computeReminderEntries } from '../../../cloud/js/reminders.js';
import { loadCloudShimFrontendEnv, createInMemoryRecordsPort } from './helpers/cloud-shim-harness.js';
import { installApiShim } from '../../../cloud/js/apishim.js';

describe('cloud shim contract — reminders', () => {
    let env;

    function setupEnv(seedRecords = {}) {
        if (env) env.cleanup();
        env = loadCloudShimFrontendEnv({ seedRecords });
    }

    beforeEach(() => {
        setupEnv();
    });

    afterEach(() => {
        if (env) {
            env.cleanup();
            env = null;
        }
    });

    it('toggle then re-read status returns the saved value (both features)', async () => {
        const { window } = env;

        // BP
        let bpStatus = await window.offlineAwareApiCall('/api/bp/reminder/status', 'GET');
        expect(bpStatus.enabled).toBe(false);

        await window.offlineAwareApiCall('/api/bp/reminder/toggle', 'POST', { enabled: true });

        bpStatus = await window.offlineAwareApiCall('/api/bp/reminder/status', 'GET');
        expect(bpStatus.enabled).toBe(true);
        expect(bpStatus.preferred_reminder_hour).toBe(20);

        // Weight
        let weightStatus = await window.offlineAwareApiCall('/api/weight/reminder/status', 'GET');
        expect(weightStatus.enabled).toBe(false);

        await window.offlineAwareApiCall('/api/weight/reminder/toggle', 'POST', { enabled: true });

        weightStatus = await window.offlineAwareApiCall('/api/weight/reminder/status', 'GET');
        expect(weightStatus.enabled).toBe(true);
        expect(weightStatus.preferred_reminder_hour).toBe(9);
    });

    it('records port shows the singleton', async () => {
        const { window } = env;
        await window.offlineAwareApiCall('/api/bp/reminder/toggle', 'POST', { enabled: true });
        await window.offlineAwareApiCall('/api/weight/reminder/toggle', 'POST', { enabled: true });

        const bpStatus = await window.offlineAwareApiCall('/api/bp/reminder/status', 'GET');
        expect(bpStatus.enabled).toBe(true);
    });

    it('bootstrap payload reflects persisted prefs instead of constants', async () => {
        setupEnv({
            bpreminderpref: [{ recordId: 'bpreminderpref', clientTs: Date.now(), deleted: false, enabled: true, preferred_reminder_hour: 18 }],
            weightreminderpref: [{ recordId: 'weightreminderpref', clientTs: Date.now(), deleted: false, enabled: true, preferred_reminder_hour: 10 }]
        });

        const { window } = env;
        const bootstrap = await window.offlineAwareApiCall('/api/bootstrap', 'GET');

        expect(bootstrap.settings.bp_reminder_status.enabled).toBe(true);
        expect(bootstrap.settings.bp_reminder_status.preferred_reminder_hour).toBe(18);

        expect(bootstrap.settings.weight_reminder_status.enabled).toBe(true);
        expect(bootstrap.settings.weight_reminder_status.preferred_reminder_hour).toBe(10);
    });
});

// bd med-9b8.3 — the five reminder action routes. Before this, all five fell
// through the shim's catch-all: a Snooze tap did nothing (and, after med-9b8.1,
// threw). They now mutate the vault prefs the horizon reads.
describe('cloud shim contract — reminder actions (snooze / dontbug / test)', () => {
    let env;

    beforeEach(() => { env = loadCloudShimFrontendEnv(); });
    afterEach(() => { env.cleanup(); env = null; });

    it('snooze sets a mute window without disabling the reminder, and echoes bot-mode copy', async () => {
        const { window } = env;
        await window.offlineAwareApiCall('/api/bp/reminder/toggle', 'POST', { enabled: true });

        const before = Date.now();
        const res = await window.offlineAwareApiCall('/api/bp/reminder/snooze', 'POST');
        expect(res).toEqual({ status: 'success', message: 'BP reminder snoozed for 2 hours' });

        const status = await window.offlineAwareApiCall('/api/bp/reminder/status', 'GET');
        expect(status.enabled).toBe(true);
        expect(status.snoozed_until).toBeGreaterThanOrEqual(before + 2 * 60 * 60 * 1000);
    });

    it("dontbug mutes for 24h on both bp and weight, leaving enabled alone", async () => {
        const { window } = env;
        await window.offlineAwareApiCall('/api/bp/reminder/toggle', 'POST', { enabled: true });
        await window.offlineAwareApiCall('/api/weight/reminder/toggle', 'POST', { enabled: true });

        const before = Date.now();
        expect(await window.offlineAwareApiCall('/api/bp/reminder/dontbug', 'POST'))
            .toEqual({ status: 'success', message: 'BP reminders disabled for 24 hours' });
        expect(await window.offlineAwareApiCall('/api/weight/reminder/dontbug', 'POST'))
            .toEqual({ status: 'success', message: 'Weight reminders disabled for 24 hours' });

        const bp = await window.offlineAwareApiCall('/api/bp/reminder/status', 'GET');
        const weight = await window.offlineAwareApiCall('/api/weight/reminder/status', 'GET');
        for (const s of [bp, weight]) {
            expect(s.enabled).toBe(true);
            expect(s.dont_remind_until).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000);
        }
    });

    it('weight snooze echoes weight-specific copy', async () => {
        const { window } = env;
        expect(await window.offlineAwareApiCall('/api/weight/reminder/snooze', 'POST'))
            .toEqual({ status: 'success', message: 'Weight reminder snoozed for 2 hours' });
    });

    it('none of the four action routes fall through to the unmapped catch-all', async () => {
        const { window } = env;
        for (const path of [
            '/api/bp/reminder/snooze', '/api/bp/reminder/dontbug',
            '/api/weight/reminder/snooze', '/api/weight/reminder/dontbug',
        ]) {
            const res = await window.offlineAwareApiCall(path, 'POST');
            expect(res.status).toBe('success');
        }
    });
});

// med-eas.58 Task 5 — the weekly-digest horizon entry, wired in
// computeReminderEntries behind the weekly_digest + gamification both-on gate.
describe('cloud shim horizon — weekly digest entry', () => {
    // Mon Jun 15 2026, noon UTC → next Sunday 19:00 local (UTC) is Jun 21.
    const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
    const EXPECTED_FIRE = Date.UTC(2026, 5, 21, 19, 0, 0) / 1000;

    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
    afterEach(() => { vi.useRealTimers(); });

    const featuresRecord = (flags) => ({
        recordId: 'features', clientTs: NOW, deleted: false, flags,
    });

    it('emits one digest entry at next Sunday 19:00 when the toggle is on', async () => {
        const records = createInMemoryRecordsPort({ features: [featuresRecord({ weekly_digest: true })] });
        const entries = await computeReminderEntries({}, { records, timeZone: 'UTC' });
        const digests = entries.filter((e) => e.kind === 'digest');
        expect(digests).toHaveLength(1);
        expect(digests[0].fireAtUnix).toBe(EXPECTED_FIRE);
        expect(digests[0].callback).toBeUndefined();
        expect(digests[0].text).toContain('\u{1F5D3} Your week');
        // genericText must be name/data-free.
        expect(digests[0].genericText).toBe('Your weekly summary is ready');
    });

    it('emits no digest entry when the toggle is off (default)', async () => {
        const records = createInMemoryRecordsPort({});
        const entries = await computeReminderEntries({}, { records, timeZone: 'UTC' });
        expect(entries.filter((e) => e.kind === 'digest')).toHaveLength(0);
    });

    it('emits no digest entry when gamification is off (both-on gate)', async () => {
        const records = createInMemoryRecordsPort({
            features: [featuresRecord({ weekly_digest: true, gamification: false })],
        });
        const entries = await computeReminderEntries({}, { records, timeZone: 'UTC' });
        expect(entries.filter((e) => e.kind === 'digest')).toHaveLength(0);
    });
});

// med-eas.59 — workout reminders ride the workout feature flag (matching the
// bot's GetWorkoutEnabled gate), not a dedicated pref, so they must reach the
// uploaded horizon by default and vanish when the feature is off.
describe('cloud shim horizon — workout entry (feature-flag gate)', () => {
    // Mon Jun 15 2026, 06:00 UTC. Group scheduled 18:00 daily, 0 advance.
    const NOW = Date.UTC(2026, 5, 15, 6, 0, 0);
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
    afterEach(() => { vi.useRealTimers(); });

    const seed = () => ({
        workoutgroup: [{ recordId: 'g1', clientTs: NOW, deleted: false, id: 1, name: 'Push Day', active: true, is_rotating: false, days_of_week: '[0,1,2,3,4,5,6]', scheduled_time: '18:00', notification_advance_minutes: 0 }],
        workoutvariant: [{ recordId: 'v1', clientTs: NOW, deleted: false, id: 10, group_id: 1, name: 'Variant A', rotation_order: 0 }],
    });

    it('emits workout entries by default (workout feature on)', async () => {
        const records = createInMemoryRecordsPort(seed());
        const entries = await computeReminderEntries({}, { records, timeZone: 'UTC' });
        const workout = entries.filter((e) => e.kind === 'workout');
        expect(workout.length).toBeGreaterThan(0);
        expect(workout[0].text).toContain('Push Day - Variant A');
    });

    it('emits no workout entries when the workout feature is off', async () => {
        const records = createInMemoryRecordsPort({
            ...seed(),
            features: [{ recordId: 'features', clientTs: NOW, deleted: false, flags: { workout: false } }],
        });
        const entries = await computeReminderEntries({}, { records, timeZone: 'UTC' });
        expect(entries.filter((e) => e.kind === 'workout')).toHaveLength(0);
    });
});

// Codex parity finding — the workout-horizon-affecting writes must trigger a
// debounced recompute+push, like the group / session-status routes already do.
// Without it, an edited variant/exercise leaves stale queued reminder text, a
// rotation init leaves the wrong variant queued, and deleting a planned session
// leaves its already-uploaded reminder in the relay until an unrelated recompute.
describe('cloud shim — workout mutations re-push the horizon', () => {
    let env;
    // 2000ms shim debounce (reminders.js DEBOUNCE_MS) + microtask flush.
    const flush = async () => { await vi.advanceTimersByTimeAsync(2100); };

    // Fixed clock so the scheduled-session date below is unambiguously future.
    const NOW = Date.UTC(2026, 5, 15, 6, 0, 0);
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); pushSchedule.mockClear(); env = loadCloudShimFrontendEnv(); });
    afterEach(() => { env.cleanup(); env = null; vi.useRealTimers(); });

    async function seedGroupVariant(window) {
        const group = await window.offlineAwareApiCall('/api/workout/groups/create', 'POST', {
            name: 'Push Day', is_rotating: false, days_of_week: '[0,1,2,3,4,5,6]', scheduled_time: '18:00',
        });
        const variant = await window.offlineAwareApiCall('/api/workout/variants/create', 'POST', {
            group_id: group.id, name: 'Variant A', rotation_order: 0,
        });
        return { group, variant };
    }

    it('variant create/update/delete each schedule a recompute+push', async () => {
        const { window } = env;
        const { variant } = await seedGroupVariant(window);
        await flush();
        expect(pushSchedule).toHaveBeenCalled();

        pushSchedule.mockClear();
        await window.offlineAwareApiCall('/api/workout/variants/update?id=' + variant.id, 'PUT', { name: 'Variant B' });
        await flush();
        expect(pushSchedule).toHaveBeenCalledTimes(1);

        pushSchedule.mockClear();
        await window.offlineAwareApiCall('/api/workout/variants/delete?id=' + variant.id, 'DELETE');
        await flush();
        expect(pushSchedule).toHaveBeenCalledTimes(1);
    });

    it('exercise create/update/delete each schedule a recompute+push', async () => {
        const { window } = env;
        const { variant } = await seedGroupVariant(window);
        await flush();

        pushSchedule.mockClear();
        const ex = await window.offlineAwareApiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variant.id, name: 'Bench', order_index: 0,
        });
        await flush();
        expect(pushSchedule).toHaveBeenCalledTimes(1);

        pushSchedule.mockClear();
        await window.offlineAwareApiCall('/api/workout/exercises/update?id=' + ex.id, 'PUT', { name: 'Incline Bench' });
        await flush();
        expect(pushSchedule).toHaveBeenCalledTimes(1);

        pushSchedule.mockClear();
        await window.offlineAwareApiCall('/api/workout/exercises/delete?id=' + ex.id, 'DELETE');
        await flush();
        expect(pushSchedule).toHaveBeenCalledTimes(1);
    });

    it('deleting a session schedules a recompute+push', async () => {
        const { window } = env;
        const { group } = await seedGroupVariant(window);
        const scheduled = await window.offlineAwareApiCall('/api/workout/sessions/schedule', 'POST', {
            group_id: group.id, scheduled_date: '2026-06-20', scheduled_time: '18:00',
            exercises: [{ exercise_name: 'Bench', target_sets: 3, target_reps_min: 5 }],
        });
        const sid = (scheduled && scheduled.id) || (scheduled && scheduled.session && scheduled.session.id);
        await flush();

        pushSchedule.mockClear();
        await window.offlineAwareApiCall('/api/workout/sessions/delete?id=' + sid, 'DELETE');
        await flush();
        expect(pushSchedule).toHaveBeenCalledTimes(1);
    });
});

// The bot-mode /api/bp/reminder/test route fans a BP card out through every
// notifier. Cloud has no server-side notifier, so the shim maps it onto the
// encrypted this-device-only push the Settings test button already uses.
describe('cloud shim contract — POST /api/bp/reminder/test', () => {
    let env;

    beforeEach(() => { sendTestPush.mockClear(); env = loadCloudShimFrontendEnv(); });
    afterEach(() => { env.cleanup(); env = null; });

    it('sends a this-device test push and reports bot-mode {status:"sent"}', async () => {
        const res = await env.window.offlineAwareApiCall('/api/bp/reminder/test', 'POST');
        expect(sendTestPush).toHaveBeenCalledTimes(1);
        expect(res).toEqual({ status: 'sent' });
    });

    it('propagates a failing test push instead of reporting success', async () => {
        sendTestPush.mockRejectedValueOnce(new Error('Enable push notifications on this device first.'));
        await expect(env.window.offlineAwareApiCall('/api/bp/reminder/test', 'POST'))
            .rejects.toThrow(/Enable push notifications/);
    });
});

// bd med-7ujt — cloud-boot.js and the inbox drain both call recomputeAndPush(ctx)
// with no zone at all, so the horizon (pure wall-clock output) has to resolve a
// pinned settings.timezone itself rather than trusting the device zone.
describe('cloud shim horizon — pinned settings.timezone', () => {
    // 13:00 in Berlin, 21:00 in Tokyo — past the 20:00 BP slot in Tokyo but not
    // in Berlin, so the two zones disagree on the DAY as well as the instant.
    const NOW = Date.UTC(2026, 2, 10, 12, 0, 0);

    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
    afterEach(() => { vi.useRealTimers(); });

    const bpPref = {
        recordId: 'bpreminderpref', clientTs: NOW, deleted: false, enabled: true, preferred_reminder_hour: 20
    };
    const pinned = (timezone) => ({
        recordId: 'settings', clientTs: NOW, deleted: false, timezone
    });
    const firstBPFire = (entries) => {
        const bp = entries.filter((e) => e.kind === 'bp');
        expect(bp.length).toBeGreaterThan(0);
        return new Date(bp[0].fireAtUnix * 1000).toISOString();
    };

    it('fires the 20:00 BP slot in the pinned zone, not the caller/device zone', async () => {
        const records = createInMemoryRecordsPort({ bpreminderpref: [bpPref], settings: [pinned('Asia/Tokyo')] });
        const entries = await computeReminderEntries({}, { records, timeZone: 'Europe/Berlin' });
        // 20:00 JST is 11:00Z year-round (Japan has no DST); today's already
        // passed, so the next slot is tomorrow's.
        expect(firstBPFire(entries)).toBe('2026-03-11T11:00:00.000Z');
    });

    it('falls back to the caller/device zone when nothing is pinned', async () => {
        const records = createInMemoryRecordsPort({ bpreminderpref: [bpPref] });
        const entries = await computeReminderEntries({}, { records, timeZone: 'Europe/Berlin' });
        // 20:00 CET (March, pre-DST) is 19:00Z, still ahead of NOW.
        expect(firstBPFire(entries)).toBe('2026-03-10T19:00:00.000Z');
    });
});
