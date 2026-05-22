// Capacitor impl of the MediaCapture abstraction (mobile Phase 2b, Task 3).
//
// Reads @capacitor/camera from window.Capacitor.Plugins.Camera so we don't
// need a JS bundler to resolve the ES-module import. takePhoto() opens the
// device camera (CameraSource.Camera) and pickPhoto() opens the OS photo
// picker (CameraSource.Photos). Both return a Blob — decoded from the
// plugin's base64 response — so the rest of the app sees one return type
// across web and Capacitor builds. User-cancel resolves to null rather than
// rejecting; the plugin throws an error with a "User cancelled" message in
// that case (varies by platform, so we match a substring).
//
// Errors are normalized to { name: 'MediaCaptureError', code, message }
// where code is 'PERMISSION_DENIED' when the error message looks like a
// permission denial, otherwise 'UNAVAILABLE'.
//
// Load order: must be after web/static/js/native/index.js so the foundation's
// registerImpl helper is available.
(function () {
    'use strict';

    function getPlugin() {
        var cap = window.Capacitor;
        if (cap && cap.Plugins && cap.Plugins.Camera) {
            return cap.Plugins.Camera;
        }
        var err = new Error('Capacitor Camera plugin not available');
        err.name = 'MediaCaptureError';
        err.code = 'UNAVAILABLE';
        throw err;
    }

    function normalizeError(e) {
        var msg = (e && e.message) ? String(e.message) : 'MediaCapture error';
        var code = 'UNAVAILABLE';
        if (/permission|denied|not\s*allowed/i.test(msg)) {
            code = 'PERMISSION_DENIED';
        }
        var err = new Error(msg);
        err.name = 'MediaCaptureError';
        err.code = code;
        return err;
    }

    // The plugin signals user-cancel by rejecting with a message containing
    // "User cancelled" or "cancelled" (Android: "User cancelled photos app";
    // iOS: "User denied photos app"). We treat those as a soft no-op rather
    // than a hard error so the caller can branch on a null return.
    function isCancel(e) {
        var msg = (e && e.message) ? String(e.message) : '';
        return /user\s*cancel/i.test(msg) || /\bcancel(l)?ed\b/i.test(msg);
    }

    function base64ToBlob(base64, mimeType) {
        var binary = window.atob(base64);
        var len = binary.length;
        var bytes = new Uint8Array(len);
        for (var i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
        return new window.Blob([bytes], { type: mimeType });
    }

    function pluginResultToBlob(result) {
        if (!result) return Promise.resolve(null);
        var fmt = (result.format && String(result.format)) || 'jpeg';
        var mime = 'image/' + fmt;
        if (result.base64String) {
            return Promise.resolve(base64ToBlob(result.base64String, mime));
        }
        if (result.webPath && typeof window.fetch === 'function') {
            return window.fetch(result.webPath).then(function (r) { return r.blob(); });
        }
        if (result.path && typeof window.fetch === 'function') {
            return window.fetch(result.path).then(function (r) { return r.blob(); });
        }
        return Promise.resolve(null);
    }

    function callCamera(source) {
        return Promise.resolve()
            .then(function () { return getPlugin(); })
            .then(function (plugin) {
                return plugin.getPhoto({
                    source: source,
                    resultType: 'base64',
                    quality: 90,
                    allowEditing: false,
                    correctOrientation: true,
                });
            })
            .then(function (result) { return pluginResultToBlob(result); });
    }

    function takePhoto() {
        return callCamera('CAMERA').catch(function (e) {
            if (isCancel(e)) return null;
            throw normalizeError(e);
        });
    }

    function pickPhoto() {
        return callCamera('PHOTOS').catch(function (e) {
            if (isCancel(e)) return null;
            throw normalizeError(e);
        });
    }

    var impl = {
        takePhoto: takePhoto,
        pickPhoto: pickPhoto,
    };

    if (window.MediaCapture && window.MediaCapture.__native && typeof window.MediaCapture.__native.registerImpl === 'function') {
        window.MediaCapture.__native.registerImpl('MediaCapture', 'capacitor', impl);
    }
})();
