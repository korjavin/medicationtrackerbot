import XCTest

/// First Health ask in the dedicated simulator part: the real Settings switch
/// requests read access before the diagnostic seed asks for write access.
@MainActor
final class FlowQAHealthImportTests: XCTestCase {
    func testHealthImport() throws {
        continueAfterFailure = false
        QA.reset()
        let app = XCUIApplication()
        launch(app, "health-qa-settings")
        let target = try XCTUnwrap(QA.target(QA.flow(app), "health"), "Health import switch absent")
        QA.coordinate(app, target).tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let hosts = [app, springboard]
        let allButton = { (host: XCUIApplication) in
            host.descendants(matching: .any).matching(NSPredicate(format: "label == 'Turn On All' OR label BEGINSWITH 'Select All'")).firstMatch
        }
        let deadline = Date().addingTimeInterval(60)
        var seen = Set<String>()
        let kinds = ["Steps", "Sleep", "Blood Oxygen", "Heart Rate"]
        while Date() < deadline && seen.count < kinds.count {
            for host in hosts {
                for kind in kinds where host.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] %@", kind)).firstMatch.exists {
                    seen.insert(kind)
                }
            }
            if seen.count < kinds.count { app.swipeUp(); Thread.sleep(forTimeInterval: 0.5) }
        }
        let sheet = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        sheet.name = "health-import-requested-kinds.png"; sheet.lifetime = .keepAlways; add(sheet)
        XCTAssertEqual(seen, Set(kinds), "Health sheet did not list the requested read kinds: \(seen)")
        let screen = app.frame
        let end = Date().addingTimeInterval(120)
        while Date() < end {
            var acted = false
            pass: for host in hosts {
                if HealthDiagnosticTests.tapIfSettled(allButton(host), within: screen) { acted = true; break pass }
                if ["Allow", "Continue"].contains(where: { HealthDiagnosticTests.tapIfSettled(host.buttons[$0].firstMatch, within: screen) }) { acted = true; break pass }
                let history = host.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'All Recorded Data'")).firstMatch
                if HealthDiagnosticTests.tapIfSettled(history, within: screen) { acted = true; break pass }
            }
            if QA.readyNode(app).exists && !hosts.contains(where: { allButton($0).exists }) { break }
            if !acted { app.swipeUp() }
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTAssertTrue(QA.readyNode(app).waitForExistence(timeout: 30), "Health sheet did not finish")
        app.terminate()

        // This second, diagnostic-only ask grants write access for seeded data.
        let seed = try HealthDiagnosticTests.run(seed: true, labels: true, in: self)
        XCTAssertEqual(seed["weightSeeded"] as? Bool, true, "simulator did not grant weight seeding: \(QA.json(seed))")
        launch(app, "health-qa-import")
        XCTAssertTrue(webText(app, "Sources · Health import").waitForExistence(timeout: 30), "sleep source label absent")
        shot("health-import-sleep")

        launch(app, "health-qa-bp-add")
        type(app, "sys", "141")
        type(app, "dia", "91")
        let (saved, after) = QA.tapTarget(app, "save", until: { rows($0, "bp").contains { $0.contains("141/91") } })
        XCTAssertTrue(saved, "typed BP did not save: \(QA.json(after))")
        let bp = rows(after ?? [:], "bp")
        XCTAssertTrue(bp.contains { $0.contains("141/91") && !$0.contains("Health import") }, "typed BP has Health label: \(bp)")
        if seed["bpSeeded"] as? Bool == true {
            XCTAssertTrue(bp.contains { $0.contains("123/79") && $0.contains("Health import") }, "imported BP source absent: \(bp)")
        }
        shot("health-import-bp")
        launch(app, "health-qa-weight")
        let (weightOK, weightState) = QA.waitFlow(app, timeout: 30) { rows($0, "weight").contains { $0.contains("73.4") && $0.contains("Health import") } }
        XCTAssertTrue(weightOK, "imported weight source absent: \(QA.json(weightState))")
        shot("health-import-weight")
    }

    private func launch(_ app: XCUIApplication, _ scene: String) {
        if app.state != .notRunning { app.terminate(); XCTAssertTrue(app.wait(for: .notRunning, timeout: 30)) }
        app.launchArguments = ["-wgLocalMode", "YES", "-wgAccountHost", "", "-wgLocalLockOn", "NO", "-wgLocalLock", "NO", "-wgQAScene", scene]
        app.launch()
        XCTAssertTrue(QA.readyNode(app).waitForExistence(timeout: 120), "\(scene) did not start")
        XCTAssertEqual(QA.report(app)?["ok"] as? Bool, true, "\(scene): \(QA.json(QA.report(app)))")
    }
    private func type(_ app: XCUIApplication, _ name: String, _ value: String) {
        let (ok, state) = QA.tapTarget(app, name, until: { _ in app.keyboards.firstMatch.exists })
        XCTAssertTrue(ok, "no keyboard for \(name): \(QA.json(state))")
        QA.dismissKeyboardTip(app); app.typeText(value)
        let (typed, result) = QA.waitFlow(app, timeout: 5) { (QA.target($0, name) != nil) && (($0["targets"] as? [String: [String: Any]])?[name]?["value"] as? String == value) }
        XCTAssertTrue(typed, "typing \(name): \(QA.json(result))")
    }
    private func rows(_ flow: [String: Any], _ key: String) -> [String] {
        (flow[key] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }
    }
    private func webText(_ app: XCUIApplication, _ text: String) -> XCUIElement {
        app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@ AND NOT (label BEGINSWITH '{')", text)).firstMatch
    }
    private func shot(_ name: String) {
        let image = XCTAttachment(screenshot: QA.stableScreenshot().0)
        image.name = name + ".png"; image.lifetime = .keepAlways; add(image)
    }
}
