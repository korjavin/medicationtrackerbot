// Capacitor impl of the Geolocation abstraction (mobile Phase 2b, Task 2).
//
// Reads the Geolocation plugin from window.Capacitor.Plugins.Geolocation (the
// bridge-level access provided by Capacitor at runtime) so we don't need a JS
// bundler step to resolve `@capacitor/geolocation`. Normalizes errors into the
// same { code, message } shape as the web impl.
//
// Caches the last successful position for 1h in-memory (cleared on app
// restart). The cache is keyed by nothing — there's one current device, and
// repeated calls within a short window should return the same coordinates
// without re-prompting the user or burning battery. The TTL is conservative;
// most callers (future travel-aware tz correction, for example) only need
// kilometer-grade accuracy and the user doesn't move kilometers per hour.
//
// Load order: must be after web/static/js/native/index.js so the foundation's
// registerImpl helper is available.
(function () {
    'use strict';

    var CACHE_TTL_MS = 60 * 60 * 1000;

    var cached = null;
    var cachedAt = 0;

    function nowMs() {
        return Date.now();
    }

    function normalizeError(e) {
        var msg = (e && e.message) ? String(e.message) : 'Geolocation error';
        var code = 'POSITION_UNAVAILABLE';
        // @capacitor/geolocation throws on both native and web; codes/messages
        // are not stable across platforms, so match on the message text after
        // checking the numeric .code (web fallback uses W3C PositionError).
        if (e && typeof e.code === 'number') {
            if (e.code === 1) code = 'PERMISSION_DENIED';
            else if (e.code === 2) code = 'POSITION_UNAVAILABLE';
            else if (e.code === 3) code = 'TIMEOUT';
        } else if (/permission|denied|not\s*allowed/i.test(msg)) {
            code = 'PERMISSION_DENIED';
        } else if (/timeout|timed\s*out/i.test(msg)) {
            code = 'TIMEOUT';
        }
        var err = new Error(msg);
        err.name = 'GeolocationError';
        err.code = code;
        return err;
    }

    function getPlugin() {
        var cap = window.Capacitor;
        if (cap && cap.Plugins && cap.Plugins.Geolocation) {
            return cap.Plugins.Geolocation;
        }
        var err = new Error('Capacitor Geolocation plugin not available');
        err.name = 'GeolocationError';
        err.code = 'POSITION_UNAVAILABLE';
        throw err;
    }

    function normalizePosition(pos) {
        return {
            coords: {
                latitude: pos.coords.latitude,
                longitude: pos.coords.longitude,
                accuracy: pos.coords.accuracy,
            },
            timestamp: pos.timestamp,
        };
    }

    function getCurrentPosition(opts) {
        opts = opts || {};
        var now = nowMs();
        if (cached && (now - cachedAt) < CACHE_TTL_MS) {
            return Promise.resolve(cached);
        }
        return Promise.resolve()
            .then(function () { return getPlugin(); })
            .then(function (plugin) {
                var pluginOpts = { enableHighAccuracy: false };
                if (typeof opts.timeoutMs === 'number') pluginOpts.timeout = opts.timeoutMs;
                if (typeof opts.maximumAgeMs === 'number') pluginOpts.maximumAge = opts.maximumAgeMs;
                return plugin.getCurrentPosition(pluginOpts);
            })
            .then(function (pos) {
                var normalized = normalizePosition(pos);
                cached = normalized;
                cachedAt = nowMs();
                return normalized;
            })
            .catch(function (e) { throw normalizeError(e); });
    }

    function _resetCache() {
        cached = null;
        cachedAt = 0;
    }

    var impl = {
        getCurrentPosition: getCurrentPosition,
        _resetCache: _resetCache,
    };

    if (window.Geolocation && window.Geolocation.__native && typeof window.Geolocation.__native.registerImpl === 'function') {
        window.Geolocation.__native.registerImpl('Geolocation', 'capacitor', impl);
    }
})();
