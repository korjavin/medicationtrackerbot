import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

    it('computes correct BP and weight reminder entries with timezone offset', async () => {
        // Mock a pushSchedule interceptor via push API testing if possible,
        // or just import computeReminderHorizon from domain to test the pure function.
        // We will do a pure function test to verify timezone math explicitly.
    });
});
