import XCTest

@MainActor
final class HealthDiagnosticTests: XCTestCase {
    func testNativeAuthorizationAndQuery() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-wgQAHealthDiagnostic", "YES"]
        app.launch()
        let result = app.staticTexts["health-diagnostic-result"]
        XCTAssertTrue(result.waitForExistence(timeout: 30))
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let deadline = Date().addingTimeInterval(45)
        while result.label == "pending", Date() < deadline {
            for host in [app, springboard] {
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
        add(shot)
        let report = XCTAttachment(string: result.label)
        report.name = "health-native-baseline.json"
        report.lifetime = .keepAlways
        add(report)
        guard result.label != "pending" else {
            XCTFail("Native HealthKit authorization did not complete; see permission screenshot")
            return
        }
        let data = try XCTUnwrap(result.label.data(using: .utf8))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["ok"] as? Bool, true, result.label)
    }
}
