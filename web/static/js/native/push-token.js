// window.NativePush — APNs / FCM wake channel of the app shells (bd med-erq1.3).
//
// WKWebView and Android WebView have no Web Push, so in cloud (account) mode
// the shell hands the page its device token, the page registers it with the
// relay (POST /api/push/native-tokens, web/cloud/js/push.js), and the relay's
// content-free wakes come back as a document event. The web impl reports
// unsupported, so feature code branches on isSupported(), never on the platform.
//
// Shell contract (ios med-erq1.4, android med-erq1.5), account mode only:
//   op push.token {}  → {platform: 'ios' | 'android', token} | null — null until
//                       the OS granted notifications and the token is known.
//                       A shell without the op (shell.ops omits it) reads as null.
//   page event        → document.dispatchEvent(new CustomEvent('wg:native-push',
//                       {detail: {kind}})), kind one of:
//                         'inbox-wake' — the relay sealed inbox mail: drain it
//                         'dry-queue'  — the reminder horizon ran dry: refill it
//                         'token'      — the device token is new or changed:
//                                        register it again
//                       The push payload carries nothing but kind. The event
//                       is cancelable: an onWake(fn) whose fn returns true for
//                       the kind calls preventDefault() as its receipt (bd
//                       med-erq1.4), and the shell shows its own notification
//                       unless the event came back defaultPrevented (no listener
//                       yet, an old page, a failed boot all fall back to it).
//
// Load order: after native/index.js.
(function () {
    'use strict';

    var foundation = window.NativePush && window.NativePush.__native;
    if (!foundation || typeof foundation.registerImpl !== 'function') {
        throw new Error('native/push-token.js: native/index.js must load first');
    }

    foundation.registerImpl('NativePush', 'web', {
        isSupported: function () { return false; },
    });
    var shell = {
        isSupported: function () { return true; },
        // Never rejects: an old shell, a denied permission or a bridge error
        // all mean "no token yet".
        token: function () {
            return foundation.has('push.token')
                .then(function (has) { return has ? foundation.call('push.token') : null; })
                .then(function (r) {
                    var ok = r && (r.platform === 'ios' || r.platform === 'android')
                        && typeof r.token === 'string' && r.token;
                    return ok ? { platform: r.platform, token: r.token } : null;
                }, function () { return null; });
        },
        onWake: function (fn) {
            document.addEventListener('wg:native-push', function (e) {
                var kind = e && e.detail && e.detail.kind;
                // fn returns true when it took this kind: the receipt the shell reads.
                if (typeof kind === 'string' && fn(kind) === true) e.preventDefault();
            });
        },
    };
    foundation.registerImpl('NativePush', 'ios', shell);
    foundation.registerImpl('NativePush', 'android', shell);
})();
