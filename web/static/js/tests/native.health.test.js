/**
 * native.health.test.js
 *
 * window.Health (bd med-w6gx.4): unsupported on web, supported inside the iOS
 * shell (the wgNative reply handler present). Platform selection itself is
 * pinned in native.local-notifications.test.js.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NATIVE = path.resolve(__dirname, '../native');

let dom;
afterEach(() => { if (dom) dom.window.close(); dom = null; });

function load({ ios = false } = {}) {
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://acct.example.test/', runScripts: 'outside-only' });
    const w = dom.window;
    if (ios) w.webkit = { messageHandlers: { wgNative: { postMessage: () => Promise.resolve(null) } } };
    for (const f of ['index.js', 'health.js']) w.eval(fs.readFileSync(path.join(NATIVE, f), 'utf8'));
    return w;
}

describe('native/health.js', () => {
    it('stub throws NotImplementedError before the impl loads', () => {
        dom = new JSDOM('', { runScripts: 'outside-only' });
        dom.window.eval(fs.readFileSync(path.join(NATIVE, 'index.js'), 'utf8'));
        expect(() => dom.window.Health.isSupported()).toThrow(/window\.Health\.isSupported/);
    });

    it('web: reports unsupported', () => {
        expect(load().Health.isSupported()).toBe(false);
    });

    it('ios: reports supported', () => {
        expect(load({ ios: true }).Health.isSupported()).toBe(true);
    });

    // bd med-w6gx.6: the ios ops are plain round trips to ios/App/Health.swift.
    it('ios: requestAuthorization and query go over the wgNative bridge', async () => {
        dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://acct.example.test/', runScripts: 'outside-only' });
        const w = dom.window;
        const sent = [];
        w.webkit = { messageHandlers: { wgNative: { postMessage: (m) => { sent.push(m); return Promise.resolve(m.op === 'health.authorize' ? true : { samples: [], anchor: 'A', more: false }); } } } };
        for (const f of ['index.js', 'health.js']) w.eval(fs.readFileSync(path.join(NATIVE, f), 'utf8'));
        await expect(w.Health.requestAuthorization(['bp', 'weight'])).resolves.toBe(true);
        await expect(w.Health.query({ type: 'bp', anchor: null, limit: 10 })).resolves.toEqual({ samples: [], anchor: 'A', more: false });
        expect(JSON.parse(JSON.stringify(sent))).toEqual([
            { op: 'health.authorize', args: { types: ['bp', 'weight'] } },
            { op: 'health.query', args: { type: 'bp', anchor: null, limit: 10 } },
        ]);
    });

    // bd med-nt9p.8: the Settings copy names the store the shell reads.
    it('names the store: Apple Health on iOS, Health Connect in the Android shell', () => {
        const ios = load({ ios: true }).Health;
        expect([ios.label, ios.accessHint]).toEqual(['Apple Health', 'Settings → Health → Data Access & Devices']);
        dom.window.close();
        dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://acct.example.test/', runScripts: 'outside-only' });
        const w = dom.window;
        w.wgNative = new w.EventTarget();
        w.wgNative.postMessage = () => {};
        for (const f of ['index.js', 'health.js']) w.eval(fs.readFileSync(path.join(NATIVE, f), 'utf8'));
        expect(w.Health.__native.platform).toBe('android');
        expect([w.Health.label, w.Health.accessHint]).toEqual(['Health Connect', 'Health Connect → App permissions']);
    });

    // bd med-8f4s.1: the write-back contract.
    it('web: writeAccess, write and remove reject unsupported', async () => {
        const h = load().Health;
        await expect(h.writeAccess(['bp'])).rejects.toThrow(/unsupported/);
        await expect(h.write({ type: 'bp', id: 'bp-1' })).rejects.toThrow(/unsupported/);
        await expect(h.remove({ type: 'bp', id: 'bp-1' })).rejects.toThrow(/unsupported/);
    });

    it('shell: authorize with write, writeAccess, write and remove forward to the ops', async () => {
        dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://acct.example.test/', runScripts: 'outside-only' });
        const w = dom.window;
        const sent = [];
        w.webkit = { messageHandlers: { wgNative: { postMessage: (m) => { sent.push(m); return Promise.resolve(true); } } } };
        for (const f of ['index.js', 'health.js']) w.eval(fs.readFileSync(path.join(NATIVE, f), 'utf8'));
        await w.Health.requestAuthorization(['bp', 'weight'], { write: ['bp', 'weight'] });
        await w.Health.writeAccess(['bp', 'weight']);
        await w.Health.write({ type: 'weight', id: 'weight-1', version: 5, at: 1000, kg: 80 });
        await w.Health.remove({ type: 'weight', id: 'weight-1' });
        expect(JSON.parse(JSON.stringify(sent))).toEqual([
            { op: 'health.authorize', args: { types: ['bp', 'weight'], write: ['bp', 'weight'] } },
            { op: 'health.writeAccess', args: { types: ['bp', 'weight'] } },
            { op: 'health.write', args: { type: 'weight', id: 'weight-1', version: 5, at: 1000, kg: 80 } },
            { op: 'health.delete', args: { type: 'weight', id: 'weight-1' } },
        ]);
    });

    // An old shell must never get the write ops (Android's call has no timeout).
    it('canWrite: false on the web, else whether shell.ops lists health.write', async () => {
        await expect(load().Health.canWrite()).resolves.toBe(false);
        for (const [ops, want] of [[['health.query'], false], [['health.query', 'health.write'], true]]) {
            dom.window.close();
            dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://acct.example.test/', runScripts: 'outside-only' });
            const w = dom.window;
            w.webkit = { messageHandlers: { wgNative: { postMessage: (m) => Promise.resolve(m.op === 'shell.ops' ? ops : null) } } };
            for (const f of ['index.js', 'health.js']) w.eval(fs.readFileSync(path.join(NATIVE, f), 'utf8'));
            await expect(w.Health.canWrite()).resolves.toBe(want);
        }
    });

    it('web: has no query surface, so nothing can reach HealthKit', () => {
        const w = load();
        expect(w.Health.query).toBeUndefined();
        expect(w.Health.requestAuthorization).toBeUndefined();
    });
});
