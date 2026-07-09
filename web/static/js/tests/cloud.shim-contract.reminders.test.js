import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// push.js reaches the network + WebCrypto; the shim's reminder routes only need
// to prove they reach it. pushSchedule is what the (debounced) recompute would
// call, so stubbing both keeps this suite offline.
vi.mock('../../../cloud/js/push.js', () => ({
    pushSchedule: vi.fn(async () => {}),
    sendTestPush: vi.fn(async () => {}),
}));
import { sendTestPush } from '../../../cloud/js/push.js';
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
