// window.Health — Apple Health (HealthKit) read access (bd med-w6gx.4).
//
// Only the iOS app shell has it. The web impl reports unsupported, so feature
// code branches on isSupported(), never on the platform.
//
// ios (bd med-w6gx.6), answered by ios/App/Health.swift:
//   requestAuthorization(types) → Promise<boolean>: shows the Health read
//     sheet for `types` (e.g. ['bp', 'weight']); false when this device has no
//     Health data store. HealthKit never says whether read access was granted
//     — a denied type simply returns no samples.
//   query({ type, anchor, limit }) → Promise<{ samples, anchor, returned, more }>: an
//     anchored query; pass the returned anchor (opaque string) back next time
//     to get only what was added since. `more` means call again now. Types:
//     'bp', 'weight', 'sleep', 'workout' (bd med-w6gx.7); a 'sleep' page
//     returns every sleep sample around the new ones, plus the window's
//     { from, to } (ms). query({ type: 'sleep', from, to }) (ms, no anchor)
//     re-reads every sleep sample in that window.
//
// Load order: after native/index.js.
(function () {
    'use strict';

    var foundation = window.Health && window.Health.__native;
    if (!foundation || typeof foundation.registerImpl !== 'function') {
        throw new Error('native/health.js: native/index.js must load first');
    }

    foundation.registerImpl('Health', 'web', {
        isSupported: function () { return false; },
    });
    foundation.registerImpl('Health', 'ios', {
        isSupported: function () { return true; },
        requestAuthorization: function (types) {
            return foundation.call('health.authorize', { types: types });
        },
        query: function (args) {
            return foundation.call('health.query', args);
        },
    });
})();
