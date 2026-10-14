import CryptoKit
import SwiftUI
import UIKit
import WebKit

// GO/NO-GO spike diagnostic (bd med-w6gx.2). Throwaway: the shell bead
// (med-w6gx.3) deletes this file. Lives only in the iOS app — nothing here is
// served to the web. The procedure and criteria are in docs/ios.md.
//
// Records, for docs/ios.md: passkey create/get + PRF (both the app's real
// ceremonies via a passive tap and a throwaway probe credential), Service
// Worker state, IndexedDB + non-extractable CryptoKey persistence across app
// kills, getUserMedia, and a JS->Swift reply round trip. Never records PRF
// output bytes, only whether they came back.
@MainActor
final class Spike: NSObject, ObservableObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate {
    @Published var showPanel = false
    @Published var lines: [String] = UserDefaults.standard.stringArray(forKey: "wgSpikeLog") ?? [] {
        didSet { UserDefaults.standard.set(Array(lines.suffix(400)), forKey: "wgSpikeLog") }
    }

    /// Fresh per process: an IndexedDB marker from another launchId proves the
    /// data survived an app kill.
    let launchId = UUID().uuidString
    private let startURL = URL(string: Bundle.main.object(forInfoDictionaryKey: "WGStartURL") as? String ?? "")
    private var baseDomain: String { startURL?.host ?? "" }
    private var credId = ""

    lazy var webView: WKWebView = makeWebView()

    private func makeWebView() -> WKWebView {
        let config = WKWebViewConfiguration()
        // Service Workers in WKWebView need the page on a WKAppBoundDomains
        // entry (Info.plist, from project.yml) with navigation limited to them.
        config.limitsNavigationsToAppBoundDomains = true
        config.allowsInlineMediaPlayback = true // barcode/photo preview stays inline
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "wgSpike")
        config.userContentController.addUserScript(
            WKUserScript(source: Spike.webauthnTap, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        Downloads.shared.install(on: config) // shell code (App.swift); the shell bead keeps it
        let view = WKWebView(frame: .zero, configuration: config)
        view.isInspectable = true // Safari Web Inspector from a Mac, for spike debugging only
        view.navigationDelegate = self

        let device = UIDevice.current
        let info = Bundle.main.infoDictionary ?? [:]
        log("launch \(launchId.prefix(8)) iOS \(device.systemVersion) \(device.model) build \(info["CFBundleShortVersionString"] ?? "?")(\(info["CFBundleVersion"] ?? "?"))")

        // Relaunch where the user was, so kill/relaunch tests the account origin.
        let last = UserDefaults.standard.string(forKey: "wgSpikeLastURL").flatMap(URL.init(string:))
        if let url = last ?? startURL, url.scheme == "https" {
            view.load(URLRequest(url: url))
        } else {
            view.loadHTMLString("<h1>Start URL not configured</h1>", baseURL: nil)
        }
        return view
    }

    // MARK: panel actions

    func open(_ raw: String) {
        guard let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)), url.scheme == "https" else {
            log("open: not an https URL")
            return
        }
        showPanel = false
        webView.load(URLRequest(url: url))
    }

    func runChecks() { run("checks", Spike.checksJS, ["launchId": launchId]) }
    func passkeyCreate() { run("passkey.create", Spike.passkeyCreateJS) }
    func passkeyGet() { run("passkey.get", Spike.passkeyGetJS, ["credId": credId]) }

    func resetWebData() {
        let store = WKWebsiteDataStore.default()
        store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) { [weak self] in
            Task { @MainActor in
                self?.log("web data reset (IndexedDB, SW, caches, cookies)")
                self?.webView.reload()
            }
        }
    }

    /// Closes the panel first so system sheets (passkey, camera permission)
    /// present over the web view, then reopens it with the result.
    private func run(_ name: String, _ body: String, _ args: [String: Any] = [:]) {
        showPanel = false
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(700))
            let host = webView.url?.host ?? "?"
            do {
                let value = try await webView.callAsyncJavaScript(body, arguments: args, contentWorld: .page)
                let text = value as? String ?? String(describing: value)
                if name == "passkey.create", let id = Spike.field(text, "credId") { credId = id }
                log("\(name) on \(host):\n\(text)")
            } catch {
                log("\(name) on \(host): FAILED \(Spike.describe(error))")
            }
            showPanel = true
        }
    }

    // MARK: report

    /// Redacts before storing, so the persisted log (wgSpikeLog) never holds
    /// a raw deployment or account host name.
    func log(_ s: String) {
        lines.append("[\(Date().formatted(date: .omitted, time: .standard))] \(redact(s))")
    }

    var report: String { lines.joined(separator: "\n") }

    /// Replaces the base domain with <base> and each account label with
    /// <sub-xxxxxx> (a short SHA-256 of the label: stable across launches so
    /// two accounts stay distinguishable, with no raw label kept anywhere).
    private func redact(_ s: String) -> String {
        guard !baseDomain.isEmpty else { return s }
        var text = s
        let escaped = NSRegularExpression.escapedPattern(for: baseDomain)
        if let re = try? NSRegularExpression(pattern: "([A-Za-z0-9-]+)\\.\(escaped)") {
            let ns = text as NSString
            // Back to front so earlier ranges stay valid while replacing.
            for m in re.matches(in: text, range: NSRange(location: 0, length: ns.length)).reversed() {
                let label = (text as NSString).substring(with: m.range(at: 1))
                let tag = SHA256.hash(data: Data(label.utf8)).prefix(3).map { String(format: "%02x", $0) }.joined()
                text = (text as NSString).replacingCharacters(in: m.range(at: 1), with: "<sub-\(tag)>")
            }
        }
        return text.replacingOccurrences(of: baseDomain, with: "<base>")
    }

    private static func describe(_ error: Error) -> String {
        let e = error as NSError
        return "\(e.domain) \(e.code): \(e.localizedDescription)"
    }

    private static func field(_ json: String, _ key: String) -> String? {
        guard let data = json.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return obj[key] as? String
    }

    // MARK: WKScriptMessageHandlerWithReply

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let body = message.body as? [String: Any] ?? [:]
        switch body["op"] as? String {
        case "ping":
            replyHandler(["pong": true, "launchId": launchId], nil)
        case "log":
            let data = (try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])) ?? Data()
            log("tap \(String(decoding: data, as: UTF8.self))")
            replyHandler(nil, nil)
        default:
            replyHandler(nil, "unknown op")
        }
    }

    // MARK: WKNavigationDelegate

    // Downloads (bd med-w6gx.11): the shell bead moves these four forwards to its own delegate.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        Downloads.policy(for: navigationAction)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        Downloads.policy(for: navigationResponse)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = Downloads.shared
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = Downloads.shared
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let url = webView.url, var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return }
        parts.fragment = nil // never keep or log a #claim= token
        parts.query = nil
        let clean = parts.url?.absoluteString ?? ""
        log("loaded \(clean)")
        if let host = url.host, !baseDomain.isEmpty, host == baseDomain || host.hasSuffix("." + baseDomain) {
            // Unredacted on purpose: the relaunch needs the real origin, and it stays in
            // the app's own sandbox (the PWA keeps its origin too). Fragment/query stripped above.
            UserDefaults.standard.set(clean, forKey: "wgSpikeLastURL")
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        log("navigation failed: \(Spike.describe(error))")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        log("load failed: \(Spike.describe(error))")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        log("web content process terminated; reloading")
        webView.reload()
    }

    // MARK: page scripts (run in the page world on the account origin)

    /// Passive wrapper around the app's own WebAuthn calls: passes every call
    /// through unchanged and reports whether PRF results came back.
    static let webauthnTap = #"""
    (() => {
      const c = navigator.credentials;
      const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.wgSpike;
      if (!c || !h) return;
      const post = (m) => { try { h.postMessage(Object.assign({ op: 'log' }, m)); } catch (_) {} };
      for (const op of ['create', 'get']) {
        const orig = c[op].bind(c);
        c[op] = async (opts) => {
          const ev = { event: 'webauthn.' + op, host: location.host, publicKey: !!(opts && opts.publicKey),
                       wantsPrf: !!(opts && opts.publicKey && opts.publicKey.extensions && opts.publicKey.extensions.prf) };
          try {
            const cred = await orig(opts);
            let prf = null;
            try { prf = cred && cred.getClientExtensionResults ? cred.getClientExtensionResults().prf || null : null; } catch (_) {}
            post(Object.assign(ev, { ok: !!cred, prfEnabled: prf ? (prf.enabled === undefined ? null : prf.enabled) : null,
                                     prfFirst: !!(prf && prf.results && prf.results.first) }));
            return cred;
          } catch (e) {
            post(Object.assign(ev, { ok: false, error: String(e && e.name) + ': ' + String(e && e.message) }));
            throw e;
          }
        };
      }
    })();
    """#

    static let checksJS = #"""
    const out = {};
    const t = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = { error: String(e && e.name) + ': ' + String(e && e.message) }; } };
    await t('context', async () => ({ origin: location.origin, secureContext: isSecureContext, online: navigator.onLine, ua: navigator.userAgent }));
    await t('bridge', async () => {
      const t0 = performance.now();
      const reply = await window.webkit.messageHandlers.wgSpike.postMessage({ op: 'ping' });
      return { reply, rttMs: Math.round(performance.now() - t0) };
    });
    await t('serviceWorker', async () => {
      if (!('serviceWorker' in navigator)) return { supported: false };
      const regs = await navigator.serviceWorker.getRegistrations();
      return { supported: true, controlled: !!navigator.serviceWorker.controller,
               registrations: regs.map((r) => ({ scope: r.scope, active: r.active ? r.active.state : null })),
               cacheNames: self.caches ? (await caches.keys()).length : null };
    });
    await t('storage', async () => ({
      persisted: navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null,
      databases: indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : null }));
    await t('idb', async () => {
      // Own database: never touches the app's Dexie data.
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('wg-ios-spike', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const tx = (mode, fn) => new Promise((res, rej) => {
        const x = db.transaction('kv', mode);
        const req = fn(x.objectStore('kv'));
        x.oncomplete = () => res(req.result);
        x.onerror = () => rej(x.error);
      });
      const previous = (await tx('readonly', (s) => s.get('marker'))) || null;
      let key = await tx('readonly', (s) => s.get('key'));
      const keyFromEarlierRun = !!key;
      if (!key) {
        // Same shape as the warm-unlock cache: a non-extractable CryptoKey structured-cloned into IDB.
        key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        await tx('readwrite', (s) => s.put(key, 'key'));
      }
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('spike'));
      const back = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
      await tx('readwrite', (s) => s.put({ launchId, at: new Date().toISOString() }, 'marker'));
      db.close();
      return { previousMarker: previous, markerFromEarlierLaunch: !!previous && previous.launchId !== launchId,
               keyFromEarlierRun, keyExtractable: key.extractable, keyUsable: back === 'spike' };
    });
    await t('camera', async () => {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const videoTracks = s.getVideoTracks().length;
      s.getTracks().forEach((x) => x.stop());
      return { videoTracks, barcodeDetector: 'BarcodeDetector' in window };
    });
    return JSON.stringify(out, null, 1);
    """#

    static let passkeyCreateJS = #"""
    try {
      const cred = await navigator.credentials.create({ publicKey: {
        rp: { id: location.hostname, name: 'iOS spike' },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'ios-spike', displayName: 'iOS spike - delete me' },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        extensions: { prf: { eval: { first: new Uint8Array(32).fill(7) } } } } });
      const prf = cred.getClientExtensionResults().prf || null;
      return JSON.stringify({ ok: true, credId: btoa(String.fromCharCode(...new Uint8Array(cred.rawId))),
        attachment: cred.authenticatorAttachment, prfEnabled: prf ? prf.enabled : null,
        prfFirstBytes: prf && prf.results && prf.results.first ? prf.results.first.byteLength : 0 });
    } catch (e) {
      return JSON.stringify({ ok: false, error: String(e && e.name) + ': ' + String(e && e.message) });
    }
    """#

    /// With credId (from a create in this launch) asks for that credential;
    /// without it, a discoverable get the user picks a passkey for.
    static let passkeyGetJS = #"""
    try {
      const allow = credId ? [{ type: 'public-key', id: Uint8Array.from(atob(credId), (c) => c.charCodeAt(0)) }] : [];
      const a = await navigator.credentials.get({ publicKey: {
        rpId: location.hostname, challenge: crypto.getRandomValues(new Uint8Array(32)),
        userVerification: 'required', allowCredentials: allow,
        extensions: { prf: { eval: { first: new Uint8Array(32).fill(7) } } } } });
      const prf = a.getClientExtensionResults().prf || null;
      return JSON.stringify({ ok: true, usedCreatedCredential: !!credId,
        prfFirstBytes: prf && prf.results && prf.results.first ? prf.results.first.byteLength : 0 });
    } catch (e) {
      return JSON.stringify({ ok: false, error: String(e && e.name) + ': ' + String(e && e.message) });
    }
    """#
}
