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

    it('web: has no query surface, so nothing can reach HealthKit', () => {
        const w = load();
        expect(w.Health.query).toBeUndefined();
        expect(w.Health.requestAuthorization).toBeUndefined();
    });
});
