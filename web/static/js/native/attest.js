// window.Attest — App Attest + DeviceCheck (bd med-o7zq.16), for local mode's
// anonymous trial AI (web/cloud/js/local-trial.js).
//
// Only the iOS app shell has it. The web impl reports unsupported, so callers
// branch on isSupported(), never on the platform.
//
// ios ops, answered by ios/App/Attest.swift (local mode only, never while the
// lock holds — Shell.swift answers "locked"):
//   status()                       → { supported, base, attested }: supported is
//                                    false on the Simulator and old devices; base
//                                    is the trial host; attested: the current key
//                                    was attested once (Apple allows only once)
//   enroll(challenge)              → { keyId, attestation, deviceToken, pass? }
//                                    (base64) for the current key, or a new one
//                                    once it was attested; pass: the trial pass
//                                    an earlier install kept in the Keychain
//   setPass(pass)                  → null; keeps the server's trial pass in the
//                                    Keychain (survives a reinstall, this device
//                                    only, bd med-o7zq.26); '' deletes it
//   assert(challenge, bodySha256)  → { keyId, assertion } (base64); rejects
//                                    "no_key" when there is no usable key (enroll again)
// android ops (bd med-nt9p.32.8.4), answered by android/.../Attest.kt in local
// mode only (an account page gets "unsupported: <op>"): the same four, over a
// Keystore P-256 key and a Play Integrity standard request instead of App
// Attest + DeviceCheck:
//   status()                       → { supported, base, attested }: supported is
//                                    false without Play services or in a build
//                                    with no Play Integrity project (forks, QA)
//   enroll(challenge)              → { kind: 'android', keyId, publicKey,
//                                    integrityToken, pass? }: publicKey is the
//                                    key's SPKI DER (base64), keyId base64url
//   setPass(pass), assert(…)       → as ios; the assertion is counter ‖ signature
// The android impl also carries copy.trialTransit, the trial consent's "what
// our server keeps" text for this platform (features/trial-consent.js).
// challenge and bodySha256 are standard base64. The replies mean something
// only to our server's /api/attest routes: the key proves a genuine app
// install, not that the user meant a given request.
//
// Load order: after native/index.js.
(function () {
    'use strict';

    var foundation = window.Attest && window.Attest.__native;
    if (!foundation || typeof foundation.registerImpl !== 'function') {
        throw new Error('native/attest.js: native/index.js must load first');
    }

    foundation.registerImpl('Attest', 'web', {
        isSupported: function () { return false; },
    });
    foundation.registerImpl('Attest', 'ios', {
        isSupported: function () { return true; },
        status: function () { return foundation.call('attest.status'); },
        enroll: function (challenge) { return foundation.call('attest.enroll', { challenge: challenge }); },
        assert: function (challenge, bodySha256) {
            return foundation.call('attest.assert', { challenge: challenge, bodySha256: bodySha256 });
        },
        setPass: function (pass) { return foundation.call('attest.setPass', { pass: pass }); },
    });
    // The same ops as ios, plus this platform's consent copy (bd med-nt9p.32.8.4).
    var ios = foundation.getImpl('Attest', 'ios');
    foundation.registerImpl('Attest', 'android', {
        isSupported: ios.isSupported,
        status: ios.status,
        enroll: ios.enroll,
        assert: ios.assert,
        setPass: ios.setPass,
        copy: {
            trialTransit: 'To count the trial without an account, our server stores an anonymous install id (a key this app made in this phone’s Android Keystore, confirmed by Google Play Integrity) and how many requests and seconds of calls this phone’s trial has used. Turning the trial on asks Google Play Integrity to check this app install: no health data, no account. You get a limited number of free AI requests on this phone, a daily allowance of food lookups, and a limited number of free minutes of voice calls on this phone, with a daily limit (the minutes left are shown in Settings), counted by our server as call time: each call uses its full length limit when it starts, even if you hang up sooner.',
        },
    });
})();
