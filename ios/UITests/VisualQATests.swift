import UIKit
import XCTest

/// Visual QA on the Simulator (bd med-y5xx.2, docs/design/ios-visual-testing.md
/// tier 2): one screenshot per scene of tests/visual/scenes.json (copied into
/// this bundle by project.yml), taken with the real software keyboard.
///
/// Web scenes launch local mode on the bundled app with the Debug-only
/// `-wgQAScene <name>` hook (Shell.swift), so the page opens on
/// wgapp://local/?qa=<name>; the in-page QA driver seeds the fixture,
/// navigates and publishes `<div role="status" id="wg-qa-ready" aria-label="<probe json>">`.
/// Native scenes (`"nativeOnly": true`, or a `native-` name) launch without
/// the driver and no account (so local mode, bd med-ta2n.17) plus their `args`.
///
/// Per scene, attachments `<scene>.png` (XCUIScreen) and, for web scenes,
/// `<scene>.json` (the ready node's label), kept on success too. The device is
/// the xcresult's (one result bundle per device). A scene whose ready node
/// never appears still attaches its screenshot and fails; the others still run.
///
/// Native steps, `"native": [...]` on a scene, in order:
///   {"tap": "#food-add-search", "placeholder": "Search foods"}  web element by DOM id or placeholder
///   {"type": "app"}            typeText into the tapped element (real keyboard)
///   {"clear": true}            delete the tapped field's text
///   {"tapButton": "Only on this device"}  native (SwiftUI) button by label
///   {"waitFor": "Start"}       any element by label or id, 10 s (or "timeout": seconds; "contains": true matches part of the label)
///   {"keyboard": true}         the software keyboard must be up (implied after "type")
///   {"edgeSwipe": true, "closes": "#id"}  the shell's left-edge pan
///   {"pullDown": true}         a real finger pull down from the upper middle (pull to refresh)
///   {"allowNotifications": true}  tap the system permission alert's Allow, if it shows within 3 s
///   {"notification": "body"}   tap the banner of a delivered notification with that text, 30 s
///
/// One scene: `TEST_RUNNER_WG_QA_SCENES=food-add-sheet-keyboard xcodebuild test ...`
/// (comma-separated).
@MainActor
final class VisualQATests: XCTestCase {
    struct Scene {
        let name: String
        let nativeOnly: Bool
        let steps: [[String: Any]]
        /// `"args"`: extra launch arguments (Dynamic Type, the Debug-only `-wgQALoadError`).
        let args: [String]
    }

    func testScenes() throws {
        continueAfterFailure = true
        try executeScenes(requested: ProcessInfo.processInfo.environment["WG_QA_SCENES"]) { run($0) }
    }

    struct SceneFilterError: Error, CustomStringConvertible {
        let entries: [String]
        var description: String { "Invalid WG_QA_SCENES: \(entries.joined(separator: "; ")). No scenes ran." }
    }

    /// The same entry point for real runs and guard regressions. Validate the
    /// whole request before creating any activity (including Health seeding).
    /// Keep catalog order: later scenes can depend on earlier fixture writes.
    private func executeScenes(requested: String?, run: (Scene) -> Void) throws {
        let eligible = try Self.scenes()
        var selected = eligible
        if let requested, !requested.isEmpty {
            let names = requested.components(separatedBy: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            let eligibleNames = Set(eligible.map(\.name))
            let invalid = names.enumerated().compactMap { index, name -> String? in
                if name.isEmpty { return "blank entry \(index + 1)" }
                return eligibleNames.contains(name) ? nil : "\"\(name)\" (unknown or ineligible on iOS)"
            }
            guard invalid.isEmpty else { throw SceneFilterError(entries: invalid) }
            let only = Set(names)
            selected = eligible.filter { only.contains($0.name) }
        }
        guard !selected.isEmpty else { throw SceneFilterError(entries: ["no eligible scenes"]) }
        for scene in selected {
            XCTContext.runActivity(named: scene.name) { _ in run(scene) }
        }
    }

    func testSceneFilterExecutionGuard() throws {
        // Expected rejection is asserted here; it is not a failed dispatch
        // relabelled green. Exercise the real selection/activity entry point,
        // replacing only the scene body so no apps or permissions are touched.
        continueAfterFailure = true
        let all = try Self.scenes().map(\.name)
        let pair = all.filter { ["today", "food-add-sheet"].contains($0) }
        XCTAssertEqual(pair, ["today", "food-add-sheet"])
        var evidence = [[String: Any]]()
        let valid: [(String?, [String])] = [
            (nil, all), ("", all),
            (" today, food-add-sheet \n", pair),
            ("food-add-sheet,today, today,food-add-sheet", pair)
        ]
        for (request, expected) in valid {
            var executed = [String]()
            try executeScenes(requested: request) { executed.append($0.name) }
            XCTAssertEqual(executed, expected, "request: \(String(describing: request))")
            evidence.append(["request": request as Any? ?? NSNull(), "executed": executed, "rejected": false])
        }
        let invalid: [(String, String)] = [
            ("today,unknown-scene", "unknown-scene"),
            ("unknown-scene,also-unknown", "also-unknown"),
            ("today,settings-account", "settings-account"), // bundled cloud-only scene
            ("settings-account", "settings-account"),
            ("today,native-android-first-run", "native-android-first-run"),
            (" \n\t", "blank entry 1"),
            (",today", "blank entry 1"),
            ("today,", "blank entry 2"),
            ("today, ,food-add-sheet", "blank entry 2"),
            (",", "blank entry 2")
        ]
        for (request, diagnostic) in invalid {
            var executed = [String]()
            var rejection = ""
            XCTAssertThrowsError(try executeScenes(requested: request) { executed.append($0.name) }) { error in
                rejection = String(describing: error)
                XCTAssertTrue(error is SceneFilterError, rejection)
                XCTAssertTrue(rejection.contains(diagnostic), rejection)
            }
            XCTAssertTrue(executed.isEmpty, "invalid request started scenes: \(executed)")
            evidence.append(["request": request, "executed": executed, "rejected": !rejection.isEmpty, "error": rejection])
        }
        let report = XCTAttachment(data: try JSONSerialization.data(withJSONObject: evidence, options: [.prettyPrinted, .sortedKeys]),
                                   uniformTypeIdentifier: "public.json")
        report.name = "scene-filter-execution-guard.json"
        report.lifetime = .keepAlways
        add(report)
    }

    static func scenes() throws -> [Scene] {
        let url = try XCTUnwrap(Bundle(for: VisualQATests.self).url(forResource: "scenes", withExtension: "json"),
                                "scenes.json is not in the test bundle (tests/visual/scenes.json, project.yml)")
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: url))
        let list = try XCTUnwrap((json as? [[String: Any]]) ?? ((json as? [String: Any])?["scenes"] as? [[String: Any]]),
                                 "scenes.json: expected an array of scenes or {\"scenes\": [...]}")
        return try list.compactMap { raw in
            // Web scenes run in local mode here; a cloud-only one (an account control) has nothing to show.
            if raw["cloudOnly"] as? Bool == true { return nil }
            // Another shell's scene (Android's native first run; iOS has none, bd med-ta2n.17).
            if let platform = raw["platform"] as? String, platform != "ios" { return nil }
            let name = try XCTUnwrap(raw["name"] as? String, "scenes.json: a scene without a name")
            return Scene(name: name,
                         nativeOnly: raw["nativeOnly"] as? Bool ?? name.hasPrefix("native-"),
                         steps: raw["native"] as? [[String: Any]] ?? [],
                         args: raw["args"] as? [String] ?? [])
        }
    }

    private func run(_ scene: Scene) {
        if scene.name == "health-kit-import" {
            do { try HealthDiagnosticTests.run(seed: true, in: self) }
            catch { XCTFail("HealthKit seeding failed: \(error)"); return }
        }
        let app = XCUIApplication()
        // Launch arguments land in NSArgumentDomain, over the persisted choice:
        // no account (local mode unless a QA error screen sets a host) or local mode, lock off, on the scene.
        var args = scene.nativeOnly
            ? ["-wgLocalMode", "NO", "-wgAccountHost", ""]
            : ["-wgLocalMode", "1", "-wgLocalLockOn", "0", "-wgQAScene", scene.name]
        // A scene's own `-key value` wins over the base pair (native-lock turns local mode on).
        for key in scene.args where key.hasPrefix("-") {
            if let i = args.firstIndex(of: key) { args.removeSubrange(i...i + 1) }
        }
        app.launchArguments = args + scene.args
        app.launch()

        var failure: String?
        if scene.nativeOnly {
            if !app.buttons.firstMatch.waitForExistence(timeout: 30) { failure = "the native scene never showed a button" }
        } else if !QA.readyNode(app).waitForExistence(timeout: 60) {
            failure = "ready node #wg-qa-ready never appeared"
        }
        if failure == nil { failure = perform(scene.steps, in: app) }
        Thread.sleep(forTimeInterval: 1) // keyboard and sheet animations settle; the driver re-publishes
        let region = scene.nativeOnly ? nil : paintRegion(app)
        let (screenshot, painted) = QA.stableScreenshot(paint: region, points: app.frame.width)
        if !painted, failure == nil { failure = "the ready content never painted (blank frame)" }
        // The app is dark: a white status-bar band hides the clock (med-o7zq.44).
        if !scene.nativeOnly, failure == nil, Self.cornerLuma(screenshot.image) > 0.9 {
            failure = "the status-bar band is white (shell sampled the wrong page colour)"
        }
        let shot = XCTAttachment(screenshot: screenshot)
        shot.name = "\(scene.name).png"
        shot.lifetime = .keepAlways
        add(shot)
        if !scene.nativeOnly {
            if let json = readyReport(app) {
                let report = XCTAttachment(data: Data(json.utf8), uniformTypeIdentifier: "public.json")
                report.name = "\(scene.name).json"
                report.lifetime = .keepAlways
                add(report)
                // The driver re-checks the scene's ready selectors on every
                // report: "ready" in failed means the shot shows another view.
                if failure == nil,
                   let obj = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
                   (obj["failed"] as? [String])?.contains("ready") == true {
                    failure = "the scene's ready content was gone at the shot (probes.readyLost in \(scene.name).json)"
                }
            }
        }
        if scene.name == "health-kit-import" {
            if let json = readyReport(app),
               let obj = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
               obj["ok"] as? Bool == true, obj["paint"] as? [String: Any] != nil {
                // Required native import/value assertions completed.
            } else {
                failure = "native Health scene requires a valid report with ok=true and a painted-content region: \(readyReport(app) ?? "missing")"
            }
        }
        if let failure { XCTFail("\(scene.name): \(failure)") }
        app.terminate()
    }

    /// Luma (0–1) of the screenshot's top-left 4×4 px: the status-bar band, clear of the clock.
    static func cornerLuma(_ image: UIImage) -> Double {
        guard let cg = image.cgImage?.cropping(to: CGRect(x: 0, y: 0, width: 4, height: 4)) else { return 0 }
        var px = [UInt8](repeating: 0, count: 4)
        guard let ctx = CGContext(data: &px, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return 0 }
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        return (0.2126 * Double(px[0]) + 0.7152 * Double(px[1]) + 0.0722 * Double(px[2])) / 255
    }

    /// The ready node's probe JSON (WebKit appends the role, ", application
    /// status", to the label).
    private func readyReport(_ app: XCUIApplication) -> String? {
        let ready = QA.readyNode(app)
        guard ready.exists else { return nil }
        let label = ready.label
        return label.range(of: "}", options: .backwards).map { String(label[...$0.lowerBound]) } ?? label
    }

    /// The report's `paint` rect (web view points) on the screen.
    private func paintRegion(_ app: XCUIApplication) -> CGRect? {
        guard let json = readyReport(app),
              let obj = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
              let p = obj["paint"] as? [String: Double],
              let x = p["x"], let y = p["y"], let w = p["w"], let h = p["h"] else { return nil }
        let web = app.webViews.firstMatch
        guard web.exists else { return nil }
        return CGRect(x: web.frame.minX + x, y: web.frame.minY + y, width: w, height: h)
    }

    /// Runs the scene's native steps; returns the first failure.
    private func perform(_ steps: [[String: Any]], in app: XCUIApplication) -> String? {
        var field: XCUIElement?
        var typed = false
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for step in steps {
            if let selector = step["tap"] as? String {
                let id = selector.hasPrefix("#") ? String(selector.dropFirst()) : selector
                let placeholder = step["placeholder"] as? String ?? id
                let el = QA.webElement(app, id: id, placeholder: placeholder)
                guard el.waitForExistence(timeout: 10) else { return "no web element \(selector)" }
                el.tap()
                field = el
                QA.dismissKeyboardTip(app)
            } else if let text = step["type"] as? String {
                (field ?? app).typeText(text)
                QA.dismissKeyboardTip(app) // it can also come up mid-typing
                typed = true
                // The field's AX value lags the keystrokes: poll before failing.
                // (An XCTNSPredicateExpectation on `value` never matched and
                // stalled for minutes on CI.)
                if let field {
                    var shown = ""
                    for _ in 0..<10 {
                        shown = field.value as? String ?? ""
                        if shown.contains(text) { break }
                        Thread.sleep(forTimeInterval: 0.3)
                    }
                    if !shown.contains(text) { return "typed \"\(text)\" but the field shows \"\(shown)\"" }
                }
            } else if step["clear"] as? Bool == true {
                guard let field else { return "clear without a tapped field" }
                let count = max((field.value as? String)?.count ?? 0, 32)
                field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: count))
            } else if let label = step["tapButton"] as? String {
                let button = app.buttons[label]
                guard button.waitForExistence(timeout: 10) else { return "no button \"\(label)\"" }
                button.tap()
            } else if let label = step["waitFor"] as? String {
                let format = step["contains"] as? Bool == true ? "label CONTAINS %@ OR identifier == %@" : "label == %@ OR identifier == %@"
                let el = app.descendants(matching: .any).matching(NSPredicate(format: format, label, label)).firstMatch
                let timeout = step["timeout"] as? Double ?? 10
                guard el.waitForExistence(timeout: timeout) else { return "\"\(label)\" never appeared" }
            } else if step["edgeSwipe"] as? Bool == true {
                // The shell's left-edge pan (bd med-y7b4.4): `closes` shows before it and is gone after.
                var target: XCUIElement?
                let closes = step["closes"] as? String
                if let selector = closes {
                    let id = selector.hasPrefix("#") ? String(selector.dropFirst()) : selector
                    let el = QA.webElement(app, id: id, placeholder: step["placeholder"] as? String ?? id)
                    guard el.waitForExistence(timeout: 10) else { return "no web element \(selector) before the edge swipe" }
                    target = el
                }
                app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.5))
                    .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.5)))
                if let target {
                    var gone = false
                    for _ in 0..<20 where !gone {
                        Thread.sleep(forTimeInterval: 0.25)
                        gone = !target.exists
                    }
                    if !gone { return "\(closes ?? "") still shows after the edge swipe" }
                }
            } else if step["pullDown"] as? Bool == true {
                // A real finger pull from the upper content, clear of the left-edge pan (bd med-y7b4.7):
                // proves WKWebView delivers the touches to the web pull-to-refresh with bounces off.
                // Follow it with a waitFor on the pill's busy text.
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
                    .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75)),
                           withVelocity: XCUIGestureVelocity(600), thenHoldForDuration: 0.1)
            } else if step["allowNotifications"] as? Bool == true {
                // The system's notification permission alert, only on the first ask of a run.
                let allow = springboard.buttons["Allow"]
                if allow.waitForExistence(timeout: 3) { allow.tap() }
            } else if let body = step["notification"] as? String {
                // A real local notification's banner (bd med-wi09.6): the tap goes
                // through Notifications.didReceive → ReminderPath → Shell.openReminder.
                let banner = springboard.descendants(matching: .any)
                    .matching(NSPredicate(format: "label CONTAINS %@", body)).firstMatch
                guard banner.waitForExistence(timeout: step["timeout"] as? Double ?? 30) else { return "no notification \"\(body)\"" }
                banner.tap()
            } else if step["keyboard"] as? Bool == true {
                typed = true
            } else {
                return "unknown native step \(step)"
            }
        }
        if typed, !app.keyboards.firstMatch.waitForExistence(timeout: 5) {
            return "the software keyboard never appeared (hardware keyboard connected?)"
        }
        return nil
    }
}
