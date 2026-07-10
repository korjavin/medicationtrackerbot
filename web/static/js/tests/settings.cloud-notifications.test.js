// Plan 2026-07-06 cloud-push-notifications-settings, Task 5, updated by
// med-eas.20 (cloud-push-test-this-device). Guards the cloud-only
// Notifications block wired in features/settings.js (bindCloudNotifications)
// against: the server block staying hidden in server mode, the cloud block
// un-hiding + wiring Enable/Disable/Test in cloud mode, and the real
// (non-mocked) sendTestPush sending an immediate this-device-only test via
// POST /api/push/test (never PUT /api/push/schedule).
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

    it('Enable click handles the WebKit/iOS callback form of requestPermission (med-eas.19)', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            // WebKit/iOS: requestPermission delivers the result via callback and
            // returns undefined (not a promise). A plain await would yield
            // undefined -> "not granted" and never subscribe.
            //
            // The stub now also flips Notification.permission before invoking the
            // callback, as a real browser does. It didn't before, which let the
            // med-1n6 defect hide: the code trusted the callback's ARGUMENT, and
            // no test ever disagreed with it.
            window.Notification = {
                permission: 'default',
                requestPermission: vi.fn((cb) => { window.Notification.permission = 'granted'; cb('granted'); return undefined; }),
            };
            const subscribe = vi.fn().mockResolvedValue(undefined);
            const getSubscription = vi.fn()
                .mockResolvedValueOnce(null)
                .mockResolvedValue({});
            stubCloudModules(window, {
                push: { subscribe, unsubscribe: vi.fn(), getSubscription },
                reminders: { sendTestPush: vi.fn() }
            });
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            await window.loadSettings();

            const toggleBtn = document.getElementById('cloud-push-toggle');
            toggleBtn.click();
            // The callback-form permission must be treated as granted -> subscribe.
            await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
            await vi.waitFor(() => expect(toggleBtn.textContent).toBe('Disable'));
        } finally {
            cleanup();
        }
    });

    it('Enable click shows the iOS install hint when Notification is unavailable (med-eas.19)', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            delete window.Notification; // non-installed iOS Safari: no Notification API
            const subscribe = vi.fn();
            stubCloudModules(window, {
                push: { subscribe, unsubscribe: vi.fn(), getSubscription: vi.fn().mockResolvedValue(null) },
                reminders: { sendTestPush: vi.fn() }
            });
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            await window.loadSettings();

            document.getElementById('cloud-push-toggle').click();
            const status = document.getElementById('cloud-push-status');
            await vi.waitFor(() => expect(status.textContent).toMatch(/Home Screen/i));
            expect(subscribe).not.toHaveBeenCalled();
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
            await vi.waitFor(() => expect(status.textContent).toContain('Test sent to this device.'));
        } finally {
            cleanup();
        }
    });
});

describe('sendTestPush this-device-only send (web/cloud/js/push.js, real implementation)', () => {
    // sendTestPush no longer schedules anything (docs/cloud-mode.md): it
    // POSTs the current device's subscription + encrypted ct straight to
    // /api/push/test, which the server sends immediately to that one
    // subscription only. Exercises the real sendTestPush against a stubbed
    // service-worker registration + fetch (crypto/sync are mocked — they're
    // covered on their own merits elsewhere).
    afterEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
    });

    it('POSTs endpoint + ct to /api/push/test and never touches /api/push/schedule', async () => {
        vi.doMock('../../../../web/cloud/js/sync.js', () => ({
            getOrCreateNK: vi.fn().mockResolvedValue('nk-stub'),
            hasRichNotifications: vi.fn(),
            disableRichNotifications: vi.fn(),
        }));
        vi.doMock('../../../../web/cloud/js/crypto.js', () => ({
            encryptPushPayload: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
            toBase64: vi.fn(() => 'ct-base64'),
        }));

        const sub = { endpoint: 'https://push.example/device-a' };
        vi.stubGlobal('navigator', {
            serviceWorker: {
                getRegistration: vi.fn().mockResolvedValue({
                    pushManager: { getSubscription: vi.fn().mockResolvedValue(sub) }
                })
            }
        });
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);

        const { sendTestPush } = await import('../../../../web/cloud/js/push.js');
        const ctx = { accountId: 'acc-1' };
        await sendTestPush(ctx);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, opts] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/push/test');
        expect(opts.method).toBe('POST');
        const body = JSON.parse(opts.body);
        expect(body.endpoint).toBe(sub.endpoint);
        expect(body.ct).toBe('ct-base64');
    });

    it('throws a clear error when no subscription exists on this device', async () => {
        vi.doMock('../../../../web/cloud/js/sync.js', () => ({
            getOrCreateNK: vi.fn(),
            hasRichNotifications: vi.fn(),
            disableRichNotifications: vi.fn(),
        }));
        vi.doMock('../../../../web/cloud/js/crypto.js', () => ({
            encryptPushPayload: vi.fn(),
            toBase64: vi.fn(),
        }));
        vi.stubGlobal('navigator', {
            serviceWorker: {
                getRegistration: vi.fn().mockResolvedValue({
                    pushManager: { getSubscription: vi.fn().mockResolvedValue(null) }
                })
            }
        });
        vi.stubGlobal('fetch', vi.fn());

        const { sendTestPush } = await import('../../../../web/cloud/js/push.js');
        await expect(sendTestPush({ accountId: 'acc-1' })).rejects.toThrow(/enable push/i);
    });
});

// bd med-1n6 — owner report on iOS: home-screen PWA, tapped "Enable", the system
// dialogue appeared, tapped Allow, and the app said permission was NOT granted.
// Worse, tapping Enable again did nothing at all.
//
// Two defects. (1) The code resolved with whatever WebKit's legacy callback
// handed it — and WebKit has been seen invoking it with no argument, so
// `undefined !== 'granted'` reported a denial for a permission the user had just
// granted. (2) Nothing re-armed the button, and re-prompting on an
// already-decided permission can settle neither callback nor promise, hanging
// the handler with the button left disabled.
describe('iOS Enable-push permission handling (med-1n6)', () => {
    function mountCloud(window, { push, notification }) {
        window.__MEDTRACKER_CLOUD__ = true;
        window.Notification = notification;
        stubCloudModules(window, { push, reminders: { sendTestPush: vi.fn() } });
        window.apiCall = vi.fn(async () => { throw new Error('offline'); });
        return window.loadSettings();
    }

    it('treats a callback invoked with NO argument as the grant it is', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            // The exact WebKit shape that produced the report: permission flips to
            // 'granted', but the callback carries nothing.
            const notification = {
                permission: 'default',
                requestPermission: vi.fn((cb) => { notification.permission = 'granted'; cb(); return undefined; }),
            };
            const subscribe = vi.fn().mockResolvedValue(undefined);
            await mountCloud(window, {
                push: {
                    subscribe,
                    unsubscribe: vi.fn(),
                    getSubscription: vi.fn().mockResolvedValueOnce(null).mockResolvedValue({}),
                },
                notification,
            });

            document.getElementById('cloud-push-toggle').click();

            await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
            const status = document.getElementById('cloud-push-status');
            expect(status.textContent).not.toMatch(/not granted/i);
            expect(status.textContent).toMatch(/enabled/i);
        } finally {
            cleanup();
        }
    });

    it('never re-prompts once the permission is decided — that path can hang forever', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            // A WebKit that settles NOTHING when the permission is already granted.
            // Before the fix this await never resolved, so the button stayed
            // disabled and the second tap "did nothing".
            const notification = {
                permission: 'granted',
                requestPermission: vi.fn(() => undefined),
            };
            const subscribe = vi.fn().mockResolvedValue(undefined);
            await mountCloud(window, {
                push: {
                    subscribe,
                    unsubscribe: vi.fn(),
                    getSubscription: vi.fn().mockResolvedValueOnce(null).mockResolvedValue({}),
                },
                notification,
            });

            const toggleBtn = document.getElementById('cloud-push-toggle');
            toggleBtn.click();

            await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
            expect(notification.requestPermission).not.toHaveBeenCalled();
            await vi.waitFor(() => expect(toggleBtn.disabled).toBe(false));
        } finally {
            cleanup();
        }
    });

    it('re-arms the button after a failure, so the next tap retries', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            const notification = { permission: 'granted', requestPermission: vi.fn() };
            const subscribe = vi.fn()
                .mockRejectedValueOnce(new Error('Subscription failed: push service down'))
                .mockResolvedValue(undefined);
            await mountCloud(window, {
                push: {
                    subscribe,
                    unsubscribe: vi.fn(),
                    getSubscription: vi.fn().mockResolvedValue(null),
                },
                notification,
            });

            const toggleBtn = document.getElementById('cloud-push-toggle');
            toggleBtn.click();
            await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
            // The whole point: not latched disabled.
            await vi.waitFor(() => expect(toggleBtn.disabled).toBe(false));

            toggleBtn.click();
            await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2));
        } finally {
            cleanup();
        }
    });

    it('reports a failed subscribe as a SUBSCRIPTION failure, not a denied permission', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            const notification = { permission: 'granted', requestPermission: vi.fn() };
            await mountCloud(window, {
                push: {
                    subscribe: vi.fn().mockRejectedValue(new Error('Subscription failed: push service down')),
                    unsubscribe: vi.fn(),
                    getSubscription: vi.fn().mockResolvedValue(null),
                },
                notification,
            });

            document.getElementById('cloud-push-toggle').click();

            const status = document.getElementById('cloud-push-status');
            await vi.waitFor(() => expect(status.textContent).toMatch(/subscription failed/i));
            // The user granted the permission; blaming them for it is the bug.
            expect(status.textContent).not.toMatch(/permission was not granted/i);
        } finally {
            cleanup();
        }
    });

    it('says "blocked in your browser settings" when the permission really is denied', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            const notification = { permission: 'denied', requestPermission: vi.fn() };
            const subscribe = vi.fn();
            await mountCloud(window, {
                push: { subscribe, unsubscribe: vi.fn(), getSubscription: vi.fn().mockResolvedValue(null) },
                notification,
            });

            document.getElementById('cloud-push-toggle').click();

            const status = document.getElementById('cloud-push-status');
            await vi.waitFor(() => expect(status.textContent).toMatch(/blocked in your browser settings/i));
            expect(subscribe).not.toHaveBeenCalled();
        } finally {
            cleanup();
        }
    });
});
