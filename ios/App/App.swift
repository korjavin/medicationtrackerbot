import SwiftUI
import WebKit

// Skeleton shell (bd med-w6gx.9): one WKWebView on the account origin.
// The spike (med-w6gx.2) and shell (med-w6gx.3) beads extend this.
@main
struct WGApp: App {
    var body: some Scene {
        WindowGroup { WebView().ignoresSafeArea() }
    }
}

struct WebView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView {
        let view = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        // WGStartURL comes from the WG_START_URL build setting (CI fills it
        // from a repo variable so the deployment domain stays out of the tree).
        let raw = Bundle.main.object(forInfoDictionaryKey: "WGStartURL") as? String ?? ""
        if let url = URL(string: raw), url.scheme == "https" {
            view.load(URLRequest(url: url))
        } else {
            view.loadHTMLString("<h1>Start URL not configured</h1>", baseURL: nil)
        }
        return view
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
