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

/// The local-mode health flow steps both import flows share.
@MainActor
private enum HealthFlow {
    static func launch(_ app: XCUIApplication, _ scene: String) {
        if app.state != .notRunning { app.terminate(); XCTAssertTrue(app.wait(for: .notRunning, timeout: 30)) }
        app.launchArguments = ["-wgLocalMode", "YES", "-wgAccountHost", "", "-wgLocalLockOn", "NO", "-wgLocalLock", "NO", "-wgQAScene", scene]
        app.launch()
        XCTAssertTrue(QA.readyNode(app).waitForExistence(timeout: 120), "\(scene) did not start")
        XCTAssertEqual(QA.report(app)?["ok"] as? Bool, true, "\(scene): \(QA.json(QA.report(app)))")
    }
    /// Settings → Import from Health on, after the seed's union sheet: no second sheet.
    static func turnOn(_ app: XCUIApplication, in test: XCTestCase) throws {
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
        if !finished { HealthSheet.screenshot("health-import-pending", in: test) }
        XCTAssertTrue(finished, "Health authorization did not finish; bridge: \(QA.json(QA.flow(app)?["memo"]))")
    }
    static func type(_ app: XCUIApplication, _ name: String, _ value: String) {
        let (ok, state) = QA.tapTarget(app, name, until: { _ in app.keyboards.firstMatch.exists })
        XCTAssertTrue(ok, "no keyboard for \(name): \(QA.json(state))")
        QA.dismissKeyboardTip(app); app.typeText(value)
        let (typed, result) = QA.waitFlow(app, timeout: 5) { (QA.target($0, name) != nil) && (($0["targets"] as? [String: [String: Any]])?[name]?["value"] as? String == value) }
        XCTAssertTrue(typed, "typing \(name): \(QA.json(result))")
    }
    static func rows(_ flow: [String: Any], _ key: String) -> [String] {
        (flow[key] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }
    }
    static func webText(_ app: XCUIApplication, _ text: String) -> XCUIElement {
        app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@ AND NOT (label BEGINSWITH '{')", text)).firstMatch
    }
    static func shot(_ name: String, in test: XCTestCase) {
        let image = XCTAttachment(screenshot: QA.stableScreenshot().0)
        image.name = name + ".png"; image.lifetime = .keepAlways; test.add(image)
    }
}

/// testscenarios/common/health-deleted-in-health.yaml (bd med-88x0.6): a
/// weight and a BP seeded in Health and imported, a typed weight, both seeded
/// samples deleted in Health; the relaunch's anchored query carries their
/// uuids. Rows are matched by their imported record id (<kind>-hk-<uuid>,
/// web/domain/healthsource.js), never by value: HealthKit outlives QA.reset,
/// so testHealthImport's same-valued seed may still be in Health; either
/// class may run first on the Simulator, every ask after the first sheet
/// resolves without one.
@MainActor
final class FlowQAHealthDeletedTests: XCTestCase {
    func testHealthDeletedInHealth() throws {
        continueAfterFailure = false
        QA.reset()
        let seed = try HealthDiagnosticTests.run(seed: true, labels: true, in: self)
        let uuids = try ["weightUUID", "bpUUID"].map { try XCTUnwrap(seed[$0] as? String, "seed wrote no \($0): \(QA.json(seed))") }
        let weight = "weight-hk-" + uuids[0].lowercased(), bp = "bp-hk-" + uuids[1].lowercased()

        let app = XCUIApplication()
        try HealthFlow.turnOn(app, in: self)
        HealthFlow.launch(app, "health-qa-weight")
        var (ok, f) = QA.waitFlow(app, timeout: 30) { Self.row($0, "weight", weight)?.contains("Health import") == true }
        XCTAssertTrue(ok, "imported weight \(weight) absent or unlabelled: \(QA.json(f))")
        HealthFlow.launch(app, "health-qa-bp")
        (ok, f) = QA.waitFlow(app, timeout: 30) { Self.row($0, "bp", bp)?.contains("Health import") == true }
        XCTAssertTrue(ok, "imported BP \(bp) absent or unlabelled: \(QA.json(f))")

        HealthFlow.launch(app, "core-local-weight")
        HealthFlow.type(app, "value", "77.7")
        (ok, f) = QA.tapTarget(app, "save", until: { Self.typed($0) })
        XCTAssertTrue(ok, "typed weight did not save: \(QA.json(f))")
        let before = try count(app)

        let gone = try HealthDiagnosticTests.run("-wgQAHealthDelete", args: ["-wgQAHealthDeleteUUIDs", uuids.joined(separator: ",")], in: self)
        XCTAssertEqual(gone["deleted"] as? Int, 2, QA.json(gone))

        // The relaunch: a new anchored query, its reply carries the deleted uuids.
        HealthFlow.launch(app, "health-qa-weight")
        (ok, f) = QA.waitFlow(app, timeout: 30) { Self.typed($0) && Self.row($0, "weight", weight) == nil }
        XCTAssertTrue(ok, "imported weight \(weight) not removed, or the typed one went with it: \(QA.json(f))")
        HealthFlow.shot("health-deleted-weight", in: self)
        HealthFlow.launch(app, "health-qa-bp")
        (ok, f) = QA.waitFlow(app, timeout: 30) { !HealthFlow.rows($0, "bp").isEmpty && Self.row($0, "bp", bp) == nil }
        XCTAssertTrue(ok, "imported BP \(bp) not removed: \(QA.json(f))")
        HealthFlow.shot("health-deleted-bp", in: self)
        XCTAssertEqual(try count(app), before, "the Health import count moved for deletions")
    }

    /// The text of the list row whose record id is `id`.
    private static func row(_ flow: [String: Any], _ key: String, _ id: String) -> String? {
        (flow[key] as? [[String: Any]] ?? []).first(where: { $0["id"] as? String == id })?["text"] as? String
    }
    private static func typed(_ flow: [String: Any]) -> Bool {
        HealthFlow.rows(flow, "weight").contains { $0.contains("77.7") && !$0.contains("Health import") }
    }
    /// Settings' "N readings so far" (healthStatusText).
    private func count(_ app: XCUIApplication) throws -> Int {
        HealthFlow.launch(app, "health-qa-settings")
        let line = HealthFlow.webText(app, "so far")
        XCTAssertTrue(line.waitForExistence(timeout: 30), "no Health import count in Settings")
        let n = line.label.components(separatedBy: " reading").first?.split(separator: " ").last.flatMap { Int($0) }
        return try XCTUnwrap(n, "unreadable Health import count: \(line.label)")
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
        try HealthFlow.turnOn(app, in: self)
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
        reveal(app, "Health import")
        shot("health-import-bp")
        launch(app, "health-qa-weight")
        let (weightOK, weightState) = QA.waitFlow(app, timeout: 30) { rows($0, "weight").contains { $0.contains("73.4") && $0.contains("Health import") } }
        XCTAssertTrue(weightOK, "imported weight source absent: \(QA.json(weightState))")
        reveal(app, "Health import")
        shot("health-import-weight")
    }

    private func launch(_ app: XCUIApplication, _ scene: String) { HealthFlow.launch(app, scene) }
    private func type(_ app: XCUIApplication, _ name: String, _ value: String) { HealthFlow.type(app, name, value) }
    private func rows(_ flow: [String: Any], _ key: String) -> [String] { HealthFlow.rows(flow, key) }
    private func webText(_ app: XCUIApplication, _ text: String) -> XCUIElement { HealthFlow.webText(app, text) }
    private func reveal(_ app: XCUIApplication, _ text: String) {
        let element = webText(app, text)
        for _ in 0..<6 {
            if element.isHittable && element.frame.maxY < app.frame.maxY - 100 { return }
            app.swipeUp()
        }
    }
    private func shot(_ name: String) { HealthFlow.shot(name, in: self) }
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
        var confirmed = false
        var swipes = 0
        var scrollCapReached = false
        var hierarchy = ""
        while Date() < deadline {
            hierarchy = app.debugDescription
            let reads = HealthSheet.readValues(hierarchy)
            if !reads.isEmpty { denied = reads }
            if !submitted, Set(reads.keys) == HealthSheet.expected, reads.values.allSatisfy({ $0 == "0" }) {
                // HealthUI virtualizes the button while it is below the fold;
                // only scroll after the exact read set proves the sheet is up.
                if hierarchy.contains("identifier: '\(HealthSheet.deny)'") {
                    submitted = HealthSheet.tap(HealthSheet.deny, host: app, screen: screen)
                } else if swipes < 3 {
                    app.swipeUp(); swipes += 1
                } else {
                    scrollCapReached = true
                    break
                }
            } else if submitted && !confirmed && hierarchy.contains("later in the Health app") {
                for host in [app, XCUIApplication(bundleIdentifier: "com.apple.springboard")] {
                    if HealthDiagnosticTests.tapIfSettled(host.alerts.buttons["OK"].firstMatch, within: screen) {
                        confirmed = true; break
                    }
                }
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
        let failure = scrollCapReached ? "deny button never realized after \(swipes) swipes" : "no denied-read guidance after the native denial"
        XCTAssertTrue(submitted && finished, failure)
        let shot = XCTAttachment(screenshot: QA.stableScreenshot().0)
        shot.name = "health-import-denied-guidance.png"; shot.lifetime = .keepAlways; add(shot)
    }
}
