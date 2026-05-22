// Capacitor impl of the Reminders abstraction (mobile Phase 2b, Task 5).
//
// Wraps @capacitor/local-notifications so the OS fires medication reminders
// natively even when the WebView is suspended. Reads the plugin via
// window.Capacitor.Plugins.LocalNotifications (and the App plugin via
// window.Capacitor.Plugins.App) so no JS bundler is required — matches the
// pattern from geolocation / media-capture / barcode.
//
// Scheduling is REPLACE-ALL on every refresh: getPending() → cancel all →
// schedule the freshly-fetched batch. Cost: a sub-second window where no
// notifications are scheduled during the cancel+reschedule. Benefit: no diff
// bookkeeping, no per-id reconciliation, identical behavior on cold start and
// resume. Resolved trade-off captured in the Phase 2b plan.
//
// schedule(reminders) accepts the shape returned by
// GET /api/reminders/upcoming?hours=24 — an array of
// { intake_id, medication_id, medication_name, scheduled_at }.
//
// startPreScheduleLoop() runs the fetch+schedule once immediately (so a fresh
// app launch is not stale) and registers a Capacitor App.appStateChange
// listener so it re-runs every time the app moves to the foreground. The
// resume re-run is what keeps the OS-scheduled queue accurate after the user
// closes-and-reopens or backgrounds for hours.
//
// Notification taps deliver `extra.intake_id` / `extra.medication_id` via the
// LocalNotifications.localNotificationActionPerformed event. The handler
// reroutes to the existing in-app medication confirm modal by setting the URL
// query string and calling window.handleDeepLinks() — same path push.js takes
// in the browser PWA so there is no separate Capacitor router to maintain.
//
// Load order: must be after web/static/js/native/index.js so the foundation's
// registerImpl helper is available.
(function () {
    'use strict';

    var REMINDERS_ENDPOINT = '/api/reminders/upcoming?hours=24';

    function getPlugin(name) {
        var cap = window.Capacitor;
        if (cap && cap.Plugins && cap.Plugins[name]) {
            return cap.Plugins[name];
        }
        var err = new Error('Capacitor ' + name + ' plugin not available');
        err.name = 'RemindersError';
        err.code = 'UNAVAILABLE';
        throw err;
    }

    function getLocalNotifications() { return getPlugin('LocalNotifications'); }
    function tryGetApp() {
        try { return getPlugin('App'); } catch (_) { return null; }
    }

    function normalizeError(e) {
        var msg = (e && e.message) ? String(e.message) : 'Reminders error';
        var code = 'UNAVAILABLE';
        if (/permission|denied|not\s*allowed/i.test(msg)) {
            code = 'PERMISSION_DENIED';
        }
        var err = new Error(msg);
        err.name = 'RemindersError';
        err.code = code;
        return err;
    }

    // Map an /api/reminders/upcoming entry into the LocalNotifications.schedule
    // payload shape. The id MUST be a positive 32-bit integer per the plugin
    // contract; intake_id is the natural stable identifier, and is bounded by
    // the SQLite autoincrement so it fits in int32 for any realistic deployment.
    function reminderToNotification(r) {
        if (!r || r.intake_id == null) return null;
        var scheduledAt = r.scheduled_at ? new Date(r.scheduled_at) : null;
        if (!scheduledAt || isNaN(scheduledAt.getTime())) return null;
        var name = r.medication_name ? String(r.medication_name) : 'Medication';
        return {
            id: Number(r.intake_id),
            title: name,
            body: 'Time to take ' + name,
            schedule: { at: scheduledAt },
            extra: {
                intake_id: r.intake_id,
                medication_id: r.medication_id,
                // medication_name + scheduled_at need to round-trip through the
                // notification so handleNotificationTap can populate the
                // `names` and `scheduled` deep-link params that
                // handlePushAction → showMedicationConfirmModal both consume.
                medication_name: name,
                scheduled_at: scheduledAt.toISOString(),
            },
        };
    }

    function buildPayload(reminders) {
        var list = Array.isArray(reminders) ? reminders : [];
        var notifications = [];
        for (var i = 0; i < list.length; i++) {
            var n = reminderToNotification(list[i]);
            if (n) notifications.push(n);
        }
        return { notifications: notifications };
    }

    function cancelAll() {
        return Promise.resolve()
            .then(function () { return getLocalNotifications(); })
            .then(function (plugin) {
                return plugin.getPending().then(function (pending) {
                    var ids = (pending && Array.isArray(pending.notifications))
                        ? pending.notifications.map(function (n) { return { id: n.id }; })
                        : [];
                    if (!ids.length) return { canceled: 0, platform: 'capacitor' };
                    return plugin.cancel({ notifications: ids })
                        .then(function () { return { canceled: ids.length, platform: 'capacitor' }; });
                });
            })
            .catch(function (e) { throw normalizeError(e); });
    }

    function schedule(reminders) {
        var payload = buildPayload(reminders);
        return Promise.resolve()
            .then(function () { return getLocalNotifications(); })
            .then(function (plugin) {
                return plugin.getPending()
                    .then(function (pending) {
                        var ids = (pending && Array.isArray(pending.notifications))
                            ? pending.notifications.map(function (n) { return { id: n.id }; })
                            : [];
                        if (!ids.length) return null;
                        return plugin.cancel({ notifications: ids });
                    })
                    .then(function () {
                        if (!payload.notifications.length) {
                            return { scheduled: 0, platform: 'capacitor' };
                        }
                        return plugin.schedule(payload).then(function () {
                            return { scheduled: payload.notifications.length, platform: 'capacitor' };
                        });
                    });
            })
            .catch(function (e) { throw normalizeError(e); });
    }

    // FETCH_FAILED is a sentinel so the caller can distinguish "the server told
    // us there are no upcoming reminders" (-> wipe queue, schedule nothing)
    // from "we couldn't reach the server" (-> leave the existing OS queue
    // alone). Without this distinction a transient 5xx on app resume cancels
    // every pre-scheduled medication notification, which on Capacitor means
    // the user silently misses doses for the next 24h.
    var FETCH_FAILED = { __fetchFailed: true };

    function fetchUpcoming() {
        // offlineAwareApiCall and apiCallDirect both have signature
        // (endpoint, method, body, opts) and return the parsed JSON body
        // directly (not a Response). Fall back to fetch() only when neither
        // helper is present, in which case we read the Response ourselves.
        var apiCall = (typeof window.offlineAwareApiCall === 'function')
            ? window.offlineAwareApiCall
            : (typeof window.apiCallDirect === 'function' ? window.apiCallDirect : null);
        var doFetch;
        if (apiCall) {
            doFetch = Promise.resolve(apiCall(REMINDERS_ENDPOINT, 'GET'));
        } else {
            doFetch = window.fetch(REMINDERS_ENDPOINT, { method: 'GET', credentials: 'same-origin' })
                .then(function (res) {
                    if (!res || !res.ok) return FETCH_FAILED;
                    return res.json();
                });
        }
        return doFetch.then(function (data) {
            if (data === FETCH_FAILED) return FETCH_FAILED;
            // offlineAwareApiCall returns null on network/5xx errors for
            // endpoints that aren't registered for offline reads (see
            // sync.js:898-905). /api/reminders/upcoming is not registered,
            // so a transient failure surfaces as null — treat it as
            // FETCH_FAILED rather than as an empty list, otherwise
            // schedule([]) wipes every pre-scheduled OS notification.
            if (!Array.isArray(data)) return FETCH_FAILED;
            return data;
        }).catch(function () { return FETCH_FAILED; });
    }

    function refreshFromServer() {
        return fetchUpcoming().then(function (reminders) {
            if (reminders === FETCH_FAILED) {
                // Leave existing pending OS notifications alone — they remain
                // the best-effort snapshot until the next successful fetch.
                return { scheduled: 0, platform: 'capacitor', skipped: 'fetch_failed' };
            }
            return schedule(reminders);
        }).catch(function (e) {
            // Pre-schedule loop is best-effort; never throw from the listener.
            return { scheduled: 0, platform: 'capacitor', error: String(e && e.message || e) };
        });
    }

    // Notification-tap deep-link handler. The plugin emits
    // 'localNotificationActionPerformed' with { notification: { extra: {...} } }
    // when the user taps. We route through the existing query-param deep-link
    // path (push.js does the same thing in the browser PWA) so there is no
    // duplicate router.
    function handleNotificationTap(event) {
        var extra = event && event.notification && event.notification.extra;
        if (!extra || extra.intake_id == null) return;
        try {
            var ids = String(extra.medication_id != null ? extra.medication_id : '');
            var intakeIds = String(extra.intake_id);
            // Merge into the existing query string rather than replacing it,
            // so unrelated state (e.g. ?section=workouts) isn't lost when the
            // user taps a notification.
            var params;
            try {
                params = new window.URLSearchParams(window.location.search || '');
            } catch (_) {
                params = new window.URLSearchParams();
            }
            params.set('action', 'medication_confirm');
            if (ids) params.set('ids', ids);
            params.set('intake_ids', intakeIds);
            if (extra.medication_name) {
                params.set('names', String(extra.medication_name));
            }
            if (extra.scheduled_at) {
                params.set('scheduled', String(extra.scheduled_at));
            }
            var search = '?' + params.toString();
            if (typeof window.history !== 'undefined' && window.history.replaceState) {
                window.history.replaceState({}, '', search);
            }
            if (typeof window.handleDeepLinks === 'function') {
                window.handleDeepLinks();
            }
        } catch (e) {
            // Log so a broken tap-handler is debuggable from WebView logs
            // rather than silently dropping the deep-link.
            try { console.error('Reminders: notification tap handler failed:', e); } catch (_) { /* ignore */ }
        }
    }

    var loopState = { started: false, removeListeners: [] };

    function startPreScheduleLoop() {
        if (loopState.started) return loopState;
        loopState.started = true;

        // Initial fire — don't wait for the first resume to fill the queue on
        // a cold app launch. Best-effort; swallow errors.
        refreshFromServer();

        // Re-fire on resume so the queue stays fresh after the user closes,
        // backgrounds, or sleeps the device.
        var app = tryGetApp();
        if (app && typeof app.addListener === 'function') {
            try {
                var sub = app.addListener('appStateChange', function (state) {
                    if (state && state.isActive) refreshFromServer();
                });
                if (sub && typeof sub.remove === 'function') loopState.removeListeners.push(sub.remove.bind(sub));
                else if (sub && typeof sub.then === 'function') {
                    // Capacitor 5+ returns a Promise<PluginListenerHandle>.
                    sub.then(function (handle) {
                        if (handle && typeof handle.remove === 'function') {
                            loopState.removeListeners.push(handle.remove.bind(handle));
                        }
                    });
                }
            } catch (_) { /* ignore */ }
        }

        // Notification-tap deep-link wiring.
        try {
            var ln = getLocalNotifications();
            if (ln && typeof ln.addListener === 'function') {
                var tapSub = ln.addListener('localNotificationActionPerformed', handleNotificationTap);
                if (tapSub && typeof tapSub.remove === 'function') loopState.removeListeners.push(tapSub.remove.bind(tapSub));
                else if (tapSub && typeof tapSub.then === 'function') {
                    tapSub.then(function (handle) {
                        if (handle && typeof handle.remove === 'function') {
                            loopState.removeListeners.push(handle.remove.bind(handle));
                        }
                    });
                }
            }
        } catch (_) { /* ignore — plugin absence already surfaces via schedule() */ }

        return loopState;
    }

    function _stopPreScheduleLoop() {
        for (var i = 0; i < loopState.removeListeners.length; i++) {
            try { loopState.removeListeners[i](); } catch (_) { /* ignore */ }
        }
        loopState.removeListeners = [];
        loopState.started = false;
    }

    var impl = {
        schedule: schedule,
        cancelAll: cancelAll,
        startPreScheduleLoop: startPreScheduleLoop,
        // Test-only seams (underscore-prefixed). _refreshFromServer exercises
        // the fetch+schedule path without booting the resume listener;
        // _handleNotificationTap exercises the deep-link routing in isolation.
        _refreshFromServer: refreshFromServer,
        _handleNotificationTap: handleNotificationTap,
        _stopPreScheduleLoop: _stopPreScheduleLoop,
        _buildPayload: buildPayload,
    };

    if (window.Reminders && window.Reminders.__native && typeof window.Reminders.__native.registerImpl === 'function') {
        window.Reminders.__native.registerImpl('Reminders', 'capacitor', impl);
    }
})();
