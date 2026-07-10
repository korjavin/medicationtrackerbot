// bd med-d5t.3 — a push service can revoke and re-issue a subscription. Before
// this handler existed the cloud SW ignored `pushsubscriptionchange` entirely,
// so the endpoint the relay held went dead and medication reminders stopped
// with no signal to the user.
//
// This is the belt; the braces are ensurePushSubscription() on every app boot
// (push.resubscribe.test.js). Safari fires this event unreliably, which is
// exactly why both exist.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const NEW_SUB = {
    toJSON: () => ({
        endpoint: 'https://push.example/new-endpoint',
        keys: { p256dh: 'p256dh-new', auth: 'auth-new' },
    }),
};

function loadCloudSw({ fetchImpl, subscribe } = {}) {
    const swSrc = fs.readFileSync(path.resolve(REPO_ROOT, 'web/cloud/sw.js'), 'utf-8');
    const listeners = new Map();
    const self = {
        addEventListener: vi.fn((type, fn) => {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        }),
        clients: { matchAll: vi.fn().mockResolvedValue([]), openWindow: vi.fn(), claim: vi.fn() },
        registration: {
            showNotification: vi.fn(),
            pushManager: { subscribe: subscribe || vi.fn().mockResolvedValue(NEW_SUB) },
        },
        skipWaiting: vi.fn(),
    };
    const caches = {
        open: vi.fn().mockResolvedValue({}),
        match: vi.fn(),
        keys: vi.fn().mockResolvedValue([]),
        delete: vi.fn(),
    };
    const fetchMock = fetchImpl || vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    // eslint-disable-next-line no-new-func
    new Function('self', 'caches', 'fetch', 'indexedDB', swSrc)(self, caches, fetchMock, { open: vi.fn() });
    return { self, listeners, fetchMock };
}

async function fireChange(listeners, oldSubscription) {
    const handler = listeners.get('pushsubscriptionchange')[0];
    let waited;
    handler({ oldSubscription, waitUntil: (p) => { waited = p; } });
    await waited;
}

describe('cloud sw.js — pushsubscriptionchange', () => {
    let consoleError;
    beforeEach(() => { consoleError = vi.spyOn(console, 'error').mockImplementation(() => {}); });

    it('registers a handler at all — its absence is the whole bug', () => {
        const { listeners } = loadCloudSw();
        expect(listeners.has('pushsubscriptionchange')).toBe(true);
    });

    it('re-subscribes with the dead subscription\'s own applicationServerKey', async () => {
        const subscribe = vi.fn().mockResolvedValue(NEW_SUB);
        const { listeners, fetchMock } = loadCloudSw({ subscribe });
        const key = new Uint8Array([1, 2, 3]);

        await fireChange(listeners, { options: { applicationServerKey: key } });

        expect(subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: key });
        // Per-account VAPID keys are never rotated, so reusing the old key is
        // correct and spares a round-trip.
        const fetched = fetchMock.mock.calls.map(([url]) => url);
        expect(fetched).not.toContain('/api/push/vapid-public-key');
    });

    it('uploads the new endpoint so the relay stops pushing to a dead one', async () => {
        const { listeners, fetchMock } = loadCloudSw();

        await fireChange(listeners, { options: { applicationServerKey: new Uint8Array([1]) } });

        const post = fetchMock.mock.calls.find(([url]) => url === '/api/push/subscriptions');
        expect(post).toBeDefined();
        expect(post[1].method).toBe('POST');
        // Without cookies the upload 401s and the subscription stays dead.
        expect(post[1].credentials).toBe('same-origin');
        expect(JSON.parse(post[1].body)).toEqual({
            endpoint: 'https://push.example/new-endpoint',
            p256dh: 'p256dh-new',
            auth: 'auth-new',
        });
    });

    it('refetches the VAPID key when the browser hands over no oldSubscription', async () => {
        const subscribe = vi.fn().mockResolvedValue(NEW_SUB);
        const fetchImpl = vi.fn(async (url) => {
            if (url === '/api/push/vapid-public-key') {
                return { ok: true, status: 200, json: async () => ({ public_key: 'AQID' }) };
            }
            return { ok: true, status: 200, json: async () => ({}) };
        });
        const { listeners } = loadCloudSw({ fetchImpl, subscribe });

        await fireChange(listeners, null);

        expect(subscribe).toHaveBeenCalledTimes(1);
        const { applicationServerKey } = subscribe.mock.calls[0][0];
        expect(Array.from(applicationServerKey)).toEqual([1, 2, 3]); // base64url "AQID"
    });

    it('swallows a failed re-subscribe — boot retries, an unhandled rejection helps nobody', async () => {
        const subscribe = vi.fn().mockRejectedValue(new Error('push service down'));
        const { listeners } = loadCloudSw({ subscribe });

        await expect(fireChange(listeners, { options: {} })).resolves.toBeUndefined();
        expect(consoleError).toHaveBeenCalled();
    });

    it('swallows a failed upload rather than leaving the worker rejecting', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
        const { listeners } = loadCloudSw({ fetchImpl });

        await expect(fireChange(listeners, { options: { applicationServerKey: new Uint8Array([1]) } })).resolves.toBeUndefined();
        expect(consoleError).toHaveBeenCalled();
    });
});
