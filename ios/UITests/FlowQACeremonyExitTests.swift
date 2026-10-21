import XCTest

/// An invite into an account and back out (bd med-ta2n.17, contract
/// med-ta2n.7 §6-7). Local mode (no account, no native first run) → the
/// invite arrives as medtracker://i/<sub>#<token> (capture: the slot, then
/// home?invite=1) → the web offers it ("Turn on sync?" over records, "Your
/// invite is here" without) → move.stash + local.leave {url} → the claim page.
/// There N5 (bd med-ckm5.15, med-ckm5.2): the shell has no exit bar of its
/// own; the ceremony page's web `.wg-exitbar` ("Not your account?") confirms
/// in-page and calls account.leave with no args, which forgets the host and
/// lands in local mode on home?invite=1 ("Have an invite?"). The invite is a
/// real one: ios/qa/fake-server.sh runs cmd/cloud behind tlsfront and hands
/// its claim URL over as WG_QA_CLAIM_URL.
@MainActor
final class FlowQACeremonyExitTests: XCTestCase {
    func testWebExitBarLeaves() throws {
        continueAfterFailure = false
        let claim = try XCTUnwrap(ProcessInfo.processInfo.environment["WG_QA_CLAIM_URL"].flatMap { URL(string: $0) },
                                  "WG_QA_CLAIM_URL is unset (fake-server.sh mints it; TEST_RUNNER_ prefix in ios.yml)")
        // https://<sub>.qa.test/#claim=<token> → the landing page's scheme link.
        let sub = try XCTUnwrap(claim.host?.split(separator: ".").first, "no host in \(claim)")
        let token = try XCTUnwrap(claim.fragment?.split(separator: "=").last, "no claim token in \(claim)")
        let link = try XCTUnwrap(URL(string: "medtracker://i/\(sub)#\(token)"))

        let app = XCUIApplication()
        // No account: local mode. The lock off, so the flow is not held behind it.
        app.launchArguments = ["-wgAccountHost", "", "-wgLocalLockOn", "NO"]
        app.launch()
        XCTAssertTrue(app.webViews.buttons.firstMatch.waitForExistence(timeout: 60), "local mode never showed its page")

        // Warm capture: the slot, then home?invite=1; the web reads the slot and offers it.
        app.open(link)
        let offer = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Turn on sync' OR label BEGINSWITH 'Sign in with'")).firstMatch
        XCTAssertTrue(offer.waitForExistence(timeout: 60), "the captured invite was not offered (no \"Turn on sync\" / \"Sign in with\")")
        shot("ceremony-exit", "offer")
        offer.tap()

        let leave = app.webViews.buttons["Not your account?"]
        XCTAssertTrue(leave.waitForExistence(timeout: 60), "local.leave {url} did not open the claim page (no web exit bar)")
        XCTAssertFalse(app.buttons["Not your account? Use another invite"].exists, "the old native bar is still there")
        shot("ceremony-exit", "bar")
        leave.tap()
        let confirm = app.webViews.buttons["Use another invite"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 10), "\"Not your account?\" opened no confirm")
        shot("ceremony-exit", "confirm")
        confirm.tap()
        XCTAssertTrue(QA.inviteSheetShows(app, timeout: 60),
                      "account.leave did not land on local mode's \"Have an invite?\"")
        shot("ceremony-exit", "landing")
        app.terminate()
        app.launchArguments = ["-wgLocalLockOn", "NO"]
        app.launch()
        XCTAssertTrue(app.webViews.buttons.firstMatch.waitForExistence(timeout: 60), "the relaunch showed no page")
        XCTAssertFalse(app.webViews.buttons["Not your account?"].waitForExistence(timeout: 10), "after relaunch the left account reopened")
        app.terminate()
    }

    private func shot(_ flow: String, _ step: String) {
        let attachment = XCTAttachment(screenshot: QA.stableScreenshot().0)
        attachment.name = "\(flow)-\(step).png"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
