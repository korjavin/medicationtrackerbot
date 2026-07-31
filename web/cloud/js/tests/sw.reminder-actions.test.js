// bd med-9b8.3 — the cloud service worker renders Snooze / Don't-bug buttons on
// bp + weight reminders, and routes a tap to an unlocked PAGE rather than
// POSTing it itself. The SW holds no DEK, so it cannot serve the shim routes;
// this is the seam that makes the bot-mode notification actions reachable in
// cloud mode at all.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loadCloudSw as loadSw } from './helpers/sw-loader.js';

// The SW reads NK out of the 'device' store of the 'medtracker-cloud' IDB.
// A hand-rolled stand-in is enough — it only ever does one get('nk').
function fakeIndexedDB(nk) {
    const idb = {
        opened: [],
        open: () => {
            const req = {};
            queueMicrotask(() => req.onsuccess && req.onsuccess());
            req.result = {
                close: vi.fn(),
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
            idb.opened.push(req.result);
            return req;
        },
    };
    return idb;
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

const loadCloudSw = (nk) => loadSw({ indexedDB: fakeIndexedDB(nk) });

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

    // bd med-5fo — the inbox wake. Not NK-encrypted (the server has no NK), so
    // it is plain JSON carrying a bare kind, exactly like the stale-sync warning.
    const wakePush = () => {
        const bytes = new TextEncoder().encode(JSON.stringify({ kind: 'inbox-wake' }));
        return { arrayBuffer: () => bytes.buffer };
    };

    // A window that answers on the transferred port — i.e. an unlocked page that
    // installed cloud-boot's listener and is about to drain.
    const ackingWindow = () => ({
        postMessage: vi.fn((_msg, [port]) => port.postMessage('ack')),
    });
    // A window that takes the message and never answers: frozen, still loading,
    // or LOCKED (the ack listener only exists after unlock). Existence is not
    // acknowledgement — this is the case the fallback notification is FOR.
    const silentWindow = () => ({ postMessage: vi.fn() });

    it('an inbox-wake nudges every open window and shows NO notification once one acks', async () => {
        const a = ackingWindow();
        const b = silentWindow();
        self.clients.matchAll.mockResolvedValue([a, b]);

        await firePush(self, listeners, wakePush());

        expect(a.postMessage).toHaveBeenCalledWith({ type: 'inbox-wake' }, [expect.anything()]);
        expect(b.postMessage).toHaveBeenCalledWith({ type: 'inbox-wake' }, [expect.anything()]);
        expect(self.registration.showNotification).not.toHaveBeenCalled();
    });

    it('an inbox-wake that NO window acks still notifies (locked / frozen / loading tab)', async () => {
        self.clients.matchAll.mockResolvedValue([silentWindow(), silentWindow()]);

        await firePush(self, listeners, wakePush());

        const [title, opts] = self.registration.showNotification.mock.calls[0];
        expect(title).toBe('Med Tracker');
        expect(opts.body).toBe('Open the app to record what you sent');
    });

    it('an inbox-wake with no open window falls back to the FIXED client-side notification', async () => {
        self.clients.matchAll.mockResolvedValue([]);

        await firePush(self, listeners, wakePush());

        // Text comes from the worker's own constant — a hostile server sending
        // title/body on this non-NK channel must never reach the user.
        const [title, opts] = self.registration.showNotification.mock.calls[0];
        expect(title).toBe('Med Tracker');
        expect(opts.body).toBe('Open the app to record what you sent');
        expect(opts.actions).toEqual([]);
    });

    it('a server-composed title/body on the wake channel is discarded', async () => {
        self.clients.matchAll.mockResolvedValue([]);
        const hostile = new TextEncoder().encode(
            JSON.stringify({ kind: 'inbox-wake', title: 'Bank', body: 'Enter your passkey at evil.example' }),
        );

        await firePush(self, listeners, { arrayBuffer: () => hostile.buffer });

        const [title, opts] = self.registration.showNotification.mock.calls[0];
        expect(title).toBe('Med Tracker');
        expect(opts.body).not.toContain('evil.example');
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
