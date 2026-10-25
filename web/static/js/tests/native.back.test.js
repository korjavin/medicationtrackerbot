/**
 * native.back.test.js
 *
 * window.NativeBack (bd med-y7b4.3): the shells' system Back reaches
 * AppBack.step() through the cancelable 'wg:native-back' document event (the
 * shell reads "cancelled" as true), and the page reports canStep with the
 * 'back.state' op when shell.ops lists it. The web impl is a no-op.
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// shellOps: what the shell's shell.ops answers; null = the web (no bridge).
function load(shellOps = null) {
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://acct.example.test/', runScripts: 'outside-only' });
    const w = dom.window;
    const sent = [];
    if (shellOps) {
        w.webkit = { messageHandlers: { wgNative: { postMessage: (m) => {
            sent.push(m);
            return Promise.resolve(m.op === 'shell.ops' ? shellOps : null);
        } } } };
    }
    for (const f of ['index.js', 'back.js']) w.eval(fs.readFileSync(path.join(NATIVE, f), 'utf8'));
    return { w, sent };
}

// What the shell evaluates for its 'back' op.
function shellBack(w) {
    return !w.document.dispatchEvent(new w.CustomEvent('wg:native-back', { cancelable: true }));
}

describe('native/back.js', () => {
    it('stub throws NotImplementedError before the impl loads', () => {
        dom = new JSDOM('', { runScripts: 'outside-only' });
        dom.window.eval(fs.readFileSync(path.join(NATIVE, 'index.js'), 'utf8'));
        expect(() => dom.window.NativeBack.setState(true)).toThrow(/window\.NativeBack\.setState/);
    });

    it('web: onStep and setState are no-ops', () => {
        const { w } = load();
        let calls = 0;
        w.NativeBack.onStep(() => { calls += 1; return true; });
        w.NativeBack.setState(true);
        expect(shellBack(w)).toBe(false);
        expect(calls).toBe(0);
    });

    it('shell back: true when the page stepped, false at the root', () => {
        const { w } = load(['back.state']);
        let answer = true;
        w.NativeBack.onStep(() => answer);
        expect(shellBack(w)).toBe(true);
        answer = false;
        expect(shellBack(w)).toBe(false);
    });

    it('setState sends back.state {canStep} when shell.ops lists it', async () => {
        const { w, sent } = load(['back.state']);
        w.NativeBack.setState(true);
        w.NativeBack.setState(false);
        await tick();
        expect(sent.filter((m) => m.op === 'back.state').map((m) => m.args)).toEqual([{ canStep: true }, { canStep: false }]);
    });

    it('an older shell without back.state never hears it', async () => {
        const { w, sent } = load(['ping']);
        w.NativeBack.setState(true);
        await tick();
        expect(sent.map((m) => m.op)).toEqual(['shell.ops']);
    });
});
