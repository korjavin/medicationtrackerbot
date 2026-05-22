// Native platform abstraction layer foundation (mobile Phase 2b, Task 1).
//
// Exposes four window globals — MediaCapture, Geolocation, Barcode, Reminders —
// as the seam between feature code (web/static/js/features/*) and platform
// APIs. Each global is initially populated with stubs that throw
// NotImplementedError so any premature caller is loud rather than silently
// no-op; subsequent tasks (2–5) replace the stubs with web/* and capacitor/*
// impls and the runtime picks one via isNativePlatform().
//
// Load order: this file MUST run before features/* scripts because Task 7's
// refactored callers (food/scanner.js, food/photo.js) read these globals at
// module-evaluate time. The script tag sits in index.html between
// cached-fetch.js and features/tab-controller.js.
(function () {
    'use strict';

    function NotImplementedError(capability, method) {
        var err = new Error(
            'window.' + capability + '.' + method + ' is not implemented yet ' +
            '(Phase 2b foundation stub — Tasks 2–5 install the real impls).'
        );
        err.name = 'NotImplementedError';
        err.capability = capability;
        err.method = method;
        return err;
    }

    function makeStub(capability, methods) {
        var stub = {};
        for (var i = 0; i < methods.length; i++) {
            (function (method) {
                stub[method] = function () {
                    throw NotImplementedError(capability, method);
                };
            })(methods[i]);
        }
        return stub;
    }

    // Runtime platform detection. Returns true when running inside the
    // Capacitor Android shell (Phase 2a embedded-Go build); false in the
    // browser PWA and the server-mode build. Safe when window.Capacitor is
    // undefined because the optional-chain short-circuits to undefined and
    // the nullish-coalesce returns false.
    function isNativePlatform() {
        try {
            var cap = window.Capacitor;
            if (!cap) return false;
            if (typeof cap.isNativePlatform === 'function') {
                return Boolean(cap.isNativePlatform());
            }
            return false;
        } catch (_) {
            return false;
        }
    }

    var foundation = {
        isNativePlatform: isNativePlatform,
        NotImplementedError: NotImplementedError,
    };

    // Stub surface area — kept in sync with the abstractions defined by the
    // Phase 2b plan. Each global lists the methods Tasks 2–5 will fill in.
    window.MediaCapture = makeStub('MediaCapture', ['takePhoto', 'pickPhoto']);
    window.Geolocation = makeStub('Geolocation', ['getCurrentPosition']);
    window.Barcode = makeStub('Barcode', ['scan']);
    window.Reminders = makeStub('Reminders', ['schedule', 'cancelAll']);

    // Stash the foundation helpers under a namespaced property on each global
    // so tests (and future capacitor/* impls) can call isNativePlatform()
    // without poking at window. Keeping it under a chained property avoids
    // adding a fifth window global behind the allowlist.
    window.MediaCapture.__native = foundation;
    window.Geolocation.__native = foundation;
    window.Barcode.__native = foundation;
    window.Reminders.__native = foundation;
})();
