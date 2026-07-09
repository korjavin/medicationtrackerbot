// bd med-9b8.3 — the cloud service worker renders Snooze / Don't-bug buttons on
// bp + weight reminders, and routes a tap to an unlocked PAGE rather than
// POSTing it itself. The SW holds no DEK, so it cannot serve the shim routes;
// this is the seam that makes the bot-mode notification actions reachable in
// cloud mode at all.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

// The SW reads NK out of the 'device' store of the 'medtracker-cloud' IDB.
// A hand-rolled stand-in is enough — it only ever does one get('nk').
function fakeIndexedDB(nk) {
    return {
        open: () => {
            const req = {};
            queueMicrotask(() => req.onsuccess && req.onsuccess());
            req.result = {
                close: () => {},
                transaction: () => ({
                    objectStore: () => ({
                        get: () => {
                            const r = {};
                            queueMicrotask(() => { r.result = nk; r.onsuccess && r.onsuccess(); });
                            return r;
                        },
                    }),
                }),
            };
            return req;
        },
    };
}

// Mirrors crypto.js encryptPushPayload, which is what push.js uses to seal the
// {title, body, kind} the SW reads back.
async function sealPush(nk, payload) {
    const key = await crypto.subtle.importKey('raw', nk, 'AES-GCM', false, ['encrypt']);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode('mt/v1/push') },
        key,
        new TextEncoder().encode(JSON.stringify(payload)),
    );
    const packed = new Uint8Array(12 + ct.byteLength);
    packed.set(nonce, 0);
    packed.set(new Uint8Array(ct), 12);
    return packed.buffer;
}

function loadCloudSw(nk) {
    const swSrc = fs.readFileSync(path.resolve(REPO_ROOT, 'web/cloud/sw.js'), 'utf-8');
    const listeners = new Map();
    const self = {
        addEventListener: vi.fn((type, fn) => {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        }),
        clients: {
            matchAll: vi.fn().mockResolvedValue([]),
            openWindow: vi.fn().mockResolvedValue(undefined),
            claim: vi.fn(),
        },
        registration: { showNotification: vi.fn() },
        skipWaiting: vi.fn(),
    };
    const caches = {
        open: vi.fn().mockResolvedValue({ match: vi.fn(), put: vi.fn(), addAll: vi.fn() }),
        match: vi.fn(),
        keys: vi.fn().mockResolvedValue([]),
        delete: vi.fn(),
    };
    // eslint-disable-next-line no-new-func
    new Function('self', 'caches', 'fetch', 'indexedDB', swSrc)(self, caches, vi.fn(), fakeIndexedDB(nk));
    return { self, listeners };
}

// Drive the push handler. `data` is null (undecodable → generic notification)
// or a PushMessageData stand-in whose arrayBuffer() returns sealed bytes.
async function firePush(self, listeners, data) {
    const handler = listeners.get('push')[0];
    let waited;
    handler({ data, waitUntil: (p) => { waited = p; } });
    await waited;
}

async function fireNotificationClick(self, listeners, action) {
    const handler = listeners.get('notificationclick')[0];
    let waited;
    handler({ action, notification: { close: vi.fn() }, waitUntil: (p) => { waited = p; } });
    await waited;
}

describe('cloud sw.js — reminder notification actions', () => {
    let self;
    let listeners;
    let nk;

    beforeEach(() => {
        nk = crypto.getRandomValues(new Uint8Array(32));
        ({ self, listeners } = loadCloudSw(nk));
    });

    it.each([
        ['bp', ['bp_snooze', 'bp_dontbug']],
        ['weight', ['weight_snooze', 'weight_dontbug']],
    ])('a %s reminder renders its Snooze / Don\'t-bug buttons', async (kind, expected) => {
        const packed = await sealPush(nk, { title: 'Med Tracker', body: 'Time to measure', kind });
        await firePush(self, listeners, { arrayBuffer: () => packed });

        const [, opts] = self.registration.showNotification.mock.calls[0];
        expect(opts.actions.map((a) => a.action)).toEqual(expected);
    });

    it('a medication reminder decodes but carries no action buttons (needs an intake id, med-76c.2)', async () => {
        const packed = await sealPush(nk, { title: 'Med Tracker', body: 'Time to take: Lisinopril', kind: 'medication' });
        await firePush(self, listeners, { arrayBuffer: () => packed });

        const [title, opts] = self.registration.showNotification.mock.calls[0];
        expect(title).toBe('Med Tracker');
        expect(opts.body).toBe('Time to take: Lisinopril');
        expect(opts.actions).toEqual([]);
    });

    it('an undecodable push shows the generic notification with no action buttons', async () => {
        await firePush(self, listeners, null);
        expect(self.registration.showNotification).toHaveBeenCalledWith(
            'Med Tracker',
            expect.objectContaining({ actions: [] }),
        );
    });

    it('a body click with no action just focuses an open tab', async () => {
        const client = { focus: vi.fn(), postMessage: vi.fn() };
        self.clients.matchAll.mockResolvedValue([client]);

        await fireNotificationClick(self, listeners, '');

        expect(client.focus).toHaveBeenCalled();
        expect(client.postMessage).not.toHaveBeenCalled();
    });

    it('a Snooze tap hands the shim route to an open tab — the SW never posts it itself', async () => {
        const client = { focus: vi.fn(), postMessage: vi.fn() };
        self.clients.matchAll.mockResolvedValue([client]);

        await fireNotificationClick(self, listeners, 'bp_snooze');

        expect(client.postMessage).toHaveBeenCalledWith({
            type: 'reminder-action',
            route: '/api/bp/reminder/snooze',
        });
        expect(client.focus).toHaveBeenCalled();
        expect(self.clients.openWindow).not.toHaveBeenCalled();
    });

    it('a cold-start tap opens the app carrying the action in the URL', async () => {
        self.clients.matchAll.mockResolvedValue([]);

        await fireNotificationClick(self, listeners, 'weight_dontbug');

        expect(self.clients.openWindow).toHaveBeenCalledWith('/?reminder_action=weight_dontbug');
    });

    it('an unknown action is treated as a plain click, not a route', async () => {
        const client = { focus: vi.fn(), postMessage: vi.fn() };
        self.clients.matchAll.mockResolvedValue([client]);

        await fireNotificationClick(self, listeners, 'rm_-rf_slash');

        expect(client.postMessage).not.toHaveBeenCalled();
        expect(client.focus).toHaveBeenCalled();
    });
});
