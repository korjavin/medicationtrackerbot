import UIKit
import XCTest

/// Shared by the visual tier (VisualQATests) and the flow tier (FlowQATests,
/// docs/ios.md "Flow QA (Simulator)").
@MainActor
enum QA {
    static let bundleID = "com.example.medtracker"

    /// WKWebView's DOM reaches XCUITest as accessibility elements: the node's
    /// id is its identifier, and its label is the probe JSON.
    static func readyNode(_ app: XCUIApplication) -> XCUIElement {
        app.webViews.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == 'wg-qa-ready' OR label BEGINSWITH '{\"scene\"'"))
            .firstMatch
    }

    /// A web element by DOM id or placeholder (WKWebView leaves identifier
    /// empty: the driver's `tag` step also makes the id the element's label).
    static func webElement(_ app: XCUIApplication, id: String, placeholder: String? = nil) -> XCUIElement {
        app.webViews.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == %@ OR label == %@ OR placeholderValue == %@", id, id, placeholder ?? id))
            .firstMatch
    }

    /// The web app's bottom tab bar (.wg-tabbar, wg-bottom-nav.js): its Meds
    /// and Train tabs as web buttons.
    static func tabBarShows(_ app: XCUIApplication, timeout: TimeInterval) -> Bool {
        app.webViews.buttons["Train"].waitForExistence(timeout: timeout) && app.webViews.buttons["Meds"].exists
    }

    /// A device's first keyboard opens under the slide-to-type tip (seen on
    /// both CI Simulators, on tap or mid-typing; ContinuousPath defaults did not suppress it).
    static func dismissKeyboardTip(_ app: XCUIApplication) {
        guard app.keyboards.firstMatch.waitForExistence(timeout: 3) else { return }
        let tip = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Speed up your typing'")).firstMatch
        if tip.waitForExistence(timeout: 1) { app.buttons["Continue"].firstMatch.tap() }
    }

    /// The CI Simulator renders without a GPU: a heavy page can show its
    /// previous frame for seconds after the DOM (and the probes) moved on, so
    /// shoot once two screenshots a second apart match. Two identical blank
    /// boot frames also match (run 39209916915, bd med-y5xx.11), so a web
    /// scene's frame must also show painted content where the driver says its
    /// last ready element is. 15 s cap; returns whether the region painted.
    static func stableScreenshot(paint region: CGRect? = nil, points: CGFloat = 0) -> (XCUIScreenshot, Bool) {
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
    static func painted(_ shot: XCUIScreenshot, _ region: CGRect, points: CGFloat) -> Bool {
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

    /// The app's data container as the UI-test runner sees it (both run in
    /// the same Simulator device): the Containers/Data/Application/<uuid>
    /// whose metadata plist names the app's bundle id. nil if not found.
    static func appContainer(bundleID: String = QA.bundleID) -> URL? {
        let env = ProcessInfo.processInfo.environment
        // The device's data dir; else up from the runner's own container.
        let data = env["SIMULATOR_SHARED_RESOURCES_DIRECTORY"].map { URL(fileURLWithPath: $0) }
            ?? URL(fileURLWithPath: NSHomeDirectory()).deletingLastPathComponent().deletingLastPathComponent()
                .deletingLastPathComponent().deletingLastPathComponent()
        let apps = data.appendingPathComponent("Containers/Data/Application")
        let dirs = (try? FileManager.default.contentsOfDirectory(at: apps, includingPropertiesForKeys: nil)) ?? []
        return dirs.first { dir in
            let meta = dir.appendingPathComponent(".com.apple.mobile_container_manager.metadata.plist")
            guard let data = try? Data(contentsOf: meta),
                  let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
            else { return false }
            return plist["MCMMetadataIdentifier"] as? String == bundleID
        }
    }

    /// The app's persisted UserDefaults (its prefs plist in the container).
    static func appDefaults(bundleID: String = QA.bundleID) -> [String: Any]? {
        guard let dir = appContainer(bundleID: bundleID),
              let data = try? Data(contentsOf: dir.appendingPathComponent("Library/Preferences/\(bundleID).plist"))
        else { return nil }
        return try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
    }
}
