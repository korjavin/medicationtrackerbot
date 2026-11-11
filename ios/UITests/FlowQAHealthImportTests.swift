import XCTest

/// Health's hosted sheet has a large accessibility tree. Take one tree per
/// pass, then use its identifiers and off-screen values; only the chosen
/// action gets the two settled snapshots required by XCTest's native tap.
@MainActor
private enum HealthSheet {
    static let readPrefix = "UIA.Health.Read."
    static let all = "UIA.Health.AuthSheet.AllCategoryButton"
    static let allow = "UIA.Health.Allow.Button"
    static let deny = "UIA.Health.DoNotAllow.Button"
    static let expected = Set(["ActiveEnergy", "CyclingDistance", "Steps", "SwimmingDistance", "Walking+RunningDistance", "Workouts", "Weight", "BloodPressure", "HeartRate", "BloodOxygen", "Sleep"])

    static func nodes(_ root: XCUIElementSnapshot) -> [XCUIElementSnapshot] {
        var result = [XCUIElementSnapshot](), pending = [root]
        while let node = pending.popLast() { result.append(node); pending.append(contentsOf: node.children) }
        return result
    }
    static func readValues(_ nodes: [XCUIElementSnapshot]) -> [String: String] {
        var result = [String: String]()
        for node in nodes where node.identifier.hasPrefix(readPrefix) && node.identifier.hasSuffix(".SwitchCell.Switch") {
            let kind = String(node.identifier.dropFirst(readPrefix.count).dropLast(".SwitchCell.Switch".count))
            if let value = node.value as? String { result[kind] = value }
        }
        return result
    }
    static func visible(_ node: XCUIElementSnapshot, screen: CGRect) -> Bool {
        node.isEnabled && !node.frame.isEmpty && screen.contains(CGPoint(x: node.frame.midX, y: node.frame.midY))
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
}

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
        let hosts = [app, XCUIApplication(bundleIdentifier: "com.apple.springboard")]
        let kinds = Set(["Steps", "Sleep", "BloodOxygen", "HeartRate"])
        let screen = app.frame
        let end = Date().addingTimeInterval(120)
        var seen = [String: String]()
        var selected = false, submitted = false, finished = false
        while Date() < end {
            var acted = false
            pass: for host in hosts {
                guard let tree = try? host.snapshot() else { continue }
                let nodes = HealthSheet.nodes(tree)
                let reads = HealthSheet.readValues(nodes)
                if !reads.isEmpty && seen.isEmpty {
                    seen = reads
                    let sheet = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
                    sheet.name = "health-import-requested-kinds.png"; sheet.lifetime = .keepAlways; add(sheet)
                }
                if !selected, kinds.isSubset(of: Set(reads.keys)), let all = nodes.first(where: { $0.identifier == HealthSheet.all }) {
                    if HealthSheet.visible(all, screen: screen) { selected = HealthSheet.tap(HealthSheet.all, host: host, screen: screen) }
                    else { app.swipeDown() }
                    acted = true; break pass
                }
                if selected, let allow = nodes.first(where: { $0.identifier == HealthSheet.allow }) {
                    if HealthSheet.visible(allow, screen: screen) { submitted = HealthSheet.tap(HealthSheet.allow, host: host, screen: screen) || submitted }
                    else { app.swipeUp() }
                    acted = true; break pass
                }
                if submitted, nodes.contains(where: { $0.label.hasPrefix("Import from") && $0.isEnabled && ($0.value as? String) == "1" }) {
                    finished = true; break pass
                }
                // On iOS 27 a second Health page can request a history range.
                if submitted, let history = nodes.first(where: { $0.label.hasPrefix("All Recorded Data") && HealthSheet.visible($0, screen: screen) }), !history.identifier.isEmpty {
                    acted = HealthSheet.tap(history.identifier, host: host, screen: screen); break pass
                }
            }
            if finished { break }
            if !acted { app.swipeUp() }
            Thread.sleep(forTimeInterval: 0.5)
        }
        try HealthSheet.attach(seen, name: "health-import-requested-kinds", in: self)
        XCTAssertTrue(kinds.isSubset(of: Set(seen.keys)), "Health sheet missing requested read kinds: \(seen); bridge: \(QA.json(QA.flow(app)?["memo"]))")
        XCTAssertTrue(finished, "Health authorization did not finish")
        app.terminate()
        XCTAssertTrue(app.wait(for: .notRunning, timeout: 30), "the authorization instance did not exit")

        // This second, diagnostic-only ask grants write access for seeded data.
        let seed = try HealthDiagnosticTests.run(seed: true, labels: true, in: self)
        XCTAssertEqual(seed["weightSeeded"] as? Bool, true, "simulator did not grant weight seeding: \(QA.json(seed))")
        XCTAssertEqual(seed["bpSeeded"] as? Bool, true, "simulator did not grant BP seeding: \(QA.json(seed))")
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
        XCTAssertTrue(bp.contains { $0.contains("123/79") && $0.contains("Health import") }, "imported BP source absent: \(bp)")
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
        var denied = [String: String]()
        var submitted = false, finished = false
        while Date() < deadline {
            var acted = false
            pass: for host in hosts {
                guard let tree = try? host.snapshot() else { continue }
                let nodes = HealthSheet.nodes(tree)
                let reads = HealthSheet.readValues(nodes)
                if !reads.isEmpty { denied = reads }
                if let deny = nodes.first(where: { $0.identifier == HealthSheet.deny }),
                   Set(reads.keys) == HealthSheet.expected, reads.values.allSatisfy({ $0 == "0" }) {
                    if HealthSheet.visible(deny, screen: screen) { submitted = HealthSheet.tap(HealthSheet.deny, host: host, screen: screen) || submitted }
                    else { app.swipeUp() }
                    acted = true; break pass
                }
                if submitted, nodes.contains(where: { $0.label.contains("Checked") && $0.label.contains("nothing yet") && $0.label.contains("Settings → Health → Data Access & Devices") && !$0.label.hasPrefix("{") }) {
                    finished = true; break pass
                }
            }
            if finished { break }
            if !acted { app.swipeUp() }
            Thread.sleep(forTimeInterval: 0.5)
        }
        try HealthSheet.attach(denied, name: "health-import-denied-kinds", in: self)
        XCTAssertEqual(Set(denied.keys), HealthSheet.expected, "wrong Health read switches: \(denied)")
        XCTAssertTrue(denied.values.allSatisfy { $0 == "0" }, "a Health read switch was enabled: \(denied)")
        XCTAssertTrue(submitted && finished, "no denied-read guidance after the native denial")
        let shot = XCTAttachment(screenshot: QA.stableScreenshot().0)
        shot.name = "health-import-denied-guidance.png"; shot.lifetime = .keepAlways; add(shot)
    }
}
