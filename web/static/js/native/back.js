// window.NativeBack — the app shells' system Back (bd med-y7b4.3; iOS twin
// med-y7b4.4, Android twin med-y7b4.5). The page owns the back order
// (features/app-back.js AppBack.step()); the shells only ask it.
//
//   onStep(fn)        → fn() runs AppBack.step(): true when it closed or returned
//                       something, false at the root.
//   setState(canStep) → tells the shell what step() would answer right now.
//
// Shell contract (both shells, local and account mode):
//   shell → web 'back': evaluate
//       !document.dispatchEvent(new CustomEvent('wg:native-back',{cancelable:true}))
//     → true when the page stepped back (it cancels the event as its answer),
//       false at the root (iOS: nothing; Android: WebView history, then leave).
//     Same shape as the shells' pushEvent, without its account/unlock gate.
//   web → shell op 'back.state' {canStep: boolean}: once on load and whenever
//     the answer changes; sent only when shell.ops lists it. Android registers
//     its OnBackInvokedCallback only while canStep; iOS may ignore it.
//
// The web impl is a no-op: the browser's own Back reaches AppBack through
// popstate (modal-history.js / back-button.js).
//
// Load order: after native/index.js.
(function () {
    'use strict';

    var foundation = window.NativeBack && window.NativeBack.__native;
    if (!foundation || typeof foundation.registerImpl !== 'function') {
        throw new Error('native/back.js: native/index.js must load first');
    }

    foundation.registerImpl('NativeBack', 'web', {
        onStep: function () {},
        setState: function () {},
    });
    var shell = {
        onStep: function (fn) {
            document.addEventListener('wg:native-back', function (e) {
                if (fn() === true) e.preventDefault();
            });
        },
        // Never rejects: an older shell without the op just never hears it.
        setState: function (canStep) {
            foundation.has('back.state').then(function (has) {
                if (has) return foundation.call('back.state', { canStep: !!canStep });
            }).catch(function () {});
        },
    };
    foundation.registerImpl('NativeBack', 'ios', shell);
    foundation.registerImpl('NativeBack', 'android', shell);
})();
