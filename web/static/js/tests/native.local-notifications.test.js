/**
 * native.local-notifications.test.js
 *
 * window.LocalNotifications (bd med-w6gx.4) and the ios platform it rides on:
 * on web the foundation stays 'web', the capability reports unsupported and
 * every existing global keeps its web impl; inside the iOS shell (the
 * wgNative reply handler present) the ios impl wins and foundation.call()
 * round-trips through the bridge.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NATIVE = path.resolve(__dirname, '../native');
const FILES = ['index.js', 'web/media-capture.js', 'web/barcode.js', 'web/bluetooth.js', 'local-notifications.js', 'health.js']
    .map((f) => path.join(NATIVE, f));

let dom;
afterEach(() => { if (dom) dom.window.close(); dom = null; });

// ios: install a fake WKScriptMessageHandlerWithReply before native/ loads.
function load({ ios = false } = {}) {
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://acct.example.test/', runScripts: 'outside-only' });
    const w = dom.window;
    const sent = [];
    if (ios) {
        w.webkit = { messageHandlers: { wgNative: { postMessage: (body) => {
            sent.push(body);
            return body.op === 'ping' ? Promise.resolve('pong') : Promise.reject(new w.Error('unsupported: ' + body.op));
        } } } };
    }
    for (const f of FILES) w.eval(fs.readFileSync(f, 'utf8'));
    return { w, sent };
}

describe('native/local-notifications.js', () => {
    it('web: platform stays web, unsupported, existing globals keep their web impls', () => {
        const { w } = load();
        const native = w.LocalNotifications.__native;
        expect(native.platform).toBe('web');
        expect(w.LocalNotifications.isSupported()).toBe(false);
        expect(w.LocalNotifications).toBe(native.getImpl('LocalNotifications', 'web'));
        for (const cap of ['MediaCapture', 'Barcode', 'Bluetooth']) {
            expect(w[cap]).toBe(native.getImpl(cap, 'web'));
        }
    });

    it('web: foundation.call rejects without touching any bridge', async () => {
        const { w } = load();
        await expect(w.LocalNotifications.__native.call('ping')).rejects.toMatchObject({ name: 'NotImplementedError' });
    });

    it('ios: the shell bridge selects the ios impl, which reports supported', () => {
        const { w } = load({ ios: true });
        expect(w.LocalNotifications.__native.platform).toBe('ios');
        expect(w.LocalNotifications.isSupported()).toBe(true);
        expect(w.LocalNotifications).toBe(w.LocalNotifications.__native.getImpl('LocalNotifications', 'ios'));
        // No ios impl for these yet: web impls stay installed.
        expect(w.Barcode).toBe(w.Barcode.__native.getImpl('Barcode', 'web'));
    });

    it('ios: foundation.call posts {op, args} and resolves/rejects with the Swift reply', async () => {
        const { w, sent } = load({ ios: true });
        await expect(w.LocalNotifications.__native.call('ping')).resolves.toBe('pong');
        await expect(w.LocalNotifications.__native.call('nope', { a: 1 })).rejects.toThrow('unsupported: nope');
        expect(sent).toEqual([{ op: 'ping', args: {} }, { op: 'nope', args: { a: 1 } }]);
    });

    it('registerImpl still rejects platforms other than web and ios', () => {
        const { w } = load();
        expect(() => w.LocalNotifications.__native.registerImpl('LocalNotifications', 'android', {})).toThrow(/must be "web" or "ios"/);
    });
});
