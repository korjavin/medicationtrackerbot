// Device-capability abstraction layer.
//
// Exposes two window globals — MediaCapture and Barcode — as the seam between
// feature code (web/static/js/features/*) and browser device APIs. Each global
// is initially populated with stubs that throw NotImplementedError so a caller
// that loads before the impls is loud rather than silently no-op; the web/*
// sibling files replace them via registerImpl().
//
// Load order: this file MUST run before features/* scripts because
// food/scanner.js and food/photo.js read these globals at module-evaluate
// time. The script tag sits in index.html between cached-fetch.js and
// features/tab-controller.js.
(function () {
    'use strict';

    function NotImplementedError(capability, method) {
        var err = new Error('window.' + capability + '.' + method + ' has no registered implementation.');
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

    // Per-capability impl registry. Populated by the web/* sibling files via
    // registerImpl(). Splitting the wiring step from the file load lets the
    // impl files run in any order after index.js, and lets tests reach an
    // impl by name.
    var impls = {};

    function registerImpl(capability, platform, impl) {
        if (platform !== 'web') {
            throw new Error('registerImpl: platform must be "web", got ' + platform);
        }
        if (!impls[capability]) impls[capability] = {};
        impls[capability][platform] = impl;
        window[capability] = impl;
        window[capability].__native = foundation;
    }

    function getImpl(capability, platform) {
        return impls[capability] && impls[capability][platform];
    }

    var foundation = {
        NotImplementedError: NotImplementedError,
        registerImpl: registerImpl,
        getImpl: getImpl,
    };

    window.MediaCapture = makeStub('MediaCapture', ['takePhoto', 'pickPhoto', 'openCameraStream', 'recordAudio']);
    window.Barcode = makeStub('Barcode', ['scan', 'supportsLiveScan']);

    // Stash the foundation helpers under a namespaced property on each global
    // so tests and impls can reach registerImpl without a third window global.
    window.MediaCapture.__native = foundation;
    window.Barcode.__native = foundation;
})();
