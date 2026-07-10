// bd med-1n6 — the owner granted notification permission on an iOS home-screen
// PWA and the app told him he had denied it; the second tap on Enable then did
// nothing at all.
//
// Both symptoms come from requestNotificationPermission(). It resolved with
// whatever WebKit's legacy callback handed over — and WebKit has been seen
// invoking that callback with NO argument — and it re-prompted on an already
// decided permission, a path where WebKit may settle neither the callback nor
// a promise, hanging the caller with the Enable button left disabled.
//
// settings.js carries a deliberate copy of this helper (it must reach
// requestPermission() inside the click's transient activation, before the
// dynamic import). settings.cloud-notifications.test.js pins that copy to the
// same behavior; these pin the module.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestNotificationPermission } from '../push.js';

vi.mock('../crypto.js', () => ({ encryptPushPayload: vi.fn(), toBase64: vi.fn() }));
vi.mock('../sync.js', () => ({
    getOrCreateNK: vi.fn(),
    hasRichNotifications: vi.fn(),
    disableRichNotifications: vi.fn(),
}));
vi.mock('../localdb.js', () => ({ openDb: vi.fn() }));

afterEach(() => { delete globalThis.Notification; });

// A promise that rejects the test if it never settles, rather than hanging the
// runner until its timeout — a hang is precisely the defect under test.
function within(promise, ms = 200) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('requestNotificationPermission never settled')), ms)),
    ]);
}

describe('requestNotificationPermission (med-1n6)', () => {
    it('reports the grant when WebKit invokes the callback with no argument', async () => {
        // The exact shape behind the report: permission flips, callback carries
        // nothing, and nothing is returned to await.
        const Notification = {
            permission: 'default',
            requestPermission: vi.fn((cb) => { Notification.permission = 'granted'; cb(); return undefined; }),
        };
        globalThis.Notification = Notification;

        await expect(within(requestNotificationPermission())).resolves.toBe('granted');
    });

    it('still honors a spec-compliant promise that resolves the value itself', async () => {
        globalThis.Notification = {
            permission: 'default',
            requestPermission: vi.fn().mockResolvedValue('granted'),
        };

        await expect(within(requestNotificationPermission())).resolves.toBe('granted');
    });

    it('honors the legacy callback when it does carry the value', async () => {
        globalThis.Notification = {
            permission: 'default',
            requestPermission: vi.fn((cb) => { cb('denied'); return undefined; }),
        };

        await expect(within(requestNotificationPermission())).resolves.toBe('denied');
    });

    it('never prompts again once granted — that path can settle nothing at all', async () => {
        const requestPermission = vi.fn(() => undefined); // settles neither callback nor promise
        globalThis.Notification = { permission: 'granted', requestPermission };

        await expect(within(requestNotificationPermission())).resolves.toBe('granted');
        expect(requestPermission).not.toHaveBeenCalled();
    });

    it('never prompts again once denied', async () => {
        const requestPermission = vi.fn(() => undefined);
        globalThis.Notification = { permission: 'denied', requestPermission };

        await expect(within(requestNotificationPermission())).resolves.toBe('denied');
        expect(requestPermission).not.toHaveBeenCalled();
    });

    it('settles on a rejected request rather than hanging the Enable button', async () => {
        globalThis.Notification = {
            permission: 'default',
            requestPermission: vi.fn().mockRejectedValue(new Error('no user gesture')),
        };

        await expect(within(requestNotificationPermission())).resolves.toBe('default');
    });

    it('reports denied where there is no Notification API at all', async () => {
        await expect(within(requestNotificationPermission())).resolves.toBe('denied');
    });
});
