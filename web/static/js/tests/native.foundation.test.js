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
    'web/static/js/native/web/bluetooth.js',
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

    it('installs all window globals after script load', () => {
        env = loadFoundation();
        expect(typeof env.window.MediaCapture).toBe('object');
        expect(typeof env.window.Barcode).toBe('object');
        expect(typeof env.window.Bluetooth).toBe('object');
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
            ['Bluetooth', 'isSupported'],
            ['Bluetooth', 'requestHeartRateDevice'],
            ['Bluetooth', 'subscribeHeartRate'],
            ['Bluetooth', 'unsubscribe'],
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
            ['Bluetooth', 'isSupported'],
            ['Bluetooth', 'requestHeartRateDevice'],
            ['Bluetooth', 'subscribeHeartRate'],
            ['Bluetooth', 'unsubscribe'],
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

describe('native/index.js — permissions.query shim (med-o7zq.25)', () => {
    // iOS WKWebView on wgapp:// rejects permissions.query({name:'microphone'})
    // after a granted getUserMedia, which killed the voice call. The shim turns
    // that rejection into a 'prompt' status for microphone/camera only.
    let env;
    afterEach(() => { if (env) env.cleanup(); env = null; });

    function loadWithQuery(query) {
        env = makeWindow();
        Object.defineProperty(env.window.navigator, 'permissions', { value: { query }, configurable: true });
        env.evalFile(NATIVE_INDEX_JS);
        return env.window.navigator.permissions;
    }

    it('rejecting query resolves a prompt stub for microphone', async () => {
        const perms = loadWithQuery(() => Promise.reject(new TypeError('Permissions::query does not support this API')));
        const mic = await perms.query({ name: 'microphone' });
        expect(mic.name).toBe('microphone');
        expect(mic.state).toBe('prompt');
        expect(mic.onchange).toBeNull();
        expect(mic.dispatchEvent()).toBe(false);
        expect(() => { mic.addEventListener('change', () => {}); mic.removeEventListener('change', () => {}); }).not.toThrow();
    });

    it('synchronously throwing query resolves a prompt stub for camera', async () => {
        const perms = loadWithQuery(() => { throw new TypeError('unsupported'); });
        expect((await perms.query({ name: 'camera' })).state).toBe('prompt');
    });

    it('working query passes its result through unchanged', async () => {
        const real = { name: 'microphone', state: 'denied' };
        const perms = loadWithQuery(() => Promise.resolve(real));
        expect(await perms.query({ name: 'microphone' })).toBe(real);
    });

    it('non-device names keep the original rejection', async () => {
        const err = new TypeError('nope');
        const perms = loadWithQuery(() => Promise.reject(err));
        await expect(perms.query({ name: 'notifications' })).rejects.toBe(err);
    });

    it('provides permissions.query when navigator.permissions is missing', async () => {
        env = makeWindow();
        Object.defineProperty(env.window.navigator, 'permissions', { value: undefined, configurable: true });
        env.evalFile(NATIVE_INDEX_JS);
        const perms = env.window.navigator.permissions;
        expect((await perms.query({ name: 'microphone' })).state).toBe('prompt');
        await expect(perms.query({ name: 'geolocation' })).rejects.toHaveProperty('name', 'TypeError');
    });
});
