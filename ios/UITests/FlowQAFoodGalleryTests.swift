import XCTest

/// Food → Add → Gallery opens the photo library directly (bd med-w6gx.33):
/// the shell's PHPicker (media.pickPhoto), never WebKit's Photo Library /
/// Take Photo / Choose File sheet. Cancel leaves the Add sheet open with
/// nothing logged; a picked Simulator sample reaches the review as a JPEG
/// (flow.memo.photo, the scene's photoTrace). Camera (Photo) has no code here.
@MainActor
final class FlowQAFoodGalleryTests: XCTestCase {
    nonisolated override func setUp() {
        super.setUp()
        MainActor.assumeIsolated { QA.reset() }
    }

    func testGalleryOpensPhotoPicker() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-wgLocalMode", "YES", "-wgAccountHost", "", "-wgLocalLockOn", "NO", "-wgLocalLock", "NO", "-wgQAScene", "flow-food-gallery"]
        app.launch()
        XCTAssertTrue(QA.readyNode(app).waitForExistence(timeout: 120), "flow-food-gallery did not become ready")
        var (ok, state) = QA.waitFlow(app, timeout: 30) { Self.sheetOpen($0) && QA.target($0, "gallery") != nil }
        XCTAssertTrue(ok, "the Add sheet with Gallery did not show: \(QA.json(state))")
        let food = state?["food"] as? [String] ?? []

        // Cancel: back on the Add sheet, nothing logged, no review.
        openGallery(app, state)
        shot("picker")
        tapCancel(app)
        (ok, state) = QA.waitFlow(app, timeout: 15) {
            Self.sheetOpen($0) && QA.target($0, "review") == nil && Self.photo($0) == nil && ($0["food"] as? [String] ?? []) == food
        }
        XCTAssertTrue(ok, "cancelling the picker did not leave the Add sheet as it was: \(QA.json(state))")
        XCTAssertFalse(pickerShows(app, timeout: 2), "the picker is still up after Cancel")
        shot("cancelled")

        // Pick the workflow's ios/qa/food-exif.jpg (DateTimeOriginal 2030-01-02
        // 12:34:56, the newest photo): the review gets it as a JPEG with EXIF.
        openGallery(app, state)
        let cell = app.images.matching(NSPredicate(format: "label BEGINSWITH 'Photo,' AND label CONTAINS '2030'")).firstMatch
        XCTAssertTrue(cell.waitForExistence(timeout: 15), "no 2030 test photo in the picker: \(tree(app))")
        cell.tap()
        (ok, state) = QA.waitFlow(app, timeout: 30) { Self.photo($0) != nil && QA.target($0, "review") != nil }
        XCTAssertTrue(ok, "the picked photo did not reach the review: \(QA.json(state))")
        let photo = Self.photo(state ?? [:]) ?? [:]
        XCTAssertEqual(photo["type"] as? String, "image/jpeg", "picked photo: \(QA.json(photo))")
        XCTAssertEqual(photo["jpeg"] as? Bool, true, "picked photo is not JPEG bytes: \(QA.json(photo))")
        XCTAssertGreaterThan(photo["size"] as? Double ?? 0, 1000, "picked photo: \(QA.json(photo))")
        // EXIF kept: photo.js reads DateTimeOriginal (eaten_at). Local time, so the day may shift by the zone.
        XCTAssertTrue((photo["exif"] as? String ?? "").hasPrefix("2030-01-0"), "EXIF DateTimeOriginal lost: \(QA.json(photo))")
        let memo = XCTAttachment(string: QA.json(photo))
        memo.name = "gallery-photo.json"
        memo.lifetime = .keepAlways
        add(memo)
        shot("review")
    }

    private static func sheetOpen(_ state: [String: Any]) -> Bool {
        (state["modals"] as? [String] ?? []).contains("food-add-sheet")
    }

    private static func photo(_ state: [String: Any]) -> [String: Any]? {
        (state["memo"] as? [String: Any])?["photo"] as? [String: Any]
    }

    /// Taps Gallery and asserts the Photos picker, not WebKit's three-way sheet.
    private func openGallery(_ app: XCUIApplication, _ state: [String: Any]?) {
        guard let rect = QA.target(state, "gallery") else { return XCTFail("no Gallery target: \(QA.json(state))") }
        QA.coordinate(app, rect).tap()
        let sheet = app.descendants(matching: .any).matching(NSPredicate(
            format: "label IN %@", ["Photo Library", "Take Photo", "Choose File"])).firstMatch
        let end = Date().addingTimeInterval(5)
        repeat {
            XCTAssertFalse(sheet.exists, "WebKit's Photo Library / Take Photo / Choose File sheet showed: \(tree(app))")
            Thread.sleep(forTimeInterval: 0.5)
        } while Date() < end
        XCTAssertTrue(pickerShows(app, timeout: 20), "the Photos picker did not show: \(tree(app))")
    }

    /// The picker is a hosted, out-of-process sheet: found by element query
    /// (its Cancel or a photo cell), never a root snapshot walk.
    private func pickerShows(_ app: XCUIApplication, timeout: TimeInterval) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        repeat {
            if cancelButton(app).exists || photoCell(app).exists { return true }
            Thread.sleep(forTimeInterval: 0.5)
        } while Date() < end
        return false
    }

    private func cancelButton(_ app: XCUIApplication) -> XCUIElement {
        app.navigationBars.buttons["Cancel"].firstMatch
    }

    private func photoCell(_ app: XCUIApplication) -> XCUIElement {
        app.images.matching(NSPredicate(format: "label BEGINSWITH 'Photo,'")).firstMatch
    }

    private func tapCancel(_ app: XCUIApplication) {
        let cancel = cancelButton(app).exists ? cancelButton(app) : app.buttons["Cancel"].firstMatch
        XCTAssertTrue(cancel.waitForExistence(timeout: 5), "no Cancel in the picker: \(tree(app))")
        cancel.tap()
    }

    /// Only on failure, for the message.
    private func tree(_ app: XCUIApplication) -> String {
        String(app.debugDescription.prefix(6000))
    }

    private func shot(_ step: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "food-gallery-\(step).png"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
