import XCTest

/// Flow QA: the EU register check in local mode (bd med-3u28.4, web contract
/// med-3u28.2; twin of android/qa eu-register.mjs). The register is bundled
/// (`/static/data/ema-article57-rev90-v1.json`) and loads from wgapp://local on
/// the first check. Same contract as FlowQATests. The page's numbers come from
/// the driver's `euRegister` step (tests/visual/driver.js) through the
/// #wg-qa-ready report and are attached as `eu-register-<step>.json`; the qa
/// job's `webcontent-rss-<part>.log` holds the memory side.
@MainActor
final class FlowQAEURegisterTests: XCTestCase {
    nonisolated override func setUp() {
        super.setUp()
        MainActor.assumeIsolated { QA.reset() } // XCTest runs setUp on the main thread
    }

    func testEURegister() throws {
        continueAfterFailure = false
        let flow = "eu-register"
        let app = XCUIApplication()

        // US (the default): local mode has no RxNav, so a name commit checks
        // nothing, and the EU register is never fetched.
        let us = try scene(app, "eu-register-us", flow: flow, step: "us")
        XCTAssertEqual((us["check"] as? [String: Any])?["status"] as? String, "off", "with US picked the EU port answered: \(us)")
        XCTAssertEqual(us["euSlot"] as? Bool, false, "with US picked the editor shows the EU slot")
        XCTAssertEqual(us["rxChip"] as? Bool, false, "an Rx chip in local mode (RxNav is off there)")
        XCTAssertEqual((us["cachesAfter"] as? [String])?.isEmpty ?? true, true, "with US picked an EU register cache exists: \(us)")
        app.terminate()

        // Settings → Features → "Check names in": ER2's local-mode copy, then EU.
        launch(app, "eu-register-pick")
        XCTAssertTrue(QA.readyNode(app).waitForExistence(timeout: 90), "the register choice never opened")
        let usCopy = webText(app, "Needs an account. Without one, no name check runs.")
        XCTAssertTrue(usCopy.waitForExistence(timeout: 10), "the US option lacks ER2's local-mode line")
        shot(flow, "choice")
        let eu = app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'EU register'")).firstMatch
        XCTAssertTrue(eu.waitForExistence(timeout: 5), "no EU register choice")
        for _ in 0..<3 where usCopy.exists { // a web tap now and then never lands on CI (QA.tapUntil)
            eu.tap()
            _ = waitUntil(5) { !usCopy.exists }
        }
        XCTAssertFalse(usCopy.exists, "the choice did not close on EU register")
        XCTAssertTrue(webText(app, "EU register").waitForExistence(timeout: 5), "the Settings row does not say EU register")
        shot(flow, "picked")
        app.terminate()

        // Relaunch: the choice held (the step fails otherwise); the first check
        // downloads the bundled register, the chip shows, its sheet opens.
        let first = try scene(app, "eu-register", flow: flow, step: "first", timeout: 180)
        XCTAssertEqual(first["storedBefore"] as? Bool, false, "a stored register before the first download: \(first)")
        XCTAssertEqual(first["assetFetches"] as? Int, 1, "the first load did not read the bundled register once: \(first)")
        let chip = euChip(app)
        XCTAssertTrue(chip.waitForExistence(timeout: 10), "no EU chip for Candecor")
        shot(flow, "chip")
        XCTAssertTrue(QA.tapUntil(chip, shows: webText(app, "Germany")), "the register sheet does not list Germany")
        shot(flow, "sheet")
        app.terminate()

        // Next launch: cache-first when WebKit stored it on this origin; else
        // the register loads again into memory and still answers (best-effort).
        let second = try scene(app, "eu-register", flow: flow, step: "second", timeout: 180)
        if first["stored"] as? Bool == true {
            XCTAssertEqual(second["storedBefore"] as? Bool, true, "the stored register is gone after a relaunch: \(second)")
        }
        // A cache entry must be what serves the relaunch; none → the bundle again.
        XCTAssertEqual(second["assetFetches"] as? Int, second["storedBefore"] as? Bool == true ? 0 : 1,
                       "the relaunch's asset fetches do not match its cache entry: \(second)")
        XCTAssertTrue(euChip(app).waitForExistence(timeout: 10), "no EU chip on the second launch")
        shot(flow, "second-chip")
        app.terminate()
    }

    private func launch(_ app: XCUIApplication, _ scene: String) {
        app.launchArguments = ["-wgLocalMode", "1", "-wgLocalLockOn", "0", "-wgLocalLock", "0", "-wgQAScene", scene]
        app.launch()
    }

    /// Launches the scene, waits for an ok report, attaches its euRegister
    /// part and returns it.
    private func scene(_ app: XCUIApplication, _ name: String, flow: String, step: String,
                       timeout: TimeInterval = 90) throws -> [String: Any] {
        launch(app, name)
        let node = QA.readyNode(app)
        XCTAssertTrue(node.waitForExistence(timeout: timeout), "\(name) never published #wg-qa-ready")
        // WebKit appends the role to the label ("…}, application status").
        let raw = node.label
        let label = raw.lastIndex(of: "}").map { String(raw[...$0]) } ?? raw
        let report = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(label.utf8)) as? [String: Any], "unreadable report: \(label)")
        XCTAssertNil(report["error"], "\(name): \(label)")
        let eu = try XCTUnwrap(report["euRegister"] as? [String: Any], "\(name): no euRegister in \(label)")
        let attachment = XCTAttachment(data: try JSONSerialization.data(withJSONObject: eu, options: [.prettyPrinted, .sortedKeys]),
                                       uniformTypeIdentifier: "public.json")
        attachment.name = "\(flow)-\(step).json"
        attachment.lifetime = .keepAlways
        add(attachment)
        return eu
    }

    /// The EU chip, not the ready node (its report JSON names the chip too).
    private func euChip(_ app: XCUIApplication) -> XCUIElement {
        app.webViews.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS 'Candesartan' AND NOT (label BEGINSWITH '{')")).firstMatch
    }

    private func webText(_ app: XCUIApplication, _ text: String) -> XCUIElement {
        app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    private func waitUntil(_ timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.5)
        }
        return condition()
    }

    private func shot(_ flow: String, _ step: String) {
        let attachment = XCTAttachment(screenshot: QA.stableScreenshot().0)
        attachment.name = "\(flow)-\(step).png"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
