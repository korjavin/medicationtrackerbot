// Plan 2026-07-06 cloud-push-notifications-settings, Task 5. Guards the
// cloud-only Notifications block wired in features/settings.js
// (bindCloudNotifications) against: the server block staying hidden in
// server mode, the cloud block un-hiding + wiring Enable/Disable/Test in
// cloud mode, and the real (non-mocked) sendTestPush/pushSchedule chain
// preserving the real reminder entries when it appends the test entry
// (PUT /api/push/schedule is replace-all — see web/cloud/js/reminders.js).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

// settings.js dynamic-imports '/js/push.js' + '/js/reminders.js' via
// loadCloudPushModule()/loadCloudRemindersModule() — bare global functions
// (classic script, no module system) evaluated into the jsdom window, so
// overriding window.loadCloudPushModule/window.loadCloudRemindersModule
// after loadFrontendEnv() replaces what bindCloudNotifications's internal
// bare calls resolve to, without needing jsdom to satisfy a real import().
function stubCloudModules(window, { push, reminders }) {
    window.loadCloudPushModule = () => Promise.resolve(push);
    window.loadCloudRemindersModule = () => Promise.resolve(reminders);
}

describe('cloud Notifications block visibility (server vs cloud mode)', () => {
    it('server mode: cloud block stays hidden and the server block stays visible', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            await window.loadSettings();

            expect(document.querySelector('.wg-settings-notifications-cloud').classList.contains('wg-settings-hidden')).toBe(true);
            expect(document.querySelector('.wg-settings-notifications').classList.contains('wg-settings-hidden')).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('cloud mode: hides the server block and un-hides the cloud block', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            stubCloudModules(window, {
                push: { subscribe: vi.fn(), unsubscribe: vi.fn(), getSubscription: vi.fn().mockResolvedValue(null) },
                reminders: { sendTestPush: vi.fn() }
            });
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            await window.loadSettings();

            expect(document.querySelector('.wg-settings-notifications-cloud').classList.contains('wg-settings-hidden')).toBe(false);
            expect(document.querySelector('.wg-settings-notifications').classList.contains('wg-settings-hidden')).toBe(true);
        } finally {
            cleanup();
        }
    });
});

describe('cloud Notifications controls (bindCloudNotifications)', () => {
    it('Enable click calls the mocked subscribe() and flips the button to Disable', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            window.Notification = { permission: 'default', requestPermission: vi.fn().mockResolvedValue('granted') };
            const subscribe = vi.fn().mockResolvedValue(undefined);
            const getSubscription = vi.fn()
                .mockResolvedValueOnce(null) // initial mount state: not subscribed
                .mockResolvedValue({}); // post-subscribe refresh: subscribed
            stubCloudModules(window, {
                push: { subscribe, unsubscribe: vi.fn(), getSubscription },
                reminders: { sendTestPush: vi.fn() }
            });
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            await window.loadSettings();

            const toggleBtn = document.getElementById('cloud-push-toggle');
            expect(toggleBtn.textContent).toBe('Enable');

            toggleBtn.click();
            await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
            await vi.waitFor(() => expect(toggleBtn.textContent).toBe('Disable'));
        } finally {
            cleanup();
        }
    });

    it('Disable click calls the mocked unsubscribe()', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            window.Notification = { permission: 'default' };
            const unsubscribe = vi.fn().mockResolvedValue(undefined);
            const getSubscription = vi.fn().mockResolvedValue({}); // already subscribed on mount
            stubCloudModules(window, {
                push: { subscribe: vi.fn(), unsubscribe, getSubscription },
                reminders: { sendTestPush: vi.fn() }
            });
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            await window.loadSettings();

            const toggleBtn = document.getElementById('cloud-push-toggle');
            await vi.waitFor(() => expect(toggleBtn.textContent).toBe('Disable'));

            toggleBtn.click();
            await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
        } finally {
            cleanup();
        }
    });

    it('Test click is a no-op with no unlocked vault ctx (vault locked)', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            window.Notification = { permission: 'default' };
            const sendTestPush = vi.fn().mockResolvedValue(undefined);
            stubCloudModules(window, {
                push: { subscribe: vi.fn(), unsubscribe: vi.fn(), getSubscription: vi.fn().mockResolvedValue(null) },
                reminders: { sendTestPush }
            });
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            await window.loadSettings();

            const testBtn = document.getElementById('cloud-push-test-btn');
            const status = document.getElementById('cloud-push-status');

            testBtn.click();
            await vi.waitFor(() => expect(status.textContent).toContain('Unlock the vault'));
            expect(sendTestPush).not.toHaveBeenCalled();
        } finally {
            cleanup();
        }
    });

    it('Test click is a no-op when the vault is unlocked but push is not subscribed', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            window.Notification = { permission: 'default' };
            const sendTestPush = vi.fn().mockResolvedValue(undefined);
            stubCloudModules(window, {
                push: { subscribe: vi.fn(), unsubscribe: vi.fn(), getSubscription: vi.fn().mockResolvedValue(null) },
                reminders: { sendTestPush }
            });
            window.MedTrackerCloud = { ctx: { accountId: 'acc-1', dek: new Uint8Array(1) } };
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            await window.loadSettings();

            const testBtn = document.getElementById('cloud-push-test-btn');
            const status = document.getElementById('cloud-push-status');

            testBtn.click();
            await vi.waitFor(() => expect(status.textContent).toContain('Enable push'));
            expect(sendTestPush).not.toHaveBeenCalled();
        } finally {
            cleanup();
        }
    });

    it('Test click calls sendTestPush(ctx) once the vault is unlocked and push is subscribed', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            window.Notification = { permission: 'default' };
            const sendTestPush = vi.fn().mockResolvedValue(undefined);
            stubCloudModules(window, {
                push: { subscribe: vi.fn(), unsubscribe: vi.fn(), getSubscription: vi.fn().mockResolvedValue({}) },
                reminders: { sendTestPush }
            });
            const ctx = { accountId: 'acc-1', dek: new Uint8Array(1) };
            window.MedTrackerCloud = { ctx };
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            await window.loadSettings();

            const testBtn = document.getElementById('cloud-push-test-btn');
            const status = document.getElementById('cloud-push-status');
            await vi.waitFor(() => expect(document.getElementById('cloud-push-toggle').dataset.subscribed).toBe('1'));

            testBtn.click();
            await vi.waitFor(() => expect(sendTestPush).toHaveBeenCalledTimes(1));
            expect(sendTestPush).toHaveBeenCalledWith(ctx);
            await vi.waitFor(() => expect(status.textContent).toContain('Test push scheduled'));
        } finally {
            cleanup();
        }
    });
});

describe('sendTestPush non-clobber guarantee (web/cloud/js/reminders.js, real implementation)', () => {
    // /api/push/schedule is a replace-all PUT (docs/cloud-mode.md), so
    // sendTestPush must upload the real reminder entries alongside the test
    // entry in one call, or the test push wipes every real reminder until
    // the next recompute. Exercises the real sendTestPush/computeReminderEntries
    // against an injected records port (bypassing recordsPort/IndexedDB, which
    // need a browser) and a stubbed domain horizon (createRemindersDomain is
    // covered on its own merits by the domain-purity suite) — only
    // web/cloud/js/push.js's pushSchedule is mocked, to capture what gets sent.
    afterEach(() => {
        vi.resetModules();
    });

    it('PUTs the real entries plus one appended test entry, never the test entry alone', async () => {
        const realEntry = { fireAtUnix: 1700000000, text: 'Take Aspirin (10mg)' };
        vi.doMock('../../../../web/domain/reminders.js', () => ({
            createRemindersDomain: () => ({ buildHorizon: async () => [realEntry] })
        }));
        const pushSchedule = vi.fn().mockResolvedValue(undefined);
        vi.doMock('../../../../web/cloud/js/push.js', () => ({ pushSchedule }));

        const { sendTestPush } = await import('../../../../web/cloud/js/reminders.js');
        const ctx = { accountId: 'acc-1' };
        const fakeRecords = { list: vi.fn(async () => []) };

        const beforeUnix = Math.floor(Date.now() / 1000);
        await sendTestPush(ctx, { records: fakeRecords, timeZone: 'UTC' });
        const afterUnix = Math.floor(Date.now() / 1000);

        expect(pushSchedule).toHaveBeenCalledTimes(1);
        const [calledCtx, entries] = pushSchedule.mock.calls[0];
        expect(calledCtx).toBe(ctx);
        expect(entries).toHaveLength(2);
        expect(entries[0]).toEqual(realEntry);
        expect(entries[1].text).toBe('Test notification from Med Tracker');
        expect(entries[1].fireAtUnix).toBeGreaterThanOrEqual(beforeUnix);
        expect(entries[1].fireAtUnix).toBeLessThanOrEqual(afterUnix + 5 + 1);
    });
});
