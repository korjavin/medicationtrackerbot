// window.LocalNotifications — device-scheduled notifications (bd med-w6gx.4).
//
// Only the iOS app shell has them (UNUserNotificationCenter; WKWebView has no
// Web Push). The web impl reports unsupported, so feature code branches on
// isSupported(), never on the platform, and calls nothing else on web.
//
// ios ops (bd med-w6gx.5, Swift side ios/App/Notifications.swift):
//   permission()        → 'granted' | 'denied' | 'default'
//   requestPermission() → the same, after the iOS prompt (asked once)
//   schedule(items)     → replace-all of the pending reminders; items are
//                         {fireAtUnix, title, body, section}, at most 64 (iOS cap)
//   test()              → one notification a second from now
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
    // The Android shell (bd med-nt9p.6) answers the same ops with the same
    // impl; until its Kotlin side lands (med-nt9p.7) they reject "unsupported: <op>".
    var shell = {
        isSupported: function () { return true; },
        permission: function () { return foundation.call('notifications.permission'); },
        requestPermission: function () { return foundation.call('notifications.requestPermission'); },
        schedule: function (items) { return foundation.call('notifications.schedule', { items: items }); },
        test: function () { return foundation.call('notifications.test'); },
    };
    foundation.registerImpl('LocalNotifications', 'ios', shell);
    foundation.registerImpl('LocalNotifications', 'android', shell);
})();
