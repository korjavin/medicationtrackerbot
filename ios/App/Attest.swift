import CryptoKit
import DeviceCheck
import Foundation

/// window.Attest on iOS (bd med-o7zq.16): App Attest + DeviceCheck for local
/// mode's anonymous trial AI. The server half is internal/cloudserver/attest.go
/// (docs/cloud-mode.md → Anonymous trial); the page's client is
/// web/cloud/js/local-trial.js over web/static/js/native/attest.js.
///
/// What this proves, and what it does not: the key proves a genuine build of
/// this app on a real Apple device, per install. It says nothing about who
/// asked or whether the user meant a given request — the page picks the body
/// it wants signed. That is why the shell answers these ops only for the
/// bundled app's own top-level page, only in local mode and never while the
/// lock holds (Shell.swift), and why the replies are useful only to our
/// server's /api/attest routes. It is not a proof that two keys share a device.
///
/// Ops (web/static/js/native/attest.js):
///   attest.status → {supported, base, attested} (no network); attested: the
///     current key was attested already, so the server has it or the enroll
///     POST failed after it — Apple attests a key only once.
///   attest.enroll {challenge} → {keyId, attestation, deviceToken}: attests
///     the current key, or a new one when it was attested already or is gone
///     (a new key then meets the server's DeviceCheck bit0: one trial per
///     device). clientDataHash = SHA256(challenge).
///   attest.assert {challenge, bodySha256} → {keyId, assertion}, or "no_key"
///     when there is no usable key (enroll again). clientDataHash =
///     SHA256(challenge ‖ bodySha256); the page computes bodySha256 =
///     SHA256(pathAndQuery ‖ "\n" ‖ body), as the server does.
/// All binary values are standard base64; the challenge is hashed as its
/// decoded bytes.
@MainActor
enum Attest {
    struct Failure: LocalizedError {
        let errorDescription: String?
        init(_ message: String) { errorDescription = message }
    }

    /// The install's App Attest key id, and that id once attested.
    /// UserDefaults, not the Keychain: a reinstall must not find them, since
    /// App Attest keys do not survive one.
    static let keyIdKey = "wgAttestKeyId"
    static let attestedKey = "wgAttestAttested"

    /// False on the Simulator and devices without Secure Enclave support.
    static var supported: Bool { DCAppAttestService.shared.isSupported && DCDevice.current.isSupported }

    static func handle(_ op: String, _ args: [String: Any], base: String) async throws -> Any {
        let defaults = UserDefaults.standard
        let current = defaults.string(forKey: keyIdKey)
        let attested = current != nil && current == defaults.string(forKey: attestedKey)
        switch op {
        case "attest.status":
            // base is the trial host: the deployment's base domain (WG_BASE_DOMAIN).
            return ["supported": supported && !base.isEmpty, "base": base, "attested": attested]
        case "attest.enroll":
            guard supported else { throw Failure("unsupported") }
            let hash = Data(SHA256.hash(data: try bytes(args["challenge"])))
            var keyId: String
            if let current, !attested {
                keyId = current
            } else {
                keyId = try await newKey()
            }
            let attestation: Data
            do {
                attestation = try await DCAppAttestService.shared.attestKey(keyId, clientDataHash: hash)
            } catch let e as DCError where e.code == .invalidKey {
                keyId = try await newKey() // the stored key is no longer usable
                attestation = try await DCAppAttestService.shared.attestKey(keyId, clientDataHash: hash)
            }
            defaults.set(keyId, forKey: attestedKey)
            let token = try await DCDevice.current.generateToken()
            return ["keyId": keyId, "attestation": attestation.base64EncodedString(),
                    "deviceToken": token.base64EncodedString()]
        case "attest.assert":
            guard supported else { throw Failure("unsupported") }
            guard let keyId = current, attested else { throw Failure("no_key") }
            let challenge = try bytes(args["challenge"])
            let digest = try bytes(args["bodySha256"])
            guard digest.count == 32 else { throw Failure("invalid bodySha256") }
            let hash = Data(SHA256.hash(data: challenge + digest))
            do {
                let assertion = try await DCAppAttestService.shared.generateAssertion(keyId, clientDataHash: hash)
                return ["keyId": keyId, "assertion": assertion.base64EncodedString()]
            } catch let e as DCError where e.code == .invalidKey {
                defaults.removeObject(forKey: keyIdKey)
                throw Failure("no_key")
            }
        default:
            throw Failure("unsupported: \(op)")
        }
    }

    private static func newKey() async throws -> String {
        let id = try await DCAppAttestService.shared.generateKey()
        UserDefaults.standard.set(id, forKey: keyIdKey)
        return id
    }

    private static func bytes(_ raw: Any?) throws -> Data {
        guard let s = raw as? String, let d = Data(base64Encoded: s), !d.isEmpty else { throw Failure("invalid base64") }
        return d
    }
}
