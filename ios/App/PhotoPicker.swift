import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// media.pickPhoto (bd med-w6gx.33): Food → Add → Gallery straight into the
/// photo library. WKWebView answers <input type=file accept=image/*> with its
/// own Photo Library / Take Photo / Choose File sheet and iOS has no hook to
/// skip it, so web/static/js/native/media-capture.js asks the shell instead.
///
/// {} → { name, type (MIME), lastModified (ms), data (base64) }; cancelled →
/// NSNull; a second call while a picker is up → "busy". PHPicker runs out of
/// process: no photo-library permission, no Info.plist key. The bytes are the
/// library's own file (JPEG when the item offers one, as Safari's input hands
/// over; else the original image type), never re-encoded, so EXIF and the
/// page's eaten_at from DateTimeOriginal survive.
/// ponytail: base64 through the reply handler (~1.4× the file, a few MB);
/// a wgapp:// fetch would hit the account page's connect-src allowlist.
@MainActor
final class PhotoPicker: NSObject, PHPickerViewControllerDelegate, UIAdaptivePresentationControllerDelegate {
    private static var active: PhotoPicker?
    private let reply: (Any?, String?) -> Void

    private init(reply: @escaping (Any?, String?) -> Void) {
        self.reply = reply
    }

    static func pick(reply: @escaping (Any?, String?) -> Void) {
        guard active == nil else { return reply(nil, "busy") }
        guard let top = Downloads.topViewController() else { return reply(nil, "no window") }
        var config = PHPickerConfiguration()
        config.filter = .images
        config.selectionLimit = 1
        config.preferredAssetRepresentationMode = .current
        let session = PhotoPicker(reply: reply)
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = session
        active = session
        top.present(picker, animated: true)
        // A swipe-down dismissal is a cancel too.
        picker.presentationController?.delegate = session
    }

    struct Photo: Sendable {
        let name: String, type: String, lastModified: Double, data: String
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let provider = results.first?.itemProvider else { return finish(NSNull(), nil) }
        let type = provider.hasItemConformingToTypeIdentifier(UTType.jpeg.identifier) ? UTType.jpeg : UTType.image
        let name = provider.suggestedName
        // Runs on a background queue, hence @Sendable (non-isolated) and the hop back.
        _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { @Sendable url, error in
            // The temporary file is gone once this returns: read it here.
            let photo = url.flatMap { Self.read($0, name: name) }
            let failure = photo == nil ? (error?.localizedDescription ?? "unreadable photo") : nil
            Task { @MainActor in
                guard let photo else { return self.finish(nil, failure) }
                self.finish(["name": photo.name, "type": photo.type, "lastModified": photo.lastModified, "data": photo.data], nil)
            }
        }
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        finish(NSNull(), nil)
    }

    nonisolated static func read(_ url: URL, name: String?) -> Photo? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        let ext = url.pathExtension.isEmpty ? "jpg" : url.pathExtension
        let mime = UTType(filenameExtension: ext)?.preferredMIMEType ?? "image/jpeg"
        let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? Date()
        let base = name.flatMap { $0.isEmpty ? nil : $0 } ?? url.deletingPathExtension().lastPathComponent
        return Photo(name: base + "." + ext, type: mime, lastModified: (modified.timeIntervalSince1970 * 1000).rounded(),
                     data: data.base64EncodedString())
    }

    /// The lock dismissed every sheet (Shell.didEnterBackground), which tells
    /// no delegate: the page gets a cancel and the next Gallery is not "busy".
    static func drop() {
        active?.finish(NSNull(), nil)
    }

    /// Replies once and frees the slot.
    private func finish(_ value: Any?, _ error: String?) {
        guard Self.active === self else { return }
        Self.active = nil
        reply(value, error)
    }
}
