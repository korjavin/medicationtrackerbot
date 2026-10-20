/**
 * native.clipboard.test.js
 *
 * window.Clipboard (bd med-ta2n.6): readText() → string | null, never rejects.
 * web + ios read navigator.clipboard (WebKit's own Paste callout); android
 * uses the shell's clipboard.read op when shell.ops lists it (contract
 * med-ta2n.7 §7), else the same web read.
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

function withClipboard(w, readText) {
    Object.defineProperty(w.navigator, 'clipboard', { configurable: true, value: readText ? { readText } : undefined });
}

function load({ clipboard, ios = false } = {}) {
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://acct.example.test/', runScripts: 'outside-only' });
    const w = dom.window;
    const sent = [];
    if (ios) w.webkit = { messageHandlers: { wgNative: { postMessage: (m) => { sent.push(m); return Promise.resolve(null); } } } };
    withClipboard(w, clipboard);
    for (const f of ['index.js', 'clipboard.js']) w.eval(fs.readFileSync(path.join(NATIVE, f), 'utf8'));
    return { w, sent };
}

// The Android shell's WebMessageListener (window.wgNative), answering by id
// like MainActivity.kt onBridge.
function loadAndroid(replies, { clipboard } = {}) {
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://appassets.androidplatform.net/', runScripts: 'outside-only' });
    const w = dom.window;
    const sent = [];
    const bridge = new w.EventTarget();
    bridge.postMessage = (data) => {
        const msg = JSON.parse(data);
        sent.push(msg.op);
        const reply = msg.op in replies ? { id: msg.id, result: replies[msg.op] } : { id: msg.id, error: 'unsupported: ' + msg.op };
        setTimeout(() => bridge.dispatchEvent(new w.MessageEvent('message', { data: JSON.stringify(reply) })), 0);
    };
    w.wgNative = bridge;
    withClipboard(w, clipboard);
    for (const f of ['index.js', 'clipboard.js']) w.eval(fs.readFileSync(path.join(NATIVE, f), 'utf8'));
    return { w, sent };
}

describe('native/clipboard.js', () => {
    it('stub throws NotImplementedError before the impl loads', () => {
        dom = new JSDOM('', { runScripts: 'outside-only' });
        dom.window.eval(fs.readFileSync(path.join(NATIVE, 'index.js'), 'utf8'));
        expect(() => dom.window.Clipboard.readText()).toThrow(/window\.Clipboard\.readText/);
    });

    it('web: the clipboard text; empty, denied or unsupported → null', async () => {
        expect(await load({ clipboard: async () => 'https://a.example.test/#claim=ab' }).w.Clipboard.readText()).toBe('https://a.example.test/#claim=ab');
        expect(await load({ clipboard: async () => '' }).w.Clipboard.readText()).toBeNull();
        expect(await load({ clipboard: async () => { throw new Error('NotAllowedError'); } }).w.Clipboard.readText()).toBeNull();
        expect(await load({ clipboard: () => { throw new Error('sync throw'); } }).w.Clipboard.readText()).toBeNull();
        expect(await load().w.Clipboard.readText()).toBeNull();
    });

    it('ios: the web read, no bridge op (WebKit shows its Paste callout)', async () => {
        const { w, sent } = load({ ios: true, clipboard: async () => 'x' });
        expect(w.Clipboard.__native.platform).toBe('ios');
        expect(await w.Clipboard.readText()).toBe('x');
        expect(sent).toEqual([]);
    });

    it('android: clipboard.read when the shell lists it', async () => {
        const { w, sent } = loadAndroid({ 'shell.ops': ['clipboard.read'], 'clipboard.read': 'from-android' }, { clipboard: async () => 'from-web' });
        expect(await w.Clipboard.readText()).toBe('from-android');
        expect(sent).toEqual(['shell.ops', 'clipboard.read']);
    });

    it('android: an empty clip or a failing op → null', async () => {
        expect(await loadAndroid({ 'shell.ops': ['clipboard.read'], 'clipboard.read': null }).w.Clipboard.readText()).toBeNull();
        expect(await loadAndroid({ 'shell.ops': ['clipboard.read'] }).w.Clipboard.readText()).toBeNull();
    });

    it('android: an older shell without clipboard.read falls back to the web read', async () => {
        const { w, sent } = loadAndroid({ 'shell.ops': ['ping'] }, { clipboard: async () => 'from-web' });
        expect(await w.Clipboard.readText()).toBe('from-web');
        expect(sent).toEqual(['shell.ops']);
    });
});
