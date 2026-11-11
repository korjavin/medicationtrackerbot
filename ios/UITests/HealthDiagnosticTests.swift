import XCTest

@MainActor
final class HealthDiagnosticTests: XCTestCase {
    func testNativeAuthorizationAndQuery() throws {
        try Self.run(seed: false, in: self)
    }

    static func run(seed: Bool, labels: Bool = false, in test: XCTestCase) throws -> [String: Any] {
        let json = try run(seed ? "-wgQAHealthSeed" : "-wgQAHealthDiagnostic", labels: labels, in: test)
        if seed { XCTAssertGreaterThan(json["sampleCount"] as? Int ?? 0, 0, "Health store has no seeded Steps sample") }
        return json
    }

    /// Launches HealthDiagnosticView in `mode`, accepts the Health sheet, and
    /// returns its JSON report after asserting `ok`.
    @discardableResult
    static func run(_ mode: String, labels: Bool = false, in test: XCTestCase) throws -> [String: Any] {
        let app = XCUIApplication()
        app.launchArguments = [mode, "YES"] + (labels ? ["-wgQAHealthLabels", "YES"] : [])
        app.launch()
        defer { app.terminate() }
        let result = app.staticTexts["health-diagnostic-result"]
        XCTAssertTrue(result.waitForExistence(timeout: 30))
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        // "pending: <step>" is a run still in progress (the write-back mode
        // names its step, so a stall shows where).
        let deadline = Date().addingTimeInterval(120)
        while result.label.hasPrefix("pending"), Date() < deadline {
            var acted = false
            let screen = app.frame
            pass: for host in [app, springboard] {
                acted = true
                // One action per pass, then let the sheet settle: toggles read
                // right after "Turn On All" (iOS 27: "Select All N Topics")
                // still say "0", and tapping them would switch rows back off
                // (bd med-8f4s.3: write rows).
                let all = host.descendants(matching: .any)
                    .matching(NSPredicate(format: "label == 'Turn On All' OR label BEGINSWITH 'Select All'")).firstMatch
                if tapIfSettled(all, within: screen) { break pass }
                let off = host.switches.allElementsBoundByIndex
                    .filter { live($0, within: screen)?.value as? String == "0" }
                if !off.isEmpty {
                    off.forEach { _ = tapIfSettled($0, within: screen) }
                    break
                }
                // iOS 26 confirms with "Allow"; the iOS 27 sheet with
                // "Continue", then a data-range page whose "Allow" stays
                // disabled until a window is picked (bd med-8f4s.18). Pick
                // all history: full access, so readableFrom is 0.
                if ["Allow", "Continue"].contains(where: { tapIfSettled(host.buttons[$0].firstMatch, within: screen) }) {
                    break
                }
                let history = host.descendants(matching: .any)
                    .matching(NSPredicate(format: "label BEGINSWITH %@", "All Recorded Data")).firstMatch
                if tapIfSettled(history, within: screen) { break }
                acted = false
            }
            // Nothing to tap: the iOS 27 write+read sheet keeps its toggles
            // and "Continue" below the fold, so scroll it (it covers the app).
            if !acted { app.swipeUp() }
            Thread.sleep(forTimeInterval: 0.5)
        }
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "health-native-baseline.png"
        shot.lifetime = .keepAlways
        test.add(shot)
        let report = XCTAttachment(string: result.label)
        report.name = "health-native-baseline.json"
        report.lifetime = .keepAlways
        test.add(report)
        guard !result.label.hasPrefix("pending") else {
            XCTFail("Native HealthKit run did not complete (\(result.label)); see permission screenshot")
            return [:]
        }
        let data = try XCTUnwrap(result.label.data(using: .utf8))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["ok"] as? Bool, true, result.label)
        return json
    }

    // The sheet's controls vanish when it advances or dismisses, so an
    // exists-then-isEnabled/isHittable sequence can race it and XCTest records
    // "Failed to get matching snapshot" (bd med-8f4s.18, run 42152753328:
    // "Allow"). Read state from one throwing snapshot() instead; a vanished
    // control is just skipped this pass, and whether the sheet was answered is
    // still decided by the app's report above.
    static func live(_ element: XCUIElement, within screen: CGRect) -> XCUIElementSnapshot? {
        guard let snap = try? element.snapshot(), snap.isEnabled, !snap.frame.isEmpty,
              screen.contains(CGPoint(x: snap.frame.midX, y: snap.frame.midY)) else { return nil }
        return snap
    }

    // Tap through the element, not a coordinate built from the snapshot frame:
    // that tap landed off the control in the hosted Health sheet (qa run
    // 42162700133: 120s on an untouched first page, "Select All" never
    // applied), while element.tap() resolves XCTest's own hit point (qa run
    // 42152745433 passed). Tap only once two snapshots 0.3s apart agree, so a
    // control mid-transition is skipped instead of vanishing under the tap.
    static func tapIfSettled(_ element: XCUIElement, within screen: CGRect) -> Bool {
        guard let first = live(element, within: screen) else { return false }
        Thread.sleep(forTimeInterval: 0.3)
        guard let settled = live(element, within: screen), settled.frame == first.frame else { return false }
        element.tap()
        return true
    }
}

/// The Health write-back through Health.handle (bd med-8f4s.3; hr .8; workout
/// .10): write, replace, own-id import filter, an imported row's id deletes
/// nothing, delete leaves nothing; (.18) readableFrom 0 with full access and
/// readableFromMs ([:] → 0, two types → the later date in ms), the OS gate
/// readableFrom(osMajor:) (26 → 0, 27 threw → omitted), equal/lower-version
/// replays resolve true (a store error verified by held(), whose true/false
/// cases are checked), the entries batch. Runs in the qa job (HealthDiagnosticView's
/// write-back mode).
@MainActor
final class HealthWriteBackTests: XCTestCase {
    func testWriteReplaceFilterDelete() throws {
        try HealthDiagnosticTests.run("-wgQAHealthWriteBack", in: self)
    }
}
