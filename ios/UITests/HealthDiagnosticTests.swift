import XCTest

@MainActor
final class HealthDiagnosticTests: XCTestCase {
    func testNativeAuthorizationAndQuery() throws {
        try Self.run(seed: false, in: self)
    }

    static func run(seed: Bool, in test: XCTestCase) throws {
        let json = try run(seed ? "-wgQAHealthSeed" : "-wgQAHealthDiagnostic", in: test)
        if seed { XCTAssertGreaterThan(json["sampleCount"] as? Int ?? 0, 0, "Health store has no seeded Steps sample") }
    }

    /// Launches HealthDiagnosticView in `mode`, accepts the Health sheet, and
    /// returns its JSON report after asserting `ok`.
    @discardableResult
    static func run(_ mode: String, in test: XCTestCase) throws -> [String: Any] {
        let app = XCUIApplication()
        app.launchArguments = [mode, "YES"]
        app.launch()
        defer { app.terminate() }
        let result = app.staticTexts["health-diagnostic-result"]
        XCTAssertTrue(result.waitForExistence(timeout: 30))
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let deadline = Date().addingTimeInterval(45)
        while result.label == "pending", Date() < deadline {
            for host in [app, springboard] {
                let all = host.staticTexts["Turn On All"].firstMatch
                if all.exists && all.isHittable { all.tap() }
                for toggle in host.switches.allElementsBoundByIndex {
                    if toggle.isHittable && toggle.value as? String == "0" { toggle.tap() }
                }
                for title in ["Allow"] {
                    let button = host.buttons[title].firstMatch
                    if button.exists && button.isEnabled && button.isHittable { button.tap() }
                }
            }
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
        guard result.label != "pending" else {
            XCTFail("Native HealthKit authorization did not complete; see permission screenshot")
            return [:]
        }
        let data = try XCTUnwrap(result.label.data(using: .utf8))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["ok"] as? Bool, true, result.label)
        return json
    }
}

/// The Health write-back through Health.handle (bd med-8f4s.3): write, replace,
/// own-id import filter, an imported row's id deletes nothing, delete leaves
/// nothing. Runs in the qa job (HealthDiagnosticView's write-back mode).
@MainActor
final class HealthWriteBackTests: XCTestCase {
    func testWriteReplaceFilterDelete() throws {
        try HealthDiagnosticTests.run("-wgQAHealthWriteBack", in: self)
    }
}
