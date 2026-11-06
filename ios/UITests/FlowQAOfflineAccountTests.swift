import XCTest

/// Offline cold open in account mode (bd med-sz4k.6.1, twin of android/qa
/// offline-account.mjs): testscenarios/common/offline-cold-open and
/// offline-food-log-today. The golden seed (QA driver, local mode) moves into
/// a real account on the qa job's cmd/cloud ("Turn on sync" with this run's
/// second invite, claimed with the Debug shell's soft authenticator,
/// `-wgQASoftAuthn`) → every section renders online → Food browsed back a day
/// → the fake server stops answering → terminate → relaunch → Food opens on
/// today and every section renders from the phone; a note written offline
/// syncs once the server answers again.
///
/// The Simulator has no airplane mode: "offline" is tlsfront's closed port
/// (ios/qa/fake-server.sh `-control`), so the app's connection attempts are
/// refused before any request reaches the server, and are not observed; the
/// zero received requests over the offline interval are the server's own log.
@MainActor
final class FlowQAOfflineAccountTests: XCTestCase {
    nonisolated override func setUp() {
        super.setUp()
        MainActor.assumeIsolated { QA.reset() } // XCTest runs setUp on the main thread
    }

    nonisolated override func tearDown() {
        // Another flow must not find the fake server stopped.
        _ = MainActor.assumeIsolated { try? QA.fakeServer("POST", "/start") }
        super.tearDown()
    }

    /// Every section the scenario names: (tab, sub-tabs, text its saved data shows).
    private let sections: [(String, [String], String)] = [
        ("Today", [], "135"),
        ("Meds", ["Timeline"], "Lisinopril"),
        ("Food", ["Log"], "Greek yogurt"),
        ("Food", ["Food DB"], "Greek yogurt 2%"),
        ("Train", ["Plans"], "Push/Pull"),
        ("Train", ["Equipment"], "Ohio bar"),
        ("Health", ["BP"], "135"),
        ("Health", ["Weight"], "82.1"),
        ("Health", ["Vitals", "Overview"], "10,200"),
        ("Health", ["Vitals", "Notes"], "Felt good after the run today"),
        ("Settings", [], "Food 2200 kcal"),
    ]

    func testOfflineColdOpen() throws {
        continueAfterFailure = false
        let claim = try XCTUnwrap(ProcessInfo.processInfo.environment["WG_QA_OFFLINE_CLAIM_URL"].flatMap { URL(string: $0) },
                                  "WG_QA_OFFLINE_CLAIM_URL is unset (fake-server.sh mints it; TEST_RUNNER_ prefix in ios.yml)")
        let host = try XCTUnwrap(claim.host, "no host in \(claim)")
        let sub = try XCTUnwrap(host.split(separator: ".").first)
        let token = try XCTUnwrap(claim.fragment?.split(separator: "=").last, "no claim token in \(claim)")
        let link = try XCTUnwrap(URL(string: "medtracker://i/\(sub)#\(token)"))
        let app = XCUIApplication()

        // The golden seed in local mode, then "Turn on sync" with the invite.
        launch(app, ["-wgAccountHost", "", "-wgQAScene", "today"])
        XCTAssertTrue(QA.readyNode(app).waitForExistence(timeout: 120), "the seeded local app never published #wg-qa-ready")
        app.open(link)
        let offer = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Turn on sync'")).firstMatch
        XCTAssertTrue(offer.waitForExistence(timeout: 60), "the invite over local records was not offered (no \"Turn on sync\")")
        shot("offline-account", "offer")
        offer.tap()
        let create = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Continue with'")).firstMatch
        XCTAssertTrue(create.waitForExistence(timeout: 60), "the claim page shows no sign-in button")
        shot("offline-account", "claim")
        create.tap()
        XCTAssertTrue(openApp(app, timeout: 120), "the claimed account never showed the tab bar; on screen: \(texts(app))")
        shot("offline-account", "claimed")

        // Online: every section shows the moved records (a synced boot).
        launch(app, [])
        XCTAssertTrue(openApp(app, timeout: 90), "the account relaunch showed no tab bar; on screen: \(texts(app))")
        var online: [String: Double] = [:]
        for s in sections { online[s.0 + "/" + s.1.joined(separator: "/")] = visit(app, s, phase: "online") }

        // offline-food-log-today: browse Food back a day before the relaunch.
        visit(app, ("Food", ["Log"], "Greek yogurt"), phase: "online")
        let prev = app.webViews.buttons["Previous day"]
        XCTAssertTrue(prev.waitForExistence(timeout: 10), "Food has no Previous day")
        let yesterday = webText(app, "No food logged this day")
        for _ in 0..<3 where !yesterday.exists {
            prev.tap()
            _ = yesterday.waitForExistence(timeout: 5)
        }
        XCTAssertTrue(yesterday.exists && !webText(app, "Greek yogurt").exists, "Food did not move to the day before (today's meal still shows)")
        shot("offline-account", "food-yesterday")

        // The server stops answering; the app stops; nothing may reach it until it answers again.
        let stopped = try QA.fakeServer("POST", "/stop")
        XCTAssertEqual(stopped["listening"] as? Bool, false, "tlsfront still listens")
        app.terminate()
        XCTAssertTrue(app.wait(for: .notRunning, timeout: 30), "the app did not exit")
        let receivedBefore = try QA.receipts(host: host).count
        XCTAssertGreaterThan(receivedBefore, 0, "the fake server never saw the account online (no observer)")

        launch(app, [])
        XCTAssertTrue(openApp(app, timeout: 90), "offline, the account showed no tab bar; on screen: \(texts(app))")
        shot("offline-account", "offline-boot")
        XCTAssertFalse(app.staticTexts["Can't reach your account"].exists, "offline, the shell showed its load error")
        // Food first: it opens on today, not on the day browsed before.
        let foodMs = visit(app, ("Food", ["Log"], "Greek yogurt"), phase: "offline-food-today")
        XCTAssertFalse(webText(app, "No food logged this day").exists, "offline, Food reopened on the day browsed before")
        var offline: [String: Double] = ["Food/Log (today)": foodMs]
        for s in sections { offline[s.0 + "/" + s.1.joined(separator: "/")] = visit(app, s, phase: "offline") }

        // A write stays enabled offline.
        let note = "QA B1 offline note"
        visit(app, ("Health", ["Vitals", "Notes"], "Felt good after the run today"), phase: "offline-note")
        let box = QA.webElement(app, id: "notes-textarea", placeholder: "How are you feeling? What did you notice?")
        XCTAssertTrue(box.waitForExistence(timeout: 10), "no note box offline")
        box.tap()
        QA.dismissKeyboardTip(app)
        box.typeText(note)
        let add = app.webViews.buttons["+ Add note"]
        XCTAssertTrue(add.waitForExistence(timeout: 5) && add.isEnabled, "Add note is disabled offline")
        add.tap()
        XCTAssertTrue(webText(app, note).waitForExistence(timeout: 10), "the offline note is not listed")
        shot("offline-account", "offline-note")
        let receivedOffline = try QA.receipts(host: host)
        XCTAssertEqual(receivedOffline.count, receivedBefore,
                       "the fake server received requests while stopped: \(QA.json(Array(receivedOffline.dropFirst(receivedBefore))))")
        app.terminate()

        // The server answers again: the queued note reaches it on the next open.
        _ = try QA.fakeServer("POST", "/start")
        launch(app, [])
        XCTAssertTrue(openApp(app, timeout: 90), "back online, the account showed no tab bar")
        let end = Date().addingTimeInterval(60)
        var pushed: [[String: Any]] = []
        repeat {
            pushed = try QA.receipts(host: host).dropFirst(receivedBefore)
                .filter { $0["method"] as? String == "POST" && $0["path"] as? String == "/api/sync/ops" && $0["status"] as? Int == 200 }
            if !pushed.isEmpty { break }
            Thread.sleep(forTimeInterval: 1)
        } while Date() < end
        XCTAssertFalse(pushed.isEmpty, "back online, no sync push was answered 200")
        visit(app, ("Health", ["Vitals", "Notes"], note), phase: "reconnected")
        shot("offline-account", "reconnected-note")
        attach("offline-account", ["host": host, "receivedBeforeStop": receivedBefore, "online": online, "offline": offline,
                                    "receipts": try QA.receipts(host: host)])
        app.terminate()
    }

    // MARK: Steps

    /// A cold launch, lock off, the soft authenticator on (account pages only).
    private func launch(_ app: XCUIApplication, _ extra: [String]) {
        if app.state != .notRunning {
            app.terminate()
            XCTAssertTrue(app.wait(for: .notRunning, timeout: 30), "the previous instance did not exit")
        }
        app.launchArguments = ["-wgLocalLockOn", "NO", "-wgLocalLock", "NO", "-wgQASoftAuthn", "YES"] + extra
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 60), "the app did not reach the foreground")
    }

    /// Waits for the account app's tab bar, passing the steps a fresh or
    /// returning account may show first (install nudge, onboarding, unlock).
    private func openApp(_ app: XCUIApplication, timeout: TimeInterval) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if QA.tabBarShows(app, timeout: 2) { return true }
            for label in ["Continue in browser anyway", "Skip all", "Unlock with passkey"] {
                let b = app.webViews.buttons[label]
                if b.exists { b.tap() }
            }
        }
        return false
    }

    /// Opens a section (tab, then sub-tab) and waits for its saved text;
    /// returns the seconds from the last tap to the text. Offline it must
    /// render from the phone: well under the sync engine's 10 s fetch deadline.
    @discardableResult
    private func visit(_ app: XCUIApplication, _ s: (String, [String], String), phase: String) -> Double {
        let (tab, subs, text) = s
        let want = webText(app, text)
        let tabButton = tab == "Settings"
            ? app.webViews.buttons["Settings"]
            : app.webViews.buttons.matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", tab, tab + " ")).firstMatch
        var t0 = Date()
        for _ in 0..<3 {
            if tabButton.waitForExistence(timeout: 5) { tabButton.tap() }
            for sub in subs {
                let b = QA.control(app, sub)
                if b.waitForExistence(timeout: 5) { b.tap() }
            }
            t0 = Date()
            if want.waitForExistence(timeout: 10) { break }
        }
        let seconds = Date().timeIntervalSince(t0)
        let name = ([tab] + subs).joined(separator: "/")
        shot("offline-account", "\(phase)-\(name.lowercased().replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: " ", with: "-"))")
        XCTAssertTrue(want.exists, "\(phase): \(name) does not show \"\(text)\"; on screen: \(texts(app))")
        for empty in ["Failed to load", "No notes yet", "No food logged today", "No sleep data yet"] {
            XCTAssertFalse(webText(app, empty).exists, "\(phase): \(name) shows \"\(empty)\"")
        }
        if phase.hasPrefix("offline") {
            XCTAssertLessThan(seconds, 5, "\(phase): \(name) took \(seconds) s to show its saved data")
        }
        return seconds
    }

    private func webText(_ app: XCUIApplication, _ text: String) -> XCUIElement {
        app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    private func texts(_ app: XCUIApplication) -> String {
        app.staticTexts.allElementsBoundByIndex.prefix(40).map(\.label).filter { !$0.isEmpty }.joined(separator: " | ")
    }

    private func attach(_ name: String, _ value: Any) {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]) else { return }
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = "\(name).json"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func shot(_ flow: String, _ step: String) {
        let attachment = XCTAttachment(screenshot: QA.stableScreenshot().0)
        attachment.name = "\(flow)-\(step).png"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
