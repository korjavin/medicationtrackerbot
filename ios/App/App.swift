import AVFoundation
import SwiftUI
import UIKit
import VisionKit
import WebKit

// The iOS shell (bd med-w6gx.3): first-run → the account origin in one
// WKWebView (Shell.swift). docs/ios.md.
@main
struct WGApp: App {
    @StateObject private var shell = Shell()

    init() {
        Notifications.shared.install() // before launch finishes: a tap that started the app is delivered
    }

    var body: some Scene {
        WindowGroup { RootView(shell: shell) }
    }
}

struct RootView: View {
    @ObservedObject var shell: Shell
    @Environment(\.scenePhase) private var phase
    /// Local-mode diagnostic (bd med-o7zq.1): exists only while its Settings toggle is on.
    @State private var spike: LocalSpike?

    var body: some View {
        Group {
            if let spike {
                LocalSpikeView(spike: spike) {
                    UserDefaults.standard.set(false, forKey: LocalSpike.toggleKey)
                    spike.stop()
                    self.spike = nil
                }
            } else if shell.host == nil && !shell.local {
                FirstRunView(shell: shell)
            } else if shell.concealed {
                // The web view leaves the window: its page goes hidden, so no
                // visibility-triggered work (Health import, reminders) runs.
                LockView(shell: shell)
            } else {
                WebView(webView: shell.webView)
                    .ignoresSafeArea(.keyboard) // WKWebView handles the keyboard itself
                    .background {
                        // The safe-area bands, in the page's own top/bottom colours.
                        VStack(spacing: 0) { shell.top; shell.bottom }.ignoresSafeArea()
                    }
                    .overlay {
                        if let error = shell.loadError { LoadErrorView(shell: shell, message: error) }
                    }
            }
        }
        .overlay {
            // Before the app-switcher snapshot (taken after inactive): no data in it.
            if phase != .active && shell.local && shell.lock.on {
                Color(uiColor: Shell.screen).ignoresSafeArea()
            }
        }
        .onChange(of: phase) { _, now in
            if now == .active {
                shell.applySettings()
                shell.didBecomeActive()
                openSpikeIfRequested()
            } else if now == .background {
                shell.didEnterBackground()
            }
        }
        .onAppear {
            if phase == .active { shell.didBecomeActive() } // the lock prompts once either way
            openSpikeIfRequested()
        }
    }

    private func openSpikeIfRequested() {
        guard spike == nil, LocalSpike.requested else { return }
        let s = LocalSpike()
        s.start()
        spike = s
    }
}

struct WebView: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

/// Invite-only: no signup here. The user brings an invite/claim link, the
/// account address, or the Emergency Kit QR.
struct FirstRunView: View {
    @ObservedObject var shell: Shell
    @State private var text = ""
    @State private var error: String?
    @State private var scanning = false
    /// "Only on this device" tapped: the local intro replaces this screen until Back.
    @State private var localIntro = false

    var body: some View {
        if localIntro {
            LocalIntroView(shell: shell) { localIntro = false }
        } else {
            invite
        }
    }

    private var invite: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Med Tracker").font(.largeTitle.bold())
            Text("Open your account with your invite link, your account address, or the QR code on your Emergency Kit. Accounts are by invitation only.")
                .foregroundStyle(.secondary)
            TextField("Invite link or account address", text: $text)
                .keyboardType(.URL)
                .textContentType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .onSubmit { submit(text) }
                .padding(12)
                .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
            if let error {
                Text(error).font(.callout).foregroundStyle(.orange)
            }
            Button("Continue") { submit(text) }
                .buttonStyle(.borderedProminent)
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            if DataScannerViewController.isSupported {
                Button { scan() } label: { Label("Scan QR code", systemImage: "qrcode.viewfinder") }
                    .buttonStyle(.bordered)
            }
            // Local mode (bd med-o7zq.5): secondary to the invite, no account at all.
            VStack(alignment: .leading, spacing: 6) {
                Text("No invite? Use Med Tracker without an account.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Button("Only on this device") { localIntro = true }
                    .buttonStyle(.bordered)
            }
            .padding(.top, 8)
            Spacer()
            // App Store packaging (bd med-w6gx.8): same wording as the store description.
            Text("Med Tracker is a personal log, not a medical device, and does not give medical advice. Talk to your doctor before changing a treatment.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Link("Privacy policy", destination: URL(string: "https://github.com/korjavin/medicationtrackerbot/blob/master/docs/privacy-policy.md")!)
                .font(.footnote)
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: Shell.screen).ignoresSafeArea())
        .preferredColorScheme(.dark)
        .sheet(isPresented: $scanning) {
            QRScanner { payload in
                scanning = false
                // Straight to submit, never into the text field: a kit QR carries the recovery code.
                submit(payload)
            }
            .ignoresSafeArea()
        }
    }

    private func submit(_ raw: String) {
        error = shell.open(raw)
    }

    private func scan() {
        Task {
            if await AVCaptureDevice.requestAccess(for: .video) {
                scanning = true
            } else {
                error = "Allow camera access for Med Tracker in Settings to scan a QR code."
            }
        }
    }
}

/// Local mode's onboarding (bd med-o7zq.5): what "only on this device" means
/// for the user's data, before the choice is stored. Honest on purpose — this
/// can be someone's only medication history.
struct LocalIntroView: View {
    @ObservedObject var shell: Shell
    let back: () -> Void
    @State private var lock = false
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Only on this device").font(.largeTitle.bold())
                Label("No account and no sign-in. Your records are stored only on this iPhone, and nothing is sent to our servers.",
                      systemImage: "iphone")
                Label("They are included in this iPhone's own backup (iCloud or your computer). Med Tracker keeps no other copy and cannot recover them for you.",
                      systemImage: "externaldrive")
                Label("Deleting the app, or losing or resetting the iPhone without a backup, deletes them for good. Export a backup file regularly in Settings → Backup & import.",
                      systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
                Label("AI and food search work only with providers you add with your own key. Voice, Telegram and the shared food database need an account.",
                      systemImage: "key")
                // Optional lock (bd med-o7zq.8); also iPhone Settings → Med Tracker → Lock.
                if DeviceAuth.available {
                    Toggle("Lock with \(DeviceAuth.method)", isOn: $lock)
                    Text("Asks for \(DeviceAuth.method) or your passcode each time you open Med Tracker. It hides the app; it does not encrypt your records, and reminders on the Lock Screen still show.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if let error {
                    Text(error).font(.callout).foregroundStyle(.orange)
                }
                Button("Start") { start() }
                    .buttonStyle(.borderedProminent)
                    .padding(.top, 8)
                Button("Back", action: back)
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color(uiColor: Shell.screen).ignoresSafeArea())
        .preferredColorScheme(.dark)
        .onAppear { lock = shell.lock.on } // still on from an earlier stay in local mode
    }

    private func start() {
        Task {
            if await shell.setLock(lock) {
                error = nil
                shell.openLocal()
            } else {
                error = lock
                    ? "The lock was not turned on. Try again, or switch it off to continue without it."
                    : "The lock is still on. Try again, or switch it on to continue with it."
            }
        }
    }
}

/// Local mode's lock screen (bd med-o7zq.8). A cancelled prompt lands here and
/// stays: only the button asks again.
struct LockView: View {
    @ObservedObject var shell: Shell

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "lock.fill").font(.largeTitle)
            Text("Med Tracker is locked").font(.title2.bold())
            Text("Unlock with \(DeviceAuth.method) to see your records.")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Unlock") { shell.unlock() }
                .buttonStyle(.borderedProminent)
                .disabled(shell.lock.state == .unlocking)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: Shell.screen).ignoresSafeArea())
        .preferredColorScheme(.dark)
    }
}

struct LoadErrorView: View {
    @ObservedObject var shell: Shell
    let message: String

    var body: some View {
        VStack(spacing: 16) {
            Text(shell.local ? "Can't open Med Tracker" : "Can't open your account").font(.title2.bold())
            Text(message).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Button("Try again") { shell.retry() }.buttonStyle(.borderedProminent)
            // Leaving local mode keeps its data: it is back on the next switch.
            Button(shell.local ? "Use an account instead" : "Switch account") { shell.forget() }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: Shell.screen).ignoresSafeArea())
        .preferredColorScheme(.dark)
    }
}

/// Reads one QR code with VisionKit and hands back its text.
struct QRScanner: UIViewControllerRepresentable {
    let found: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        if !scanner.isScanning { try? scanner.startScanning() }
    }

    func makeCoordinator() -> Coordinator { Coordinator(found: found) }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let found: (String) -> Void
        private var done = false
        init(found: @escaping (String) -> Void) { self.found = found }

        func dataScanner(_ scanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            for case .barcode(let code) in addedItems {
                guard !done, let text = code.payloadStringValue else { continue }
                done = true
                scanner.stopScanning()
                found(text)
            }
        }
    }
}

/// Web downloads and printing for the shell (bd med-w6gx.11). WKWebView drops
/// both unless the app handles them. Downloads (blob:/data: `<a download>`,
/// `Content-Disposition: attachment`, types it cannot show) land in a temp file
/// offered through the share sheet (Save to Files), deleted once the sheet
/// closes. `window.print()`, including the offscreen-iframe print in
/// web/cloud/js/print-doc.js, goes to UIPrintInteractionController.
/// The web view's navigation delegate forwards the policy and didBecome calls here.
@MainActor
final class Downloads: NSObject, WKDownloadDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    static let shared = Downloads()
    private var destinations: [WKDownload: URL] = [:]
    private var printView: WKWebView? // retained until its document finished loading and printed
    /// Shell's lock holds (bd med-o7zq.8): nothing the hidden page finishes may show over it.
    var held: @MainActor () -> Bool = { false }

    /// All downloads live here; swept at launch for any file a killed app left behind.
    private let root = FileManager.default.temporaryDirectory.appendingPathComponent("wg-downloads", isDirectory: true)

    func install(on config: WKWebViewConfiguration) {
        try? FileManager.default.removeItem(at: root)
        config.userContentController.add(self, contentWorld: .page, name: "wgPrint")
        config.userContentController.addUserScript(
            WKUserScript(source: Downloads.printShim, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
    }

    static func policy(for action: WKNavigationAction) -> WKNavigationActionPolicy {
        action.shouldPerformDownload ? .download : .allow
    }

    static func policy(for response: WKNavigationResponse) -> WKNavigationResponsePolicy {
        let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        let attachment = disposition.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("attachment")
        return attachment || !response.canShowMIMEType ? .download : .allow
    }

    // MARK: WKDownloadDelegate

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String) async -> URL? {
        // Own directory per download: the destination must not exist yet, and
        // the file keeps the page's filename in the share sheet.
        let dir = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            return nil
        }
        let name = (suggestedFilename as NSString).lastPathComponent
        let url = dir.appendingPathComponent(name.isEmpty ? "download" : name)
        destinations[download] = url
        return url
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let url = destinations.removeValue(forKey: download) else { return }
        if held() {
            try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
            return
        }
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        sheet.completionWithItemsHandler = { _, _, _, _ in
            // The file can hold a recovery code or a full vault export: delete it now,
            // not when iOS purges tmp (a kill mid-sheet is swept at next launch).
            try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
        }
        guard let top = Downloads.topViewController() else {
            try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
            return
        }
        sheet.popoverPresentationController?.sourceView = top.view
        top.present(sheet, animated: true)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let url = destinations.removeValue(forKey: download) {
            try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
        }
    }

    // MARK: print

    /// Body is the frame document's HTML for an iframe print, null for the page itself.
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let html = message.body as? String else {
            present(message.webView?.viewPrintFormatter())
            return
        }
        // The iframe's document rendered in its own offscreen view: no app CSP,
        // so its inline <style> applies, and nothing of the app chrome prints.
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 612, height: 792))
        view.navigationDelegate = self
        printView = view
        view.loadHTMLString("<!doctype html>" + html, baseURL: nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        present(webView.viewPrintFormatter())
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        printView = nil
    }

    private func present(_ formatter: UIPrintFormatter?) {
        guard let formatter, !held() else {
            printView = nil
            return
        }
        let controller = UIPrintInteractionController.shared
        controller.printFormatter = formatter
        controller.present(animated: true) { [weak self] _, _, _ in
            Task { @MainActor in self?.printView = nil }
        }
    }

    private static func topViewController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes.first { $0.activationState == .foregroundActive } as? UIWindowScene
        var top = scene?.keyWindow?.rootViewController
        while let next = top?.presentedViewController { top = next }
        return top
    }

    /// Routes window.print() to the app. print-doc.js prints an offscreen
    /// same-origin iframe through `frame.contentWindow.print()`, so the
    /// contentWindow getter patches that frame's print on the way out. A
    /// cross-origin frame throws on the assignment and keeps its own print.
    static let printShim = #"""
    (() => {
      const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.wgPrint;
      if (!h) return;
      window.print = () => h.postMessage(null);
      const d = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
      if (!d || !d.get) return;
      Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
        configurable: true,
        enumerable: d.enumerable,
        get() {
          const w = d.get.call(this);
          try {
            if (w && !w.__wgPrint) {
              w.print = () => h.postMessage(w.document.documentElement.outerHTML);
              w.__wgPrint = true;
            }
          } catch (_) {}
          return w;
        },
      });
    })();
    """#
}
