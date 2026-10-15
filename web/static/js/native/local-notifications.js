// window.LocalNotifications — device-scheduled notifications (bd med-w6gx.4).
//
// Only the iOS app shell has them (UNUserNotificationCenter; WKWebView has no
// Web Push). The web impl reports unsupported, so feature code branches on
// isSupported(), never on the platform. Scheduling ops arrive with the
// reminder hand-off (bd med-w6gx.5) as foundation.call('notifications.*').
//
// Load order: after native/index.js.
(function () {
    'use strict';

    var foundation = window.LocalNotifications && window.LocalNotifications.__native;
    if (!foundation || typeof foundation.registerImpl !== 'function') {
        throw new Error('native/local-notifications.js: native/index.js must load first');
    }

    foundation.registerImpl('LocalNotifications', 'web', {
        isSupported: function () { return false; },
    });
    foundation.registerImpl('LocalNotifications', 'ios', {
        isSupported: function () { return true; },
    });
})();
