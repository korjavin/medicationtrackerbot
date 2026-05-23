// Web impl of the MediaCapture abstraction (mobile Phase 2b, Task 3).
//
// takePhoto() opens a live MediaDevices stream (rear camera by preference),
// grabs one frame via a hidden <canvas>, and resolves with a JPEG Blob. The
// stream tracks are stopped as soon as the snapshot is captured. The
// implementation is lifted from the pattern in features/food/scanner.js:136
// (getUserMedia { facingMode: environment }) — no behavior change, just
// relocated behind the abstraction so feature code can call the same
// MediaCapture.takePhoto() on both web and Capacitor builds.
//
// pickPhoto() drives a hidden <input type=file accept=image/* capture=...>,
// matching the existing photo-picker fallback in
// features/food/scanner.js:216 and features/food/photo.js. Resolves with the
// selected File (a Blob) or null when the user cancels.
//
// Errors are normalized to a { name: 'MediaCaptureError', code, message }
// shape — code is 'PERMISSION_DENIED' for getUserMedia NotAllowedError /
// SecurityError, otherwise 'UNAVAILABLE'.
//
// Load order: must be after web/static/js/native/index.js so the foundation's
// registerImpl helper is available.
(function () {
    'use strict';

    function normalizeError(e) {
        var msg = (e && e.message) ? String(e.message) : 'MediaCapture error';
        var name = e && e.name ? String(e.name) : '';
        var code = 'UNAVAILABLE';
        if (/NotAllowedError|SecurityError|PermissionDenied/i.test(name) ||
            /permission|denied|not\s*allowed/i.test(msg)) {
            code = 'PERMISSION_DENIED';
        }
        var err = new Error(msg);
        err.name = 'MediaCaptureError';
        err.code = code;
        return err;
    }

    function stopStream(stream) {
        if (!stream || typeof stream.getTracks !== 'function') return;
        stream.getTracks().forEach(function (t) {
            try { t.stop(); } catch (_) { /* ignore */ }
        });
    }

    function captureFrameFromVideo(video) {
        return new Promise(function (resolve, reject) {
            var doc = window.document;
            var canvas = doc.createElement('canvas');
            canvas.width = video.videoWidth || video.width || 640;
            canvas.height = video.videoHeight || video.height || 480;
            var ctx = canvas.getContext ? canvas.getContext('2d') : null;
            if (!ctx) {
                return reject(new Error('Canvas 2D context unavailable'));
            }
            try {
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            } catch (e) {
                return reject(e);
            }
            if (typeof canvas.toBlob === 'function') {
                canvas.toBlob(function (blob) {
                    if (blob) resolve(blob);
                    else reject(new Error('canvas.toBlob returned null'));
                }, 'image/jpeg', 0.9);
                return;
            }
            reject(new Error('canvas.toBlob is unavailable'));
        });
    }

    function takePhoto(opts) {
        opts = opts || {};
        var nav = window.navigator;
        if (!nav || !nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== 'function') {
            var unavailable = new Error('navigator.mediaDevices.getUserMedia is unavailable');
            unavailable.name = 'MediaCaptureError';
            unavailable.code = 'UNAVAILABLE';
            return Promise.reject(unavailable);
        }

        var stream = null;
        var video = window.document.createElement('video');
        try { video.setAttribute('playsinline', 'true'); } catch (_) { /* ignore */ }
        video.muted = true;

        return nav.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: { ideal: opts.facingMode || 'environment' } }
        })
            .then(function (s) {
                stream = s;
                video.srcObject = s;
                var p = video.play && video.play();
                return p && typeof p.then === 'function' ? p : Promise.resolve();
            })
            .then(function () { return captureFrameFromVideo(video); })
            .then(function (blob) {
                stopStream(stream);
                return blob;
            })
            .catch(function (e) {
                stopStream(stream);
                throw normalizeError(e);
            });
    }

    function pickPhoto(opts) {
        opts = opts || {};
        return new Promise(function (resolve) {
            var doc = window.document;
            var input = doc.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            if (opts.capture !== false) {
                try { input.capture = 'environment'; } catch (_) { /* ignore */ }
            }

            var settled = false;
            function settle(value) {
                if (settled) return;
                settled = true;
                resolve(value);
            }

            input.addEventListener('change', function (event) {
                var file = event.target && event.target.files && event.target.files[0];
                settle(file || null);
            });
            // Modern browsers fire a 'cancel' event when the picker is dismissed
            // without selecting a file. Older browsers fire nothing; in that
            // case the caller has no way to distinguish cancel from "still
            // waiting" — they get a never-resolving promise. Acceptable per
            // the existing food.scanner.js pattern.
            input.addEventListener('cancel', function () { settle(null); });

            try { input.click(); }
            catch (e) { settle(null); }
        });
    }

    // requestPermissions on the web has no separate prompt API — browsers
    // surface the prompt inline at first getUserMedia / file-picker
    // invocation. Resolve as a granted PermissionState so the firstrun
    // helper's web fallback path treats web builds as "no prompt needed";
    // the screen auto-advances on isNativePlatform()==false anyway, so this
    // is primarily defensive for direct callers.
    function requestPermissions() {
        return Promise.resolve({ camera: 'granted', photos: 'granted' });
    }

    var impl = {
        takePhoto: takePhoto,
        pickPhoto: pickPhoto,
        requestPermissions: requestPermissions,
    };

    if (window.MediaCapture && window.MediaCapture.__native && typeof window.MediaCapture.__native.registerImpl === 'function') {
        window.MediaCapture.__native.registerImpl('MediaCapture', 'web', impl);
    }
})();
