// bd med-d5t.3 — Safari evicts the push subscription of a PWA left unopened for
// a few days. Nothing used to detect it: reminders stopped forever, silently, on
// a medication tracker. The documented countermeasure (the server's stale-sync
// warning) is itself a web push, so it could never arrive through the very
// subscription that had just died.
//
// ensurePushSubscription() is the load-bearing half of the fix: on every app
// boot, if permission is still granted, demand a live subscription and restore
// it if it is gone. No user gesture is required once permission exists.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensurePushSubscription } from '../push.js';

// push.js pulls these in at module load; none is on the boot-reconcile path.
vi.mock('../crypto.js', () => ({ encryptPushPayload: vi.fn(), toBase64: vi.fn() }));
vi.mock('../sync.js', () => ({
    getOrCreateNK: vi.fn(),
    hasRichNotifications: vi.fn(),
    disableRichNotifications: vi.fn(),
}));
vi.mock('../localdb.js', () => ({ openDb: vi.fn() }));

const SUB = {
    toJSON: () => ({ endpoint: 'https://push.example/e1', keys: { p256dh: 'p', auth: 'a' } }),
};

let pushManager;

// Distinct from `undefined`, which the default parameter would swallow.
const NO_NOTIFICATION_API = Symbol('no Notification API');

function setNavigator(value) {
    // Node exposes globalThis.navigator as a read-only accessor, so a plain
    // assignment throws.
    Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}

function setup({ permission = 'granted', existing = null, subscribe, fetchImpl } = {}) {
    pushManager = {
        getSubscription: vi.fn().mockResolvedValue(existing),
        subscribe: subscribe || vi.fn().mockResolvedValue(SUB),
    };
    const registration = { pushManager };
    setNavigator({
        serviceWorker: {
            register: vi.fn().mockResolvedValue(registration),
            ready: Promise.resolve(registration),
        },
    });
    globalThis.PushManager = function PushManager() {};
    if (permission === NO_NOTIFICATION_API) delete globalThis.Notification;
    else globalThis.Notification = { permission };

    globalThis.fetch = fetchImpl || vi.fn(async (url) => {
        if (url === '/api/push/vapid-public-key') {
            return { ok: true, status: 200, json: async () => ({ public_key: 'AQID' }) };
        }
        return { ok: true, status: 200 };
    });
}

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });

afterEach(() => {
    vi.restoreAllMocks();
    setNavigator(undefined);
    delete globalThis.PushManager;
    delete globalThis.Notification;
    delete globalThis.fetch;
});

describe('ensurePushSubscription — boot-time reconcile', () => {
    it('re-subscribes and uploads when the browser has evicted the subscription', async () => {
        setup({ existing: null });

        const result = await ensurePushSubscription();

        expect(result.state).toBe('resubscribed');
        expect(pushManager.subscribe).toHaveBeenCalledWith(
            expect.objectContaining({ userVisibleOnly: true }),
        );
        const post = globalThis.fetch.mock.calls.find(([url]) => url === '/api/push/subscriptions');
        expect(post[1].method).toBe('POST');
        expect(JSON.parse(post[1].body)).toEqual({
            endpoint: 'https://push.example/e1', p256dh: 'p', auth: 'a',
        });
    });

    it('re-uploads a surviving subscription, healing a server row a 410 disabled', async () => {
        setup({ existing: SUB });

        const result = await ensurePushSubscription();

        expect(result.state).toBe('ok');
        // Not a redundant write: POST upserts with disabled = 0, which is the
        // only way a relay-disabled endpoint comes back to life.
        const post = globalThis.fetch.mock.calls.find(([url]) => url === '/api/push/subscriptions');
        expect(post).toBeDefined();
        expect(pushManager.subscribe).not.toHaveBeenCalled();
    });

    it('does nothing push-side when the user never granted permission', async () => {
        setup({ permission: 'default' });

        const result = await ensurePushSubscription();

        expect(result.state).toBe('not-granted');
        expect(pushManager.subscribe).not.toHaveBeenCalled();
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('still registers the SW without permission — it serves the offline app shell (med-deq.1)', async () => {
        setup({ permission: 'default' });

        await ensurePushSubscription();

        expect(globalThis.navigator.serviceWorker.register).toHaveBeenCalledWith('/sw.js');
    });

    it('reports failure when SW registration itself fails', async () => {
        setup();
        globalThis.navigator.serviceWorker.register = vi.fn().mockRejectedValue(new Error('nope'));

        const result = await ensurePushSubscription();

        expect(result.state).toBe('failed');
        expect(result.error).toBeInstanceOf(Error);
    });

    it('does nothing when the user denied permission', async () => {
        setup({ permission: 'denied' });
        expect((await ensurePushSubscription()).state).toBe('not-granted');
        expect(pushManager.subscribe).not.toHaveBeenCalled();
    });

    it('stands down on a browser with no Notification API (non-installed iOS Safari)', async () => {
        setup({ permission: NO_NOTIFICATION_API });
        expect((await ensurePushSubscription()).state).toBe('not-granted');
        expect(pushManager.subscribe).not.toHaveBeenCalled();
    });

    it('reports unsupported where push does not exist at all', async () => {
        setup();
        delete globalThis.PushManager;
        expect((await ensurePushSubscription()).state).toBe('unsupported');
    });

    it('reports failure instead of throwing when the push service refuses', async () => {
        setup({ subscribe: vi.fn().mockRejectedValue(new Error('push service down')) });

        const result = await ensurePushSubscription();

        // Boot must not break, but the UI must not claim reminders are armed.
        expect(result.state).toBe('failed');
        expect(result.error).toBeInstanceOf(Error);
    });

    it('reports failure when the upload is rejected, so the UI can warn', async () => {
        setup({
            existing: SUB,
            fetchImpl: vi.fn().mockResolvedValue({ ok: false, status: 401 }),
        });

        expect((await ensurePushSubscription()).state).toBe('failed');
    });

    it('reports failure when the server has no VAPID key configured', async () => {
        setup({
            existing: null,
            fetchImpl: vi.fn(async (url) => (url === '/api/push/vapid-public-key'
                ? { ok: false, status: 404 }
                : { ok: true, status: 200 })),
        });

        const result = await ensurePushSubscription();

        expect(result.state).toBe('failed');
        expect(pushManager.subscribe).not.toHaveBeenCalled();
    });
});
