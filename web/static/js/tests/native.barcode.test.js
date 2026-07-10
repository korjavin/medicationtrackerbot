/**
 * native.barcode.test.js
 *
 * Pins the Phase 2b Task 4 Barcode abstraction contract: a web impl that
 * wraps window.BarcodeDetector with a ZXing fallback for still images, a
 * Capacitor impl wrapping window.Capacitor.Plugins.BarcodeScanner, both
 * returning { format, rawValue } on success or null when nothing was
 * decoded / the user canceled. The runtime selector in native/index.js
 * picks one based on isNativePlatform().
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
const WEB_BC_JS = path.join(REPO_ROOT, 'web/static/js/native/web/barcode.js');
const CAP_BC_JS = path.join(REPO_ROOT, 'web/static/js/native/capacitor/barcode.js');

function loadEnv({ capacitor, barcodeDetector, zxing } = {}) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'http://app.example.test/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const { window } = dom;
    if (capacitor !== undefined) window.Capacitor = capacitor;
    if (barcodeDetector !== undefined) window.BarcodeDetector = barcodeDetector;
    if (zxing !== undefined) window.ZXing = zxing;
    const evalFile = (file) => {
        const src = fs.readFileSync(file, 'utf8');
        window.eval(`${src}\n//# sourceURL=file://${file}`);
    };
    evalFile(NATIVE_INDEX_JS);
    evalFile(WEB_BC_JS);
    evalFile(CAP_BC_JS);
    return { window, cleanup: () => dom.window.close() };
}

function makeFakeVideo(window) {
    const v = window.document.createElement('video');
    return v;
}
function makeFakeImage(window) {
    const i = window.document.createElement('img');
    return i;
}

describe('native/web/barcode.js — web impl', () => {
    let env;
    afterEach(() => { if (env) env.cleanup(); env = null; });

    it('is selected as window.Barcode when Capacitor is absent', () => {
        env = loadEnv();
        const webImpl = env.window.Barcode.__native.getImpl('Barcode', 'web');
        expect(env.window.Barcode).toBe(webImpl);
        expect(typeof env.window.Barcode.scan).toBe('function');
    });

    it('uses BarcodeDetector on a video source and returns { format, rawValue }', async () => {
        const detect = vi.fn().mockResolvedValue([
            { rawValue: '0123456789012', format: 'ean_13' },
        ]);
        const ctor = vi.fn(function () { this.detect = detect; });
        env = loadEnv({ barcodeDetector: ctor });
        const video = makeFakeVideo(env.window);
        const result = await env.window.Barcode.scan({ source: video });
        expect(ctor).toHaveBeenCalledTimes(1);
        expect(detect).toHaveBeenCalledWith(video);
        expect(result).toEqual({ format: 'ean_13', rawValue: '0123456789012' });
    });

    it('passes the formats list through to BarcodeDetector', async () => {
        const detect = vi.fn().mockResolvedValue([
            { rawValue: 'abc', format: 'qr_code' },
        ]);
        const ctor = vi.fn(function (opts) {
            this.detect = detect;
            this._formats = opts && opts.formats;
        });
        env = loadEnv({ barcodeDetector: ctor });
        const video = makeFakeVideo(env.window);
        const result = await env.window.Barcode.scan({
            source: video,
            formats: ['qr_code', 'ean_13'],
        });
        expect(ctor).toHaveBeenCalledWith({ formats: ['qr_code', 'ean_13'] });
        expect(result).toEqual({ format: 'qr_code', rawValue: 'abc' });
    });

    it('returns null on a video source when nothing is decoded (cancel-equivalent)', async () => {
        const detect = vi.fn().mockResolvedValue([]);
        const ctor = vi.fn(function () { this.detect = detect; });
        env = loadEnv({ barcodeDetector: ctor });
        const result = await env.window.Barcode.scan({ source: makeFakeVideo(env.window) });
        expect(result).toBeNull();
    });

    it('returns null when BarcodeDetector.detect throws on a video source', async () => {
        const detect = vi.fn().mockRejectedValue(new Error('decode failed'));
        const ctor = vi.fn(function () { this.detect = detect; });
        env = loadEnv({ barcodeDetector: ctor });
        const result = await env.window.Barcode.scan({ source: makeFakeVideo(env.window) });
        expect(result).toBeNull();
    });

    it('falls back to ZXing when BarcodeDetector is undefined and the source is an image', async () => {
        const decode = vi.fn().mockResolvedValue({ text: '5901234123457', format: 4 });
        const reset = vi.fn();
        function FakeReader() { this.decodeFromImageElement = decode; this.reset = reset; }
        env = loadEnv({
            barcodeDetector: undefined,
            zxing: { BrowserMultiFormatReader: FakeReader },
        });
        const image = makeFakeImage(env.window);
        const result = await env.window.Barcode.scan({ source: image });
        expect(decode).toHaveBeenCalledWith(image);
        expect(result).toEqual({ format: '4', rawValue: '5901234123457' });
    });

    it('uses BarcodeDetector first, then ZXing fallback if it returned no results', async () => {
        const detect = vi.fn().mockResolvedValue([]); // detector finds nothing
        const ctor = vi.fn(function () { this.detect = detect; });
        const decode = vi.fn().mockResolvedValue({ text: '5901234123457', format: 4 });
        function FakeReader() { this.decodeFromImageElement = decode; this.reset = vi.fn(); }
        env = loadEnv({
            barcodeDetector: ctor,
            zxing: { BrowserMultiFormatReader: FakeReader },
        });
        const image = makeFakeImage(env.window);
        const result = await env.window.Barcode.scan({ source: image });
        expect(detect).toHaveBeenCalledWith(image);
        expect(decode).toHaveBeenCalledWith(image);
        expect(result).toEqual({ format: '4', rawValue: '5901234123457' });
    });

    it('returns null when both BarcodeDetector and ZXing find nothing in an image', async () => {
        const detect = vi.fn().mockResolvedValue([]);
        const ctor = vi.fn(function () { this.detect = detect; });
        const decode = vi.fn().mockRejectedValue(new Error('NotFoundException'));
        function FakeReader() { this.decodeFromImageElement = decode; this.reset = vi.fn(); }
        env = loadEnv({
            barcodeDetector: ctor,
            zxing: { BrowserMultiFormatReader: FakeReader },
        });
        const image = makeFakeImage(env.window);
        const result = await env.window.Barcode.scan({ source: image });
        expect(result).toBeNull();
    });

    it('rejects when no source is provided', async () => {
        env = loadEnv();
        let caught;
        try { await env.window.Barcode.scan({}); } catch (e) { caught = e; }
        expect(caught).toBeDefined();
        expect(caught.name).toBe('BarcodeError');
    });

    it('rejects with a typed error when the source type is unsupported', async () => {
        env = loadEnv();
        let caught;
        try { await env.window.Barcode.scan({ source: 'oops-not-a-source' }); }
        catch (e) { caught = e; }
        expect(caught).toBeDefined();
        expect(caught.name).toBe('BarcodeError');
    });

    it('caches the BarcodeDetector instance across scan() calls with the same formats (perf regression guard)', async () => {
        // The live food-scanner loop calls scan() ~5x/sec on the same video
        // source and same formats list. Allocating a new BarcodeDetector per
        // call (the pre-Phase-2b code path) measurably regresses CPU on
        // lower-end Android, so the abstraction must hold one detector per
        // unique formats key for the page lifetime.
        const detect = vi.fn().mockResolvedValue([{ rawValue: '0000', format: 'ean_13' }]);
        const ctor = vi.fn(function () { this.detect = detect; });
        env = loadEnv({ barcodeDetector: ctor });
        const video = makeFakeVideo(env.window);
        const formats = ['qr_code', 'ean_13', 'upc_a'];
        await env.window.Barcode.scan({ source: video, formats });
        await env.window.Barcode.scan({ source: video, formats });
        await env.window.Barcode.scan({ source: video, formats });
        expect(ctor).toHaveBeenCalledTimes(1);
        expect(detect).toHaveBeenCalledTimes(3);
    });

    it('uses a separate cached detector for a different formats list', async () => {
        const detect = vi.fn().mockResolvedValue([{ rawValue: '1234', format: 'qr_code' }]);
        const ctor = vi.fn(function () { this.detect = detect; });
        env = loadEnv({ barcodeDetector: ctor });
        const video = makeFakeVideo(env.window);
        await env.window.Barcode.scan({ source: video, formats: ['qr_code'] });
        await env.window.Barcode.scan({ source: video, formats: ['ean_13', 'upc_a'] });
        await env.window.Barcode.scan({ source: video, formats: ['qr_code'] });
        expect(ctor).toHaveBeenCalledTimes(2);
    });

    it('handles BarcodeDetector constructors that throw with formats (default fallback)', async () => {
        const detect = vi.fn().mockResolvedValue([
            { rawValue: '999', format: 'qr_code' },
        ]);
        let constructorCallCount = 0;
        const ctor = vi.fn(function (opts) {
            constructorCallCount++;
            if (opts && opts.formats && constructorCallCount === 1) {
                throw new Error('formats not supported');
            }
            this.detect = detect;
        });
        env = loadEnv({ barcodeDetector: ctor });
        const video = makeFakeVideo(env.window);
        const result = await env.window.Barcode.scan({ source: video });
        expect(ctor).toHaveBeenCalledTimes(2);
        expect(result).toEqual({ format: 'qr_code', rawValue: '999' });
    });

    it('revokes the object URL after decoding a Blob source (no leaked URL on success)', async () => {
        const detect = vi.fn().mockResolvedValue([{ rawValue: '777', format: 'ean_13' }]);
        const ctor = vi.fn(function () { this.detect = detect; });
        env = loadEnv({ barcodeDetector: ctor });
        const createObjectURL = vi.fn().mockReturnValue('blob:fake/url');
        const revokeObjectURL = vi.fn();
        env.window.URL.createObjectURL = createObjectURL;
        env.window.URL.revokeObjectURL = revokeObjectURL;

        // jsdom's HTMLImageElement does not auto-fire load when src is a fake
        // blob: URL, so install a small shim that triggers onload synchronously.
        const origImage = env.window.Image;
        env.window.Image = function () {
            const i = new origImage();
            Object.defineProperty(i, 'src', {
                set(_v) { if (typeof this.onload === 'function') this.onload(); },
            });
            return i;
        };

        const fakeBlob = new env.window.Blob(['x'], { type: 'image/jpeg' });
        await env.window.Barcode.scan({ source: fakeBlob });
        expect(createObjectURL).toHaveBeenCalledTimes(1);
        // Revoked at least once after the success path settles — the object
        // URL is not leaked across decodes.
        expect(revokeObjectURL).toHaveBeenCalled();
        expect(revokeObjectURL.mock.calls[0][0]).toBe('blob:fake/url');
    });

    it('hasNativeScanner() is false — the browser has no full-screen scanner UI', () => {
        env = loadEnv();
        expect(env.window.Barcode.hasNativeScanner()).toBe(false);
    });

    it('supportsLiveScan() follows window.BarcodeDetector presence, probed at call time', () => {
        env = loadEnv();
        expect(env.window.Barcode.supportsLiveScan()).toBe(false);
        env.window.BarcodeDetector = function () {};
        expect(env.window.Barcode.supportsLiveScan()).toBe(true);
        delete env.window.BarcodeDetector;
        expect(env.window.Barcode.supportsLiveScan()).toBe(false);
    });

    it('rejects a Response object as an unsupported source (not a Blob)', async () => {
        env = loadEnv();
        // Fabricate a Response-shaped object: duck-typed arrayBuffer+type but
        // constructor.name === 'Response'. Before the fix, isBlob() would
        // accept this and silently fail inside URL.createObjectURL.
        const fakeResponse = {
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
            type: 'basic',
        };
        Object.defineProperty(fakeResponse, 'constructor', {
            value: { name: 'Response' },
        });
        let caught;
        try { await env.window.Barcode.scan({ source: fakeResponse }); }
        catch (e) { caught = e; }
        expect(caught).toBeDefined();
        expect(caught.name).toBe('BarcodeError');
        expect(/unsupported source/i.test(caught.message)).toBe(true);
    });
});

describe('native/capacitor/barcode.js — Capacitor impl', () => {
    let env;
    afterEach(() => { if (env) env.cleanup(); env = null; });

    function makeCapacitor({ scan }) {
        return {
            isNativePlatform: () => true,
            Plugins: {
                BarcodeScanner: { scan },
            },
        };
    }

    it('is selected as window.Barcode when isNativePlatform() is true', () => {
        env = loadEnv({
            capacitor: makeCapacitor({ scan: vi.fn() }),
        });
        const capImpl = env.window.Barcode.__native.getImpl('Barcode', 'capacitor');
        expect(env.window.Barcode).toBe(capImpl);
    });

    it('scan() opens MLKit and returns the first barcode as { format, rawValue }', async () => {
        const scan = vi.fn().mockResolvedValue({
            barcodes: [
                { rawValue: '0123456789012', format: 'EAN_13', displayValue: '0123456789012' },
            ],
        });
        env = loadEnv({ capacitor: makeCapacitor({ scan }) });
        const result = await env.window.Barcode.scan();
        expect(scan).toHaveBeenCalledWith({});
        expect(result).toEqual({ format: 'EAN_13', rawValue: '0123456789012' });
    });

    it('uppercases the formats list when handing it to MLKit', async () => {
        const scan = vi.fn().mockResolvedValue({
            barcodes: [{ rawValue: 'x', format: 'QR_CODE' }],
        });
        env = loadEnv({ capacitor: makeCapacitor({ scan }) });
        await env.window.Barcode.scan({ formats: ['qr_code', 'ean_13'] });
        expect(scan).toHaveBeenCalledWith({ formats: ['QR_CODE', 'EAN_13'] });
    });

    it('returns null when MLKit resolves with an empty barcodes array (user dismiss)', async () => {
        const scan = vi.fn().mockResolvedValue({ barcodes: [] });
        env = loadEnv({ capacitor: makeCapacitor({ scan }) });
        const result = await env.window.Barcode.scan();
        expect(result).toBeNull();
    });

    it('returns null when MLKit rejects with a "User cancelled" message', async () => {
        const scan = vi.fn().mockRejectedValue(new Error('User cancelled scan'));
        env = loadEnv({ capacitor: makeCapacitor({ scan }) });
        const result = await env.window.Barcode.scan();
        expect(result).toBeNull();
    });

    it('returns null on a generic "canceled" rejection (single-l variant)', async () => {
        const scan = vi.fn().mockRejectedValue(new Error('scan canceled'));
        env = loadEnv({ capacitor: makeCapacitor({ scan }) });
        const result = await env.window.Barcode.scan();
        expect(result).toBeNull();
    });

    it('normalizes permission-denied errors to BarcodeError / PERMISSION_DENIED', async () => {
        const scan = vi.fn().mockRejectedValue(new Error('Camera permission was denied'));
        env = loadEnv({ capacitor: makeCapacitor({ scan }) });
        let caught;
        try { await env.window.Barcode.scan(); }
        catch (e) { caught = e; }
        expect(caught).toBeDefined();
        expect(caught.name).toBe('BarcodeError');
        expect(caught.code).toBe('PERMISSION_DENIED');
    });

    it('hasNativeScanner() is true and supportsLiveScan() is false (MLKit owns the UI)', () => {
        env = loadEnv({ capacitor: makeCapacitor({ scan: vi.fn() }), barcodeDetector: function () {} });
        expect(env.window.Barcode.hasNativeScanner()).toBe(true);
        // Even with a BarcodeDetector present in the WebView, the in-app frame
        // loop must never run in the shell.
        expect(env.window.Barcode.supportsLiveScan()).toBe(false);
    });

    it('rejects with UNAVAILABLE when Capacitor.Plugins.BarcodeScanner is missing', async () => {
        env = loadEnv({ capacitor: { isNativePlatform: () => true, Plugins: {} } });
        let caught;
        try { await env.window.Barcode.scan(); }
        catch (e) { caught = e; }
        expect(caught).toBeDefined();
        expect(caught.name).toBe('BarcodeError');
        expect(caught.code).toBe('UNAVAILABLE');
    });
});

describe('native/index.js — runtime selector after Task 4', () => {
    let env;
    afterEach(() => { if (env) env.cleanup(); env = null; });

    it('selects the web Barcode impl when Capacitor.isNativePlatform() is false', () => {
        env = loadEnv({ capacitor: { isNativePlatform: () => false } });
        const web = env.window.Barcode.__native.getImpl('Barcode', 'web');
        expect(env.window.Barcode).toBe(web);
    });

    it('selects the Capacitor Barcode impl when Capacitor.isNativePlatform() is true', () => {
        env = loadEnv({
            capacitor: { isNativePlatform: () => true, Plugins: { BarcodeScanner: {} } },
        });
        const cap = env.window.Barcode.__native.getImpl('Barcode', 'capacitor');
        expect(env.window.Barcode).toBe(cap);
    });

    it('registers both web and capacitor impls regardless of selection', () => {
        env = loadEnv();
        const web = env.window.Barcode.__native.getImpl('Barcode', 'web');
        const cap = env.window.Barcode.__native.getImpl('Barcode', 'capacitor');
        expect(typeof web.scan).toBe('function');
        expect(typeof cap.scan).toBe('function');
    });

    it('both impls expose the platform-decision methods', () => {
        env = loadEnv();
        const web = env.window.Barcode.__native.getImpl('Barcode', 'web');
        const cap = env.window.Barcode.__native.getImpl('Barcode', 'capacitor');
        expect(web.hasNativeScanner()).toBe(false);
        expect(web.supportsLiveScan()).toBe(false);
        expect(cap.hasNativeScanner()).toBe(true);
        expect(cap.supportsLiveScan()).toBe(false);
    });
});
