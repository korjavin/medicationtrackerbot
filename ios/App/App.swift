import SwiftUI
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
