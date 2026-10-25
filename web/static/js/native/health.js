// window.Health — Apple Health (HealthKit) / Health Connect read access (bd med-w6gx.4).
//
// Only the iOS and Android app shells have it. The web impl reports unsupported, so feature
// code branches on isSupported(), never on the platform.
//
// ios (bd med-w6gx.6), answered by ios/App/Health.swift, and android (bd
// med-nt9p.8, Health Connect: bp and weight), by android/.../HealthConnect.kt:
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
// Steps, heart rate and SpO2 (bd med-0xad.1; iOS med-0xad.2, Android med-0xad.3).
// requestAuthorization takes 'steps', 'hr', 'spo2' like the other types.
//   query({ type: 'steps', from, to }) (ms, no anchor) → { samples, returned,
//     more: false }: one DAILY TOTAL per LOCAL day in the device zone,
//     samples [{ day: 'YYYY-MM-DD', steps: <int>, tz: <zone name> }]. `from`
//     is aligned down to its local midnight so the first day is whole; the
//     count is the store's own deduped aggregate across sources (HealthKit
//     statistics query / Health Connect aggregate), never a sum of raw
//     samples. Days with no steps may be left out. `returned` = the number of
//     days in `samples` (the web keys its window on `samples` anyway). The
//     web reads a year back until a read returns days, then from a week
//     before the last such read.
//   query({ type: 'hr' | 'spo2', anchor, limit[, from] }) → anchored pages
//     like 'bp': samples [{ uuid, start (ms), value }], value in bpm for 'hr'
//     and percent 0-100 for 'spo2' (not a 0-1 fraction: values under 50 are
//     dropped as invalid). `from` (ms) comes only with anchor null, on the
//     first read: return only samples starting at or after it (90 days
//     back), the anchor then covers what follows. `limit` / `more` hold on
//     that first scan too (a watch's 90 days of HR is tens of thousands of
//     samples): page it, never one answer. 'hr' is every heart-rate sample
//     in the store, workout-rate ones included, no filtering (same as the
//     .nxk import, which wrote every sample).
//   History: Health Connect reads nothing older than 30 days before the grant
//   without READ_HEALTH_DATA_HISTORY. The shell asks for it with the read
//   types when the device offers it; without it, answer what is readable. A
//   history grant later is picked up by switching the import off and on
//   (that rescan forgets the steps window and every anchor).
//   A type the shell does not know: authorize ignores it, query rejects. The
//   web then forgets it was asked, so a later shell that knows it shows the
//   sheet (health-import.js).
//
// Where it lands: web/domain/healthimport.js → vitals.js importSamples
// (daystats / hrsample / spo2sample, the rows the Vitals cards read).
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
    // The Android shell (bd med-nt9p.8) answers the same ops with the same
    // impl, from Health Connect (android/.../HealthConnect.kt). `label` and
    // `accessHint` name the store and where its read access is managed, for
    // the Settings copy (web/cloud/js/health-import.js): feature code reads
    // the copy off the capability, never the platform.
    var android = foundation.platform === 'android';
    var shell = {
        label: android ? 'Health Connect' : 'Apple Health',
        accessHint: android ? 'Health Connect → App permissions' : 'Settings → Health → Data Access & Devices',
        isSupported: function () { return true; },
        requestAuthorization: function (types) {
            return foundation.call('health.authorize', { types: types });
        },
        query: function (args) {
            return foundation.call('health.query', args);
        },
    };
    foundation.registerImpl('Health', 'ios', shell);
    foundation.registerImpl('Health', 'android', shell);
})();
