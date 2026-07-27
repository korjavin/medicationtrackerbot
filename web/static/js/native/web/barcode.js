// Web impl of the Barcode abstraction.
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
// behavior change, just relocated behind the abstraction.
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
        for (var i = 0; i < results.length; i++) {
            var r = results[i];
            if (r && r.rawValue) {
                return {
                    format: r.format ? String(r.format) : 'unknown',
                    rawValue: String(r.rawValue),
                };
            }
        }
        return null;
    }

    // Cache BarcodeDetector instances keyed by the sorted formats list. The
    // live food-scanner loop calls scan() 5x/sec on the same { source: video,
    // formats: [...] } shape; allocating a new BarcodeDetector per call is a
    // measurable perf regression vs. the pre-Phase-2b code which held one
    // detector for the lifetime of the scanner modal. A null entry in the
    // cache means "this formats list constructed-but-no-args fallback".
    var detectorCache = Object.create(null);
    var DETECTOR_FALLBACK_KEY = '__default__';

    function getDetector(formats) {
        var key = (formats && formats.length) ? formats.slice().sort().join(',') : DETECTOR_FALLBACK_KEY;
        if (detectorCache[key] !== undefined) return detectorCache[key];
        var detector = null;
        try {
            detector = new window.BarcodeDetector({ formats: formats });
        } catch (_) {
            try { detector = new window.BarcodeDetector(); }
            catch (_e2) { detector = null; }
        }
        detectorCache[key] = detector;
        return detector;
    }

    function tryBarcodeDetector(source, formats) {
        if (!window.BarcodeDetector) return Promise.resolve(null);
        var detector = getDetector(formats);
        if (!detector) return Promise.resolve(null);
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
        if (!s) return false;
        if (window.Blob && s instanceof window.Blob) return true;
        // JSDOM/test environments occasionally lack a shared Blob constructor
        // across realms; fall back to a constructor-name check that excludes
        // Response (which also exposes arrayBuffer()+type).
        var ctor = s.constructor && s.constructor.name;
        return ctor === 'Blob' || ctor === 'File';
    }

    function blobToImage(blob) {
        return new Promise(function (resolve, reject) {
            var url;
            try { url = window.URL.createObjectURL(blob); }
            catch (e) { return reject(e); }
            var img = new window.Image();
            var settled = false;
            function revoke() {
                try { window.URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
            }
            function settleOk() {
                if (settled) return;
                settled = true;
                // BarcodeDetector / ZXing will read pixels synchronously off
                // the image element; once they finish the caller has no more
                // need for the underlying blob URL, so revoke immediately to
                // avoid leaking it for the page lifetime.
                resolve(img);
                revoke();
            }
            function settleErr(e) {
                if (settled) return;
                settled = true;
                reject(e || new Error('image load failed'));
                revoke();
            }
            img.onload = settleOk;
            img.onerror = settleErr;
            img.src = url;
            // img.decode() is preferred when available (signals decode
            // completion, not just load) but several JSDOM versions don't
            // expose it — fall through to onload in that case.
            if (typeof img.decode === 'function') {
                img.decode().then(settleOk).catch(function () { /* onload still pending */ });
            }
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

    // The browser has no full-screen scanner UI of its own — feature code owns
    // the in-app video modal and drives scan({ source: video }) itself.
    // Probed at call time, not module load: BarcodeDetector is installed late
    // by both test harnesses and some browsers (origin trials, polyfills).
    function supportsLiveScan() {
        return !!window.BarcodeDetector;
    }

    var impl = {
        scan: scan,
        supportsLiveScan: supportsLiveScan,
    };

    if (window.Barcode && window.Barcode.__native && typeof window.Barcode.__native.registerImpl === 'function') {
        window.Barcode.__native.registerImpl('Barcode', 'web', impl);
    }
})();
