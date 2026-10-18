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
    // which injects the wgNative reply handler (ios/App/Shell.swift);
    // 'android' only inside the Android app shell, whose WebMessageListener
    // WebView injects as window.wgNative (android/.../MainActivity.kt,
    // docs/android.md); 'web' everywhere else, where everything below behaves
    // exactly as before. ios is checked first.
    var bridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.wgNative;
    // Named-property globals can clobber window.wgNative on the web: an
    // <iframe name=wgNative> yields a WindowProxy (it has postMessage and
    // addEventListener) and an element with that id yields a DOM node. The
    // injected listener object is neither, so both stay 'web'.
    var injected = window.wgNative;
    var androidBridge = !bridge && injected && typeof injected.postMessage === 'function'
        && typeof injected.addEventListener === 'function'
        && injected.window !== injected
        && !(typeof Node === 'function' && injected instanceof Node) ? injected : null;
    var current = bridge ? 'ios' : (androidBridge ? 'android' : 'web');

    // android: a WebMessageListener has no reply promise, so call()
    // correlates by id — {op, args, id} out as a JSON string, {id, result} or
    // {id, error} back as a message event on the same object.
    var pending = {};
    var nextId = 0;
    if (androidBridge) {
        androidBridge.addEventListener('message', function (event) {
            var reply;
            try { reply = JSON.parse(event.data); } catch (e) { return; }
            var waiter = reply && pending[reply.id];
            if (!waiter) return;
            delete pending[reply.id];
            if (reply.error != null) waiter.reject(new Error(String(reply.error)));
            else waiter.resolve(reply.result === undefined ? null : reply.result);
        });
    }

    // One request/response round trip to the shell: a promise of the native
    // reply, rejected with the native error string. ios: with
    // WKScriptMessageHandlerWithReply, postMessage itself returns that
    // promise. ios and android impls only.
    function call(op, args) {
        if (androidBridge) {
            var id = ++nextId;
            return new Promise(function (resolve, reject) {
                pending[id] = { resolve: resolve, reject: reject };
                try {
                    androidBridge.postMessage(JSON.stringify({ op: op, args: args || {}, id: id }));
                } catch (e) {
                    delete pending[id];
                    reject(e);
                }
            });
        }
        if (!bridge) return Promise.reject(NotImplementedError('native', op));
        return Promise.resolve(bridge.postMessage({ op: op, args: args || {} }));
    }

    // Per-capability impl registry. Populated by the impl files via
    // registerImpl(). Splitting the wiring step from the file load lets the
    // impl files run in any order after index.js, and lets tests reach an
    // impl by name.
    var impls = {};

    function registerImpl(capability, platform, impl) {
        if (platform !== 'web' && platform !== 'ios' && platform !== 'android') {
            throw new Error('registerImpl: platform must be "web", "ios" or "android", got ' + platform);
        }
        if (!impls[capability]) impls[capability] = {};
        impls[capability][platform] = impl;
        // The running platform's impl wins, else web's: on web an ios or
        // android impl stays in the registry and is never installed.
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
