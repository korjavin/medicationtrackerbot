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

    it('registerImpl still rejects platforms other than web, ios and android', () => {
        const { w } = load();
        expect(() => w.LocalNotifications.__native.registerImpl('LocalNotifications', 'capacitor', {})).toThrow(/must be "web", "ios" or "android"/);
    });
});

// bd med-nt9p.6: inside the Android shell WebView injects the wgNative
// WebMessageListener as window.wgNative — postMessage(string) out, message
// events back. The fake answers like MainActivity.kt onBridge.
function loadAndroid({ ios = false } = {}) {
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://acct.example.test/', runScripts: 'outside-only' });
    const w = dom.window;
    const sent = [];
    const bridge = new w.EventTarget();
    bridge.postMessage = (data) => {
        const msg = JSON.parse(data);
        sent.push(msg);
        const reply = msg.op === 'ping' ? { id: msg.id, result: 'pong' }
            : msg.op === 'silent' ? { id: msg.id } : { id: msg.id, error: 'unsupported: ' + msg.op };
        // Out of order on purpose: replies are matched by id, not arrival.
        setTimeout(() => bridge.dispatchEvent(new w.MessageEvent('message', { data: JSON.stringify(reply) })), msg.op === 'ping' ? 5 : 0);
    };
    w.wgNative = bridge;
    if (ios) w.webkit = { messageHandlers: { wgNative: { postMessage: () => Promise.resolve('ios') } } };
    for (const f of FILES) w.eval(fs.readFileSync(f, 'utf8'));
    return { w, sent };
}

describe('native/ android platform', () => {
    it('android: window.wgNative selects android; the shared impls report supported', () => {
        const { w } = loadAndroid();
        const native = w.LocalNotifications.__native;
        expect(native.platform).toBe('android');
        expect(w.LocalNotifications.isSupported()).toBe(true);
        expect(w.Health.isSupported()).toBe(true);
        // The same impl objects as ios, not copies.
        expect(w.LocalNotifications).toBe(native.getImpl('LocalNotifications', 'ios'));
        expect(w.Health).toBe(native.getImpl('Health', 'ios'));
        for (const cap of ['MediaCapture', 'Barcode', 'Bluetooth']) {
            expect(w[cap]).toBe(native.getImpl(cap, 'web'));
        }
    });

    it('names the OS in reminder copy: iOS wording on ios (unchanged), Android wording in the Android shell', () => {
        const ios = load({ ios: true }).w.LocalNotifications.copy;
        expect(ios.settingsPath).toBe('iOS Settings → Med Tracker → Notifications');
        expect(ios.pushNote).toBe('This app sends reminders as iPhone notifications once your account is open. Turn them on in Settings → Notifications, or allow Med Tracker in iOS Settings.');
        const android = loadAndroid().w.LocalNotifications.copy;
        expect(android.os).toBe('Android');
        expect(android.settingsPath).toContain('Alarms & reminders');
        expect(`${android.pushNote} ${android.settingsPath} ${android.device}`).not.toMatch(/iOS|iPhone/);
    });

    it('android: call() correlates replies by id — result resolves, error rejects', async () => {
        const { w, sent } = loadAndroid();
        const call = w.LocalNotifications.__native.call;
        const ping = call('ping');
        const nope = call('nope', { a: 1 });
        const silent = call('silent');
        await expect(nope).rejects.toThrow('unsupported: nope');
        await expect(silent).resolves.toBeNull();
        await expect(ping).resolves.toBe('pong');
        expect(sent.map((m) => m.op)).toEqual(['ping', 'nope', 'silent']);
        expect(sent[1].args).toEqual({ a: 1 });
        expect(new Set(sent.map((m) => m.id)).size).toBe(3);
    });

    it('android: the notifications.* and health.* ops go over the same bridge', async () => {
        const { w, sent } = loadAndroid();
        await w.LocalNotifications.permission().catch(() => {});
        await w.Health.query({ type: 'bp' }).catch(() => {});
        expect(sent.map((m) => [m.op, m.args])).toEqual([['notifications.permission', {}], ['health.query', { type: 'bp' }]]);
    });

    it('ios detection stays first when both bridges are present', () => {
        const { w } = loadAndroid({ ios: true });
        expect(w.LocalNotifications.__native.platform).toBe('ios');
    });

    it('a window.wgNative without the WebMessageListener surface leaves the platform web', () => {
        dom = new JSDOM('<!doctype html><html><body><div id="wgNative"></div></body></html>', { url: 'https://acct.example.test/', runScripts: 'outside-only' });
        for (const f of FILES) dom.window.eval(fs.readFileSync(f, 'utf8'));
        expect(dom.window.LocalNotifications.__native.platform).toBe('web');
        expect(dom.window.LocalNotifications.isSupported()).toBe(false);
    });

    it('an <iframe name="wgNative"> (a WindowProxy with postMessage + addEventListener) leaves the platform web', () => {
        dom = new JSDOM('<!doctype html><html><body><iframe name="wgNative"></iframe></body></html>', { url: 'https://acct.example.test/', runScripts: 'outside-only' });
        expect(typeof dom.window.wgNative.postMessage).toBe('function'); // the clobber is real
        for (const f of FILES) dom.window.eval(fs.readFileSync(f, 'utf8'));
        expect(dom.window.LocalNotifications.__native.platform).toBe('web');
        expect(dom.window.LocalNotifications.isSupported()).toBe(false);
    });
});

// bd med-w6gx.5: the ios scheduling ops are thin bridge calls; the web impl has
// none, so web code can only ever reach isSupported().
describe('native/local-notifications.js ios ops', () => {
    it('web: no scheduling surface at all', () => {
        const { w } = load();
        expect(Object.keys(w.LocalNotifications).filter((k) => k !== '__native')).toEqual(['isSupported']);
    });

    it('ios: permission / requestPermission / schedule / test post their notifications.* op', async () => {
        const { w, sent } = load({ ios: true });
        const ln = w.LocalNotifications;
        const items = [{ fireAtUnix: 1, title: 't', body: 'b', section: 'meds' }];
        for (const p of [ln.permission(), ln.requestPermission(), ln.schedule(items), ln.test()]) {
            await p.catch(() => {}); // the fake bridge answers only ping
        }
        expect(sent).toEqual([
            { op: 'notifications.permission', args: {} },
            { op: 'notifications.requestPermission', args: {} },
            { op: 'notifications.schedule', args: { items } },
            { op: 'notifications.test', args: {} },
        ]);
    });
});
