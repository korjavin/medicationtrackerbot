/**
 * native.foundation.test.js
 *
 * Pins the device-capability foundation contract: native/index.js installs
 * window.MediaCapture + window.Barcode as stubs that throw
 * NotImplementedError, and the web/* impl files replace them via
 * registerImpl() so feature code sees real methods at script-load time.
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
const NATIVE_IMPL_FILES = [
    'web/static/js/native/web/media-capture.js',
    'web/static/js/native/web/barcode.js',
].map((rel) => path.join(REPO_ROOT, rel));

function makeWindow() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'http://app.example.test/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const evalFile = (file) => {
        const src = fs.readFileSync(file, 'utf8');
        dom.window.eval(`${src}\n//# sourceURL=file://${file}`);
    };
    return { window: dom.window, evalFile, cleanup: () => dom.window.close() };
}

function loadFoundation() {
    const env = makeWindow();
    env.evalFile(NATIVE_INDEX_JS);
    return env;
}

function loadFullStack() {
    const env = makeWindow();
    env.evalFile(NATIVE_INDEX_JS);
    for (const file of NATIVE_IMPL_FILES) env.evalFile(file);
    return env;
}

describe('native/index.js — foundation', () => {
    let env;

    beforeEach(() => { env = null; });
    afterEach(() => { if (env) env.cleanup(); env = null; });

    it('installs both window globals after script load', () => {
        env = loadFoundation();
        expect(typeof env.window.MediaCapture).toBe('object');
        expect(typeof env.window.Barcode).toBe('object');
    });

    it('every stub method throws NotImplementedError naming the capability and method', () => {
        env = loadFoundation();
        const cases = [
            ['MediaCapture', 'takePhoto'],
            ['MediaCapture', 'pickPhoto'],
            ['MediaCapture', 'openCameraStream'],
            ['MediaCapture', 'recordAudio'],
            ['Barcode', 'scan'],
            ['Barcode', 'supportsLiveScan'],
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

    it('registerImpl rejects any platform other than "web"', () => {
        env = loadFoundation();
        expect(() => env.window.Barcode.__native.registerImpl('Barcode', 'capacitor', {}))
            .toThrow(/must be "web"/);
    });

    it('foundation helpers are shared across every global', () => {
        env = loadFoundation();
        expect(env.window.MediaCapture.__native).toBe(env.window.Barcode.__native);
    });
});

describe('native/index.js — full module load wires real impls', () => {
    // After loading every web/*.js sibling, both window globals MUST be
    // replaced with the real impls — none of their methods should still throw
    // NotImplementedError. This is the contract feature callers depend on: at
    // script load time window.MediaCapture.takePhoto / window.Barcode.scan are
    // real promises, not stubs.
    let env;
    afterEach(() => { if (env) env.cleanup(); env = null; });

    // Invoke a method and consume any returned promise so the test runner
    // doesn't flag a benign rejection as an unhandled rejection. We only care
    // that the call did NOT throw NotImplementedError.
    function callAndSwallow(surface, method) {
        let caught;
        let returned;
        try {
            returned = surface[method]();
        } catch (e) { caught = e; }
        if (returned && typeof returned.then === 'function') {
            returned.catch(() => {});
        }
        return caught;
    }

    it('every method is functional, not a stub', () => {
        env = loadFullStack();
        const checks = [
            ['MediaCapture', 'takePhoto'],
            ['MediaCapture', 'pickPhoto'],
            ['MediaCapture', 'openCameraStream'],
            ['MediaCapture', 'recordAudio'],
            ['Barcode', 'scan'],
            ['Barcode', 'supportsLiveScan'],
        ];
        for (const [capability, method] of checks) {
            const surface = env.window[capability];
            expect(typeof surface[method]).toBe('function');
            const caught = callAndSwallow(surface, method);
            if (caught) {
                expect(caught.name, `${capability}.${method} still threw NotImplementedError`)
                    .not.toBe('NotImplementedError');
            }
        }
    });
});
