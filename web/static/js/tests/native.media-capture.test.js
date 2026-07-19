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

    it('openCameraStream resolves with the raw stream and asks for the rear camera', async () => {
        const stream = { getTracks: () => [{ stop: vi.fn() }] };
        const getUserMedia = vi.fn().mockResolvedValue(stream);
        env = loadEnv({ mediaDevices: { getUserMedia } });
        const result = await env.window.MediaCapture.openCameraStream({ facingMode: 'environment' });
        expect(result).toBe(stream);
        expect(getUserMedia).toHaveBeenCalledWith({
            audio: false,
            video: { facingMode: { ideal: 'environment' } },
        });
    });

    it('openCameraStream rejects with UNAVAILABLE when getUserMedia is absent', async () => {
        env = loadEnv({ mediaDevices: {} });
        let caught;
        try { await env.window.MediaCapture.openCameraStream(); }
        catch (e) { caught = e; }
        expect(caught).toBeDefined();
        expect(caught.name).toBe('MediaCaptureError');
        expect(caught.code).toBe('UNAVAILABLE');
    });

    it('openCameraStream normalizes NotAllowedError into PERMISSION_DENIED', async () => {
        const err = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
        env = loadEnv({ mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(err) } });
        let caught;
        try { await env.window.MediaCapture.openCameraStream(); }
        catch (e) { caught = e; }
        expect(caught).toBeDefined();
        expect(caught.name).toBe('MediaCaptureError');
        expect(caught.code).toBe('PERMISSION_DENIED');
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

    // recordAudio() — voice-message capture for the cloud feedback modal
    // (med-dni.2). Returns a { stop, cancel } handle; MediaRecorder lives
    // inside native/ per rule 10. A fake MediaRecorder drives the lifecycle.
    function installMediaRecorder(window) {
        const instances = [];
        function FakeMediaRecorder(stream, opts) {
            this.stream = stream;
            this.mimeType = (opts && opts.mimeType) || 'audio/webm';
            this.state = 'inactive';
            this.ondataavailable = null;
            this.onstop = null;
            this.onerror = null;
            instances.push(this);
        }
        FakeMediaRecorder.prototype.start = function () { this.state = 'recording'; };
        FakeMediaRecorder.prototype.stop = function () {
            this.state = 'inactive';
            if (this.ondataavailable) {
                this.ondataavailable({ data: new window.Blob(['voice'], { type: this.mimeType }) });
            }
            if (this.onstop) this.onstop();
        };
        window.MediaRecorder = FakeMediaRecorder;
        return instances;
    }

    it('recordAudio requests audio-only getUserMedia and returns a { stop, cancel } handle', async () => {
        const track = { stop: vi.fn() };
        const stream = { getTracks: () => [track] };
        const getUserMedia = vi.fn().mockResolvedValue(stream);
        env = loadEnv({ mediaDevices: { getUserMedia } });
        installMediaRecorder(env.window);
        const handle = await env.window.MediaCapture.recordAudio();
        expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
        expect(typeof handle.stop).toBe('function');
        expect(typeof handle.cancel).toBe('function');
    });

    it('recordAudio stop() resolves an audio Blob and releases the mic tracks', async () => {
        const track = { stop: vi.fn() };
        const stream = { getTracks: () => [track] };
        const getUserMedia = vi.fn().mockResolvedValue(stream);
        env = loadEnv({ mediaDevices: { getUserMedia } });
        installMediaRecorder(env.window);
        const handle = await env.window.MediaCapture.recordAudio();
        const blob = await handle.stop();
        expect(blob).toBeInstanceOf(env.window.Blob);
        expect(blob.type).toBe('audio/webm');
        expect(blob.size).toBeGreaterThan(0);
        expect(track.stop).toHaveBeenCalledTimes(1);
    });

    it('recordAudio cancel() releases the mic tracks and stop() then rejects', async () => {
        const track = { stop: vi.fn() };
        const stream = { getTracks: () => [track] };
        const getUserMedia = vi.fn().mockResolvedValue(stream);
        env = loadEnv({ mediaDevices: { getUserMedia } });
        installMediaRecorder(env.window);
        const handle = await env.window.MediaCapture.recordAudio();
        handle.cancel();
        expect(track.stop).toHaveBeenCalledTimes(1);
        let caught;
        try { await handle.stop(); } catch (e) { caught = e; }
        expect(caught).toBeDefined();
        expect(caught.name).toBe('MediaCaptureError');
    });

    it('recordAudio rejects with UNAVAILABLE when MediaRecorder is missing', async () => {
        const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [] });
        env = loadEnv({ mediaDevices: { getUserMedia } });
        // no MediaRecorder installed
        let caught;
        try { await env.window.MediaCapture.recordAudio(); } catch (e) { caught = e; }
        expect(caught).toBeDefined();
        expect(caught.name).toBe('MediaCaptureError');
        expect(caught.code).toBe('UNAVAILABLE');
    });

    it('recordAudio normalizes a getUserMedia NotAllowedError to PERMISSION_DENIED', async () => {
        const err = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
        env = loadEnv({ mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(err) } });
        installMediaRecorder(env.window);
        let caught;
        try { await env.window.MediaCapture.recordAudio(); } catch (e) { caught = e; }
        expect(caught).toBeDefined();
        expect(caught.name).toBe('MediaCaptureError');
        expect(caught.code).toBe('PERMISSION_DENIED');
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

    // Voice recording is web-first; the Capacitor shell has no MediaRecorder
    // path, so the caller hides the Record button on a rejection.
    it('recordAudio always rejects with UNAVAILABLE', async () => {
        env = loadEnv({ capacitor: makeCapacitor({ getPhoto: vi.fn() }) });
        let caught;
        try { await env.window.MediaCapture.recordAudio(); }
        catch (e) { caught = e; }
        expect(caught).toBeDefined();
        expect(caught.name).toBe('MediaCaptureError');
        expect(caught.code).toBe('UNAVAILABLE');
    });

    // The shell has no in-app video modal — MLKit owns the scanner UI — so a
    // raw MediaStream is never obtainable here.
    it('openCameraStream always rejects with UNAVAILABLE', async () => {
        env = loadEnv({ capacitor: makeCapacitor({ getPhoto: vi.fn() }) });
        let caught;
        try { await env.window.MediaCapture.openCameraStream({ facingMode: 'environment' }); }
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

    // requestPermissions seam — Phase 2c addition for the firstrun overlay.
    // The earlier path of calling pickPhoto({capture:false}) to surface the
    // OS prompt also opens the photo picker, which is the wrong UX shape for
    // first-run. requestPermissions wraps Camera.requestPermissions and
    // returns the plugin's { camera, photos } PermissionState shape unchanged
    // so callers can branch on partial grants.
    it('requestPermissions calls Camera.requestPermissions with camera + photos and returns the result', async () => {
        const requestPermissionsFn = vi.fn().mockResolvedValue({ camera: 'granted', photos: 'granted' });
        env = loadEnv({
            capacitor: {
                isNativePlatform: () => true,
                Plugins: { Camera: { requestPermissions: requestPermissionsFn, getPhoto: vi.fn() } },
            },
        });
        const result = await env.window.MediaCapture.requestPermissions();
        expect(requestPermissionsFn).toHaveBeenCalledWith({ permissions: ['camera', 'photos'] });
        expect(result).toEqual({ camera: 'granted', photos: 'granted' });
    });

    it('requestPermissions throws MediaCaptureError UNAVAILABLE when the plugin does not expose requestPermissions', async () => {
        env = loadEnv({
            capacitor: {
                isNativePlatform: () => true,
                Plugins: { Camera: { getPhoto: vi.fn() } }, // no requestPermissions
            },
        });
        let caught;
        try { await env.window.MediaCapture.requestPermissions(); }
        catch (e) { caught = e; }
        expect(caught).toBeDefined();
        expect(caught.name).toBe('MediaCaptureError');
        expect(caught.code).toBe('UNAVAILABLE');
    });

    it('requestPermissions normalizes plugin rejection to MediaCaptureError', async () => {
        const requestPermissionsFn = vi.fn().mockRejectedValue(new Error('Permission denied by user'));
        env = loadEnv({
            capacitor: {
                isNativePlatform: () => true,
                Plugins: { Camera: { requestPermissions: requestPermissionsFn, getPhoto: vi.fn() } },
            },
        });
        let caught;
        try { await env.window.MediaCapture.requestPermissions(); }
        catch (e) { caught = e; }
        expect(caught).toBeDefined();
        expect(caught.name).toBe('MediaCaptureError');
        expect(caught.code).toBe('PERMISSION_DENIED');
    });
});

describe('native/web/media-capture.js — requestPermissions stub', () => {
    let env;
    afterEach(() => { if (env) env.cleanup(); env = null; });

    it('resolves as a granted PermissionState (browsers surface prompts inline at first use)', async () => {
        env = loadEnv();
        const result = await env.window.MediaCapture.requestPermissions();
        expect(result.camera).toBe('granted');
        expect(result.photos).toBe('granted');
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
        expect(typeof web.recordAudio).toBe('function');
        expect(typeof cap.takePhoto).toBe('function');
        expect(typeof cap.pickPhoto).toBe('function');
        expect(typeof cap.recordAudio).toBe('function');
    });
});
