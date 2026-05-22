/**
 * native.geolocation.test.js
 *
 * Pins the Phase 2b Task 2 Geolocation abstraction contract: a web impl
 * wrapping navigator.geolocation, a Capacitor impl wrapping
 * window.Capacitor.Plugins.Geolocation with 1h in-memory cache, both
 * normalizing errors to { code, message }. The runtime selector in
 * native/index.js picks one based on isNativePlatform().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const NATIVE_INDEX_JS = path.join(REPO_ROOT, 'web/static/js/native/index.js');
const WEB_GEO_JS = path.join(REPO_ROOT, 'web/static/js/native/web/geolocation.js');
const CAP_GEO_JS = path.join(REPO_ROOT, 'web/static/js/native/capacitor/geolocation.js');

function loadEnv({ capacitor, navigator } = {}) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'http://app.example.test/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const { window } = dom;
    if (capacitor !== undefined) window.Capacitor = capacitor;
    if (navigator !== undefined) {
        // JSDOM's navigator is read-only; install on the alternate accessor used
        // by web/geolocation.js. The impl reads window.navigator, so we replace
        // its navigator.geolocation property.
        try {
            Object.defineProperty(window.navigator, 'geolocation', {
                value: navigator.geolocation,
                configurable: true,
            });
        } catch (_) {
            // Fallback for jsdom versions where the property is locked
            window.navigator.geolocation = navigator.geolocation;
        }
    }
    const evalFile = (file) => {
        const src = fs.readFileSync(file, 'utf8');
        window.eval(`${src}\n//# sourceURL=file://${file}`);
    };
    evalFile(NATIVE_INDEX_JS);
    evalFile(WEB_GEO_JS);
    evalFile(CAP_GEO_JS);
    return { window, cleanup: () => dom.window.close() };
}

describe('native/web/geolocation.js — web impl', () => {
    let env;
    afterEach(() => { if (env) env.cleanup(); env = null; });

    it('is selected as window.Geolocation when Capacitor is absent', () => {
        env = loadEnv();
        const webImpl = env.window.Geolocation.__native.getImpl('Geolocation', 'web');
        expect(env.window.Geolocation).toBe(webImpl);
        expect(typeof env.window.Geolocation.getCurrentPosition).toBe('function');
    });

    it('resolves with a normalized { coords, timestamp } payload on success', async () => {
        const fakeGeo = {
            getCurrentPosition: (success) => {
                success({
                    coords: { latitude: 52.5, longitude: 13.4, accuracy: 10 },
                    timestamp: 1700000000000,
                });
            },
        };
        env = loadEnv({ navigator: { geolocation: fakeGeo } });
        const pos = await env.window.Geolocation.getCurrentPosition();
        expect(pos.coords.latitude).toBe(52.5);
        expect(pos.coords.longitude).toBe(13.4);
        expect(pos.coords.accuracy).toBe(10);
        expect(pos.timestamp).toBe(1700000000000);
    });

    it('normalizes PERMISSION_DENIED (code 1) errors', async () => {
        const fakeGeo = {
            getCurrentPosition: (_, error) => {
                error({ code: 1, message: 'User denied geolocation' });
            },
        };
        env = loadEnv({ navigator: { geolocation: fakeGeo } });
        let caught;
        try { await env.window.Geolocation.getCurrentPosition(); }
        catch (e) { caught = e; }
        expect(caught).toBeDefined();
        expect(caught.name).toBe('GeolocationError');
        expect(caught.code).toBe('PERMISSION_DENIED');
        expect(caught.message).toBe('User denied geolocation');
    });

    it('normalizes TIMEOUT (code 3) errors', async () => {
        const fakeGeo = {
            getCurrentPosition: (_, error) => {
                error({ code: 3, message: 'Timed out' });
            },
        };
        env = loadEnv({ navigator: { geolocation: fakeGeo } });
        let caught;
        try { await env.window.Geolocation.getCurrentPosition({ timeoutMs: 100 }); }
        catch (e) { caught = e; }
        expect(caught.code).toBe('TIMEOUT');
    });

    it('normalizes POSITION_UNAVAILABLE (code 2) errors', async () => {
        const fakeGeo = {
            getCurrentPosition: (_, error) => {
                error({ code: 2, message: 'No signal' });
            },
        };
        env = loadEnv({ navigator: { geolocation: fakeGeo } });
        let caught;
        try { await env.window.Geolocation.getCurrentPosition(); }
        catch (e) { caught = e; }
        expect(caught.code).toBe('POSITION_UNAVAILABLE');
    });

    it('rejects with POSITION_UNAVAILABLE when navigator.geolocation is missing', async () => {
        env = loadEnv();
        // navigator.geolocation will be absent or non-functional in plain JSDOM
        try {
            Object.defineProperty(env.window.navigator, 'geolocation', {
                value: undefined, configurable: true,
            });
        } catch (_) { /* ignore */ }
        let caught;
        try { await env.window.Geolocation.getCurrentPosition(); }
        catch (e) { caught = e; }
        expect(caught).toBeDefined();
        expect(caught.code).toBe('POSITION_UNAVAILABLE');
    });

    it('passes timeoutMs and maximumAgeMs through to the native API options', async () => {
        let capturedOpts = null;
        const fakeGeo = {
            getCurrentPosition: (success, _err, opts) => {
                capturedOpts = opts;
                success({ coords: { latitude: 0, longitude: 0, accuracy: 1 }, timestamp: 0 });
            },
        };
        env = loadEnv({ navigator: { geolocation: fakeGeo } });
        await env.window.Geolocation.getCurrentPosition({ timeoutMs: 5000, maximumAgeMs: 1000 });
        expect(capturedOpts).toEqual({ timeout: 5000, maximumAge: 1000 });
    });
});

describe('native/capacitor/geolocation.js — Capacitor impl', () => {
    let env;
    afterEach(() => {
        if (env) env.cleanup();
        env = null;
    });

    function makeCapacitor({ getCurrentPosition }) {
        return {
            isNativePlatform: () => true,
            Plugins: {
                Geolocation: { getCurrentPosition },
            },
        };
    }

    it('is selected as window.Geolocation when isNativePlatform() is true', () => {
        env = loadEnv({
            capacitor: makeCapacitor({
                getCurrentPosition: vi.fn(),
            }),
        });
        const capImpl = env.window.Geolocation.__native.getImpl('Geolocation', 'capacitor');
        expect(env.window.Geolocation).toBe(capImpl);
        expect(typeof env.window.Geolocation.getCurrentPosition).toBe('function');
    });

    it('resolves with a normalized { coords, timestamp } payload on success', async () => {
        const plugin = vi.fn().mockResolvedValue({
            coords: { latitude: 52.5, longitude: 13.4, accuracy: 5 },
            timestamp: 1700000000000,
        });
        env = loadEnv({ capacitor: makeCapacitor({ getCurrentPosition: plugin }) });
        const pos = await env.window.Geolocation.getCurrentPosition();
        expect(pos.coords).toEqual({ latitude: 52.5, longitude: 13.4, accuracy: 5 });
        expect(pos.timestamp).toBe(1700000000000);
        expect(plugin).toHaveBeenCalledTimes(1);
    });

    it('returns cached position on a second call within 1h without re-invoking the plugin', async () => {
        const plugin = vi.fn().mockResolvedValue({
            coords: { latitude: 1, longitude: 2, accuracy: 3 },
            timestamp: 1700000000000,
        });
        env = loadEnv({ capacitor: makeCapacitor({ getCurrentPosition: plugin }) });
        const first = await env.window.Geolocation.getCurrentPosition();
        const second = await env.window.Geolocation.getCurrentPosition();
        expect(second).toEqual(first);
        expect(plugin).toHaveBeenCalledTimes(1);
    });

    it('re-invokes the plugin after the 1h cache TTL expires', async () => {
        const plugin = vi.fn().mockResolvedValue({
            coords: { latitude: 1, longitude: 2, accuracy: 3 },
            timestamp: 1700000000000,
        });
        env = loadEnv({ capacitor: makeCapacitor({ getCurrentPosition: plugin }) });
        // Patch the JSDOM window's Date.now — the impl reads Date from its
        // host window scope, not from Node's globals.
        const realNow = env.window.Date.now;
        let fakeTime = 1700000000000;
        env.window.Date.now = () => fakeTime;
        try {
            await env.window.Geolocation.getCurrentPosition();
            fakeTime += (60 * 60 * 1000) + 1;
            await env.window.Geolocation.getCurrentPosition();
            expect(plugin).toHaveBeenCalledTimes(2);
        } finally {
            env.window.Date.now = realNow;
        }
    });

    it('normalizes permission-denied errors by message', async () => {
        const plugin = vi.fn().mockRejectedValue(new Error('Location permission was denied'));
        env = loadEnv({ capacitor: makeCapacitor({ getCurrentPosition: plugin }) });
        let caught;
        try { await env.window.Geolocation.getCurrentPosition(); }
        catch (e) { caught = e; }
        expect(caught.code).toBe('PERMISSION_DENIED');
        expect(caught.name).toBe('GeolocationError');
    });

    it('normalizes timeout errors by message', async () => {
        const plugin = vi.fn().mockRejectedValue(new Error('Request timed out'));
        env = loadEnv({ capacitor: makeCapacitor({ getCurrentPosition: plugin }) });
        let caught;
        try { await env.window.Geolocation.getCurrentPosition(); }
        catch (e) { caught = e; }
        expect(caught.code).toBe('TIMEOUT');
    });

    it('normalizes numeric .code errors thrown by the web fallback inside the plugin', async () => {
        const err = new Error('User denied');
        err.code = 1;
        const plugin = vi.fn().mockRejectedValue(err);
        env = loadEnv({ capacitor: makeCapacitor({ getCurrentPosition: plugin }) });
        let caught;
        try { await env.window.Geolocation.getCurrentPosition(); }
        catch (e) { caught = e; }
        expect(caught.code).toBe('PERMISSION_DENIED');
    });

    it('rejects with POSITION_UNAVAILABLE when the Capacitor plugin is missing', async () => {
        env = loadEnv({ capacitor: { isNativePlatform: () => true, Plugins: {} } });
        let caught;
        try { await env.window.Geolocation.getCurrentPosition(); }
        catch (e) { caught = e; }
        expect(caught).toBeDefined();
        expect(caught.code).toBe('POSITION_UNAVAILABLE');
    });

    it('_resetCache clears the cached position', async () => {
        const plugin = vi.fn().mockResolvedValue({
            coords: { latitude: 1, longitude: 2, accuracy: 3 },
            timestamp: 1700000000000,
        });
        env = loadEnv({ capacitor: makeCapacitor({ getCurrentPosition: plugin }) });
        await env.window.Geolocation.getCurrentPosition();
        env.window.Geolocation._resetCache();
        await env.window.Geolocation.getCurrentPosition();
        expect(plugin).toHaveBeenCalledTimes(2);
    });

    it('passes timeoutMs and maximumAgeMs through to the plugin options', async () => {
        const plugin = vi.fn().mockResolvedValue({
            coords: { latitude: 0, longitude: 0, accuracy: 1 }, timestamp: 0,
        });
        env = loadEnv({ capacitor: makeCapacitor({ getCurrentPosition: plugin }) });
        await env.window.Geolocation.getCurrentPosition({ timeoutMs: 5000, maximumAgeMs: 1000 });
        expect(plugin).toHaveBeenCalledWith(expect.objectContaining({
            timeout: 5000,
            maximumAge: 1000,
        }));
    });
});

describe('native/index.js — runtime selector after Task 2', () => {
    let env;
    afterEach(() => { if (env) env.cleanup(); env = null; });

    it('selects the web impl when Capacitor.isNativePlatform() is false', () => {
        env = loadEnv({ capacitor: { isNativePlatform: () => false } });
        const web = env.window.Geolocation.__native.getImpl('Geolocation', 'web');
        expect(env.window.Geolocation).toBe(web);
    });

    it('selects the Capacitor impl when Capacitor.isNativePlatform() is true', () => {
        env = loadEnv({ capacitor: { isNativePlatform: () => true, Plugins: { Geolocation: {} } } });
        const cap = env.window.Geolocation.__native.getImpl('Geolocation', 'capacitor');
        expect(env.window.Geolocation).toBe(cap);
    });

    it('both impls are registered regardless of which one is selected', () => {
        env = loadEnv();
        const web = env.window.Geolocation.__native.getImpl('Geolocation', 'web');
        const cap = env.window.Geolocation.__native.getImpl('Geolocation', 'capacitor');
        expect(web).toBeDefined();
        expect(cap).toBeDefined();
        expect(typeof web.getCurrentPosition).toBe('function');
        expect(typeof cap.getCurrentPosition).toBe('function');
    });

    it('registerImpl rejects unknown platforms', () => {
        env = loadEnv();
        expect(() => {
            env.window.Geolocation.__native.registerImpl('Geolocation', 'ios', {});
        }).toThrow(/platform must be "web" or "capacitor"/);
    });
});
