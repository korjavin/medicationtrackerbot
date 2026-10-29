import SwiftUI
import UIKit
import WebKit

// The iOS shell (bd med-w6gx.3): local mode or the account origin in one
// WKWebView (Shell.swift); no native first run (bd med-ta2n.17). docs/ios.md.
@main
struct WGApp: App {
    @UIApplicationDelegateAdaptor(QuickAction.self) private var quickAction
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
    /// N6 (bd med-ckm5.15): the launch screen's mark, kept over the first page until it is ready.
    @State private var launchMark = true

    var body: some View {
        Group {
            if let spike {
                LocalSpikeView(spike: spike) {
                    UserDefaults.standard.set(false, forKey: LocalSpike.toggleKey)
                    spike.stop()
                    self.spike = nil
                }
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
                        if let error = shell.loadError { LoadErrorView(shell: shell, error: error) }
                    }
            }
        }
        .overlay {
            // Before the app-switcher snapshot (taken after inactive): no data
            // in it, the teal and the mark (N3). Not under the lock's own
            // prompt: the lock screen shows there, dimmed.
            if launchMark || (phase != .active && shell.local && shell.lock.on && shell.lock.state != .unlocking) {
                LaunchCover()
            }
        }
        .onChange(of: launchDone, initial: true) { _, done in
            if done { withAnimation(.easeOut(duration: 0.18)) { launchMark = false } }
        }
        // Invite links (bd med-ta2n.11): the landing universal link and the
        // medtracker:// scheme both arrive here, cold or warm.
        .onOpenURL { shell.capture($0) }
        .alert("Diagnostics copied", isPresented: $shell.diagCopied) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Paste them into your message to support.")
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

    /// The launch mark's job is done: the page is ready, or a native screen
    /// (lock, error) shows instead. `-wgQAHoldMark YES` (Debug) keeps it.
    private var launchDone: Bool {
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "wgQAHoldMark") { return false }
        #endif
        return shell.painted || shell.concealed || spike != nil
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

/// The launch screen as a view (N6): the teal and the centred mark. Also the
/// app-switcher cover while locked (N3).
struct LaunchCover: View {
    var body: some View {
        WgLaunchMark()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Wg.screen)
            .ignoresSafeArea()
            .allowsHitTesting(false)
    }
}

/// N3 app lock (bd med-o7zq.8, med-ckm5.15): local mode's lock screen. The
/// mark sits where the launch screen has it, so launch → lock is a
/// cross-fade; never the account name. A cancelled prompt lands here and
/// stays: only the button asks again. A failed one adds the warn note.
struct LockView: View {
    @ObservedObject var shell: Shell

    var body: some View {
        ZStack(alignment: Alignment(horizontal: .center, vertical: .markCenter)) {
            Color.clear
            VStack(spacing: 16) {
                WgLaunchMark().alignmentGuide(.markCenter) { $0[VerticalAlignment.center] }
                Text("Med Tracker is locked")
                    .font(Wg.mono(22)).tracking(-0.44).foregroundStyle(Wg.fg1)
                Text(DeviceAuth.method == "passcode" ? "Unlock with your passcode." : "Unlock with \(DeviceAuth.method) or your passcode.")
                    .font(Wg.ui(16)).foregroundStyle(Wg.fg2)
                if shell.lock.failed {
                    WgNote(tone: .warn, icon: "exclamationmark.triangle",
                           text: Text("Not recognised. Try again, or use your passcode."))
                        .multilineTextAlignment(.leading)
                }
            }
            .multilineTextAlignment(.center)
            .padding(.horizontal, Wg.gutter)
        }
        .ignoresSafeArea()
        .safeAreaInset(edge: .bottom, spacing: 0) {
            WgShellFoot {
                Button { shell.unlock() } label: {
                    Label("Unlock", systemImage: DeviceAuth.method == "Face ID" ? "faceid" : DeviceAuth.method == "Touch ID" ? "touchid" : "lock")
                }
                .buttonStyle(WgPrimaryButtonStyle())
                .disabled(shell.lock.state == .unlocking)
            }
        }
        .overlay {
            // Under the system prompt (N3): a cancel lands on a screen that still makes sense.
            if shell.lock.state == .unlocking { Color.black.opacity(0.5).ignoresSafeArea() }
        }
        .background(Wg.screen.ignoresSafeArea())
        .preferredColorScheme(.dark)
    }
}

/// N4 load error (bd med-ckm5.15): network/5xx, a bare 404 (warn: trying
/// again can't fix it, so another invite leads), and local mode, which never
/// offers Switch account. The status code is a mono line for support.
struct LoadErrorView: View {
    @ObservedObject var shell: Shell
    let error: LoadError

    var body: some View {
        ViewThatFits(in: .vertical) {
            content
            ScrollView { content.padding(.vertical, 24) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            WgShellFoot {
                // Leaving the account keeps its data; forget() lands on local
                // mode's home?invite=1, where the web opens "Have an invite?" (bd med-ta2n.17).
                switch error.kind {
                case .network:
                    tryAgain
                    secondary("Switch account") { shell.forget() }
                case .notFound:
                    Button("Use another invite") { shell.forget() }.buttonStyle(WgPrimaryButtonStyle())
                    secondary("Try again") { shell.retry() }
                case .local:
                    // The invite entry is the bundled page that failed: nothing else to offer.
                    tryAgain
                }
                Button { shell.copyDiagnostics() } label: {
                    Label("Copy diagnostics", systemImage: "doc.on.doc")
                }
                .buttonStyle(WgGhostButtonStyle(small: true))
            }
        }
        .background(Wg.screen.ignoresSafeArea())
        .preferredColorScheme(.dark)
    }

    private var content: some View {
        VStack(spacing: 16) {
            let warn = error.kind == .notFound
            Image(systemName: icon)
                .font(.system(size: 28))
                .foregroundStyle(warn ? Wg.warnFg : Wg.fg2)
                .frame(width: 64, height: 64)
                .background(warn ? Wg.warnBg : Wg.fg1.opacity(0.05), in: RoundedRectangle(cornerRadius: 18))
                .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(warn ? Wg.warnLine : Wg.fg1.opacity(0.24)))
                .accessibilityHidden(true)
            Text(title).font(Wg.mono(22)).tracking(-0.44).foregroundStyle(Wg.fg1)
            Text(lede).font(Wg.ui(16)).foregroundStyle(Wg.fg2).frame(maxWidth: 320)
            Text(error.meta).font(Wg.mono(12)).foregroundStyle(Wg.fg3)
        }
        .multilineTextAlignment(.center)
        .padding(.horizontal, Wg.gutter)
        .frame(maxWidth: .infinity)
    }

    private var host: String { shell.host ?? "your account" }

    private var icon: String {
        switch error.kind {
        case .network: "icloud.slash"
        case .notFound: "magnifyingglass"
        case .local: "iphone"
        }
    }

    private var title: String {
        switch error.kind {
        case .network: "Can't reach your account"
        case .notFound: "We can't find this account"
        case .local: "Can't open Med Tracker"
        }
    }

    private var lede: String {
        switch error.kind {
        case .network: "Med Tracker couldn't connect to \(host). Your records are safe. Check your connection and try again."
        case .notFound: "There's no account at \(host) any more. It may have been deleted, or the address changed."
        case .local: "The app on this iPhone didn't start. Your records are still here. Try again, or restart your iPhone if it keeps happening."
        }
    }

    private var tryAgain: some View {
        Button { shell.retry() } label: { Label("Try again", systemImage: "arrow.clockwise") }
            .buttonStyle(WgPrimaryButtonStyle())
    }

    private func secondary(_ title: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) { Text(title).frame(maxWidth: .infinity) }.buttonStyle(WgButtonStyle())
    }
}

/// The Home Screen quick action "Copy diagnostics" (bd med-w6gx.24, twin of
/// Android's launcher shortcut; UIApplicationShortcutItems in project.yml):
/// a cold launch hands it to the scene configuration, a running app to the
/// scene delegate. Also the app delegate's remote-notification calls (native push).
@MainActor
final class QuickAction: NSObject, UIApplicationDelegate, UIWindowSceneDelegate {
    static let copyType = "copy-diagnostics"

    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        if options.shortcutItem?.type == QuickAction.copyType { QuickAction.copyDiagnostics() }
        let config = UISceneConfiguration(name: nil, sessionRole: session.role)
        config.delegateClass = QuickAction.self
        return config
    }

    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem,
                     completionHandler: @escaping (Bool) -> Void) {
        let mine = shortcutItem.type == QuickAction.copyType
        if mine { QuickAction.copyDiagnostics() }
        completionHandler(mine)
    }

    private static func copyDiagnostics() {
        if let shell = Shell.current { shell.copyDiagnostics() } else { Shell.copyOnLaunch = true }
    }

    // MARK: native push (bd med-erq1.4, Push.swift) — the app delegate's share

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Shell.current?.pushRegistered(Push.hex(deviceToken))
    }

    /// No aps-environment entitlement (a profile without Push), the Simulator, no network.
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        let e = error as NSError
        Shell.current?.diag("shell push register failed \(e.domain) \(e.code)")
    }

    /// content-available (UIBackgroundModes remote-notification). In front,
    /// willPresent (Notifications.swift) owns the wake. In the background the
    /// system already showed the alert, the fallback: a live unlocked page gets
    /// the wake and a grace to drain; otherwise this completes at once.
    /// The drain (an OpenAI tool loop) often outlives the grace, so a taken
    /// wake also holds a background task that keeps the page running past the
    /// completion (bd med-snua). The page does not report its drain's end, so
    /// the task ends at iOS's expiration, completing the fetch if still owed.
    /// Completion-handler variant, not async: see Notifications.swift (bd med-w6gx.19).
    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        guard application.applicationState != .active, let kind = userInfo["kind"] as? String, let shell = Shell.current else {
            return completionHandler(.noData)
        }
        shell.pushEvent(kind) { took in
            guard took else { return completionHandler(.noData) }
            let wake = Wake(completionHandler)
            wake.task = application.beginBackgroundTask(withName: "wg-push-drain") { wake.expire(application) }
            DispatchQueue.main.asyncAfter(deadline: .now() + Push.grace) { wake.complete() }
        }
    }

    /// One taken wake: its fetch completion runs once, and its background
    /// task ends once, at expiration. A class, so both handlers share it.
    private final class Wake {
        var task = UIBackgroundTaskIdentifier.invalid
        private var completion: ((UIBackgroundFetchResult) -> Void)?
        init(_ completion: @escaping (UIBackgroundFetchResult) -> Void) { self.completion = completion }

        func complete() {
            completion?(.newData)
            completion = nil
        }

        func expire(_ application: UIApplication) {
            complete()
            guard task != .invalid else { return }
            application.endBackgroundTask(task)
            task = .invalid
        }
    }
}

/// Web downloads and printing for the shell (bd med-w6gx.11). WKWebView drops
/// both unless the app handles them. Downloads (blob:/data: `<a download>`,
/// `Content-Disposition: attachment`, types it cannot show) land in a temp file
/// offered through the Files export picker (bd med-o7zq.43; the page owns Share),
/// deleted once the picker closes. `window.print()`, including the offscreen-iframe print in
/// web/cloud/js/print-doc.js, goes to UIPrintInteractionController.
/// The web view's navigation delegate forwards the policy and didBecome calls here.
@MainActor
final class Downloads: NSObject, WKDownloadDelegate, WKScriptMessageHandler, WKNavigationDelegate,
    UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
    static let shared = Downloads()
    private var destinations: [WKDownload: URL] = [:]
    private var exports: [UIDocumentPickerViewController: URL] = [:] // picker → its temp dir
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
        // the file keeps the page's filename in the picker.
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
        guard let top = Downloads.topViewController() else {
            try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
            return
        }
        let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
        picker.delegate = self
        picker.presentationController?.delegate = self // a swipe-down dismissal cleans up too
        exports[picker] = url.deletingLastPathComponent()
        top.present(picker, animated: true)
    }

    // MARK: UIDocumentPickerDelegate

    // The file can hold a recovery code or a full vault export: delete it once the
    // picker closes, not when iOS purges tmp (a kill mid-picker is swept at next launch).
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        close(controller)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        close(controller)
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        if let picker = presentationController.presentedViewController as? UIDocumentPickerViewController { close(picker) }
    }

    private func close(_ picker: UIDocumentPickerViewController) {
        if let dir = exports.removeValue(forKey: picker) { try? FileManager.default.removeItem(at: dir) }
    }

    /// The lock dismissed every sheet (Shell.didEnterBackground), which tells no delegate.
    func dropExports() {
        exports.keys.forEach(close)
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
