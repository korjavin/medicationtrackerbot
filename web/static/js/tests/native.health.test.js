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
});
