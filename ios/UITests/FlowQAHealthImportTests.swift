import XCTest

/// Health's hosted sheet has a large accessibility tree. Read its full
/// hierarchy once per pass; only the chosen action needs settled snapshots.
@MainActor
private enum HealthSheet {
    static let readPrefix = "UIA.Health.Read."
    static let deny = "UIA.Health.DoNotAllow.Button"
    static let expected = Set(["ActiveEnergy", "CyclingDistance", "Steps", "SwimmingDistance", "Walking+RunningDistance", "Workouts", "Weight", "BloodPressure", "HeartRate", "BloodOxygen", "Sleep"])

    static func nodes(_ root: XCUIElementSnapshot) -> [XCUIElementSnapshot] {
        var result = [XCUIElementSnapshot](), pending = [root]
        while let node = pending.popLast() { result.append(node); pending.append(contentsOf: node.children) }
        return result
    }
    // snapshot().children omits the hosted HealthUI subtree on iOS 27, while
    // debugDescription includes it (run 42975744180). Read each switch's
    // identifier and value from that one full hierarchy per pass.
    static func readValues(_ description: String) -> [String: String] {
        var result = [String: String]()
        for line in description.split(separator: "\n") {
            guard let start = line.range(of: "identifier: '\(readPrefix)"),
                  let end = line[start.upperBound...].firstIndex(of: "'"),
                  let value = line.range(of: ", value: ") else { continue }
            let id = String(line[start.upperBound..<end])
            guard id.hasSuffix(".SwitchCell.Switch") else { continue }
            let kind = String(id.dropLast(".SwitchCell.Switch".count))
            let tail = line[value.upperBound...]
            if let bit = tail.first, bit == "0" || bit == "1" { result[kind] = String(bit) }
        }
        return result
    }
    static func tap(_ id: String, host: XCUIApplication, screen: CGRect) -> Bool {
        let element = host.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@", id)).firstMatch
        return HealthDiagnosticTests.tapIfSettled(element, within: screen)
    }
    static func attach(_ values: [String: String], name: String, in test: XCTestCase) throws {
        let data = try JSONSerialization.data(withJSONObject: values, options: [.prettyPrinted, .sortedKeys])
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = name + ".json"; attachment.lifetime = .keepAlways; test.add(attachment)
    }
    static func screenshot(_ name: String, in test: XCTestCase) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name + ".png"; shot.lifetime = .keepAlways; test.add(shot)
    }
}

/// A single union authorization grants the diagnostic seed and every kind
/// requested by Settings. The separate denial part observes Settings' first ask.
@MainActor
final class FlowQAHealthImportTests: XCTestCase {
    func testHealthImport() throws {
        continueAfterFailure = false
        QA.reset()
        let seed = try HealthDiagnosticTests.run(seed: true, labels: true, in: self)
        XCTAssertEqual(seed["weightSeeded"] as? Bool, true, "simulator did not grant weight seeding: \(QA.json(seed))")
        XCTAssertEqual(seed["bpSeeded"] as? Bool, true, "simulator did not grant BP seeding: \(QA.json(seed))")

        let app = XCUIApplication()
        launch(app, "health-qa-settings")
        let target = try XCTUnwrap(QA.target(QA.flow(app), "health"), "Health import switch absent")
        QA.coordinate(app, target).tap()
        let deadline = Date().addingTimeInterval(120)
        var finished = false
        while Date() < deadline {
            for host in [app, XCUIApplication(bundleIdentifier: "com.apple.springboard")] {
                let sheet = host.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "UIA.Health.")).firstMatch
                XCTAssertFalse(sheet.exists, "seed read set drifted: a second Health sheet appeared")
            }
            if let tree = try? app.snapshot(), HealthSheet.nodes(tree).contains(where: { $0.label.hasPrefix("Import from") && $0.isEnabled && ($0.value as? String) == "1" }) {
                finished = true; break
            }
            Thread.sleep(forTimeInterval: 0.5)
        }
        if !finished { HealthSheet.screenshot("health-import-pending", in: self) }
        XCTAssertTrue(finished, "Health authorization did not finish; bridge: \(QA.json(QA.flow(app)?["memo"]))")
        launch(app, "health-qa-import")
        XCTAssertTrue(webText(app, "Sources · Health import").waitForExistence(timeout: 30), "sleep source label absent")
        reveal(app, "Sources · Health import")
        shot("health-import-sleep")

        launch(app, "health-qa-bp-add")
        type(app, "sys", "141")
        type(app, "dia", "91")
        let (saved, after) = QA.tapTarget(app, "save", until: { rows($0, "bp").contains { $0.contains("141/91") } })
        XCTAssertTrue(saved, "typed BP did not save: \(QA.json(after))")
        let bp = rows(after ?? [:], "bp")
        XCTAssertTrue(bp.contains { $0.contains("141/91") && !$0.contains("Health import") }, "typed BP has Health label: \(bp)")
        XCTAssertTrue(bp.contains { $0.contains("123/79") && $0.contains("Health import") }, "imported BP source absent: \(bp)")
        let notNow = app.buttons["Not now"].firstMatch
        if notNow.waitForExistence(timeout: 3) { notNow.tap() }
        reveal(app, "123/79")
        shot("health-import-bp")
        launch(app, "health-qa-weight")
        let (weightOK, weightState) = QA.waitFlow(app, timeout: 30) { rows($0, "weight").contains { $0.contains("73.4") && $0.contains("Health import") } }
        XCTAssertTrue(weightOK, "imported weight source absent: \(QA.json(weightState))")
        reveal(app, "Health import")
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
    private func reveal(_ app: XCUIApplication, _ text: String) {
        let element = webText(app, text)
        for _ in 0..<6 {
            if element.isHittable { return }
            app.swipeUp()
        }
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
        Thread.sleep(forTimeInterval: 3)
        HealthSheet.screenshot("health-denied-after-tap", in: self)
        let screen = app.frame
        let deadline = Date().addingTimeInterval(120)
        var denied = [String: String]()
        var submitted = false, finished = false
        var hierarchy = ""
        while Date() < deadline {
            hierarchy = app.debugDescription
            let reads = HealthSheet.readValues(hierarchy)
            if !reads.isEmpty { denied = reads }
            if !submitted, hierarchy.contains("identifier: '\(HealthSheet.deny)'"),
               Set(reads.keys) == HealthSheet.expected, reads.values.allSatisfy({ $0 == "0" }) {
                submitted = HealthSheet.tap(HealthSheet.deny, host: app, screen: screen)
                if !submitted { app.swipeUp() }
            // Copy: web/cloud/js/health-import.js:981 and web/static/js/native/health.js:140.
            } else if submitted && hierarchy.contains("nothing yet") && hierarchy.contains("Settings → Health → Data Access & Devices") {
                finished = true; break
            }
            Thread.sleep(forTimeInterval: 0.5)
        }
        try HealthSheet.attach(denied, name: "health-import-denied-kinds", in: self)
        if Set(denied.keys) != HealthSheet.expected || !denied.values.allSatisfy({ $0 == "0" }) || !(submitted && finished) {
            try HealthSheet.attach(["app-debugDescription": hierarchy], name: "health-denied-hierarchy", in: self)
            HealthSheet.screenshot("health-denied-missing-sheet", in: self)
        }
        XCTAssertEqual(Set(denied.keys), HealthSheet.expected, "wrong Health read switches: \(denied); bridge: \(QA.json(QA.flow(app)?["memo"]))")
        XCTAssertTrue(denied.values.allSatisfy { $0 == "0" }, "a Health read switch was enabled: \(denied)")
        XCTAssertTrue(submitted && finished, "no denied-read guidance after the native denial")
        let shot = XCTAttachment(screenshot: QA.stableScreenshot().0)
        shot.name = "health-import-denied-guidance.png"; shot.lifetime = .keepAlways; add(shot)
    }
}
