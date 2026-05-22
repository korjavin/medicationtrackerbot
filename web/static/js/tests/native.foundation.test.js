/**
 * native.foundation.test.js
 *
 * Pins the Phase 2b Task 1 foundation contract: native/index.js installs the
 * four window globals (MediaCapture, Geolocation, Barcode, Reminders) as
 * stubs that throw NotImplementedError, plus a runtime isNativePlatform()
 * helper that returns false in the browser PWA and true under the Capacitor
 * Android shell.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const NATIVE_INDEX_JS = path.join(REPO_ROOT, 'web/static/js/native/index.js');

function loadFoundation({ capacitor } = {}) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'http://app.example.test/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const { window } = dom;
    if (capacitor !== undefined) {
        window.Capacitor = capacitor;
    }
    const source = fs.readFileSync(NATIVE_INDEX_JS, 'utf8');
    window.eval(`${source}\n//# sourceURL=file://${NATIVE_INDEX_JS}`);
    return { window, cleanup: () => dom.window.close() };
}

describe('native/index.js — Phase 2b foundation', () => {
    let env;

    beforeEach(() => { env = null; });
    afterEach(() => { if (env) env.cleanup(); env = null; });

    it('installs the four window globals after script load', () => {
        env = loadFoundation();
        expect(typeof env.window.MediaCapture).toBe('object');
        expect(typeof env.window.Geolocation).toBe('object');
        expect(typeof env.window.Barcode).toBe('object');
        expect(typeof env.window.Reminders).toBe('object');
    });

    it('every stub method throws NotImplementedError naming the capability and method', () => {
        env = loadFoundation();
        const cases = [
            ['MediaCapture', 'takePhoto'],
            ['MediaCapture', 'pickPhoto'],
            ['Geolocation', 'getCurrentPosition'],
            ['Barcode', 'scan'],
            ['Reminders', 'schedule'],
            ['Reminders', 'cancelAll'],
        ];
        for (const [capability, method] of cases) {
            const stub = env.window[capability];
            expect(typeof stub[method]).toBe('function');
            let caught;
            try { stub[method](); } catch (e) { caught = e; }
            expect(caught, `${capability}.${method} did not throw`).toBeDefined();
            expect(caught.name).toBe('NotImplementedError');
            expect(caught.capability).toBe(capability);
            expect(caught.method).toBe(method);
            expect(String(caught.message)).toContain('window.' + capability + '.' + method);
        }
    });

    it('isNativePlatform() returns false when window.Capacitor is undefined', () => {
        env = loadFoundation();
        const foundation = env.window.MediaCapture.__native;
        expect(typeof foundation.isNativePlatform).toBe('function');
        expect(foundation.isNativePlatform()).toBe(false);
    });

    it('isNativePlatform() returns false when Capacitor exists but isNativePlatform is missing', () => {
        env = loadFoundation({ capacitor: {} });
        expect(env.window.MediaCapture.__native.isNativePlatform()).toBe(false);
    });

    it('isNativePlatform() returns false when Capacitor.isNativePlatform() returns false', () => {
        env = loadFoundation({ capacitor: { isNativePlatform: () => false } });
        expect(env.window.MediaCapture.__native.isNativePlatform()).toBe(false);
    });

    it('isNativePlatform() returns true when Capacitor.isNativePlatform() returns true', () => {
        env = loadFoundation({ capacitor: { isNativePlatform: () => true } });
        expect(env.window.MediaCapture.__native.isNativePlatform()).toBe(true);
    });

    it('isNativePlatform() swallows host errors (defensive) and returns false', () => {
        env = loadFoundation({
            capacitor: { isNativePlatform: () => { throw new Error('boom'); } },
        });
        expect(env.window.MediaCapture.__native.isNativePlatform()).toBe(false);
    });

    it('foundation helpers are shared across every native global', () => {
        env = loadFoundation();
        const a = env.window.MediaCapture.__native;
        const b = env.window.Geolocation.__native;
        const c = env.window.Barcode.__native;
        const d = env.window.Reminders.__native;
        expect(a).toBe(b);
        expect(a).toBe(c);
        expect(a).toBe(d);
    });
});
