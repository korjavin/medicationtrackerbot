// features/firstrun/permissions.js — helper that drives Capacitor permission
// prompts for the first-run permissions screen (Task 5 of the mobile Phase 2c
// plan).
//
// Each request* function asks the OS for a single permission via the existing
// Phase 2b abstractions (window.MediaCapture / window.Reminders /
// window.Geolocation). Notifications go through Reminders.requestPermissions
// (which wraps LocalNotifications.requestPermissions and is the only call that
// reliably surfaces the Android 13+ POST_NOTIFICATIONS runtime prompt — the
// earlier schedule([]) approach silently no-ops because the abstraction's
// empty-payload guard skips plugin.schedule()). The abstractions throw a
// normalized error with `code === 'PERMISSION_DENIED'` when the user denies;
// we translate any resolved-or-rejected outcome into a flat `{granted: bool,
// reason?: string, message?: string}` shape so the screen can render one of
// three UI states (granted / denied / failed-to-prompt) without poking at
// native error shapes.
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
        if (!mc) {
            return Promise.resolve({ granted: false, reason: 'UNAVAILABLE' });
        }
        // Prefer the dedicated requestPermissions seam (Phase 2c addition).
        // The legacy pickPhoto fallback exists only so a test mock that
        // hasn't been updated to expose requestPermissions still resolves;
        // production calls always land on the requestPermissions path
        // because both the capacitor and web impls register it. Falling
        // back to pickPhoto({capture:false}) is wrong for first-run UX —
        // it opens the camera/photo picker rather than just surfacing the
        // OS permission prompt — so we only do it if requestPermissions
        // is genuinely absent.
        if (typeof mc.requestPermissions === 'function') {
            return Promise.resolve(mc.requestPermissions()).then(function (res) {
                // PermissionState values: 'granted' | 'denied' | 'prompt' |
                // 'prompt-with-rationale' | 'limited'. Treat 'granted' and
                // 'limited' (iOS partial photos grant) as success; anything
                // else is a soft denial the user can retry later.
                var camera = (res && res.camera) ? String(res.camera) : 'unknown';
                if (camera === 'granted' || camera === 'limited') {
                    return { granted: true };
                }
                return { granted: false, reason: 'PERMISSION_DENIED', message: 'camera=' + camera };
            }).catch(function (e) {
                return {
                    granted: false,
                    reason: _classifyReason(e),
                    message: (e && e.message != null) ? String(e.message) : '',
                };
            });
        }
        if (typeof mc.pickPhoto === 'function') {
            return _resolveGrant(mc.pickPhoto({ capture: false }));
        }
        return Promise.resolve({ granted: false, reason: 'UNAVAILABLE' });
    }

    function requestNotifications() {
        if (!_isNative()) return Promise.resolve({ granted: true, reason: 'WEB_NO_PROMPT' });
        var rem = window.Reminders;
        if (!rem) {
            return Promise.resolve({ granted: false, reason: 'UNAVAILABLE' });
        }
        // requestPermissions wraps LocalNotifications.requestPermissions and
        // is what actually surfaces the Android 13+ POST_NOTIFICATIONS
        // runtime prompt. The earlier schedule([]) approach silently no-ops
        // because the abstraction's empty-payload guard skips plugin.schedule().
        // The schedule([]) fallback exists only so a future test mock that
        // hasn't been updated to provide requestPermissions still gets a
        // resolved promise rather than UNAVAILABLE.
        if (typeof rem.requestPermissions === 'function') {
            return Promise.resolve(rem.requestPermissions()).then(function (res) {
                // Strict check: only an explicit display='granted' is a grant.
                // 'denied' / 'prompt' / 'prompt-with-rationale' / a missing
                // display field (older plugin versions or stub mocks) all fall
                // through to PERMISSION_DENIED so the row stays unlocked
                // rather than silently claiming success.
                if (res && res.display === 'granted') {
                    return { granted: true };
                }
                var display = (res && res.display) ? String(res.display) : 'unknown';
                return { granted: false, reason: 'PERMISSION_DENIED', message: 'display=' + display };
            }).catch(function (e) {
                return {
                    granted: false,
                    reason: _classifyReason(e),
                    message: (e && e.message != null) ? String(e.message) : '',
                };
            });
        }
        if (typeof rem.schedule === 'function') {
            return _resolveGrant(rem.schedule([]));
        }
        return Promise.resolve({ granted: false, reason: 'UNAVAILABLE' });
    }

    function requestLocation() {
        if (!_isNative()) return Promise.resolve({ granted: true, reason: 'WEB_NO_PROMPT' });
        var geo = window.Geolocation;
        if (!geo) {
            return Promise.resolve({ granted: false, reason: 'UNAVAILABLE' });
        }
        // Prefer the dedicated requestPermissions seam (Phase 2c addition).
        // The legacy getCurrentPosition fallback exists only so a test mock
        // that hasn't been updated still resolves; production always uses
        // requestPermissions. getCurrentPosition is the wrong shape for
        // first-run UX: it performs a real GPS read which can hang for
        // 10+ seconds indoors and may TIMEOUT after the user granted
        // permission, surfacing a misleading "couldn't request access"
        // error.
        if (typeof geo.requestPermissions === 'function') {
            return Promise.resolve(geo.requestPermissions()).then(function (res) {
                var location = (res && res.location) ? String(res.location) : 'unknown';
                if (location === 'granted') {
                    return { granted: true };
                }
                // Coarse-only grant (no precise fine permission) is still a
                // permission grant from the user's perspective; treat as
                // success and let the consuming feature decide if coarse is
                // good enough.
                var coarse = (res && res.coarseLocation) ? String(res.coarseLocation) : '';
                if (coarse === 'granted') {
                    return { granted: true };
                }
                return { granted: false, reason: 'PERMISSION_DENIED', message: 'location=' + location };
            }).catch(function (e) {
                return {
                    granted: false,
                    reason: _classifyReason(e),
                    message: (e && e.message != null) ? String(e.message) : '',
                };
            });
        }
        if (typeof geo.getCurrentPosition === 'function') {
            return _resolveGrant(geo.getCurrentPosition());
        }
        return Promise.resolve({ granted: false, reason: 'UNAVAILABLE' });
    }

    window.WGFirstRun = window.WGFirstRun || {};
    window.WGFirstRun.permissions = {
        requestCamera: requestCamera,
        requestNotifications: requestNotifications,
        requestLocation: requestLocation,
        _isNative: _isNative,
    };
})();
