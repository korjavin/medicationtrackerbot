// Capacitor impl of the Barcode abstraction (mobile Phase 2b, Task 4).
//
// Reads @capacitor-mlkit/barcode-scanning from
// window.Capacitor.Plugins.BarcodeScanner so we don't need a JS bundler to
// resolve the ES-module import (matches the geolocation + media-capture
// pattern). scan({ formats }) opens MLKit's full-screen native scanner and
// resolves with the first decoded { format, rawValue } or null when the user
// cancels (the plugin either resolves with an empty barcodes array or
// rejects with a "canceled" message — both map to null).
//
// MLKit format names are uppercase (QR_CODE, EAN_13, ...); the web impl uses
// lowercase. mapFormats() upper-cases the caller's list so the same
// formats=[...] array works across both impls.
//
// Errors are normalized to { name: 'BarcodeError', code, message } where
// code is 'PERMISSION_DENIED' when the message looks like a permission
// denial, otherwise 'UNAVAILABLE'.
//
// Load order: must be after web/static/js/native/index.js so the foundation's
// registerImpl helper is available.
(function () {
    'use strict';

    function getPlugin() {
        var cap = window.Capacitor;
        if (cap && cap.Plugins && cap.Plugins.BarcodeScanner) {
            return cap.Plugins.BarcodeScanner;
        }
        var err = new Error('Capacitor BarcodeScanner plugin not available');
        err.name = 'BarcodeError';
        err.code = 'UNAVAILABLE';
        throw err;
    }

    function normalizeError(e) {
        var msg = (e && e.message) ? String(e.message) : 'Barcode error';
        var code = 'UNAVAILABLE';
        if (/permission|denied|not\s*allowed/i.test(msg)) {
            code = 'PERMISSION_DENIED';
        }
        var err = new Error(msg);
        err.name = 'BarcodeError';
        err.code = code;
        return err;
    }

    function isCancel(e) {
        var msg = (e && e.message) ? String(e.message) : '';
        return /\bcancel(l)?ed\b/i.test(msg) || /user\s*cancel/i.test(msg);
    }

    function mapFormats(formats) {
        if (!Array.isArray(formats) || !formats.length) return undefined;
        return formats.map(function (f) { return String(f).toUpperCase(); });
    }

    function pickFirstBarcode(result) {
        if (!result || !Array.isArray(result.barcodes) || !result.barcodes.length) return null;
        var b = null;
        for (var i = 0; i < result.barcodes.length; i++) {
            if (result.barcodes[i] && result.barcodes[i].rawValue) { b = result.barcodes[i]; break; }
        }
        if (!b) b = result.barcodes[0];
        if (!b || !b.rawValue) return null;
        return {
            format: b.format ? String(b.format) : 'unknown',
            rawValue: String(b.rawValue),
        };
    }

    function scan(opts) {
        opts = opts || {};
        var pluginOpts = {};
        var mapped = mapFormats(opts.formats);
        if (mapped) pluginOpts.formats = mapped;

        return Promise.resolve()
            .then(function () { return getPlugin(); })
            .then(function (plugin) { return plugin.scan(pluginOpts); })
            .then(function (result) { return pickFirstBarcode(result); })
            .catch(function (e) {
                if (isCancel(e)) return null;
                throw normalizeError(e);
            });
    }

    // MLKit owns the whole scanner UI: scan() takes over the screen, so feature
    // code must not open its own video modal, and the in-app frame loop (which
    // needs a <video> source) must never run here.
    function hasNativeScanner() {
        return true;
    }
    function supportsLiveScan() {
        return false;
    }

    var impl = {
        scan: scan,
        hasNativeScanner: hasNativeScanner,
        supportsLiveScan: supportsLiveScan,
    };

    if (window.Barcode && window.Barcode.__native && typeof window.Barcode.__native.registerImpl === 'function') {
        window.Barcode.__native.registerImpl('Barcode', 'capacitor', impl);
    }
})();
