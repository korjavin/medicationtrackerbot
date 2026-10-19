import XCTest

/// Visual QA on the Simulator (bd med-y5xx.2, docs/design/ios-visual-testing.md
/// tier 2): one screenshot per scene of tests/visual/scenes.json (copied into
/// this bundle by project.yml), taken with the real software keyboard.
///
/// Web scenes launch local mode on the bundled app with the Debug-only
/// `-wgQAScene <name>` hook (Shell.swift), so the page opens on
/// wgapp://local/?qa=<name>; the in-page QA driver seeds the fixture,
/// navigates and publishes `<div role="status" id="wg-qa-ready" aria-label="<probe json>">`.
/// Native scenes (`"nativeOnly": true`, or a `native-` name) open first-run.
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
///   {"waitFor": "Start"}       any element by label or id, 10 s
///   {"keyboard": true}         the software keyboard must be up (implied after "type")
///
/// One scene: `TEST_RUNNER_WG_QA_SCENES=food-add-sheet-keyboard xcodebuild test ...`
/// (comma-separated).
@MainActor
final class VisualQATests: XCTestCase {
    struct Scene {
        let name: String
        let nativeOnly: Bool
        let steps: [[String: Any]]
    }

    func testScenes() throws {
        continueAfterFailure = true
        let only = ProcessInfo.processInfo.environment["WG_QA_SCENES"].map { Set($0.split(separator: ",").map(String.init)) }
        let scenes = try Self.scenes().filter { only?.contains($0.name) ?? true }
        XCTAssertFalse(scenes.isEmpty, "no scenes to run")
        for scene in scenes {
            XCTContext.runActivity(named: scene.name) { _ in run(scene) }
        }
    }

    static func scenes() throws -> [Scene] {
        let url = try XCTUnwrap(Bundle(for: VisualQATests.self).url(forResource: "scenes", withExtension: "json"),
                                "scenes.json is not in the test bundle (tests/visual/scenes.json, project.yml)")
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: url))
        let list = try XCTUnwrap((json as? [[String: Any]]) ?? ((json as? [String: Any])?["scenes"] as? [[String: Any]]),
                                 "scenes.json: expected an array of scenes or {\"scenes\": [...]}")
        return try list.map { raw in
            let name = try XCTUnwrap(raw["name"] as? String, "scenes.json: a scene without a name")
            return Scene(name: name,
                         nativeOnly: raw["nativeOnly"] as? Bool ?? name.hasPrefix("native-"),
                         steps: raw["native"] as? [[String: Any]] ?? [])
        }
    }

    private func run(_ scene: Scene) {
        let app = XCUIApplication()
        // Launch arguments land in NSArgumentDomain, over the persisted choice:
        // first-run (no local mode, no account) or local mode, lock off, on the scene.
        app.launchArguments = scene.nativeOnly
            ? ["-wgLocalMode", "NO", "-wgAccountHost", ""]
            : ["-wgLocalMode", "1", "-wgLocalLockOn", "0", "-wgQAScene", scene.name]
        app.launch()

        var failure: String?
        if scene.nativeOnly {
            if !app.buttons.firstMatch.waitForExistence(timeout: 30) { failure = "first-run never showed" }
        } else if !readyNode(app).waitForExistence(timeout: 30) {
            failure = "ready node #wg-qa-ready never appeared"
        }
        if failure == nil { failure = perform(scene.steps, in: app) }
        Thread.sleep(forTimeInterval: 1) // keyboard and sheet animations settle

        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "\(scene.name).png"
        shot.lifetime = .keepAlways
        add(shot)
        if !scene.nativeOnly {
            let ready = readyNode(app)
            if ready.exists {
                // WebKit appends the role (", application status") to the label.
                let label = ready.label
                let json = label.range(of: "}", options: .backwards).map { String(label[...$0.lowerBound]) } ?? label
                let report = XCTAttachment(data: Data(json.utf8), uniformTypeIdentifier: "public.json")
                report.name = "\(scene.name).json"
                report.lifetime = .keepAlways
                add(report)
            }
        }
        if let failure { XCTFail("\(scene.name): \(failure)") }
        app.terminate()
    }

    /// WKWebView's DOM reaches XCUITest as accessibility elements: the node's
    /// id is its identifier, and its label is the probe JSON.
    private func readyNode(_ app: XCUIApplication) -> XCUIElement {
        app.webViews.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == 'wg-qa-ready' OR label BEGINSWITH '{\"scene\"'"))
            .firstMatch
    }

    /// Runs the scene's native steps; returns the first failure.
    private func perform(_ steps: [[String: Any]], in app: XCUIApplication) -> String? {
        var field: XCUIElement?
        var typed = false
        for step in steps {
            if let selector = step["tap"] as? String {
                let id = selector.hasPrefix("#") ? String(selector.dropFirst()) : selector
                let placeholder = step["placeholder"] as? String ?? id
                let el = app.webViews.descendants(matching: .any)
                    .matching(NSPredicate(format: "identifier == %@ OR placeholderValue == %@", id, placeholder))
                    .firstMatch
                guard el.waitForExistence(timeout: 10) else { return "no web element \(selector)" }
                el.tap()
                field = el
            } else if let text = step["type"] as? String {
                (field ?? app).typeText(text)
                typed = true
            } else if step["clear"] as? Bool == true {
                guard let field else { return "clear without a tapped field" }
                let count = max((field.value as? String)?.count ?? 0, 32)
                field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: count))
            } else if let label = step["tapButton"] as? String {
                let button = app.buttons[label]
                guard button.waitForExistence(timeout: 10) else { return "no button \"\(label)\"" }
                button.tap()
            } else if let label = step["waitFor"] as? String {
                let el = app.descendants(matching: .any)
                    .matching(NSPredicate(format: "label == %@ OR identifier == %@", label, label)).firstMatch
                guard el.waitForExistence(timeout: 10) else { return "\"\(label)\" never appeared" }
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
