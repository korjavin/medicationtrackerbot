/**
 * native.push-token.test.js
 *
 * window.NativePush (bd med-erq1.3): the app shells' APNs/FCM wake channel.
 * On web it reports unsupported and has no other surface; inside a shell
 * token() reads the push.token op (null when the shell does not list it, the
 * reply is off-shape or the bridge errors) and onWake() relays the shell's
 * 'wg:native-push' document event. Then push.js registers / drops that token
 * with the relay through the real capability.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { registerNativePushToken, dropNativePushToken } from '../../../cloud/js/push.js';

// push.js pulls these in at module load; none is on the native-token path.
vi.mock('../../../cloud/js/crypto.js', () => ({ encryptPushPayload: vi.fn(), toBase64: vi.fn() }));
vi.mock('../../../cloud/js/sync.js', () => ({
    getOrCreateNK: vi.fn(),
    hasRichNotifications: vi.fn(),
    disableRichNotifications: vi.fn(),
}));
vi.mock('../../../cloud/js/localdb.js', () => ({ openDb: vi.fn() }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NATIVE = path.resolve(__dirname, '../native');
const FILES = ['index.js', 'push-token.js'].map((f) => path.join(NATIVE, f));
const TOKEN = 'f'.repeat(64);

let dom;
afterEach(() => {
    if (dom) dom.window.close();
    dom = null;
    delete globalThis.NativePush;
    delete globalThis.fetch;
});

// shell: 'ios' | 'android' | null (web). ops: what shell.ops lists. reply: push.token's answer.
function load({ shell = null, ops = ['shell.ops', 'push.token'], reply = { platform: 'ios', token: TOKEN } } = {}) {
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://acct.example.test/', runScripts: 'outside-only' });
    const w = dom.window;
    const sent = [];
    const answer = (op) => {
        sent.push(op);
        if (op === 'shell.ops') return ops;
        if (op === 'push.token') {
            if (reply instanceof Error) throw reply;
            return reply;
        }
        throw new Error('unsupported: ' + op);
    };
    if (shell === 'ios') {
        w.webkit = { messageHandlers: { wgNative: { postMessage: (body) => {
            try { return Promise.resolve(answer(body.op)); } catch (e) { return Promise.reject(e); }
        } } } };
    } else if (shell === 'android') {
        const bridge = new w.EventTarget();
        bridge.postMessage = (data) => {
            const msg = JSON.parse(data);
            let out;
            try { out = { id: msg.id, result: answer(msg.op) }; } catch (e) { out = { id: msg.id, error: e.message }; }
            setTimeout(() => bridge.dispatchEvent(new w.MessageEvent('message', { data: JSON.stringify(out) })), 0);
        };
        w.wgNative = bridge;
    }
    for (const f of FILES) w.eval(fs.readFileSync(f, 'utf8'));
    return { w, sent };
}

function wake(w, detail) {
    w.document.dispatchEvent(new w.CustomEvent('wg:native-push', { detail }));
}

describe('native/push-token.js', () => {
    it('web: unsupported, no token or wake surface, never touches a bridge', () => {
        const { w, sent } = load();
        expect(w.NativePush.isSupported()).toBe(false);
        expect(Object.keys(w.NativePush).filter((k) => k !== '__native')).toEqual(['isSupported']);
        expect(sent).toEqual([]);
    });

    it('ios: token() reads push.token once the shell lists it', async () => {
        const { w, sent } = load({ shell: 'ios' });
        expect(w.NativePush.isSupported()).toBe(true);
        await expect(w.NativePush.token()).resolves.toEqual({ platform: 'ios', token: TOKEN });
        expect(sent).toEqual(['shell.ops', 'push.token']);
    });

    it('android: the same impl over the message bridge', async () => {
        const { w } = load({ shell: 'android', reply: { platform: 'android', token: 'fcm-token' } });
        expect(w.NativePush).toBe(w.NativePush.__native.getImpl('NativePush', 'ios'));
        await expect(w.NativePush.token()).resolves.toEqual({ platform: 'android', token: 'fcm-token' });
    });

    it('a shell without the op, a null / off-shape reply or a bridge error all read as no token', async () => {
        const old = load({ shell: 'ios', ops: ['shell.ops'] });
        await expect(old.w.NativePush.token()).resolves.toBeNull();
        expect(old.sent).toEqual(['shell.ops']); // never calls an op the shell lacks
        for (const reply of [null, { platform: 'web', token: TOKEN }, { platform: 'ios', token: '' }, new Error('bridge down')]) {
            await expect(load({ shell: 'ios', reply }).w.NativePush.token()).resolves.toBeNull();
        }
    });

    it('onWake relays the wg:native-push kind and ignores events without one', () => {
        const { w } = load({ shell: 'android' });
        const kinds = [];
        w.NativePush.onWake((k) => kinds.push(k));
        wake(w, { kind: 'inbox-wake' });
        wake(w, { kind: 'dry-queue' });
        wake(w, null);
        wake(w, { kind: 7 });
        expect(kinds).toEqual(['inbox-wake', 'dry-queue']);
    });
});

describe('push.js native token registration (real capability)', () => {
    function relay(status = 204) {
        const calls = [];
        globalThis.fetch = vi.fn(async (url, init) => {
            calls.push({ url, method: init.method, body: JSON.parse(init.body) });
            return { ok: status < 300, status };
        });
        return calls;
    }

    it('POSTs then DELETEs {platform, token} at /api/push/native-tokens', async () => {
        globalThis.NativePush = load({ shell: 'ios' }).w.NativePush;
        const calls = relay();
        await expect(registerNativePushToken()).resolves.toBe(true);
        await dropNativePushToken();
        expect(calls).toEqual([
            { url: '/api/push/native-tokens', method: 'POST', body: { platform: 'ios', token: TOKEN } },
            { url: '/api/push/native-tokens', method: 'DELETE', body: { platform: 'ios', token: TOKEN } },
        ]);
    });

    it('web, a missing capability or no token yet: no request at all', async () => {
        const calls = relay();
        await expect(registerNativePushToken()).resolves.toBe(false); // native/ not loaded
        globalThis.NativePush = load().w.NativePush;
        await expect(registerNativePushToken()).resolves.toBe(false);
        globalThis.NativePush = load({ shell: 'ios', reply: null }).w.NativePush;
        await expect(registerNativePushToken()).resolves.toBe(false);
        await dropNativePushToken();
        expect(calls).toEqual([]);
    });

    it('a relay refusal rejects without the token in the message', async () => {
        globalThis.NativePush = load({ shell: 'ios' }).w.NativePush;
        relay(500);
        const err = await registerNativePushToken().catch((e) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toContain('500');
        expect(err.message).not.toContain(TOKEN);
    });
});
