// Web impl of the Geolocation abstraction (mobile Phase 2b, Task 2).
//
// Wraps navigator.geolocation.getCurrentPosition in a promise and normalizes
// the platform-specific PositionError into a stable
// { code: 'PERMISSION_DENIED' | 'POSITION_UNAVAILABLE' | 'TIMEOUT', message }
// shape so callers don't branch on numeric error codes. Selected at runtime
// when isNativePlatform() is false (browser PWA path).
//
// Load order: must be after web/static/js/native/index.js so the foundation's
// registerImpl helper is available.
(function () {
    'use strict';

    var POSITION_ERROR_CODES = {
        1: 'PERMISSION_DENIED',
        2: 'POSITION_UNAVAILABLE',
        3: 'TIMEOUT',
    };

    function normalizeError(positionError) {
        var msg;
        var code = 'POSITION_UNAVAILABLE';
        if (positionError && typeof positionError.code === 'number') {
            code = POSITION_ERROR_CODES[positionError.code] || 'POSITION_UNAVAILABLE';
        }
        msg = (positionError && positionError.message) ? String(positionError.message) : code;
        var err = new Error(msg);
        err.name = 'GeolocationError';
        err.code = code;
        return err;
    }

    function getCurrentPosition(opts) {
        opts = opts || {};
        return new Promise(function (resolve, reject) {
            var nav = window.navigator;
            if (!nav || !nav.geolocation || typeof nav.geolocation.getCurrentPosition !== 'function') {
                var err = new Error('navigator.geolocation is unavailable');
                err.name = 'GeolocationError';
                err.code = 'POSITION_UNAVAILABLE';
                return reject(err);
            }
            var posOpts = {};
            if (typeof opts.timeoutMs === 'number') posOpts.timeout = opts.timeoutMs;
            if (typeof opts.maximumAgeMs === 'number') posOpts.maximumAge = opts.maximumAgeMs;

            nav.geolocation.getCurrentPosition(
                function (pos) {
                    resolve({
                        coords: {
                            latitude: pos.coords.latitude,
                            longitude: pos.coords.longitude,
                            accuracy: pos.coords.accuracy,
                        },
                        timestamp: pos.timestamp,
                    });
                },
                function (e) { reject(normalizeError(e)); },
                posOpts
            );
        });
    }

    // requestPermissions on the web has no separate prompt API — the browser
    // surfaces the prompt inline at first getCurrentPosition. Resolve as a
    // granted PermissionState so the firstrun helper's web fallback path
    // treats web builds as "no prompt needed"; the screen auto-advances on
    // isNativePlatform()==false anyway, so this is primarily defensive.
    function requestPermissions() {
        return Promise.resolve({ location: 'granted', coarseLocation: 'granted' });
    }

    var impl = {
        getCurrentPosition: getCurrentPosition,
        requestPermissions: requestPermissions,
    };

    if (window.Geolocation && window.Geolocation.__native && typeof window.Geolocation.__native.registerImpl === 'function') {
        window.Geolocation.__native.registerImpl('Geolocation', 'web', impl);
    }
})();
