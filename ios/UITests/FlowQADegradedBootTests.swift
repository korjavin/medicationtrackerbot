import XCTest

/// Real A/B workers and a one-shot post-unlock module failure. The Debug-only
/// probe preserves the original cached Responses and reports browser state.
@MainActor
final class FlowQADegradedBootTests: XCTestCase {
    nonisolated override func setUp() {
        super.setUp()
        MainActor.assumeIsolated { QA.reset() }
    }

    nonisolated override func tearDown() {
        _ = MainActor.assumeIsolated { try? QA.fakeServer("POST", "/start") }
        super.tearDown()
    }

    func testDegradedBootReload() throws {
        continueAfterFailure = false
        let claim = try XCTUnwrap(ProcessInfo.processInfo.environment["WG_QA_UPDATE_CLAIM_URL"].flatMap(URL.init(string:)))
        let host = try XCTUnwrap(claim.host)
        let sub = try XCTUnwrap(host.split(separator: ".").first)
        let token = try XCTUnwrap(claim.fragment?.split(separator: "=").last)
        let link = try XCTUnwrap(URL(string: "medtracker://i/\(sub)#\(token)"))
        let app = XCUIApplication()
        app.launchArguments = ["-wgAccountHost", "", "-wgLocalLockOn", "NO", "-wgLocalLock", "NO", "-wgQASoftAuthn", "YES"]
        app.launch()
        XCTAssertTrue(app.webViews.buttons.firstMatch.waitForExistence(timeout: 60))
        app.open(link)
        let offer = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Turn on sync' OR label BEGINSWITH 'Sign in with'")).firstMatch
        XCTAssertTrue(offer.waitForExistence(timeout: 60))
        offer.tap()
        let create = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Continue with'")).firstMatch
        XCTAssertTrue(create.waitForExistence(timeout: 60))
        create.tap()
        XCTAssertTrue(openAccount(app, timeout: 120))
        coldOpen(app)
        XCTAssertTrue(openAccount(app, timeout: 90))
        XCTAssertTrue(waitState(app, timeout: 90) { $0["build"] as? String == "20990101-0001" && $0["controlled"] as? Bool == true })
        _ = try control("/switch-b")
        coldOpen(app)
        XCTAssertTrue(openAccount(app, timeout: 90))
        XCTAssertTrue(waitState(app, timeout: 90) { $0["build"] as? String == "20990101-0001" && $0["banners"] as? Int == 1 && $0["waiting"] as? String == "installed" })
        shot("degraded-update-before")
        try action(app, "evict")
        _ = try control("/arm", ["host": host])
        let priorPage = try XCTUnwrap(state(app)?["pageNumber"] as? Int)
        app.webViews.buttons["QA reload"].tap()
        // The fixture releases after four seconds. The probe observes the
        // real banner before the failure within the same new document.
        XCTAssertTrue(waitState(app, timeout: 60) {
            $0["pageNumber"] as? Int == priorPage + 1 && $0["degradedBanners"] as? Int == 1 &&
            $0["banners"] as? Int == 0 && $0["specifier"] as? String == "/js/apishim.js" &&
            $0["updateSeenBeforeDegraded"] as? Bool == true
        }, "real module failure did not replace update banner: \(QA.json(state(app)))")
        let faultPage = try XCTUnwrap(state(app)?["pageNumber"] as? Int)
        let status = try control("/status", method: "GET")
        XCTAssertEqual(status["consumed"] as? Int, 1)
        let message = app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Some saved data did not load. Reload to fix.'")).firstMatch
        XCTAssertTrue(message.waitForExistence(timeout: 10))
        let reload = app.webViews.buttons["Reload"]
        XCTAssertEqual(app.webViews.buttons.matching(identifier: "Reload").count, 1)
        XCTAssertTrue(reload.exists)
        shot("degraded-replaced-update")
        try action(app, "restore")
        let stopped = try QA.fakeServer("POST", "/stop")
        XCTAssertEqual(stopped["listening"] as? Bool, false)
        let before = try QA.receipts(host: host).count
        reload.tap()
        XCTAssertTrue(waitState(app, timeout: 90) { $0["pageNumber"] as? Int == faultPage + 1 && $0["build"] as? String == "20990101-0002" && $0["controlled"] as? Bool == true && $0["degraded"] as? Bool == false }, "offline recovery did not load controlled B")
        XCTAssertTrue(openAccount(app, timeout: 90))
        Thread.sleep(forTimeInterval: 4)
        XCTAssertEqual(state(app)?["pageNumber"] as? Int, faultPage + 1, "more than one recovery document")
        XCTAssertEqual(state(app)?["degradedBanners"] as? Int, 0)
        XCTAssertEqual(try QA.receipts(host: host).count, before, "host received requests while stopped")
        shot("degraded-offline-recovered")
    }

    private func probe(_ app: XCUIApplication) -> XCUIElement {
        app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH 'QA update {'")).firstMatch
    }
    private func state(_ app: XCUIApplication) -> [String: Any]? {
        let element = probe(app)
        guard element.exists, let data = String(element.label.dropFirst("QA update ".count)).data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
    private func waitState(_ app: XCUIApplication, timeout: TimeInterval, _ predicate: ([String: Any]) -> Bool) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        repeat {
            if let value = state(app), predicate(value) { return true }
            Thread.sleep(forTimeInterval: 0.25)
        } while Date() < end
        return false
    }
    private func action(_ app: XCUIApplication, _ name: String) throws {
        let button = app.webViews.buttons["QA " + name]
        XCTAssertTrue(button.waitForExistence(timeout: 15))
        button.tap()
        XCTAssertTrue(waitState(app, timeout: 30) { ($0["action"] as? String)?.hasPrefix(name + ":") == true && $0["action"] as? String != name + ":running" })
        XCTAssertEqual(state(app)?["action"] as? String, name + ":ok", "QA action failed: \(QA.json(state(app)))")
    }
    private func coldOpen(_ app: XCUIApplication) {
        app.terminate()
        XCTAssertTrue(app.wait(for: .notRunning, timeout: 30))
        app.launchArguments = ["-wgLocalLockOn", "NO", "-wgLocalLock", "NO", "-wgQASoftAuthn", "YES"]
        app.launch()
    }
    private func openAccount(_ app: XCUIApplication, timeout: TimeInterval) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if QA.tabBarShows(app, timeout: 2) { return true }
            for label in ["Continue in browser anyway", "Skip all", "Unlock with passkey"] {
                let button = app.webViews.buttons[label]
                if button.exists { button.tap() }
            }
        }
        return false
    }
    private func control(_ path: String, _ body: [String: String]? = nil, method: String = "POST") throws -> [String: Any] {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8766" + path)!, timeoutInterval: 30)
        request.httpMethod = method
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let done = DispatchSemaphore(value: 0)
        var status = 0
        var data: Data?
        URLSession.shared.dataTask(with: request) { value, response, _ in
            status = (response as? HTTPURLResponse)?.statusCode ?? 0
            data = value
            done.signal()
        }.resume()
        XCTAssertEqual(done.wait(timeout: .now() + 35), .success)
        XCTAssertEqual(status, 200, "fixture \(path) failed")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(data)) as? [String: Any])
    }
    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: QA.stableScreenshot().0)
        attachment.name = name + ".png"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
