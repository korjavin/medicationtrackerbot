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
        } else if !readyNode(app).waitForExistence(timeout: 60) {
            failure = "ready node #wg-qa-ready never appeared"
        }
        if failure == nil { failure = perform(scene.steps, in: app) }
        Thread.sleep(forTimeInterval: 1) // keyboard and sheet animations settle; the driver re-publishes
        let region = scene.nativeOnly ? nil : paintRegion(app)
        let (screenshot, painted) = Self.stableScreenshot(paint: region, points: app.frame.width)
        if !painted, failure == nil { failure = "the ready content never painted (blank frame)" }
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
        if let failure { XCTFail("\(scene.name): \(failure)") }
        app.terminate()
    }

    /// The CI Simulator renders without a GPU: a heavy page can show its
    /// previous frame for seconds after the DOM (and the probes) moved on, so
    /// shoot once two screenshots a second apart match. Two identical blank
    /// boot frames also match (run 39209916915, bd med-y5xx.11), so a web
    /// scene's frame must also show painted content where the driver says its
    /// last ready element is. 15 s cap; returns whether the region painted.
    private static func stableScreenshot(paint region: CGRect?, points: CGFloat) -> (XCUIScreenshot, Bool) {
        var last = XCUIScreen.main.screenshot()
        var painted = false
        for _ in 0..<15 {
            Thread.sleep(forTimeInterval: 1)
            let next = XCUIScreen.main.screenshot()
            painted = region.map { Self.painted(next, $0, points: points) } ?? true
            if painted, next.pngRepresentation == last.pngRepresentation { return (next, true) }
            last = next
        }
        return (last, painted)
    }

    /// Whether the screen region (points) holds content rather than a flat
    /// background: at least 0.5 % of its pixels differ in luminance from the
    /// region's median by more than 40 (text, icons, chart strokes do; the
    /// boot frame's gradient does not).
    private static func painted(_ shot: XCUIScreenshot, _ region: CGRect, points: CGFloat) -> Bool {
        guard let cg = shot.image.cgImage, points > 0 else { return true }
        let scale = CGFloat(cg.width) / points
        let px = CGRect(x: region.minX * scale, y: region.minY * scale, width: region.width * scale, height: region.height * scale)
            .integral.intersection(CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
        guard px.width >= 4, px.height >= 4, let crop = cg.cropping(to: px) else { return true }
        let w = min(Int(px.width), 400)
        let h = max(1, Int(CGFloat(w) * px.height / px.width))
        var buf = [UInt8](repeating: 0, count: w * h * 4)
        let drawn = buf.withUnsafeMutableBytes { raw -> Bool in
            guard let ctx = CGContext(data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            ctx.draw(crop, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard drawn else { return true }
        var lum = [Int](repeating: 0, count: w * h)
        for i in 0..<(w * h) { lum[i] = (Int(buf[i * 4]) * 3 + Int(buf[i * 4 + 1]) * 6 + Int(buf[i * 4 + 2])) / 10 }
        let median = lum.sorted()[lum.count / 2]
        let off = lum.reduce(0) { $0 + (abs($1 - median) > 40 ? 1 : 0) }
        return off * 200 >= lum.count
    }

    /// The ready node's probe JSON (WebKit appends the role, ", application
    /// status", to the label).
    private func readyReport(_ app: XCUIApplication) -> String? {
        let ready = readyNode(app)
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
                    // WKWebView leaves identifier empty: the driver's `tag` step
                    // also makes the id the element's label.
                    .matching(NSPredicate(format: "identifier == %@ OR label == %@ OR placeholderValue == %@", id, id, placeholder))
                    .firstMatch
                guard el.waitForExistence(timeout: 10) else { return "no web element \(selector)" }
                el.tap()
                field = el
                dismissKeyboardTip(app)
            } else if let text = step["type"] as? String {
                (field ?? app).typeText(text)
                dismissKeyboardTip(app) // it can also come up mid-typing
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

    /// A device's first keyboard opens under the slide-to-type tip (seen on
    /// both CI Simulators, on tap or mid-typing; ContinuousPath defaults did not suppress it).
    private func dismissKeyboardTip(_ app: XCUIApplication) {
        guard app.keyboards.firstMatch.waitForExistence(timeout: 3) else { return }
        let tip = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Speed up your typing'")).firstMatch
        if tip.waitForExistence(timeout: 1) { app.buttons["Continue"].firstMatch.tap() }
    }
}
