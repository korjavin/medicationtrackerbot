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
        app.webViews.buttons["Train"].waitForExistence(timeout: timeout)
            && app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Meds'")).firstMatch.exists // "Meds 1": a due-dose badge
    }

    /// Taps `button` until `target` shows, at most three taps (bd med-w6gx.29):
    /// on the CI Simulator a tap on a web button now and then never reaches
    /// the page (run 39944639601: the Meds tab tap left Today up for 20 s), so
    /// one tap and one wait is a flake. Always taps once; retaps only while
    /// `target` is absent, so `target` must be specific to the destination
    /// and `button` idempotent (a tab, a sheet opener).
    @discardableResult
    static func tapUntil(_ button: XCUIElement, shows target: XCUIElement, timeout: TimeInterval = 10) -> Bool {
        for _ in 0..<3 {
            if button.waitForExistence(timeout: 5) { button.tap() }
            if target.waitForExistence(timeout: timeout) { return true }
        }
        return target.exists
    }

    /// The web's F1 "Have an invite?" sheet (web/static/js/features/invite.js):
    /// where local home?invite=1 lands with no pending invite (bd med-ta2n.17).
    /// Its "Scan QR" button is F1's own (W1's footer has a "Have an invite?" too).
    static func inviteSheetShows(_ app: XCUIApplication, timeout: TimeInterval) -> Bool {
        app.webViews.buttons.matching(NSPredicate(format: "label CONTAINS 'Scan QR'")).firstMatch
            .waitForExistence(timeout: timeout)
    }

    /// The web W1 picker (WGFirstRun, features/firstrun/screens/features.js),
    /// by its title: a bare "Skip" / "Skip all" also labels the Meds timeline's
    /// and Today's dose actions (run 40236769670 tapped a dose's Skip as if it
    /// were W1's, and the reminders prompt it opened hid the tab bar). In a v3
    /// shell, local mode, no pending invite, its footer has "Have an invite?".
    static func w1Shows(_ app: XCUIApplication, timeout: TimeInterval) -> Bool {
        app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'want to track'")).firstMatch
            .waitForExistence(timeout: timeout)
    }

    /// Taps W1's "Skip" if W1 opens within `timeout`; true when it did.
    @discardableResult
    static func skipW1(_ app: XCUIApplication, timeout: TimeInterval) -> Bool {
        guard w1Shows(app, timeout: timeout) else { return false }
        app.webViews.buttons["Skip"].firstMatch.tap()
        return true
    }

    /// Every flow's setUp (bd med-w6gx.23.8): the app stopped, then its
    /// website data (Library/WebKit: the next launch boots an empty store, as
    /// a fresh install does), both shell stashes and the export dir removed,
    /// so one flow's failure stays one red test. The killed instance's WebKit
    /// processes can outlive it and write on (run 39549993399: records came
    /// back after a wipe, and `try?` hid it), so it settles first and removes
    /// until everything stays gone. Defaults are pinned per launch instead
    /// (NSArgumentDomain, e.g. `-wgLocalLock NO`): cfprefsd caches them, so
    /// deleting the plist does not reliably reset them.
    static func reset() {
        let app = XCUIApplication()
        if app.state != .notRunning {
            app.terminate()
            XCTAssertTrue(app.wait(for: .notRunning, timeout: 30), "QA.reset: the app did not exit")
        }
        guard let dir = appContainer() else { return } // never launched: nothing to clear
        let paths = ["Library/WebKit", "Library/Application Support/move", "Library/Application Support/leave", "tmp/wg-downloads"]
            .map { dir.appendingPathComponent($0) }
        let fm = FileManager.default
        Thread.sleep(forTimeInterval: 2)
        for _ in 0..<15 {
            for url in paths { try? fm.removeItem(at: url) }
            Thread.sleep(forTimeInterval: 1)
            if paths.allSatisfy({ !fm.fileExists(atPath: $0.path) }) { return }
        }
        XCTFail("QA.reset could not clear \(paths.filter { fm.fileExists(atPath: $0.path) }.map(\.path))")
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
    /// last ready element is. At most 15 samples; returns whether the region
    /// painted. The optional observer records QA capture timing without
    /// changing the stability/paint acceptance used by existing callers.
    static func stableScreenshot(paint region: CGRect? = nil, points: CGFloat = 0,
                                 observe: ((XCUIScreenshot, String, Int, Bool, Date, Date) -> Void)? = nil) -> (XCUIScreenshot, Bool) {
        var lastCaptureStarted = Date()
        var last = XCUIScreen.main.screenshot()
        var lastCaptureFinished = Date()
        var painted = false
        if let observe {
            observe(last, "initial", 0, region.map { Self.painted(last, $0, points: points) } ?? true,
                    lastCaptureStarted, lastCaptureFinished)
        }
        for sample in 1...15 {
            Thread.sleep(forTimeInterval: 1)
            let captureStarted = Date()
            let next = XCUIScreen.main.screenshot()
            let captureFinished = Date()
            painted = region.map { Self.painted(next, $0, points: points) } ?? true
            if painted, next.pngRepresentation == last.pngRepresentation {
                observe?(next, "stable-painted", sample, painted, captureStarted, captureFinished)
                return (next, true)
            }
            observe?(next, "sample", sample, painted, captureStarted, captureFinished)
            last = next
            lastCaptureStarted = captureStarted
            lastCaptureFinished = captureFinished
        }
        observe?(last, "iteration-limit", 15, painted, lastCaptureStarted, lastCaptureFinished)
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
