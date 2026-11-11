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
                for kind in kinds where host.switches.matching(NSPredicate(format: "label CONTAINS[c] %@", kind)).firstMatch.exists {
                    seen.insert(kind)
                }
            }
            if seen.count < kinds.count { app.swipeUp(); Thread.sleep(forTimeInterval: 0.5) }
        }
        let sheet = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        sheet.name = "health-import-requested-kinds.png"; sheet.lifetime = .keepAlways; add(sheet)
        let requested = XCTAttachment(string: seen.sorted().joined(separator: ", "))
        requested.name = "health-import-requested-kinds.txt"; requested.lifetime = .keepAlways; add(requested)
        XCTAssertEqual(seen, Set(kinds), "Health sheet did not list the requested read kinds: \(seen)")
        let screen = app.frame
        let end = Date().addingTimeInterval(120)
        while Date() < end {
            var acted = false
            pass: for host in hosts {
                if HealthDiagnosticTests.tapIfSettled(allButton(host), within: screen) { acted = true; break pass }
                let off = host.switches.allElementsBoundByIndex.filter { HealthDiagnosticTests.live($0, within: screen)?.value as? String == "0" }
                if !off.isEmpty {
                    for item in off { _ = HealthDiagnosticTests.tapIfSettled(item, within: screen) }
                    acted = true; break pass
                }
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

/// Separate QA part = a fresh Simulator and first Health ask with every read
/// switch left off. HealthKit intentionally does not report read denial.
@MainActor
final class FlowQAHealthDeniedTests: XCTestCase {
    func testDeniedHealthGuidance() throws {
        continueAfterFailure = false
        QA.reset()
        let app = XCUIApplication()
        app.launchArguments = ["-wgLocalMode", "YES", "-wgAccountHost", "", "-wgLocalLockOn", "NO", "-wgLocalLock", "NO", "-wgQAScene", "health-qa-settings"]
        app.launch()
        XCTAssertTrue(QA.readyNode(app).waitForExistence(timeout: 120), "Settings scene did not start")
        let target = try XCTUnwrap(QA.target(QA.flow(app), "health"), "Health import switch absent")
        QA.coordinate(app, target).tap()
        let hosts = [app, XCUIApplication(bundleIdentifier: "com.apple.springboard")]
        let screen = app.frame
        let deadline = Date().addingTimeInterval(120)
        var sawSheet = false
        let kinds = ["Steps", "Sleep", "Blood Oxygen", "Heart Rate", "Blood Pressure", "Weight", "Workouts"]
        var denied = Set<String>()
        while Date() < deadline {
            var acted = false
            pass: for host in hosts {
                let select = host.descendants(matching: .any).matching(NSPredicate(format: "label == 'Turn On All' OR label BEGINSWITH 'Select All'")).firstMatch
                if select.exists { sawSheet = true }
                for kind in kinds {
                    let item = host.switches.matching(NSPredicate(format: "label CONTAINS[c] %@", kind)).firstMatch
                    if let snap = HealthDiagnosticTests.live(item, within: screen), snap.value as? String == "0" { denied.insert(kind) }
                }
                let on = host.switches.allElementsBoundByIndex.filter { HealthDiagnosticTests.live($0, within: screen)?.value as? String == "1" }
                if !on.isEmpty {
                    for item in on { _ = HealthDiagnosticTests.tapIfSettled(item, within: screen) }
                    acted = true; break pass
                }
                if denied.count < kinds.count { continue }
                if ["Don't Allow", "Continue", "Allow", "Done"].contains(where: { HealthDiagnosticTests.tapIfSettled(host.buttons[$0].firstMatch, within: screen) }) {
                    acted = true; break pass
                }
            }
            let desc = app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Checked' AND label CONTAINS 'nothing yet' AND label CONTAINS 'Settings → Health → Data Access & Devices' AND NOT (label BEGINSWITH '{')")).firstMatch
            if desc.exists { break }
            if !acted { app.swipeUp() }
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTAssertTrue(sawSheet, "did not observe the first Health permission sheet")
        XCTAssertEqual(denied, Set(kinds), "did not verify all requested read switches were off: \(denied)")
        let switches = XCTAttachment(string: denied.sorted().joined(separator: ", "))
        switches.name = "health-import-denied-kinds.txt"; switches.lifetime = .keepAlways; add(switches)
        let guidance = app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Checked' AND label CONTAINS 'nothing yet' AND label CONTAINS 'Settings → Health → Data Access & Devices' AND NOT (label BEGINSWITH '{')")).firstMatch
        XCTAssertTrue(guidance.waitForExistence(timeout: 30), "no denied-read guidance")
        let shot = XCTAttachment(screenshot: QA.stableScreenshot().0)
        shot.name = "health-import-denied-guidance.png"; shot.lifetime = .keepAlways; add(shot)
    }
}
