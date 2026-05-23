// Web impl of the Reminders abstraction (mobile Phase 2b, Task 5).
//
// Reminders on the browser path are delivered through Web Push (see push.js).
// This impl is a thin no-op shim so callers can invoke window.Reminders.*
// unconditionally without branching on platform — the schedule/cancel calls
// resolve to a stable shape and do not throw, but they also do not touch the
// browser's notification machinery. The pre-schedule loop that drives
// LocalNotifications on Capacitor has no analogue here; Web Push is push-driven
// from the server scheduler.
//
// Load order: must be after web/static/js/native/index.js so the foundation's
// registerImpl helper is available.
(function () {
    'use strict';

    function schedule(_reminders) {
        return Promise.resolve({ scheduled: 0, platform: 'web' });
    }

    function cancelAll() {
        return Promise.resolve({ canceled: 0, platform: 'web' });
    }

    function startPreScheduleLoop() {
        return null;
    }

    // Browser path delivers via Web Push; permissions are requested inline
    // by push.js when the user enables notifications, not up-front. Returning
    // a granted-shape result keeps the firstrun permissions helper from
    // surfacing a spurious denial when invoked on web (the screen itself
    // auto-advances on web, but the helper stays platform-agnostic).
    function requestPermissions() {
        return Promise.resolve({ display: 'granted', platform: 'web' });
    }

    var impl = {
        schedule: schedule,
        cancelAll: cancelAll,
        startPreScheduleLoop: startPreScheduleLoop,
        requestPermissions: requestPermissions,
    };

    if (window.Reminders && window.Reminders.__native && typeof window.Reminders.__native.registerImpl === 'function') {
        window.Reminders.__native.registerImpl('Reminders', 'web', impl);
    }
})();
