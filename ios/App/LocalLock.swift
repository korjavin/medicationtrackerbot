import Foundation
import LocalAuthentication

/// Local mode's optional lock (bd med-o7zq.8): Face ID / Touch ID with the
/// passcode as fallback before the on-device app shows. A UI lock, not
/// encryption: while it holds, Shell keeps the web view out of the window
/// (the page stays hidden, so no visibility-triggered work runs), defers
/// every load, and the bridge answers "locked".
///
/// Pure state; Shell persists `on` and runs DeviceAuth. Checked by
/// ios/Tests/main.swift.
struct LocalLock {
    enum State { case locked, unlocking, unlocked }
    /// iPhone Settings → Med Tracker → Lock: what the user asks for.
    static let settingKey = "wgLocalLock"
    /// Whether the lock is in force. Turning it off takes an unlock, so the
    /// setting alone never lowers this.
    static let onKey = "wgLocalLockOn"

    private(set) var on: Bool
    private(set) var state: State
    /// Armed at launch and on going to the background: the next activation
    /// prompts once. Never re-armed by the prompt's own inactive → active
    /// round trip, so a cancel leaves the app locked with no prompt loop.
    private(set) var promptDue: Bool
    /// Bumped by every prompt and every background: a stale prompt's result is dropped.
    private(set) var attempt = 0
    /// The last prompt failed (not cancelled): the lock screen's warn note (N3).
    private(set) var failed = false

    init(on: Bool) {
        self.on = on
        state = on ? .locked : .unlocked
        promptDue = on
    }

    /// Concealed and bridge closed. Local mode only: an account has its own passkey unlock.
    func holds(local: Bool) -> Bool { local && on && state != .unlocked }

    mutating func background() {
        guard on else { return }
        state = .locked
        failed = false
        promptDue = true
        attempt += 1
    }

    /// The app became active: applies the setting, returns the attempt to
    /// prompt for, or nil.
    mutating func activate(local: Bool, setting: Bool) -> Int? {
        apply(setting)
        guard holds(local: local), promptDue, state == .locked else { return nil }
        promptDue = false
        return begin()
    }

    /// The Unlock button (or activate): nil while a prompt is already up or nothing is locked.
    mutating func begin() -> Int? {
        guard state == .locked else { return nil }
        state = .unlocking
        attempt += 1
        return attempt
    }

    mutating func finish(_ attempt: Int, _ result: DeviceAuth.Result, setting: Bool) {
        guard attempt == self.attempt, state == .unlocking else { return }
        failed = result == .failed
        switch result {
        case .ok:
            state = .unlocked
            apply(setting)
        case .failed, .cancelled:
            state = .locked
        case .notInteractive: // asked before the app was frontmost: ask on the next activation
            state = .locked
            promptDue = true
        }
    }

    /// Onboarding's choice, after a successful check — which also unlocks a
    /// lock still on from an earlier stay in local mode, so it may turn it off.
    mutating func confirmed(on: Bool) {
        self.on = on
        state = .unlocked
        attempt += 1
    }

    /// Turning on is immediate; turning off only once unlocked.
    private mutating func apply(_ setting: Bool) {
        if setting, !on {
            on = true
        } else if !setting, on, state == .unlocked {
            on = false
        }
    }
}

enum DeviceAuth {
    enum Result { case ok, failed, cancelled, notInteractive }

    /// The phone can check its owner (a passcode is set).
    static var available: Bool {
        LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
    }

    /// "Face ID", "Touch ID" or "passcode", for the copy.
    static var method: String {
        let context = LAContext()
        _ = context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
        switch context.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        default: return "passcode"
        }
    }

    static func check(reason: String) async -> Result {
        #if DEBUG
        // Visual QA (Debug only): `-wgQALock failed|cancelled` holds the lock screen
        // on a Simulator with no passcode, where the check otherwise lets anyone in.
        switch UserDefaults.standard.string(forKey: "wgQALock") {
        case "failed": return .failed
        case "cancelled": return .cancelled
        default: break
        }
        #endif
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            // The passcode was removed after the lock went on: there is nothing
            // to check against, and the lock must not strand the user's only copy.
            return error?.code == LAError.passcodeNotSet.rawValue ? .ok : .failed
        }
        do {
            return try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) ? .ok : .failed
        } catch let e as LAError where e.code == .notInteractive {
            return .notInteractive
        } catch let e as LAError where [.userCancel, .systemCancel, .appCancel].contains(e.code) {
            return .cancelled // not an error: the plain locked state (N3)
        } catch {
            return .failed
        }
    }
}
