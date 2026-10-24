import Foundation

/// Local mode (epic med-o7zq, bd med-o7zq.4): the bundled web app
/// (ios/bundle-web.sh → <bundle>/LocalApp) on its own origin `wgapp://local/`,
/// served by LocalApp.swift. Foundation only, so Tests/main.swift checks it.
enum LocalOrigin {
    /// Must match the "wgapp:" WKAppBoundDomains entry (ios/project.yml): an
    /// app-bound scheme, so the page loads under the shell's app-bound limit
    /// and keeps its script message handlers (spike med-o7zq.1, check 8).
    static let scheme = "wgapp"
    static let host = "local"
    static let home = URL(string: "wgapp://local/")!
    /// Persisted mode choice: true = this device only, no account.
    static let modeKey = "wgLocalMode"
    /// Native mirror of the BYOK provider hosts the page registered
    /// (bridge op setEgressHosts): the CSP is sent before the page can read its own settings.
    static let hostsKey = "wgLocalEgressHosts"
    /// Same caps as cmd/cloud's PUT /api/egress-hosts (internal/cloudserver/egress.go).
    static let maxHosts = 8

    /// Bridge ops only the bundled app may call (Shell.swift `where local`).
    static let localOps = ["setEgressHosts", "local.reset", "local.leave",
                           "attest.status", "attest.enroll", "attest.setPass", "attest.assert",
                           "lock.status", "lock.set", // Settings → App lock (bd med-o7zq.39)
                           "move.stash", // the local → cloud move (bd med-o7zq.35, Move.swift)
                           "leave.take", "leave.clear", // the account → local move (bd med-o7zq.36)
                           "base.post"] // local mode's invite request + attested feedback (BasePost.swift, bd med-ta2n.26)
    /// base.post's paths (contract med-ta2n.24 A2): exact match, no query, no
    /// normalization. Twin of Android LocalOrigin.BASE_POST_PATHS and the page's
    /// BASE_POST_PATHS (local-policy.js); the trial chat/food/voice stay page fetch.
    static let basePostPaths: Set<String> = [
        "/api/attest/challenge", "/api/attest/enroll", "/api/attest/feedback", "/api/invite-requests",
    ]
    /// Bridge ops only an account page may call (Shell.swift `where !local`).
    static let accountOps = ["account.leave", "move.take", "move.clear", "leave.stash",
                             "push.token"] // native push (bd med-erq1.4, Push.swift): never in local mode
    /// Every other op the shell answers, in both modes.
    static let sharedOps = ["ping", "shell.ops", "diag.append", "health.authorize", "health.query",
                            "notifications.permission", "notifications.requestPermission",
                            "notifications.schedule", "notifications.test",
                            "notifications.openSettings", // the denied note's "Open iOS Settings" (bd med-ckm5.15)
                            "invite.pending", "invite.clear", // the pending-invite slot (bd med-ta2n.11, InviteSlot)
                            // "Join and erase" (bd med-r1j2.7, JoinErase): listed in local mode too,
                            // where invite.js probes it before offering the erase; it wipes from the
                            // joined account only (a no-op replying true anywhere else).
                            "local.erase"]

    /// The bridge op shell.ops (bd med-o7zq.35, twin of Android LocalOrigin.ops):
    /// what this shell answers in this mode, for the page's capability probe.
    /// Keep in step with Shell.swift's op switch.
    static func ops(local: Bool) -> [String] {
        (sharedOps + (local ? localOps : accountOps)).sorted()
    }

    #if DEBUG
    /// Visual QA (bd med-y5xx.2, docs/design/ios-visual-testing.md), Debug
    /// builds only: launch argument `-wgQAScene <name>` (NSArgumentDomain)
    /// opens local mode on wgapp://local/?qa=<name> for the in-page QA driver.
    /// The archive is Release, so neither this nor its caller ships.
    static let qaSceneKey = "wgQAScene"

    /// The QA scene's start page, or nil for a missing or malformed name.
    static func qaHome(scene: String?) -> URL? {
        guard let scene, !scene.isEmpty, scene.count <= 64,
              scene.unicodeScalars.allSatisfy({ ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "-" })
        else { return nil }
        return URL(string: "wgapp://local/?qa=\(scene)")
    }
    #endif

    /// Bundle-relative file for a request path, routed like cmd/cloud's
    /// account host (internal/cloudserver/router.go ServeHTTP): "/" is the app
    /// document, /static/ and /domain/ their trees, everything else the cloud
    /// shell tree (/js/…, /css/…, /vendor/…). nil: no such file may exist.
    static func file(for path: String) -> String? {
        let path = path.isEmpty ? "/" : path // a bare wgapp://local is the root
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        guard path.hasPrefix("/"), !parts.contains(where: { $0 == ".." || $0 == "." }) else { return nil }
        if path == "/" { return "index.html" }
        if path.hasSuffix("/") { return nil } // no directory listings
        if path.hasPrefix("/static/") || path.hasPrefix("/domain/") { return String(path.dropFirst()) }
        return "cloud" + path
    }

    /// cspPolicy (router.go) with connect-src scoped to 'self' plus the
    /// registered hosts only — never a wildcard `https:`/`wss:`, the same
    /// invariant as the account app document. Each host is listed as https://
    /// AND wss:// (the trial voice SDK and relay leg open sockets, bd
    /// med-o7zq.23), like router.go buildConnectSrc: never relying on CSP3's
    /// https→wss scheme matching in WebKit. Hosts are pre-validated.
    static func csp(_ hosts: [String]) -> String {
        let connect = (["'self'"] + hosts.flatMap { ["https://" + $0, "wss://" + $0] }).joined(separator: " ")
        return "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; worker-src 'self'; "
            + "media-src 'self'; connect-src \(connect); object-src 'none'; base-uri 'none'; "
            + "frame-ancestors 'none'; form-action 'none'"
    }

    /// The page's host list, accepted only whole (like the server endpoint):
    /// an array of at most maxHosts bare, already-normalized DNS hostnames.
    static func validHosts(_ raw: Any?) -> [String]? {
        guard let list = raw as? [String], list.count <= maxHosts, list.allSatisfy(validHost) else { return nil }
        return list
    }

    /// Mirror of validEgressHost (egress.go): nothing that could smuggle a
    /// second CSP source token, a scheme, port or path into `https://<host>`.
    static func validHost(_ h: String) -> Bool {
        guard !h.isEmpty, h.utf8.count <= 253, !h.hasPrefix("."), !h.hasPrefix("-"),
              !h.hasSuffix("."), !h.hasSuffix("-"), !h.contains("..") else { return false }
        return h.utf8.allSatisfy { c in
            (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(c) || (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(c)
                || c == UInt8(ascii: ".") || c == UInt8(ascii: "-")
        }
    }

    /// Bridge op setEgressHosts {hosts: [String]}: validate, persist, reply
    /// {changed}. The page reloads when changed to get the new CSP.
    static func setEgressHosts(_ args: [String: Any], defaults: UserDefaults = .standard) -> (Any?, String?) {
        guard let hosts = LocalOrigin.validHosts(args["hosts"]) else { return (nil, "invalid hosts") }
        let changed = (defaults.array(forKey: LocalOrigin.hostsKey) as? [String] ?? []) != hosts
        defaults.set(hosts, forKey: LocalOrigin.hostsKey)
        return (["changed": changed], nil)
    }

    static func mime(_ path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8" // module scripts need a JS MIME
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json"
        case "webmanifest": return "application/manifest+json"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "ico": return "image/x-icon"
        case "woff2": return "font/woff2"
        case "txt": return "text/plain; charset=utf-8"
        default: return "application/octet-stream"
        }
    }

    // MARK: backup flag

    /// This origin's WebKit data directories (salted-hash layout: <dir>/origin
    /// names the origin; or the legacy <scheme>_<host>_<port> one).
    static func dataDirs() -> [URL] {
        guard let webkit = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first?
                .appendingPathComponent("WebKit", isDirectory: true),
              let walk = FileManager.default.enumerator(at: webkit, includingPropertiesForKeys: nil) else { return [] }
        var ours: [URL] = []
        let schemeBytes = Data(scheme.utf8), hostBytes = Data(host.utf8)
        for case let url as URL in walk {
            let name = url.lastPathComponent
            if name == "origin", let d = try? Data(contentsOf: url),
               d.range(of: schemeBytes) != nil, d.range(of: hostBytes) != nil {
                ours.append(url.deletingLastPathComponent())
            } else if name.hasPrefix("\(scheme)_\(host)") {
                ours.append(url)
            }
        }
        return ours
    }

    /// The origin dir, then its parents up to and including WebsiteData.
    static func flagChain(_ dir: URL) -> [URL] {
        var chain = [dir]
        var d = dir
        while !["WebsiteData", "Library"].contains(d.lastPathComponent), d.pathComponents.count > 2 {
            d = d.deletingLastPathComponent()
            chain.append(d)
        }
        return chain
    }

    /// On iOS WebKit excludes a NEW origin's data dir from backup when it
    /// first writes it (NetworkStorageManager::writeOriginToFileIfNecessary)
    /// and includes it again only on an access 24 h later (spike med-o7zq.11).
    /// A backup in that window would drop the user's only copy, so the shell
    /// clears the flag at launch, after a load and on going to the background.
    static func includeInBackup() {
        for dir in dataDirs().flatMap(flagChain) {
            var url = URL(fileURLWithPath: dir.path) // no cached resource values
            guard (try? url.resourceValues(forKeys: [.isExcludedFromBackupKey]))?.isExcludedFromBackup == true else { continue }
            var values = URLResourceValues()
            values.isExcludedFromBackup = false
            try? url.setResourceValues(values)
        }
    }
}
