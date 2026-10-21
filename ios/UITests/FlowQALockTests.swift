import XCTest
import LocalAuthentication

/// Flow QA for local mode's lock (bd med-w6gx.23.2, docs/ios.md "Flow QA
/// (Simulator)"): the real LocalLock state machine and DeviceAuth with
/// simulated Face ID — no app hook. The Simulator has no passcode, so without
/// enrolled biometry DeviceAuth lets anyone in; the flow enrolls Face ID first.
///
/// One method, four flows as activities: they share the app's state (the lock
/// the first one turns on, the last one turns off), and the last leaves the
/// lock off for any flow that runs after it.
@MainActor
final class FlowQALockTests: XCTestCase {
    nonisolated override func setUp() {
        super.setUp()
        // bd med-w6gx.23.8: a clean slate, so one failed flow stays one red test.
        MainActor.assumeIsolated { QA.reset() } // XCTest runs setUp on the main thread
    }

    func testLocalLock() {
        continueAfterFailure = false
        Biometry.enroll()
        let app = XCUIApplication()
        let locked = app.staticTexts["Med Tracker is locked"]
        let unlock = app.buttons["Unlock"]

        XCTContext.runActivity(named: "opt-in") { _ in
            let flow = "lock-opt-in"
            // No account: local mode (bd med-ta2n.17, no native intro with its
            // lock toggle); the lock goes on from Settings → App lock.
            app.launchArguments = ["-wgAccountHost", "", "-wgQAScene", "settings-home"]
            app.launch()
            require(flow, QA.readyNode(app).waitForExistence(timeout: 90), "settings-home never published #wg-qa-ready")
            let row = app.webViews.switches["App lock"]
            require(flow, row.waitForExistence(timeout: 15), "Settings shows no \"App lock\" row: Face ID enrollment did not reach the app")
            // The Simulator's enrollment can land late (bd med-o7zq.45, runs
            // 39544114011, 39547677012: the system check came up as "Enter
            // iPhone Passcode", or failed, on a sha that had passed): wait
            // until the runner itself sees Face ID before the first prompt.
            let biometry = Biometry.waitEnrolled(timeout: 30)
            // A check the Simulator fails or falls back to the passcode for
            // is the user's retry: cancel it, the row turns back off, tap again.
            var attempt = 0
            while "\(row.value ?? "")" != "1" || !row.isEnabled, attempt < 3 {
                attempt += 1
                if row.isEnabled { row.tap() }
                Thread.sleep(forTimeInterval: 1.5)
                shot(flow, "face-id-sheet-\(attempt)")
                if matchUntil(app, timeout: 20, { row.isEnabled && "\(row.value ?? "")" == "1" }) { break }
                cancelPrompt(app)
                _ = matchUntil(app, timeout: 8) { row.isEnabled }
            }
            require(flow, row.isEnabled && "\(row.value ?? "")" == "1",
                    "the App lock row did not turn on after \(attempt) check(s) (runner biometry: \(biometry))")
            shot(flow, "row-on")
            // (Not asserted from the prefs plist: cfprefsd may not have
            // flushed it yet; the lock screen and the local app below prove it.)
            app.terminate()
            app.launchArguments = ["-wgQAScene", "today"]
            app.launch()
            require(flow, locked.waitForExistence(timeout: 30), "relaunch with the lock on showed no lock screen")
            XCTAssertEqual(app.webViews.count, 0, "the web view is in the hierarchy behind the lock")
            shot(flow, "lock-screen")
            require(flow, matchUntil(app, timeout: 30) { !locked.exists }, "the launch prompt's match did not unlock")
            require(flow, QA.readyNode(app).waitForExistence(timeout: 90), "the local app never published #wg-qa-ready")
            require(flow, QA.tabBarShows(app, timeout: 10), "after unlock the app shows no tab bar")
            shot(flow, "unlocked")
        }

        XCTContext.runActivity(named: "cancel holds") { _ in
            let flow = "lock-cancel"
            app.terminate()
            app.launch()
            require(flow, locked.waitForExistence(timeout: 30), "relaunch showed no lock screen")
            Thread.sleep(forTimeInterval: 2) // the launch prompt is up
            shot(flow, "face-id-sheet")
            failPrompt(app, until: { unlock.exists && unlock.isEnabled })
            Thread.sleep(forTimeInterval: 3) // no re-prompt loop
            require(flow, locked.exists, "a failed check let the app open")
            require(flow, unlock.isEnabled, "Unlock is not enabled after a failed check (a prompt still up?)")
            XCTAssertEqual(app.webViews.count, 0, "the web view is in the hierarchy behind the lock")
            shot(flow, "held")
            unlock.tap()
            require(flow, matchUntil(app, timeout: 30) { !locked.exists }, "Unlock's match did not unlock")
            require(flow, QA.tabBarShows(app, timeout: 60), "after unlock the app shows no tab bar")
            shot(flow, "unlocked")
        }

        XCTContext.runActivity(named: "background") { _ in
            let flow = "lock-background"
            XCUIDevice.shared.press(.home)
            Thread.sleep(forTimeInterval: 2)
            app.activate()
            require(flow, locked.waitForExistence(timeout: 15), "back from the background showed no lock screen")
            XCTAssertEqual(app.webViews.count, 0, "the web view is in the hierarchy behind the lock")
            shot(flow, "lock-screen")
            require(flow, matchUntil(app, timeout: 30) { !locked.exists }, "the return prompt's match did not unlock")
            require(flow, QA.tabBarShows(app, timeout: 30), "after unlock the app shows no tab bar")
            shot(flow, "unlocked")
        }

        XCTContext.runActivity(named: "lock off") { _ in
            let flow = "lock-off"
            app.terminate()
            app.launchArguments = ["-wgQAScene", "settings-home"]
            app.launch()
            require(flow, locked.waitForExistence(timeout: 30), "relaunch showed no lock screen")
            require(flow, matchUntil(app, timeout: 30) { !locked.exists }, "the launch prompt's match did not unlock")
            require(flow, QA.readyNode(app).waitForExistence(timeout: 90), "settings-home never published #wg-qa-ready")
            let row = app.webViews.switches["App lock"]
            require(flow, row.waitForExistence(timeout: 15), "Settings shows no \"App lock\" row")
            XCTAssertEqual("\(row.value ?? "")", "1", "the App lock row is not on")
            shot(flow, "row-on")
            row.tap()
            Thread.sleep(forTimeInterval: 1) // the row disables itself while lock.set runs
            require(flow, matchUntil(app, timeout: 30) { row.isEnabled && "\(row.value ?? "")" == "0" },
                          "the App lock row did not turn off")
            shot(flow, "row-off")

            app.terminate()
            app.launchArguments = []
            app.launch()
            require(flow, QA.tabBarShows(app, timeout: 60), "with the lock off the app did not open straight to the tab bar")
            XCTAssertFalse(locked.exists, "the lock screen showed with the lock off")
            shot(flow, "relaunch")
            app.terminate()
        }
    }

    /// Posts a Face ID match every 2 s until `done` (a match with no sheet up
    /// is dropped), accepting the one-time "use Face ID?" permission alert.
    private func matchUntil(_ app: XCUIApplication, timeout: TimeInterval, _ done: () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if done() { return true }
            allowFaceID(app)
            Biometry.post("com.apple.BiometricKit_Sim.pearl.match")
            Thread.sleep(forTimeInterval: 2)
        }
        return done()
    }

    /// A non-match, then the sheet's Cancel (the policy allows a retry or
    /// passcode, so a non-match alone may leave the sheet up).
    private func failPrompt(_ app: XCUIApplication, until done: () -> Bool) {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let end = Date().addingTimeInterval(20)
        while Date() < end, !done() {
            Biometry.post("com.apple.BiometricKit_Sim.pearl.nomatch")
            Thread.sleep(forTimeInterval: 1.5)
            shot("lock-cancel", "face-id-nomatch")
            // "Face Not Recognized" → Try Face ID Again / Cancel (the sheet
            // exposes Cancel more than once).
            for owner in [app, springboard] where owner.buttons["Cancel"].firstMatch.exists {
                owner.buttons["Cancel"].firstMatch.tap()
                break
            }
            Thread.sleep(forTimeInterval: 1.5)
        }
    }

    /// Cancels whatever system check is up (Face ID retry alert or the
    /// passcode sheet); lock.set then answers false and the row re-enables.
    private func cancelPrompt(_ app: XCUIApplication) {
        for id in [nil, "com.apple.springboard", "com.apple.CoreAuthUI"] {
            let owner = id.map { XCUIApplication(bundleIdentifier: $0) } ?? app
            let cancel = owner.buttons["Cancel"].firstMatch
            if cancel.exists { cancel.tap(); return }
        }
    }

    private func allowFaceID(_ app: XCUIApplication) {
        for owner in [app, XCUIApplication(bundleIdentifier: "com.apple.springboard")] {
            let ok = owner.alerts.buttons["OK"]
            if ok.exists { ok.tap() }
        }
    }

    /// XCTAssertTrue that first attaches what the screen showed and puts the
    /// element tree, on one line, in the failure message (the job's log keeps
    /// only " error: " lines and the artifact only PNGs).
    private func require(_ flow: String, _ ok: Bool, _ message: String) {
        guard !ok else { return }
        shot(flow, "failed")
        let tree = XCUIApplication().debugDescription.split(separator: "\n").joined(separator: " | ")
        XCTFail("\(message) — tree: \(tree.prefix(6000))")
    }

    private func shot(_ flow: String, _ step: String) {
        let attachment = XCTAttachment(screenshot: QA.stableScreenshot().0)
        attachment.name = "\(flow)-\(step).png"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

/// The Simulator's biometry, driven the way `xcrun simctl spawn <udid>
/// notifyutil` does: Darwin notifications, posted from the runner (it runs
/// inside the same Simulator). libnotify through dlsym: it is in libSystem,
/// but Swift has no module for notify.h.
private enum Biometry {
    private typealias Post = @convention(c) (UnsafePointer<CChar>) -> UInt32
    private typealias Register = @convention(c) (UnsafePointer<CChar>, UnsafeMutablePointer<Int32>) -> UInt32
    private typealias SetState = @convention(c) (Int32, UInt64) -> UInt32

    private static func sym<T>(_ name: String, _: T.Type) -> T {
        unsafeBitCast(dlsym(UnsafeMutableRawPointer(bitPattern: -2), name)!, to: T.self) // RTLD_DEFAULT
    }

    static func post(_ name: String) {
        _ = sym("notify_post", Post.self)(name)
    }

    /// `notifyutil -s com.apple.BiometricKit.enrollmentChanged 1 -p com.apple.BiometricKit.enrollmentChanged`.
    static func enroll() {
        let name = "com.apple.BiometricKit.enrollmentChanged"
        var token: Int32 = 0
        _ = sym("notify_register_check", Register.self)(name, &token)
        _ = sym("notify_set_state", SetState.self)(token, 1)
        post(name)
        Thread.sleep(forTimeInterval: 1)
    }

    /// Re-enrolls until the runner (same Simulator) can evaluate Face ID;
    /// returns what it last saw, for the failure message.
    static func waitEnrolled(timeout: TimeInterval) -> String {
        let end = Date().addingTimeInterval(timeout)
        var state = ""
        repeat {
            let context = LAContext()
            var error: NSError?
            let ok = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
            state = "type=\(context.biometryType.rawValue) ok=\(ok) error=\(error?.code ?? 0)"
            if ok, context.biometryType == .faceID { return state }
            enroll()
        } while Date() < end
        return state
    }
}
