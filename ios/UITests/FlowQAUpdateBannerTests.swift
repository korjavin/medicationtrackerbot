import XCTest

/// Real cloud A/B binaries and WKWebView service workers, in the isolated
/// update QA part. The small Debug-only probe observes DOM/worker state and
/// sends synthetic rechecks to the unchanged production listener.
@MainActor
final class FlowQAUpdateBannerTests: XCTestCase {
    nonisolated override func setUp() {
        super.setUp()
        MainActor.assumeIsolated { QA.reset() }
    }

    func testAccountUpdateBanner() throws {
        continueAfterFailure = false
        let claim = try XCTUnwrap(ProcessInfo.processInfo.environment["WG_QA_UPDATE_CLAIM_URL"].flatMap { URL(string: $0) })
        let sub = try XCTUnwrap(claim.host?.split(separator: ".").first)
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
        XCTAssertTrue(openAccount(app, timeout: 120), "claim did not open the account")

        // A second document ensures the first installed worker controls it.
        coldOpen(app)
        XCTAssertTrue(openAccount(app, timeout: 90))
        XCTAssertTrue(waitState(app, timeout: 90) { $0["build"] as? String == "20990101-0001" && $0["controlled"] as? Bool == true })
        for _ in 0..<3 {
            probe(app).tap()
            Thread.sleep(forTimeInterval: 2)
            XCTAssertEqual(state(app)?["banners"] as? Int, 0, "matching A showed a banner")
        }

        try switchToB()
        coldOpen(app)
        XCTAssertTrue(openAccount(app, timeout: 90))
        XCTAssertTrue(waitState(app, timeout: 90) { $0["build"] as? String == "20990101-0001" && $0["banners"] as? Int == 1 && $0["waiting"] as? String == "installed" }, "A did not show one banner with B waiting")
        let banner = app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS 'A new version is available'")).firstMatch
        XCTAssertTrue(banner.waitForExistence(timeout: 10))
        shot("update-A-banner")

        // Record the native event independently of the synthetic checks.
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 3)
        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30))
        XCTAssertTrue(waitState(app, timeout: 30) {
            let events = $0["events"] as? String ?? ""
            return events.contains("hidden:true") && events.contains("visible:true")
        }, "native Home/return did not deliver trusted hidden and visible events: \(QA.json(state(app)))")
        for _ in 0..<3 {
            probe(app).tap()
            Thread.sleep(forTimeInterval: 2)
            XCTAssertEqual(state(app)?["banners"] as? Int, 1, "recheck duplicated the banner")
        }
        let reload = app.webViews.buttons["Reload"]
        XCTAssertTrue(reload.waitForExistence(timeout: 10))
        reload.tap()
        XCTAssertTrue(waitState(app, timeout: 90) { $0["build"] as? String == "20990101-0002" && $0["controlled"] as? Bool == true }, "Reload did not open controlled B")
        XCTAssertTrue(openAccount(app, timeout: 90))
        let settings = app.webViews.buttons["Settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 10))
        settings.tap()
        let version = app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS '20990101-0002'")).firstMatch
        XCTAssertTrue(version.waitForExistence(timeout: 30), "Settings did not show B")
        for _ in 0..<8 where !version.isHittable { app.webViews.firstMatch.swipeUp() }
        XCTAssertTrue(version.isHittable, "Settings version was not visible")
        shot("update-B-settings")
        probe(app).tap()
        Thread.sleep(forTimeInterval: 2)
        XCTAssertEqual(state(app)?["banners"] as? Int, 0, "matching B showed a banner")
    }

    private func probe(_ app: XCUIApplication) -> XCUIElement {
        app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH 'QA update {'")).firstMatch
    }

    private func state(_ app: XCUIApplication) -> [String: Any]? {
        let element = probe(app)
        guard element.exists else { return nil }
        let label = element.label
        guard let data = String(label.dropFirst("QA update ".count)).data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private func waitState(_ app: XCUIApplication, timeout: TimeInterval, _ predicate: ([String: Any]) -> Bool) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        repeat {
            if let value = state(app), predicate(value) { return true }
            Thread.sleep(forTimeInterval: 1)
        } while Date() < end
        return false
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

    private func switchToB() throws {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8766/switch-b")!, timeoutInterval: 30)
        request.httpMethod = "POST"
        let done = DispatchSemaphore(value: 0)
        var status = 0
        URLSession.shared.dataTask(with: request) { _, response, _ in
            status = (response as? HTTPURLResponse)?.statusCode ?? 0
            done.signal()
        }.resume()
        XCTAssertEqual(done.wait(timeout: .now() + 35), .success)
        XCTAssertEqual(status, 200, "fixture failed to switch to B")
    }

    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: QA.stableScreenshot().0)
        attachment.name = name + ".png"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
