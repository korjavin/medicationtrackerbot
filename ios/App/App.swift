import SwiftUI
import UIKit
import WebKit

// Shell: one WKWebView on the account origin (bd med-w6gx.9). The overlay
// button + panel are the GO/NO-GO spike diagnostic (bd med-w6gx.2, Spike.swift);
// the shell bead (med-w6gx.3) drops them.
@main
struct WGApp: App {
    @StateObject private var spike = Spike()

    var body: some Scene {
        WindowGroup {
            WebView(spike: spike)
                .ignoresSafeArea()
                .overlay(alignment: .trailing) {
                    Button { spike.showPanel = true } label: {
                        Image(systemName: "stethoscope")
                            .padding(10)
                            .background(.ultraThinMaterial, in: Circle())
                    }
                    .padding(.trailing, 6)
                    .accessibilityLabel("Spike diagnostics")
                }
                .sheet(isPresented: $spike.showPanel) { SpikePanel(spike: spike) }
        }
    }
}

struct WebView: UIViewRepresentable {
    let spike: Spike
    func makeUIView(context: Context) -> WKWebView { spike.webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

struct SpikePanel: View {
    @ObservedObject var spike: Spike
    @State private var url = ""

    var body: some View {
        NavigationStack {
            List {
                Section("Open URL (claim link or account URL)") {
                    TextField("https://", text: $url)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Open") { spike.open(url); url = "" }
                }
                Section("Checks (run on the page currently loaded)") {
                    Button("Run checks: bridge, SW, IndexedDB, camera") { spike.runChecks() }
                    Button("Passkey create + PRF (throwaway passkey)") { spike.passkeyCreate() }
                    Button("Passkey get + PRF") { spike.passkeyGet() }
                    Button("Reset web data (forces a cold unlock)", role: .destructive) { spike.resetWebData() }
                }
                Section("Report (host names redacted)") {
                    Button("Copy report") { UIPasteboard.general.string = spike.report }
                    Button("Clear report", role: .destructive) { spike.lines = [] }
                    Text(spike.report)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                }
            }
            .navigationTitle("iOS spike")
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
        guard let formatter else { return }
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
