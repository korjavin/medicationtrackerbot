// window.Health — Apple Health (HealthKit) read access (bd med-w6gx.4).
//
// Only the iOS app shell has it. The web impl reports unsupported, so feature
// code branches on isSupported(), never on the platform. Permission and query
// ops arrive with the HealthKit import (bd med-w6gx.6) as
// foundation.call('health.*').
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
    });
})();
