/**
 * native.media-capture.test.js
 *
 * Pins the Phase 2b Task 3 MediaCapture abstraction contract: a web impl
 * wrapping getUserMedia + canvas snapshot + hidden file input, a Capacitor
 * impl wrapping window.Capacitor.Plugins.Camera, both returning Blobs (or
 * null on cancel) and normalizing errors to { name, code, message }. The
 * runtime selector in native/index.js picks one based on isNativePlatform().
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const NATIVE_INDEX_JS = path.join(REPO_ROOT, 'web/static/js/native/index.js');
const WEB_MC_JS = path.join(REPO_ROOT, 'web/static/js/native/web/media-capture.js');
const CAP_MC_JS = path.join(REPO_ROOT, 'web/static/js/native/capacitor/media-capture.js');

function loadEnv({ capacitor, mediaDevices } = {}) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'http://app.example.test/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const { window } = dom;
    if (capacitor !== undefined) window.Capacitor = capacitor;
    if (mediaDevices !== undefined) {
        try {
            Object.defineProperty(window.navigator, 'mediaDevices', {
                value: mediaDevices,
                configurable: true,
            });
        } catch (_) {
            window.navigator.mediaDevices = mediaDevices;
        }
    }
    const evalFile = (file) => {
        const src = fs.readFileSync(file, 'utf8');
        window.eval(`${src}\n//# sourceURL=file://${file}`);
    };
    evalFile(NATIVE_INDEX_JS);
    evalFile(WEB_MC_JS);
    evalFile(CAP_MC_JS);
    return { window, cleanup: () => dom.window.close() };
}

// JSDOM doesn't ship HTMLMediaElement.play / canvas.getContext('2d') /
// canvas.toBlob. installCanvasStubs swaps document.createElement so the
// abstraction's video + canvas use a controllable mock pair. Returns helpers
// the test can use to drive the mock.
function installCanvasStubs(window, { blob } = {}) {
    const origCreate = window.document.createElement.bind(window.document);
    const realBlob = blob || new window.Blob(['fake-image'], { type: 'image/jpeg' });
    const log = { videos: [], canvases: [], inputs: [] };

    window.document.createElement = function (tag) {
        const el = origCreate(tag);
        if (tag === 'video') {
            el.play = vi.fn().mockResolvedValue(undefined);
            // Override the video src setter so we can capture the stream.
            Object.defineProperty(el, 'srcObject', {
                configurable: true,
                set(v) { this._stream = v; },
                get() { return this._stream; },
            });
            Object.defineProperty(el, 'videoWidth', {
                configurable: true, get: () => 320,
            });
            Object.defineProperty(el, 'videoHeight', {
                configurable: true, get: () => 240,
            });
            log.videos.push(el);
        } else if (tag === 'canvas') {
            el.getContext = vi.fn(() => ({
                drawImage: vi.fn(),
            }));
            el.toBlob = vi.fn((cb) => cb(realBlob));
            log.canvases.push(el);
        } else if (tag === 'input') {
            el.click = vi.fn();
            log.inputs.push(el);
        }
        return el;
    };

    return { log, restore: () => { window.document.createElement = origCreate; } };
}

describe('native/web/media-capture.js — web impl', () => {
    let env;
    afterEach(() => { if (env) env.cleanup(); env = null; });

    it('is selected as window.MediaCapture when Capacitor is absent', () => {
        env = loadEnv();
        const webImpl = env.window.MediaCapture.__native.getImpl('MediaCapture', 'web');
        expect(env.window.MediaCapture).toBe(webImpl);
        expect(typeof env.window.MediaCapture.takePhoto).toBe('function');
        expect(typeof env.window.MediaCapture.pickPhoto).toBe('function');
    });

    it('takePhoto opens getUserMedia with the rear camera and resolves with a Blob', async () => {
        const track = { stop: vi.fn() };
        const stream = { getTracks: () => [track] };
        const getUserMedia = vi.fn().mockResolvedValue(stream);
        env = loadEnv({ mediaDevices: { getUserMedia } });
        const stubs = installCanvasStubs(env.window);
        try {
            const blob = await env.window.MediaCapture.takePhoto();
            expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({
                audio: false,
                video: expect.objectContaining({ facingMode: { ideal: 'environment' } }),
            }));
            expect(blob).toBeInstanceOf(env.window.Blob);
            expect(track.stop).toHaveBeenCalledTimes(1);
            expect(stubs.log.videos[0]._stream).toBe(stream);
        } finally {
            stubs.restore();
        }
    });

    it('takePhoto normalizes NotAllowedError into PERMISSION_DENIED', async () => {
        const err = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
        const getUserMedia = vi.fn().mockRejectedValue(err);
        env = loadEnv({ mediaDevices: { getUserMedia } });
        const stubs = installCanvasStubs(env.window);
        let caught;
        try {
            try { await env.window.MediaCapture.takePhoto(); }
            catch (e) { caught = e; }
        } finally { stubs.restore(); }
        expect(caught).toBeDefined();
        expect(caught.name).toBe('MediaCaptureError');
        expect(caught.code).toBe('PERMISSION_DENIED');
    });

    it('takePhoto rejects with UNAVAILABLE when mediaDevices is missing', async () => {
        env = loadEnv();
        try {
            Object.defineProperty(env.window.navigator, 'mediaDevices', {
                value: undefined, configurable: true,
            });
        } catch (_) { /* ignore */ }
        let caught;
        try { await env.window.MediaCapture.takePhoto(); }
        catch (e) { caught = e; }
        expect(caught).toBeDefined();
        expect(caught.code).toBe('UNAVAILABLE');
        expect(caught.name).toBe('MediaCaptureError');
    });

    it('takePhoto stops the stream tracks even on canvas failure', async () => {
        const track = { stop: vi.fn() };
        const stream = { getTracks: () => [track] };
        const getUserMedia = vi.fn().mockResolvedValue(stream);
        env = loadEnv({ mediaDevices: { getUserMedia } });
        const origCreate = env.window.document.createElement.bind(env.window.document);
        env.window.document.createElement = function (tag) {
            const el = origCreate(tag);
            if (tag === 'video') {
                el.play = vi.fn().mockResolvedValue(undefined);
                Object.defineProperty(el, 'srcObject', {
                    configurable: true, set(v) { this._s = v; }, get() { return this._s; },
                });
            } else if (tag === 'canvas') {
                // Force a failure by returning no context.
                el.getContext = vi.fn(() => null);
            }
            return el;
        };
        let caught;
        try { await env.window.MediaCapture.takePhoto(); }
        catch (e) { caught = e; }
        expect(caught).toBeDefined();
        expect(caught.name).toBe('MediaCaptureError');
        expect(track.stop).toHaveBeenCalledTimes(1);
    });

    it('pickPhoto resolves with the selected File on change', async () => {
        env = loadEnv();
        const stubs = installCanvasStubs(env.window);
        try {
            const promise = env.window.MediaCapture.pickPhoto();
            // The impl created an <input> and called .click(). Find it.
            const input = stubs.log.inputs[stubs.log.inputs.length - 1];
            expect(input).toBeDefined();
            expect(input.click).toHaveBeenCalledTimes(1);
            const file = new env.window.File(['hi'], 'hi.jpg', { type: 'image/jpeg' });
            // Force the files property since JSDOM file inputs disallow direct assignment.
            Object.defineProperty(input, 'files', { configurable: true, value: [file] });
            input.dispatchEvent(new env.window.Event('change'));
            const result = await promise;
            expect(result).toBe(file);
        } finally {
            stubs.restore();
        }
    });

    it('pickPhoto resolves with null when the user cancels (cancel event)', async () => {
        env = loadEnv();
        const stubs = installCanvasStubs(env.window);
        try {
            const promise = env.window.MediaCapture.pickPhoto();
            const input = stubs.log.inputs[stubs.log.inputs.length - 1];
            input.dispatchEvent(new env.window.Event('cancel'));
            const result = await promise;
            expect(result).toBeNull();
        } finally {
            stubs.restore();
        }
    });

    it('pickPhoto resolves with null when change fires with no files', async () => {
        env = loadEnv();
        const stubs = installCanvasStubs(env.window);
        try {
            const promise = env.window.MediaCapture.pickPhoto();
            const input = stubs.log.inputs[stubs.log.inputs.length - 1];
            Object.defineProperty(input, 'files', { configurable: true, value: [] });
            input.dispatchEvent(new env.window.Event('change'));
            const result = await promise;
            expect(result).toBeNull();
        } finally {
            stubs.restore();
        }
    });
});

describe('native/capacitor/media-capture.js — Capacitor impl', () => {
    let env;
    afterEach(() => { if (env) env.cleanup(); env = null; });

    function makeCapacitor({ getPhoto }) {
        return {
            isNativePlatform: () => true,
            Plugins: {
                Camera: { getPhoto },
            },
        };
    }

    it('is selected as window.MediaCapture when isNativePlatform() is true', () => {
        env = loadEnv({
            capacitor: makeCapacitor({ getPhoto: vi.fn() }),
        });
        const capImpl = env.window.MediaCapture.__native.getImpl('MediaCapture', 'capacitor');
        expect(env.window.MediaCapture).toBe(capImpl);
    });

    it('takePhoto calls Camera.getPhoto with source CAMERA and returns a Blob', async () => {
        // base64('hello') = 'aGVsbG8='
        const getPhoto = vi.fn().mockResolvedValue({
            base64String: 'aGVsbG8=',
            format: 'jpeg',
        });
        env = loadEnv({ capacitor: makeCapacitor({ getPhoto }) });
        const blob = await env.window.MediaCapture.takePhoto();
        expect(getPhoto).toHaveBeenCalledWith(expect.objectContaining({
            source: 'CAMERA',
            resultType: 'base64',
        }));
        expect(blob).toBeInstanceOf(env.window.Blob);
        expect(blob.type).toBe('image/jpeg');
        expect(blob.size).toBe(5); // 'hello' is 5 bytes
    });

    it('pickPhoto() with no opts forces CAMERA (matches web impl default where input.capture=environment)', async () => {
        const getPhoto = vi.fn().mockResolvedValue({
            base64String: 'aGVsbG8=', format: 'png',
        });
        env = loadEnv({ capacitor: makeCapacitor({ getPhoto }) });
        const blob = await env.window.MediaCapture.pickPhoto();
        expect(getPhoto).toHaveBeenCalledWith(expect.objectContaining({
            source: 'CAMERA',
            resultType: 'base64',
        }));
        expect(blob.type).toBe('image/png');
    });

    it('pickPhoto({ capture: false }) omits source so the plugin shows the gallery+camera chooser', async () => {
        const getPhoto = vi.fn().mockResolvedValue({
            base64String: 'aGVsbG8=', format: 'png',
        });
        env = loadEnv({ capacitor: makeCapacitor({ getPhoto }) });
        await env.window.MediaCapture.pickPhoto({ capture: false });
        const opts = getPhoto.mock.calls[0][0];
        expect(opts.source).toBeUndefined();
    });

    it('resolves to null when the plugin throws a "User cancelled" error', async () => {
        const getPhoto = vi.fn().mockRejectedValue(new Error('User cancelled photos app'));
        env = loadEnv({ capacitor: makeCapacitor({ getPhoto }) });
        const result = await env.window.MediaCapture.takePhoto();
        expect(result).toBeNull();
    });

    it('resolves to null on iOS-style "User denied photos app cancelled"', async () => {
        const getPhoto = vi.fn().mockRejectedValue(new Error('User cancelled photos'));
        env = loadEnv({ capacitor: makeCapacitor({ getPhoto }) });
        const result = await env.window.MediaCapture.pickPhoto();
        expect(result).toBeNull();
    });

    it('normalizes permission-denied errors to PERMISSION_DENIED', async () => {
        const getPhoto = vi.fn().mockRejectedValue(new Error('Camera permission was denied'));
        env = loadEnv({ capacitor: makeCapacitor({ getPhoto }) });
        let caught;
        try { await env.window.MediaCapture.takePhoto(); }
        catch (e) { caught = e; }
        expect(caught).toBeDefined();
        expect(caught.name).toBe('MediaCaptureError');
        expect(caught.code).toBe('PERMISSION_DENIED');
    });

    it('rejects with UNAVAILABLE when Capacitor.Plugins.Camera is missing', async () => {
        env = loadEnv({ capacitor: { isNativePlatform: () => true, Plugins: {} } });
        let caught;
        try { await env.window.MediaCapture.takePhoto(); }
        catch (e) { caught = e; }
        expect(caught).toBeDefined();
        expect(caught.name).toBe('MediaCaptureError');
        expect(caught.code).toBe('UNAVAILABLE');
    });

    it('falls back to fetching webPath when base64String is absent', async () => {
        const getPhoto = vi.fn().mockResolvedValue({
            webPath: 'blob:http://app/abc',
            format: 'jpeg',
        });
        env = loadEnv({ capacitor: makeCapacitor({ getPhoto }) });
        const fetchBlob = new env.window.Blob(['xyz'], { type: 'image/jpeg' });
        env.window.fetch = vi.fn().mockResolvedValue({
            blob: () => Promise.resolve(fetchBlob),
        });
        const blob = await env.window.MediaCapture.takePhoto();
        expect(env.window.fetch).toHaveBeenCalledWith('blob:http://app/abc');
        expect(blob).toBe(fetchBlob);
    });
});

describe('native/index.js — runtime selector after Task 3', () => {
    let env;
    afterEach(() => { if (env) env.cleanup(); env = null; });

    it('selects the web MediaCapture impl when Capacitor.isNativePlatform() is false', () => {
        env = loadEnv({ capacitor: { isNativePlatform: () => false } });
        const web = env.window.MediaCapture.__native.getImpl('MediaCapture', 'web');
        expect(env.window.MediaCapture).toBe(web);
    });

    it('selects the Capacitor MediaCapture impl when Capacitor.isNativePlatform() is true', () => {
        env = loadEnv({
            capacitor: { isNativePlatform: () => true, Plugins: { Camera: {} } },
        });
        const cap = env.window.MediaCapture.__native.getImpl('MediaCapture', 'capacitor');
        expect(env.window.MediaCapture).toBe(cap);
    });

    it('registers both web and capacitor impls regardless of selection', () => {
        env = loadEnv();
        const web = env.window.MediaCapture.__native.getImpl('MediaCapture', 'web');
        const cap = env.window.MediaCapture.__native.getImpl('MediaCapture', 'capacitor');
        expect(typeof web.takePhoto).toBe('function');
        expect(typeof web.pickPhoto).toBe('function');
        expect(typeof cap.takePhoto).toBe('function');
        expect(typeof cap.pickPhoto).toBe('function');
    });
});
