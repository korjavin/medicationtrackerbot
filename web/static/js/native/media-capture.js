// window.MediaCapture on iOS (bd med-w6gx.33): the web impl, except Gallery.
//
// WKWebView owns <input type=file accept=image/*>: without `capture` it shows
// WebKit's Photo Library / Take Photo / Choose File sheet, and iOS gives
// neither the shell nor the page a way to skip it. So pickPhoto({ capture:
// false }) goes to the shell's media.pickPhoto op (ios/App/PhotoPicker.swift,
// a PHPickerViewController) when shell.ops lists it:
//   media.pickPhoto {} → { name, type, lastModified (ms), data (base64) } |
//     null (cancelled) | error string ("busy" while a picker is already up).
// The bytes are the photo as the library holds it (JPEG when it has one), EXIF
// intact, so photo.js reads eaten_at from DateTimeOriginal as on the web.
// An older shell without the op → the web input (today's sheet). Every other
// method, and pickPhoto with the camera, is the web impl's
// (native/web/media-capture.js), looked up at call time. Android registers
// nothing: its shell answers the input itself (med-nt9p.67).
//
// Load order: after native/index.js and native/web/media-capture.js.
(function () {
    'use strict';

    var foundation = window.MediaCapture && window.MediaCapture.__native;
    if (!foundation || typeof foundation.registerImpl !== 'function') {
        throw new Error('native/media-capture.js: native/index.js must load first');
    }

    function web() {
        return foundation.getImpl('MediaCapture', 'web');
    }

    function forward(method) {
        return function () {
            var impl = web();
            return impl[method].apply(impl, arguments);
        };
    }

    function pickerError(e) {
        var err = new Error((e && e.message) ? String(e.message) : 'MediaCapture error');
        err.name = 'MediaCaptureError';
        err.code = 'UNAVAILABLE';
        return err;
    }

    function toFile(reply) {
        if (reply == null) return null;
        var bin = window.atob(String(reply.data || ''));
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new window.File([bytes], reply.name || 'photo.jpg', {
            type: reply.type || 'image/jpeg',
            lastModified: typeof reply.lastModified === 'number' ? reply.lastModified : Date.now(),
        });
    }

    // Asked once at load, so an older shell's fallback opens the input
    // synchronously inside the tap (WebKit wants the user gesture for it).
    var hasOp = null;
    var asked = foundation.platform === 'ios'
        ? foundation.has('media.pickPhoto').then(function (has) { hasOp = has; return has; })
        : Promise.resolve(false);

    function pickPhoto(opts) {
        if (!(opts && opts.capture === false) || hasOp === false) return web().pickPhoto(opts);
        return asked.then(function (has) {
            if (!has) return web().pickPhoto(opts);
            return foundation.call('media.pickPhoto').then(toFile);
        }).catch(function (e) {
            throw (e && e.name === 'MediaCaptureError') ? e : pickerError(e);
        });
    }

    foundation.registerImpl('MediaCapture', 'ios', {
        openCameraStream: forward('openCameraStream'),
        takePhoto: forward('takePhoto'),
        pickPhoto: pickPhoto,
        recordAudio: forward('recordAudio'),
        openSettings: forward('openSettings'),
    });
})();
