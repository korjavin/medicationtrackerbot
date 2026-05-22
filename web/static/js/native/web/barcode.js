// Web impl of the Barcode abstraction (mobile Phase 2b, Task 4).
//
// scan({ source, formats }) decodes a single barcode/QR from the given source
// — an HTMLVideoElement (live frame), HTMLImageElement / HTMLCanvasElement
// (still), or a Blob/File (will be wrapped in an <img> first). Tries the
// platform-native window.BarcodeDetector when present; for image/canvas/blob
// sources, falls back to window.ZXing.BrowserMultiFormatReader if no barcode
// was found (the legacy "Use Photo" path in features/food/scanner.js).
// Returns { format, rawValue } on success or null when nothing was decoded
// (= "cancel" for our purposes — the user picked an image without a barcode,
// or a live frame had no readable code).
//
// Lifted from features/food/scanner.js:40-64 (BarcodeDetector creation),
// :102 (detect call in the live loop), :193-204 (ZXing fallback) — no
// behavior change, just relocated behind the abstraction so feature code can
// call the same Barcode.scan() on both web and Capacitor builds.
//
// Load order: must be after web/static/js/native/index.js so the foundation's
// registerImpl helper is available.
(function () {
    'use strict';

    var DEFAULT_FORMATS = [
        'qr_code',
        'ean_13',
        'ean_8',
        'upc_a',
        'upc_e',
        'code_128',
        'code_39',
        'itf',
    ];

    function normalizeError(e) {
        var msg = (e && e.message) ? String(e.message) : 'Barcode error';
        var name = e && e.name ? String(e.name) : '';
        var code = 'UNAVAILABLE';
        if (/NotAllowedError|SecurityError|PermissionDenied/i.test(name) ||
            /permission|denied|not\s*allowed/i.test(msg)) {
            code = 'PERMISSION_DENIED';
        }
        var err = new Error(msg);
        err.name = 'BarcodeError';
        err.code = code;
        return err;
    }

    function pickFirst(results) {
        if (!results || !results.length) return null;
        var first = null;
        for (var i = 0; i < results.length; i++) {
            if (results[i] && results[i].rawValue) { first = results[i]; break; }
        }
        if (!first) first = results[0];
        if (!first || !first.rawValue) return null;
        return {
            format: first.format ? String(first.format) : 'unknown',
            rawValue: String(first.rawValue),
        };
    }

    function tryBarcodeDetector(source, formats) {
        if (!window.BarcodeDetector) return Promise.resolve(null);
        var detector;
        try {
            detector = new window.BarcodeDetector({ formats: formats });
        } catch (_) {
            try { detector = new window.BarcodeDetector(); }
            catch (_e2) { return Promise.resolve(null); }
        }
        return Promise.resolve()
            .then(function () { return detector.detect(source); })
            .then(pickFirst)
            .catch(function () { return null; });
    }

    function isImageElement(s) {
        return !!(s && s.tagName && String(s.tagName).toUpperCase() === 'IMG');
    }
    function isVideoElement(s) {
        return !!(s && s.tagName && String(s.tagName).toUpperCase() === 'VIDEO');
    }
    function isCanvasElement(s) {
        return !!(s && s.tagName && String(s.tagName).toUpperCase() === 'CANVAS');
    }
    function isBlob(s) {
        return !!(s && (s instanceof window.Blob || (typeof s.arrayBuffer === 'function' && typeof s.type === 'string')));
    }

    function blobToImage(blob) {
        return new Promise(function (resolve, reject) {
            var url;
            try { url = window.URL.createObjectURL(blob); }
            catch (e) { return reject(e); }
            var img = new window.Image();
            var done = false;
            function cleanup() {
                if (done) return;
                done = true;
                try { window.URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
            }
            img.onload = function () { resolve(img); };
            img.onerror = function (e) { cleanup(); reject(e || new Error('image load failed')); };
            img.src = url;
            if (typeof img.decode === 'function') {
                img.decode().then(function () { resolve(img); }).catch(function () { /* fall through to onload */ });
            }
            // Defer URL revocation — caller may still hold the image; tests
            // don't care because the GC will collect the URL on cleanup().
        });
    }

    function tryZXingOnImage(image) {
        var ZXingGlobal = window.ZXing;
        if (!ZXingGlobal || !ZXingGlobal.BrowserMultiFormatReader) {
            return Promise.resolve(null);
        }
        var reader = new ZXingGlobal.BrowserMultiFormatReader();
        return reader.decodeFromImageElement(image)
            .then(function (result) {
                try { reader.reset(); } catch (_) { /* ignore */ }
                if (!result || !result.text) return null;
                return {
                    format: result.format != null ? String(result.format) : 'unknown',
                    rawValue: String(result.text),
                };
            })
            .catch(function () {
                try { reader.reset(); } catch (_) { /* ignore */ }
                return null;
            });
    }

    function scan(opts) {
        opts = opts || {};
        var source = opts.source;
        var formats = Array.isArray(opts.formats) && opts.formats.length ? opts.formats : DEFAULT_FORMATS;

        if (source == null) {
            return Promise.reject(normalizeError(new Error(
                'Barcode.scan(web): a `source` (HTMLVideoElement/HTMLImageElement/HTMLCanvasElement/Blob) is required'
            )));
        }

        // Video sources: BarcodeDetector only — ZXing.decodeFromImageElement
        // can't read live frames. Image/canvas/blob sources: BarcodeDetector
        // first, ZXing fallback when nothing was decoded.
        if (isVideoElement(source)) {
            return tryBarcodeDetector(source, formats);
        }

        if (isImageElement(source) || isCanvasElement(source)) {
            return tryBarcodeDetector(source, formats).then(function (result) {
                if (result) return result;
                if (isImageElement(source)) return tryZXingOnImage(source);
                return null;
            });
        }

        if (isBlob(source)) {
            return blobToImage(source).then(function (image) {
                return tryBarcodeDetector(image, formats).then(function (result) {
                    if (result) return result;
                    return tryZXingOnImage(image);
                });
            }).catch(function (e) { throw normalizeError(e); });
        }

        return Promise.reject(normalizeError(new Error(
            'Barcode.scan(web): unsupported source type'
        )));
    }

    var impl = {
        scan: scan,
    };

    if (window.Barcode && window.Barcode.__native && typeof window.Barcode.__native.registerImpl === 'function') {
        window.Barcode.__native.registerImpl('Barcode', 'web', impl);
    }
})();
