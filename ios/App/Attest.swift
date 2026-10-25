import CryptoKit
import DeviceCheck
import Foundation
import Security

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
///   attest.enroll {challenge} → {keyId, attestation, deviceToken, pass?}:
///     attests the current key, or a new one when it was attested already or
///     is gone. pass is the trial pass in the Keychain, when an earlier
///     install stored one: the server then binds the new key to that trial
///     bucket (bd med-o7zq.26); without one, a new key meets the server's
///     DeviceCheck bits. clientDataHash = SHA256(challenge).
///   attest.setPass {pass} → null: stores the trial pass the server granted
///     ("" deletes it).
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
    /// local.reset {dropAttest: true} drops both, never the pass (LocalOrigin.resetAttest, bd med-egb3).
    static let keyIdKey = LocalOrigin.attestKeyIdKey
    static let attestedKey = LocalOrigin.attestedKey

    /// The trial pass (bd med-o7zq.26) is the opposite: the Keychain, so it
    /// outlives a reinstall and the next install rejoins the same trial
    /// budget. This device only, after first unlock, never iCloud-synced.
    static let passQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "wgTrialPass",
        kSecAttrAccount as String: "trial",
        kSecAttrSynchronizable as String: false,
    ]

    static func readPass() -> String? {
        var query = passQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func writePass(_ pass: String) throws {
        SecItemDelete(passQuery as CFDictionary)
        guard !pass.isEmpty else { return }
        var item = passQuery
        item[kSecValueData as String] = Data(pass.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw Failure("keychain \(status)") }
    }

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
            var reply: [String: Any] = ["keyId": keyId, "attestation": attestation.base64EncodedString(),
                                        "deviceToken": token.base64EncodedString()]
            if let pass = readPass() { reply["pass"] = pass }
            return reply
        case "attest.setPass":
            guard let pass = args["pass"] as? String else { throw Failure("invalid pass") }
            try writePass(pass)
            return NSNull()
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
