// features/firstrun/permissions.js — helper that drives Capacitor permission
// prompts for the first-run permissions screen (Task 5 of the mobile Phase 2c
// plan).
//
// Each request* function asks the OS for a single permission via the existing
// Phase 2b abstractions (window.MediaCapture / window.Reminders /
// window.Geolocation). The abstractions throw a normalized error with
// `code === 'PERMISSION_DENIED'` when the user denies; we translate any
// resolved-or-rejected outcome into a flat `{granted: bool, reason?: string,
// message?: string}` shape so the screen can render one of three UI states
// (granted / denied / failed-to-prompt) without poking at native error shapes.
//
// On a web build (Capacitor.isNativePlatform() returns false), the screen
// itself auto-advances and never calls into these helpers. The helpers still
// resolve safely as `{granted: true, reason: 'WEB_NO_PROMPT'}` so a direct
// call from a future caller doesn't surface a spurious denial — the browser
// will prompt inline at first capability use, exactly as it does today.
(function () {
    'use strict';

    function _isNative() {
        try {
            var cap = window.Capacitor;
            if (!cap || typeof cap.isNativePlatform !== 'function') return false;
            return Boolean(cap.isNativePlatform());
        } catch (_) {
            return false;
        }
    }

    function _classifyReason(e) {
        if (!e) return 'UNAVAILABLE';
        if (e.code === 'PERMISSION_DENIED') return 'PERMISSION_DENIED';
        var msg = (e.message != null) ? String(e.message) : '';
        if (/permission|denied|not\s*allowed/i.test(msg)) return 'PERMISSION_DENIED';
        return 'UNAVAILABLE';
    }

    // Wrap a promise from one of the native abstractions into the helper's
    // flat result shape. Resolved values (including `null`, which the camera
    // impl returns on user-cancel) mean the OS prompt was answered and the
    // permission is granted — the user can always change their mind later
    // from Settings; we don't try to distinguish "answered yes but cancelled
    // the picker" from "answered yes and selected a photo" because the
    // permission grant is what matters for the first-run flow.
    function _resolveGrant(promise) {
        return Promise.resolve(promise).then(function () {
            return { granted: true };
        }).catch(function (e) {
            return {
                granted: false,
                reason: _classifyReason(e),
                message: (e && e.message != null) ? String(e.message) : '',
            };
        });
    }

    function requestCamera() {
        if (!_isNative()) return Promise.resolve({ granted: true, reason: 'WEB_NO_PROMPT' });
        var mc = window.MediaCapture;
        if (!mc || typeof mc.pickPhoto !== 'function') {
            return Promise.resolve({ granted: false, reason: 'UNAVAILABLE' });
        }
        // capture:false on the Capacitor impl maps to CameraSource.Prompt
        // which lets the user pick camera or gallery — first-run wants the
        // permission grant, not a specific source, so this is the right
        // shape.
        return _resolveGrant(mc.pickPhoto({ capture: false }));
    }

    function requestNotifications() {
        if (!_isNative()) return Promise.resolve({ granted: true, reason: 'WEB_NO_PROMPT' });
        var rem = window.Reminders;
        if (!rem || typeof rem.schedule !== 'function') {
            return Promise.resolve({ granted: false, reason: 'UNAVAILABLE' });
        }
        // schedule([]) is a no-op cancel-all on the Capacitor impl, but it
        // routes through the LocalNotifications plugin which surfaces the
        // POST_NOTIFICATIONS runtime prompt on Android 13+ before resolving.
        // The plan picked this call deliberately — no need for a dedicated
        // requestPermission method on the Reminders surface.
        return _resolveGrant(rem.schedule([]));
    }

    function requestLocation() {
        if (!_isNative()) return Promise.resolve({ granted: true, reason: 'WEB_NO_PROMPT' });
        var geo = window.Geolocation;
        if (!geo || typeof geo.getCurrentPosition !== 'function') {
            return Promise.resolve({ granted: false, reason: 'UNAVAILABLE' });
        }
        return _resolveGrant(geo.getCurrentPosition());
    }

    window.WGFirstRun = window.WGFirstRun || {};
    window.WGFirstRun.permissions = {
        requestCamera: requestCamera,
        requestNotifications: requestNotifications,
        requestLocation: requestLocation,
        _isNative: _isNative,
    };
})();
