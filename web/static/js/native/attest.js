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
//   enroll(challenge)              → { keyId, attestation, deviceToken } (base64)
//                                    for the current key, or a new one once it
//                                    was attested
//   assert(challenge, bodySha256)  → { keyId, assertion } (base64); rejects
//                                    "no_key" when there is no usable key (enroll again)
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
    });
})();
