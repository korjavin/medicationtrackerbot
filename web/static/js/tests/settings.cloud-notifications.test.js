// Plan 2026-07-06 cloud-push-notifications-settings, Task 5, updated by
// med-eas.20 (cloud-push-test-this-device). Guards the cloud-only
// Notifications block wired in features/settings.js (bindCloudNotifications)
// against: the cloud block un-hiding + wiring Enable/Disable/Test in cloud
// mode (and staying hidden outside it), and the real
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

describe('notification notes crossing provider reload commitment', () => {
    it.each(['permission', 'native-capability'])('the actual note renderer preserves its slot when %s resolves after commitment', async (boundary) => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            let release;
            let started = false;
            const pending = new Promise((resolve) => { release = resolve; });
            const pause = vi.fn(() => { started = true; return pending; });
            window.LocalNotifications = {
                isSupported: () => true, copy: { os: 'Android' },
                permission: boundary === 'permission' ? pause : async () => 'denied',
            };
            window.nativeHas = boundary === 'native-capability' ? pause : vi.fn(async () => true);
            const slot = document.getElementById('local-notify-note');
            slot.textContent = 'Existing note stays until navigation.';
            const work = window.NotifyPermission.renderNote(slot);
            await vi.waitFor(() => expect(started).toBe(true));
            document.documentElement.setAttribute('data-provider-reload-committed', '');
            release(boundary === 'permission' ? 'denied' : true);
            await work;
            expect(slot.textContent).toBe('Existing note stays until navigation.');
            expect(slot.querySelector('button')).toBeNull();
            if (boundary === 'permission') expect(window.nativeHas).not.toHaveBeenCalled();
        } finally { cleanup(); }
    });

    it('the real Settings painter and nested note renderer do not repaint after the second permission await', async () => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            let release;
            const pending = new Promise((resolve) => { release = resolve; });
            const permission = vi.fn().mockResolvedValueOnce('denied').mockImplementation(() => pending);
            window.LocalNotifications = { isSupported: () => true, permission, copy: { os: 'Android' } };
            window.nativeHas = vi.fn(async () => true);
            const note = document.getElementById('cloud-push-note');
            note.textContent = 'Existing note';
            const work = window.paintCloudPush(document.getElementById('cloud-push-toggle'), true);
            await vi.waitFor(() => expect(permission).toHaveBeenCalledTimes(2));
            const card = document.getElementById('cloud-push-card');
            const before = card.outerHTML;
            document.documentElement.setAttribute('data-provider-reload-committed', '');
            release('denied');
            await work;
            expect(card.outerHTML).toBe(before);
            expect(note.textContent).toBe('Existing note');
            expect(window.nativeHas).not.toHaveBeenCalled();
        } finally { cleanup(); }
    });
});

describe('cloud Notifications block visibility (server vs cloud mode)', () => {
    it('server mode: cloud block stays hidden', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        delete window.__MEDTRACKER_CLOUD__; // harness defaults to cloud; test outside-cloud behavior
        try {
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            await window.loadSettings();

            expect(document.querySelector('.wg-settings-notifications-cloud').classList.contains('wg-settings-hidden')).toBe(true);
        } finally {
            cleanup();
        }
    });

    it('cloud mode: un-hides the cloud block', async () => {
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

    // bd med-wi09.20: the schedule PUT takes the sync writer gate, so it must
    // declare X-Ledger: 2 — the real header source in sync.js, not a mock of it.
    it('pushSchedule PUTs /api/push/schedule with X-Ledger: 2', async () => {
        vi.doMock('../../../../web/cloud/js/sync.js', async (importOriginal) => ({
            ...(await importOriginal()),
            getOrCreateNK: vi.fn().mockResolvedValue('nk-stub'),
        }));
        vi.doMock('../../../../web/cloud/js/crypto.js', () => ({
            encryptPushPayload: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
            toBase64: vi.fn(() => 'ct-base64'),
        }));
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);

        const { pushSchedule } = await import('../../../../web/cloud/js/push.js');
        await pushSchedule({ accountId: 'acc-1' }, [{ fireAtUnix: 1900000000, text: 'Medication time', kind: 'med' }]);

        const call = fetchMock.mock.calls.find(([url]) => url === '/api/push/schedule');
        expect(call).toBeTruthy();
        expect(call[1].method).toBe('PUT');
        expect(call[1].headers['X-Ledger']).toBe('2');
        expect(JSON.parse(call[1].body).entries).toHaveLength(1);
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

// bd med-w6gx.5: inside the iOS app shell window.LocalNotifications reports
// supported, and the same controls drive iOS notifications instead of Web Push.
describe('cloud Notifications controls inside the iOS app (LocalNotifications)', () => {
    function shellLocal(window, { permission = 'default', grant = 'granted' } = {}) {
        const local = {
            isSupported: () => true,
            permission: vi.fn(async () => local.state),
            requestPermission: vi.fn(async () => { local.state = grant; return grant; }),
            schedule: vi.fn(async () => 0),
            test: vi.fn(async () => true),
            state: permission,
        };
        window.LocalNotifications = local;
        return local;
    }

    it('Enable asks iOS, reschedules the horizon, and never touches Web Push', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            const local = shellLocal(window);
            const subscribe = vi.fn();
            const getSubscription = vi.fn();
            const recomputeAndPush = vi.fn().mockResolvedValue(undefined);
            stubCloudModules(window, {
                push: { subscribe, unsubscribe: vi.fn(), getSubscription },
                reminders: { sendTestPush: vi.fn(), recomputeAndPush }
            });
            const ctx = { accountId: 'acc-1' };
            window.MedTrackerCloud = { ctx };
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            await window.loadSettings();

            const toggleBtn = document.getElementById('cloud-push-toggle');
            await vi.waitFor(() => expect(toggleBtn.dataset.subscribed).toBe('0'));
            toggleBtn.click();
            await vi.waitFor(() => expect(recomputeAndPush).toHaveBeenCalledWith(ctx));
            expect(local.requestPermission).toHaveBeenCalledTimes(1);
            await vi.waitFor(() => expect(toggleBtn.textContent).toBe('Disable'));
            expect(subscribe).not.toHaveBeenCalled();
            expect(getSubscription).not.toHaveBeenCalled();
        } finally {
            cleanup();
        }
    });

    it('a refused permission points to iOS Settings', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            shellLocal(window, { grant: 'denied' });
            const recomputeAndPush = vi.fn();
            stubCloudModules(window, {
                push: { subscribe: vi.fn(), unsubscribe: vi.fn(), getSubscription: vi.fn() },
                reminders: { sendTestPush: vi.fn(), recomputeAndPush }
            });
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            await window.loadSettings();

            const toggleBtn = document.getElementById('cloud-push-toggle');
            await vi.waitFor(() => expect(toggleBtn.disabled).toBe(false));
            toggleBtn.click();
            const status = document.getElementById('cloud-push-status');
            await vi.waitFor(() => expect(status.textContent).toContain('iOS Settings'));
            expect(recomputeAndPush).not.toHaveBeenCalled();
            expect(toggleBtn.textContent).toBe('Enable');
        } finally {
            cleanup();
        }
    });

    it('Send test posts a local notification instead of a test push', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            const local = shellLocal(window, { permission: 'granted' });
            const sendTestPush = vi.fn();
            stubCloudModules(window, {
                push: { subscribe: vi.fn(), unsubscribe: vi.fn(), getSubscription: vi.fn() },
                reminders: { sendTestPush }
            });
            window.MedTrackerCloud = { ctx: { accountId: 'acc-1' } };
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            await window.loadSettings();

            await vi.waitFor(() => expect(document.getElementById('cloud-push-toggle').dataset.subscribed).toBe('1'));
            document.getElementById('cloud-push-test-btn').click();
            await vi.waitFor(() => expect(local.test).toHaveBeenCalledTimes(1));
            expect(sendTestPush).not.toHaveBeenCalled();
            await vi.waitFor(() => expect(document.getElementById('cloud-push-status').textContent).toContain('Test sent to this device.'));
        } finally {
            cleanup();
        }
    });
    // bd med-erq1.3: the card's Wake-ups line reads the shell's APNs/FCM token
    // (NativePush); hidden on the web (the harness's native/ has no impl).
    it.each([
        [{ platform: 'android', token: 't' }, 'Wake-ups: on'],
        [null, 'Wake-ups: off (allow notifications)'],
        ['web', null],
    ])('Wake-ups line for token %j', async (token, text) => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            shellLocal(window, { permission: 'granted' });
            if (token !== 'web') window.NativePush = { isSupported: () => true, token: vi.fn(async () => token) };
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            await window.loadSettings();
            await vi.waitFor(() => expect(document.getElementById('cloud-push-toggle').dataset.subscribed).toBe('1'));
            const line = document.getElementById('cloud-push-wake');
            if (text) await vi.waitFor(() => expect(line.textContent).toBe(text));
            expect(line.hidden).toBe(!text);
        } finally {
            cleanup();
        }
    });

    it.each([[undefined, 'iPhone'], [{ device: 'phone' }, 'phone']])('Settings device words follow the shell copy %j', async (copy, word) => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            const local = shellLocal(window);
            if (copy) local.copy = copy;
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            await window.loadSettings();
            const words = [...document.querySelectorAll('[data-device-word]')];
            expect(words.length).toBeGreaterThan(0);
            words.forEach((el) => expect(el.textContent).toBe(word));
            // The W5 card's meta (bd med-ta2n.5); the status read failed, so no chip.
            expect(document.querySelector('#settings-sync-meta').textContent).toBe(`only on this ${word}`);
            expect(document.getElementById('settings-sync-chip').classList.contains('wg-settings-hidden')).toBe(true);
        } finally {
            cleanup();
        }
    });
});

describe('Reminders & notifications page (kit S8, med-ckm5.8)', () => {
    it('long-title bar, no <select>; the delivery and Telegram choices persist through the delivery pref', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            const setDeliveryPref = vi.fn(async (p) => p);
            const recomputeAndPush = vi.fn(async () => {});
            stubCloudModules(window, {
                push: { subscribe: vi.fn(), unsubscribe: vi.fn(), getSubscription: vi.fn().mockResolvedValue({}) },
                reminders: {
                    sendTestPush: vi.fn(),
                    recomputeAndPush,
                    remindersDomain: () => ({
                        getDeliveryPref: async () => ({ delivery: 'both', verbosity: 'detailed' }),
                        setDeliveryPref,
                    }),
                },
            });
            window.MedTrackerCloud = { ctx: { accountId: 'acc-1' } };
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            await window.loadSettings();

            document.querySelector('.wg-settings-home [data-settings-open="notifications"]').click();
            const pushed = document.querySelector('mt-modal.wg-page[id^="wg-page-"]');
            expect(pushed.querySelector('.wg-pagebar').classList.contains('wg-pagebar--long')).toBe(true);
            expect(pushed.querySelector('.wg-back').getAttribute('aria-label')).toBe('Settings');
            expect(pushed.querySelector('.wg-pagebar__title').textContent).toBe('Reminders & notifications');
            expect(pushed.querySelectorAll('select')).toHaveLength(0);

            const pressed = (id) => document.querySelector(`#${id} .wg-choice[aria-pressed="true"]`).dataset.value;
            await vi.waitFor(() => expect(pressed('cloud-reminder-delivery')).toBe('both'));
            expect(pressed('cloud-reminder-verbosity')).toBe('detailed');
            await vi.waitFor(() => expect(document.getElementById('cloud-push-chip').textContent).toBe('On'));

            document.querySelector('#cloud-reminder-delivery .wg-choice[data-value="telegram"]').click();
            await vi.waitFor(() => expect(setDeliveryPref).toHaveBeenCalledWith({ delivery: 'telegram', verbosity: 'detailed' }));
            await vi.waitFor(() => expect(recomputeAndPush).toHaveBeenCalled());
            expect(pressed('cloud-reminder-delivery')).toBe('telegram');

            pushed.querySelector('.wg-back').click();
            expect(document.querySelector('[data-settings-summary="notifications"]').textContent).toContain('Telegram');
        } finally {
            cleanup();
        }
    });

    // Argus 5809 #2 (bd med-wi09.14): the pref write leaves a pending op, so the
    // fenced PUT is deferred to after a pull. Settings must report that PUT's
    // failure, not "Reminder delivery updated." before it ran.
    it('a deferred schedule PUT that fails shows the error, not "updated"', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        const store = {
            medication: [{ recordId: 2, deleted: false, name: 'A', dosage: '10mg', schedule: '{"type":"daily","times":["09:00"]}' }],
            reminderdeliverypref: [{ recordId: 'reminderdeliverypref', deleted: false, delivery: 'telegram', verbosity: 'detailed' }],
        };
        let basis = { seq: 4, pending: 1 };
        const records = {
            list: async (t) => (store[t] || []).map((r) => ({ ...r })),
            listRaw: async (t) => (store[t] || []).map((r) => ({ ...r })),
            listRange: async () => [],
            put: async (t, r) => r,
            del: async () => {},
            horizonBasis: async () => ({ ...basis }),
        };
        // Only the drain is stubbed: this test decides what its pull flushes.
        vi.resetModules();
        const requestFreshDrain = vi.fn(async () => { basis = { seq: 5, pending: 0 }; });
        vi.doMock('../../../../web/cloud/js/sync.js', async (importOriginal) => ({
            ...(await importOriginal()),
            requestFreshDrain,
        }));
        const { recomputeAndPush: realRecomputeAndPush } = await import('../../../../web/cloud/js/reminders.js');
        const puts = [];
        vi.stubGlobal('fetch', vi.fn(async (url, init) => {
            puts.push(JSON.parse(init.body));
            return { ok: false, status: 503 };
        }));
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            stubCloudModules(window, {
                push: { subscribe: vi.fn(), unsubscribe: vi.fn(), getSubscription: vi.fn().mockResolvedValue({}) },
                reminders: {
                    sendTestPush: vi.fn(),
                    recomputeAndPush: (ctx) => realRecomputeAndPush(ctx, { records, timeZone: 'UTC' }),
                    remindersDomain: () => ({
                        getDeliveryPref: async () => ({ delivery: 'telegram', verbosity: 'detailed' }),
                        setDeliveryPref: async (p) => p,
                    }),
                },
            });
            window.MedTrackerCloud = { ctx: { accountId: 'acc-1' } };
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            await window.loadSettings();
            document.querySelector('.wg-settings-home [data-settings-open="notifications"]').click();

            document.querySelector('#cloud-reminder-verbosity .wg-choice[data-value="generic"]').click();
            const status = document.getElementById('cloud-reminder-delivery-status');
            await vi.waitFor(() => expect(status.textContent).toBe('Could not schedule the reminder.'));
            expect(requestFreshDrain).toHaveBeenCalledTimes(1);
            expect(puts).toHaveLength(1);
            expect(puts[0]).toMatchObject({ based_on_seq: 5, generation: 2 });
        } finally {
            vi.unstubAllGlobals();
            vi.doUnmock('../../../../web/cloud/js/sync.js');
            vi.resetModules();
            cleanup();
        }
    });

    it('"Remind me about" summarises the reminder times; Medications closes the page onto Meds', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            delete window.__MEDTRACKER_CLOUD__;
            const answers = {
                '/api/bp/reminder/status': { enabled: true, preferred_reminder_hour: 8 },
                '/api/weight/reminder/status': { enabled: false, preferred_reminder_hour: 7, cadence: 'daily' },
            };
            window.apiCall = vi.fn(async (url) => answers[url] || {});
            await window.loadSettings();
            const desc = (id) => document.getElementById(id).closest('mt-setting-toggle').querySelector('.wg-setting__desc').textContent;
            await vi.waitFor(() => expect(desc('bp-reminders-toggle')).toBe('At 08:00 unless you measured recently'));
            expect(desc('weight-reminders-toggle')).toBe('Daily at 07:00');
            expect(document.getElementById('bp-reminders-toggle').checked).toBe(true);

            window.switchTab = vi.fn();
            document.querySelector('.wg-settings-home [data-settings-open="notifications"]').click();
            document.getElementById('settings-reminders-meds').click();
            expect(document.querySelector('mt-modal.wg-page[id^="wg-page-"]')).toBeNull();
            expect(window.switchTab).toHaveBeenCalledWith('meds');
        } finally {
            cleanup();
        }
    });
});
