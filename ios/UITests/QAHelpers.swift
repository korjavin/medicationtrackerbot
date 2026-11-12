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

    /// WKWebView's form accessory bar has Done; else the keyboard's own key.
    static func hideKeyboard(_ app: XCUIApplication) {
        guard app.keyboards.firstMatch.exists else { return }
        let done = app.toolbars.buttons["Done"]
        if done.exists { done.tap() } else { app.keyboards.buttons.matching(NSPredicate(format: "label IN[c] {'return', 'done', 'go'}")).firstMatch.tap() }
        let end = Date().addingTimeInterval(5)
        while app.keyboards.firstMatch.exists && Date() < end { Thread.sleep(forTimeInterval: 0.2) }
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

    // MARK: Flow scenes (bd med-sz4k.6.1)

    /// The ready node's report (tests/visual/driver.js publish); nil while
    /// absent or unreadable. WebKit appends the role ("…}, application status").
    static func report(_ app: XCUIApplication) -> [String: Any]? {
        let node = readyNode(app)
        guard node.exists else { return nil }
        let raw = node.label
        guard let end = raw.lastIndex(of: "}") else { return nil }
        return (try? JSONSerialization.jsonObject(with: Data(raw[...end].utf8))) as? [String: Any]
    }

    /// A flow scene's page state (driver.js flowState), from the report.
    static func flow(_ app: XCUIApplication) -> [String: Any]? {
        report(app)?["flow"] as? [String: Any]
    }

    /// Polls the flow state until `ok` holds; the last state otherwise (nil
    /// when no report showed), so the caller's assertion names what it saw.
    static func waitFlow(_ app: XCUIApplication, timeout: TimeInterval = 15, _ ok: ([String: Any]) -> Bool) -> (Bool, [String: Any]?) {
        let end = Date().addingTimeInterval(timeout)
        var last: [String: Any]?
        repeat {
            if let f = flow(app) {
                last = f
                if ok(f) { return (true, f) }
            }
            Thread.sleep(forTimeInterval: 0.5)
        } while Date() < end
        return (false, last)
    }

    /// The on-screen rect (web view points) the page reports for a named
    /// target of the scene (driver.js flowState targets).
    static func target(_ flow: [String: Any]?, _ name: String) -> CGRect? {
        guard let t = (flow?["targets"] as? [String: Any])?[name] as? [String: Any],
              let x = t["x"] as? Double, let y = t["y"] as? Double, let w = t["w"] as? Double, let h = t["h"] as? Double,
              w > 0, h > 0 else { return nil }
        return CGRect(x: x, y: y, width: w, height: h)
    }

    /// A real touch on the target's centre (or `at` × its size from its
    /// origin), through the web view's frame: WKWebView exposes no DOM ids.
    static func coordinate(_ app: XCUIApplication, _ rect: CGRect, at unit: CGPoint = CGPoint(x: 0.5, y: 0.5)) -> XCUICoordinate {
        let web = app.webViews.firstMatch.frame
        return app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: web.minX + rect.minX + rect.width * unit.x, dy: web.minY + rect.minY + rect.height * unit.y))
    }

    /// Taps the named target until `done` holds, at most three taps, each only
    /// while the target is still on the page (a tap that landed late is not
    /// repeated on whatever replaced it; QA.tapUntil's reason, bd med-w6gx.29).
    @discardableResult
    static func tapTarget(_ app: XCUIApplication, _ name: String, at unit: CGPoint = CGPoint(x: 0.5, y: 0.5),
                          timeout: TimeInterval = 10, until done: ([String: Any]) -> Bool) -> (Bool, [String: Any]?) {
        var last: [String: Any]?
        for _ in 0..<3 {
            let (shown, f) = waitFlow(app, timeout: 10) { target($0, name) != nil || done($0) }
            last = f
            if let f, done(f) { return (true, f) }
            guard shown, let rect = target(f, name) else { break }
            coordinate(app, rect, at: unit).tap()
            let (ok, after) = waitFlow(app, timeout: timeout, done)
            last = after ?? last
            if ok { return (true, after) }
        }
        return (false, last)
    }

    /// A web button by label. Segmented sub-tabs (aria-pressed buttons: Meds
    /// Timeline/Schedule, Food Log/Food DB, Health BP/Weight) are exposed as
    /// Switch elements, the tab bar and the rest as Button.
    static func control(_ app: XCUIApplication, _ label: String, prefix: Bool = false) -> XCUIElement {
        app.webViews.descendants(matching: .any).matching(NSPredicate(
            format: "(elementType == %d OR elementType == %d) AND " + (prefix ? "label BEGINSWITH %@" : "label == %@"),
            XCUIElement.ElementType.button.rawValue, XCUIElement.ElementType.switch.rawValue, label)).firstMatch
    }

    /// A web button by its accessible label (a tab, a segment), tapped until
    /// the flow state says `done`, at most three taps.
    @discardableResult
    static func tapLabel(_ app: XCUIApplication, _ label: String, prefix: Bool = false, timeout: TimeInterval = 10,
                         until done: ([String: Any]) -> Bool) -> (Bool, [String: Any]?) {
        let button = control(app, label, prefix: prefix)
        var last: [String: Any]?
        for _ in 0..<3 {
            if button.waitForExistence(timeout: 5) { button.tap() }
            let (ok, f) = waitFlow(app, timeout: timeout, done)
            last = f ?? last
            if ok { return (true, f) }
        }
        return (false, last)
    }

    /// JSON of a value for a failure message or an attachment.
    static func json(_ value: Any?) -> String {
        guard let value, JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return String(describing: value) }
        return String(decoding: data, as: UTF8.self)
    }

    // MARK: The fake server's control (ios/qa/fake-server.sh, tlsfront -control)

    /// One call to tlsfront's control on the runner (https://qa.test:8768,
    /// the same CA the Simulator trusts): GET /receipts, POST /stop, POST
    /// /start. Returns {listening, receipts: [{at, host, method, path, status, tags}]} (tags: a sync push's record_type_tags).
    static func fakeServer(_ method: String = "GET", _ path: String = "/receipts") throws -> [String: Any] {
        var req = URLRequest(url: URL(string: "https://qa.test:8768\(path)")!, timeoutInterval: 15)
        req.httpMethod = method
        let done = DispatchSemaphore(value: 0)
        var result: Result<Data, Error> = .failure(URLError(.timedOut))
        URLSession.shared.dataTask(with: req) { data, res, err in
            if let err { result = .failure(err) }
            else if (res as? HTTPURLResponse)?.statusCode != 200 { result = .failure(URLError(.badServerResponse)) }
            else { result = .success(data ?? Data()) }
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 20)
        let data = try result.get()
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any], "tlsfront control: not JSON")
    }

    /// What the fake server received (every host, or one).
    static func receipts(host: String? = nil) throws -> [[String: Any]] {
        let all = try fakeServer()["receipts"] as? [[String: Any]] ?? []
        return host.map { h in all.filter { $0["host"] as? String == h } } ?? all
    }

    /// The app's persisted UserDefaults (its prefs plist in the container).
    static func appDefaults(bundleID: String = QA.bundleID) -> [String: Any]? {
        guard let dir = appContainer(bundleID: bundleID),
              let data = try? Data(contentsOf: dir.appendingPathComponent("Library/Preferences/\(bundleID).plist"))
        else { return nil }
        return try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
    }
}
