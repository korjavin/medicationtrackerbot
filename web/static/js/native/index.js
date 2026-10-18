// Device-capability abstraction layer.
//
// Exposes window globals — MediaCapture, Barcode, Bluetooth, LocalNotifications,
// Health and Attest — as the seam between feature code (web/static/js/features/*) and
// device APIs. Each global
// is initially populated with stubs that throw NotImplementedError so a caller
// that loads before the impls is loud rather than silently no-op; the impl
// files (web/*, and native/<capability>.js) replace them via registerImpl().
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

    // The platform, decided once, here and nowhere else (docs/frontend.md
    // Device-Capability Abstractions): 'ios' only inside the iOS app shell,
    // which injects the wgNative reply handler (ios/App/Shell.swift); 'web'
    // everywhere else, where everything below behaves exactly as before.
    var bridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.wgNative;
    var current = bridge ? 'ios' : 'web';

    // One request/response round trip to the shell: with
    // WKScriptMessageHandlerWithReply, postMessage returns a promise of the
    // Swift reply (rejected with the Swift error string). ios impls only.
    function call(op, args) {
        if (!bridge) return Promise.reject(NotImplementedError('native', op));
        return Promise.resolve(bridge.postMessage({ op: op, args: args || {} }));
    }

    // Per-capability impl registry. Populated by the impl files via
    // registerImpl(). Splitting the wiring step from the file load lets the
    // impl files run in any order after index.js, and lets tests reach an
    // impl by name.
    var impls = {};

    function registerImpl(capability, platform, impl) {
        if (platform !== 'web' && platform !== 'ios') {
            throw new Error('registerImpl: platform must be "web" or "ios", got ' + platform);
        }
        if (!impls[capability]) impls[capability] = {};
        impls[capability][platform] = impl;
        // The running platform's impl wins, else web's: on web an ios impl
        // stays in the registry and is never installed.
        var chosen = impls[capability][current] || impls[capability].web;
        if (!chosen) return;
        window[capability] = chosen;
        window[capability].__native = foundation;
    }

    function getImpl(capability, platform) {
        return impls[capability] && impls[capability][platform];
    }

    var foundation = {
        NotImplementedError: NotImplementedError,
        registerImpl: registerImpl,
        getImpl: getImpl,
        platform: current,
        call: call,
    };

    window.MediaCapture = makeStub('MediaCapture', ['takePhoto', 'pickPhoto', 'openCameraStream', 'recordAudio']);
    window.Barcode = makeStub('Barcode', ['scan', 'supportsLiveScan']);
    window.Bluetooth = makeStub('Bluetooth', ['isSupported', 'requestHeartRateDevice', 'subscribeHeartRate', 'unsubscribe']);
    window.LocalNotifications = makeStub('LocalNotifications', ['isSupported']);
    window.Health = makeStub('Health', ['isSupported']);
    window.Attest = makeStub('Attest', ['isSupported']);

    // Stash the foundation helpers under a namespaced property on each global
    // so tests and impls can reach registerImpl without another window global.
    window.MediaCapture.__native = foundation;
    window.Barcode.__native = foundation;
    window.Bluetooth.__native = foundation;
    window.LocalNotifications.__native = foundation;
    window.Health.__native = foundation;
    window.Attest.__native = foundation;
})();
