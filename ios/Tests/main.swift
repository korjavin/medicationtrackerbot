// Self-check for AccountURL, LocalOrigin, LocalLock, ReminderPath, Move, Diag, BasePost and Push, run by .github/workflows/ios.yml:
//   swiftc -D DEBUG App/AccountURL.swift App/LocalOrigin.swift App/LocalLock.swift App/ReminderPath.swift App/Move.swift App/Diag.swift App/BasePost.swift App/Push.swift Tests/main.swift -o <bin> && <bin>
// Not part of the app target (project.yml sources only App/).
import Foundation

let base = "app.example.com"

func check(_ input: String, _ want: String?, base: String = base) {
    let got = AccountURL.parse(input, base: base)?.absoluteString
    precondition(got == want, "\(input.debugDescription): got \(got ?? "nil"), want \(want ?? "nil")")
}

check("https://abc.app.example.com/#claim=TOKEN", "https://abc.app.example.com/#claim=TOKEN")
check("https://abc.app.example.com/claim#slot.tk", "https://abc.app.example.com/claim#slot.tk")
check("abc.app.example.com", "https://abc.app.example.com/")
check("  https://ABC.App.Example.com  ", "https://abc.app.example.com/")
check("https://abc.app.example.com\nacct-123\nABCD-EFGH-JKMN", "https://abc.app.example.com/") // Emergency Kit QR
check("", nil)
check("http://abc.app.example.com/", nil)
check("https://app.example.com/", nil)
check("https://a.b.app.example.com/", nil)
check("https://evilapp.example.com/", nil)
check("https://abc.app.example.com.evil.com/", nil)
check("https://u:p@abc.app.example.com/", nil)
check("https://abc.app.example.com:8443/", nil)
check("javascript:alert(1)", nil)
check("https://abc.app.example.com/", nil, base: "")
// accountGone (bd med-w6gx.22): only the server's marked 404, header name in any case.
precondition(AccountURL.accountGone(404, ["X-Account-Gone": "1"]))
precondition(AccountURL.accountGone(404, ["x-account-gone": " 1 "]))
precondition(!AccountURL.accountGone(404, ["X-Account-Gone": "0"]))
precondition(!AccountURL.accountGone(503, ["X-Account-Gone": "1"]))
precondition(!AccountURL.accountGone(404, [:]))
// parseInvite (bd med-ta2n.11): landing and scheme forms → the claim URL; the old forms still pass.
// Shared vectors: [input, want ("" = rejected)], base "app.example.com". Android's
// AccountUrl.parseInvite test pins the same list (contract med-ta2n.7 §5).
let inviteVectors: [(String, String)] = [
    ("https://app.example.com/i/abc#0a1b2c", "https://abc.app.example.com/#claim=0a1b2c"),
    ("https://APP.example.com/i/ABC#0a1b2c", "https://abc.app.example.com/#claim=0a1b2c"),
    ("medtracker://i/abc#0a1b2c", "https://abc.app.example.com/#claim=0a1b2c"),
    ("MedTracker://I/abc#0a1b2c", "https://abc.app.example.com/#claim=0a1b2c"),
    ("medtracker://i/my-sub-9#00ff", "https://my-sub-9.app.example.com/#claim=00ff"),
    ("https://abc.app.example.com/#claim=0a1b2c", "https://abc.app.example.com/#claim=0a1b2c"),
    ("https://abc.app.example.com/#claim=0a1b2c&kit=1", "https://abc.app.example.com/#claim=0a1b2c&kit=1"),
    ("abc.app.example.com", "https://abc.app.example.com/"),
    ("https://app.example.com/i/abc", ""), // no token
    ("https://app.example.com/i/abc#", ""), // empty token
    ("https://app.example.com/i/#0a1b2c", ""), // no sub
    ("https://app.example.com/i/a/b#0a1b2c", ""),
    ("https://app.example.com/i/a.b#0a1b2c", ""),
    ("https://app.example.com/i/a_b#0a1b2c", ""),
    ("https://app.example.com/i/%61bc#0a1b2c", ""), // raw path: no percent-decoding
    ("https://app.example.com/i/abc#%30a1b", ""), // raw fragment
    ("https://app.example.com/i/abc#0A1B2C", ""), // token is lowercase hex
    ("https://app.example.com/i/abc#0a1g", ""),
    ("https://app.example.com/i/abc#0a-1b", ""),
    ("https://app.example.com/i/abc#0a1b&kit=1", ""),
    ("https://app.example.com/i/abc?x=1#0a1b2c", ""),
    ("https://app.example.com/i/abc?#0a1b2c", ""),
    ("https://app.example.com:8443/i/abc#0a1b2c", ""),
    ("https://u@app.example.com/i/abc#0a1b2c", ""),
    ("https://u:p@app.example.com/i/abc#0a1b2c", ""),
    ("http://app.example.com/i/abc#0a1b2c", ""),
    ("https://evil.com/i/abc#0a1b2c", ""),
    ("https://app.example.com.evil.com/i/abc#0a1b2c", ""),
    ("https://evilapp.example.com/i/abc#0a1b2c", ""),
    ("https://app.example.com/x/abc#0a1b2c", ""),
    ("medtracker://x/abc#0a1b2c", ""),
    ("medtracker://i/abc", ""),
    ("medtracker://i/#0a1b2c", ""),
    ("medtracker://i/a/b#0a1b2c", ""),
    ("medtracker://i:1/abc#0a1b2c", ""),
    ("medtracker://u@i/abc#0a1b2c", ""),
    ("medtracker://i/abc?x=1#0a1b2c", ""),
    ("otherapp://i/abc#0a1b2c", ""),
    ("wgapp://local/", ""),
    ("", ""),
]
for (input, want) in inviteVectors {
    let got = AccountURL.parseInvite(input, base: base)?.absoluteString ?? ""
    precondition(got == want, "invite \(input.debugDescription): got \(got.debugDescription), want \(want.debugDescription)")
}
precondition(AccountURL.parseInvite("https://app.example.com/i/abc#0a1b2c", base: "") == nil)
let claim = "https://abc.app.example.com/#claim=0a1b2c"

// InviteSlot: empty, store, newest wins, clear.
let slotDefaults = UserDefaults(suiteName: "wg-invite-slot-test")!
slotDefaults.removePersistentDomain(forName: "wg-invite-slot-test")
precondition(InviteSlot.pending(slotDefaults) == nil)
InviteSlot.store(URL(string: claim)!, at: Date(timeIntervalSince1970: 1_700_000_000), slotDefaults)
InviteSlot.store(URL(string: "https://xyz.app.example.com/#claim=ff")!, at: Date(timeIntervalSince1970: 1_700_000_001.5), slotDefaults)
let slot = InviteSlot.pending(slotDefaults)
precondition(slot?["url"] as? String == "https://xyz.app.example.com/#claim=ff", "\(String(describing: slot))")
precondition(slot?["receivedAt"] as? Int64 == 1_700_000_001_500, "\(String(describing: slot))")
precondition(JSONSerialization.isValidJSONObject(slot!))
InviteSlot.clear(slotDefaults)
precondition(InviteSlot.pending(slotDefaults) == nil)
slotDefaults.removePersistentDomain(forName: "wg-invite-slot-test")
print("AccountURL: ok")

// LocalOrigin (bd med-o7zq.4): request routing, CSP, the bridge's host list.
func route(_ path: String, _ want: String?) {
    let got = LocalOrigin.file(for: path)
    precondition(got == want, "\(path): got \(got ?? "nil"), want \(want ?? "nil")")
}
route("/", "index.html")
route("", "index.html") // wgapp://local without the slash
precondition(LocalOrigin.mime(LocalOrigin.file(for: "")!).hasPrefix("text/html"))
route("/static/js/core/utils.js", "static/js/core/utils.js")
route("/domain/bp.js", "domain/bp.js")
route("/js/apishim.js", "cloud/js/apishim.js")
route("/vendor/qrcode.mjs", "cloud/vendor/qrcode.mjs")
route("/index.html", "cloud/index.html") // as on an account host: "/" is the app document
route("/static/../../etc/passwd", nil)
route("/./js/a.js", nil)
route("/static/", nil)
route("relative.js", nil)

let csp = LocalOrigin.csp(["api.openai.com"])
precondition(csp.contains("connect-src 'self' https://api.openai.com wss://api.openai.com;"), csp)
precondition(!csp.contains("https:;") && !csp.contains("https: ") && !csp.contains("wss:;") && !csp.contains("wss: "), "wildcard in \(csp)")
precondition(LocalOrigin.csp([]).contains("connect-src 'self';"))
precondition(csp.contains("script-src 'self';") && csp.contains("object-src 'none'"))

precondition(LocalOrigin.validHosts(["api.openai.com", "api.anthropic.com"]) == ["api.openai.com", "api.anthropic.com"])
precondition(LocalOrigin.validHosts([String]()) == [])
for bad: Any? in [nil, "api.openai.com", [1], ["API.openai.com"], ["a.com b.com"], ["https://a.com"], ["a.com:443"],
                   ["a.com/x"], [".a.com"], ["a.com."], ["a..com"], ["-a.com"], ["*.a.com"], [""], ["[::1]"],
                   Array(repeating: "a.com", count: LocalOrigin.maxHosts + 1)] {
    precondition(LocalOrigin.validHosts(bad) == nil, "accepted \(String(describing: bad))")
}

let defaults = UserDefaults(suiteName: "wg-tests-\(UUID().uuidString)")!
let first = LocalOrigin.setEgressHosts(["hosts": ["api.openai.com"]], defaults: defaults)
precondition((first.0 as? [String: Bool])?["changed"] == true && first.1 == nil)
precondition((LocalOrigin.setEgressHosts(["hosts": ["api.openai.com"]], defaults: defaults).0 as? [String: Bool])?["changed"] == false)
let rejected = LocalOrigin.setEgressHosts(["hosts": ["evil.com 'unsafe-inline'"]], defaults: defaults)
precondition(rejected.0 == nil && rejected.1 != nil)
precondition(defaults.array(forKey: LocalOrigin.hostsKey) as? [String] == ["api.openai.com"], "a rejected list must not replace the stored one")

precondition(LocalOrigin.mime("/js/a.js").hasPrefix("text/javascript") && LocalOrigin.mime("/vendor/q.mjs").hasPrefix("text/javascript"))
precondition(LocalOrigin.mime("/static/fonts/x.woff2") == "font/woff2")
// Visual QA scene (bd med-y5xx.2): compiled with -D DEBUG, like the Debug app.
precondition(LocalOrigin.qaHome(scene: "food-add-sheet-keyboard")?.absoluteString == "wgapp://local/?qa=food-add-sheet-keyboard")
precondition(LocalOrigin.qaHome(scene: "today")?.host == LocalOrigin.host)
for bad: String? in [nil, "", "Today", "a b", "a&b=c", "a#b", "../x", "x/y", String(repeating: "a", count: 65)] {
    precondition(LocalOrigin.qaHome(scene: bad) == nil, "accepted \(String(describing: bad))")
}
print("LocalOrigin: ok")

// LocalLock (bd med-o7zq.8): the lock's lifecycle without LocalAuthentication.
var lock = LocalLock(on: true)
precondition(lock.holds(local: true) && !lock.holds(local: false), "cold launch: locked, local mode only")
var attempt = lock.activate(local: true, setting: true)!
precondition(lock.activate(local: true, setting: true) == nil, "the prompt's own inactive -> active must not prompt again")
lock.finish(attempt, .failed, setting: true)
precondition(lock.holds(local: true) && lock.state == .locked && lock.failed, "a failure stays locked, with the note")
precondition(lock.activate(local: true, setting: true) == nil, "no prompt loop after a failure")
attempt = lock.begin()!
lock.finish(attempt, .cancelled, setting: true)
precondition(lock.state == .locked && !lock.failed, "a cancel stays locked, without the note")
attempt = lock.begin()!
precondition(lock.begin() == nil, "one prompt at a time")
lock.background()
let stale = attempt
attempt = lock.activate(local: true, setting: true)!
lock.finish(stale, .failed, setting: true)
precondition(lock.state == .unlocking, "a prompt from before the background must not end the current one")
lock.finish(stale, .ok, setting: true)
precondition(lock.state == .unlocking, "a prompt from before the background must not unlock")
lock.finish(attempt, .ok, setting: true)
precondition(!lock.holds(local: true), "unlocked")
lock.background()
precondition(lock.holds(local: true), "the background locks again")
precondition(lock.activate(local: true, setting: false) != nil && lock.on, "turning off waits for an unlock")
lock.finish(lock.attempt, .ok, setting: false)
precondition(!lock.on && !lock.holds(local: true), "off after the unlock")
lock.background()
precondition(!lock.holds(local: true), "off: the background does not lock")
precondition(lock.activate(local: true, setting: true) == nil && lock.on, "turning on needs no prompt")
lock.background()
precondition(lock.activate(local: false, setting: false) == nil && lock.on, "no turning off from an account's mode")
attempt = lock.activate(local: true, setting: true)!
lock.finish(attempt, .notInteractive, setting: true)
precondition(lock.activate(local: true, setting: true) != nil, "not frontmost yet: ask on the next activation")
var fresh = LocalLock(on: true)
fresh.confirmed(on: true)
precondition(!fresh.holds(local: true) && fresh.on, "onboarding's check unlocks")
fresh.background()
fresh.confirmed(on: false)
precondition(!fresh.on && !fresh.holds(local: true), "onboarding's check may turn a lock left on off")
print("LocalLock: ok")

// ReminderPath (bd med-w6gx.20): a tap opens only what sw.js reminderOpenUrl would.
func tap(_ raw: String?, _ want: String) {
    let got = ReminderPath.sanitize(raw)
    precondition(got == want, "\(raw.debugDescription): got \(got), want \(want)")
}
let dose = "/?action=medication_confirm&ids=2%2C5&scheduled=2026-01-01T09%3A00%3A00.000Z" // reminderDeeplink's shape
tap(dose, dose)
tap("/?action=medication_confirm&ids=2,5&scheduled=2026-01-01T09:00:00.000Z",
    "/?action=medication_confirm&ids=2,5&scheduled=2026-01-01T09:00:00.000Z")
tap("/?tab=meds", "/?tab=meds")
tap("/?tab=bp", "/?tab=bp")
for bad in [nil, "", "/?", "/", "?tab=meds", "https://evil.com/?tab=meds", "//evil.com/?tab=meds", "/x?tab=meds",
            "/?tab=meds#claim=x", "/?tab=meds#", "/?tab=meds&next=https://evil.com", "/?reminder_action=bp_snooze",
            "/?tab=me\"ds", "/?tab=meds');alert(1)//\n", "javascript:alert(1)"] as [String?] {
    tap(bad, "/?tab=today")
}
precondition(ReminderPath.legacy("meds") == "/?tab=meds" && ReminderPath.legacy("workouts") == "/?tab=workouts")
precondition(ReminderPath.legacy("settings") == "/?tab=today" && ReminderPath.legacy(nil) == "/?tab=today")
precondition(ReminderPath.legacy(42) == "/?tab=today")
print("ReminderPath: ok")

// shell.ops (bd med-o7zq.35): per mode, the move ops on their own side.
let localOps = LocalOrigin.ops(local: true), accountOps = LocalOrigin.ops(local: false)
precondition(localOps.contains("move.stash") && !localOps.contains("move.take") && !localOps.contains("move.clear"))
precondition(accountOps.contains("move.take") && accountOps.contains("move.clear") && !accountOps.contains("move.stash"))
precondition(accountOps.contains("account.leave") && !localOps.contains("account.leave"))
precondition(localOps.contains("shell.ops") && accountOps.contains("shell.ops") && localOps == localOps.sorted())
precondition(accountOps.contains("leave.stash") && !accountOps.contains("leave.take") && !accountOps.contains("leave.clear"))
precondition(localOps.contains("leave.take") && localOps.contains("leave.clear") && !localOps.contains("leave.stash"))
// Settings → App lock (bd med-o7zq.39): local mode only, as on Android.
precondition(localOps.contains("lock.status") && localOps.contains("lock.set"))
precondition(!accountOps.contains("lock.status") && !accountOps.contains("lock.set"))
// base.post (bd med-ta2n.26): local only; an account page gets "unsupported: base.post".
precondition(localOps.contains("base.post") && !accountOps.contains("base.post"))
// push.token (bd med-erq1.4): account only; local mode never reports a token.
precondition(accountOps.contains("push.token") && !localOps.contains("push.token"))
print("LocalOrigin.ops: ok")

// Push (bd med-erq1.4): the page event, the token encoding, the Diag fingerprint.
for kind in ["inbox-wake", "dry-queue", "token"] {
    let js = Push.event(kind)!
    precondition(js.contains("new CustomEvent('wg:native-push',{detail:{kind:'\(kind)'}})"), js)
    precondition(js.contains("window.MedTrackerCloud&&window.MedTrackerCloud.ctx"), js) // unlocked pages only
}
for kind in ["", "Inbox-wake", "inbox-wake'", "x');alert(1);('"] { precondition(Push.event(kind) == nil, kind) }
precondition(Push.hex(Data([0x00, 0x0a, 0xff])) == "000aff")
let fp = Push.fingerprint("abcdef0123456789")
precondition(fp.count == 8 && fp != Push.fingerprint("abcdef012345678a"), fp)
precondition(Push.grace > 0 && Push.grace < 30) // under iOS's background budget
print("Push: ok")

// Move (bd med-o7zq.35): the stash file's lifecycle.
let moveDir = FileManager.default.temporaryDirectory.appendingPathComponent("wg-move-\(UUID().uuidString)")
let move = Move(dir: moveDir)
func failure(_ vault: Any?) -> String? {
    do { try move.stash(vault); return nil } catch { return (error as? Move.Failure)?.message ?? "other" }
}
precondition(!move.exists && (try! move.take()) == nil)
precondition(failure(nil) == "invalid vault" && failure("") == "invalid vault" && failure(42) == "invalid vault")
precondition(failure(String(repeating: "é", count: Move.maxBytes / 2 + 1)) == "too large") // UTF-8 bytes, not characters
precondition(!move.exists)
precondition(failure("{\"v\":1}") == nil && move.exists && (try! move.take()) == "{\"v\":1}")
precondition(failure("{\"v\":2}") == nil && (try! move.take()) == "{\"v\":2}") // replaced; take does not delete
precondition((try! moveDir.resourceValues(forKeys: [.isExcludedFromBackupKey])).isExcludedFromBackup == true)
move.clear()
precondition(!move.exists && (try! move.take()) == nil)
move.clear() // idempotent
// Two stashes on different dirs (move/, leave/; bd med-o7zq.36) are independent.
let leaveStash = Move(dir: FileManager.default.temporaryDirectory.appendingPathComponent("wg-leave-\(UUID().uuidString)"))
try! move.stash("{\"v\":3}")
leaveStash.clear()
precondition(move.exists && (try! move.take()) == "{\"v\":3}")
try! leaveStash.stash("{\"v\":4}")
move.clear()
precondition(!move.exists && leaveStash.exists && (try! leaveStash.take()) == "{\"v\":4}")
leaveStash.clear()
precondition(!leaveStash.exists)
print("Move: ok")

// Diag (bd med-w6gx.24): redaction and the cap, as Android's DiagTest.
let red = Diag.redact("page https://ABC.app.example.com/unlock rp=abc.app.example.com other=xyz.app.example.com base=app.example.com", base: base)
precondition(!red.lowercased().contains("abc") && !red.contains("xyz") && !red.contains("example"), red)
let subs = red.split(separator: " ").compactMap { w in w.range(of: "<sub-[0-9a-f]{6}>", options: .regularExpression).map { String(w[$0]) } }
precondition(subs.count == 3 && subs[0] == subs[1] && subs[1] != subs[2], red) // same account, same tag; another, another
precondition(red.hasSuffix("base=<base>"), red)
precondition(Diag.redact("abc.app.example.com", base: "") == "abc.app.example.com")
var diagLog = ""
for i in 1...(Diag.cap + 50) { diagLog = Diag.append(diagLog, "line \(i)\nnext", base: base, time: "T") }
let diagLines = diagLog.split(separator: "\n")
precondition(diagLines.count == Diag.cap && diagLines.first == "T line 51 next" && diagLines.last == "T line \(Diag.cap + 50) next")
precondition(Diag.append("", String(repeating: "x", count: 5000), base: base, time: "T").count == Diag.maxLine)
print("Diag: ok")

// BasePost (bd med-ta2n.26, contract med-ta2n.24 A7; twin of Android BasePostTest.kt):
// against a scripted loopback HTTP/1.1 server on raw sockets. Plain http to
// 127.0.0.1: a command-line tool has no ATS; the app only ever builds https://.
signal(SIGPIPE, SIG_IGN)

func loopbackSocket() -> (Int32, Int) {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    var len = socklen_t(MemoryLayout<sockaddr_in>.size)
    precondition(withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, len) } } == 0)
    precondition(withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) } } == 0)
    return (fd, Int(UInt16(bigEndian: addr.sin_port)))
}

final class Loopback {
    struct Request { let path: String; let headers: [String: String]; let body: Data }
    private let lock = NSLock()
    private var got: [Request] = []
    private var script: (Int32, Request) -> Void = { c, _ in Loopback.write(c, Loopback.raw(200)) }
    private let fd: Int32
    let port: Int

    var requests: [Request] { lock.lock(); defer { lock.unlock() }; return got }
    var root: String { "http://127.0.0.1:\(port)" }
    /// Answers each request: writes to the socket (or stalls); then the server closes it.
    func respond(_ f: @escaping (Int32, Request) -> Void) { lock.lock(); script = f; lock.unlock() }

    init() {
        let s = loopbackSocket()
        fd = s.0
        port = s.1
        precondition(listen(fd, 16) == 0)
        Thread.detachNewThread { [self] in
            while true {
                let c = accept(fd, nil, nil)
                if c < 0 { return }
                Thread.detachNewThread { self.serve(c) }
            }
        }
    }

    private func serve(_ c: Int32) {
        defer { close(c) }
        var buf = Data()
        var chunk = [UInt8](repeating: 0, count: 65_536)
        let sep = Data("\r\n\r\n".utf8)
        while buf.range(of: sep) == nil {
            let n = read(c, &chunk, chunk.count)
            if n <= 0 { return }
            buf.append(contentsOf: chunk[0..<n])
        }
        let end = buf.range(of: sep)!
        let lines = String(decoding: buf[..<end.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
        var headers: [String: String] = [:]
        for l in lines.dropFirst() {
            guard let i = l.firstIndex(of: ":") else { continue }
            headers[l[..<i].lowercased()] = l[l.index(after: i)...].trimmingCharacters(in: .whitespaces)
        }
        var body = Data(buf[end.upperBound...])
        let want = Int(headers["content-length"] ?? "0") ?? 0
        while body.count < want {
            let n = read(c, &chunk, chunk.count)
            if n <= 0 { break }
            body.append(contentsOf: chunk[0..<n])
        }
        let req = Request(path: lines[0].split(separator: " ").dropFirst().first.map(String.init) ?? "", headers: headers, body: body)
        lock.lock()
        got.append(req)
        let f = script
        lock.unlock()
        f(c, req)
    }

    static func raw(_ status: Int, _ headers: [String] = [], _ body: Data = Data()) -> Data {
        Data((["HTTP/1.1 \(status) X"] + headers + ["Content-Length: \(body.count)", "Connection: close", "", ""]).joined(separator: "\r\n").utf8) + body
    }

    static func write(_ c: Int32, _ data: Data) {
        data.withUnsafeBytes { p in
            var off = 0
            while off < data.count {
                let n = Darwin.write(c, p.baseAddress! + off, data.count - off)
                if n <= 0 { return }
                off += n
            }
        }
    }
}

/// One base.post call, waited for: the first answer, its latency, and how many answers
/// arrived by `settle` seconds later (exactly once is the contract).
func post(_ root: String, _ args: [String: Any], timeout: TimeInterval = BasePost.timeout,
          settle: TimeInterval = 0) -> (reply: BasePost.Reply?, error: String?, answers: Int, took: TimeInterval) {
    let lock = NSLock()
    var answers: [(BasePost.Reply?, String?)] = []
    let first = DispatchSemaphore(value: 0)
    let start = Date()
    BasePost.send(root: root, args: args, timeout: timeout) { r, e in
        lock.lock()
        answers.append((r, e))
        lock.unlock()
        first.signal()
    }
    precondition(first.wait(timeout: .now() + 60) == .success, "base.post never answered")
    let took = Date().timeIntervalSince(start)
    if settle > 0 { Thread.sleep(forTimeInterval: settle) }
    lock.lock()
    defer { lock.unlock() }
    precondition((answers[0].0 == nil) != (answers[0].1 == nil), "a reply or an error, not both")
    return (answers[0].0, answers[0].1, answers.count, took)
}

let server = Loopback()
// Allowlist: exact string, no query, no normalization; nothing reaches the server.
let badPaths: [Any?] = ["/api/attest/chat", "/api/invite-requests?x=1", "api/invite-requests", "/api/invite-requests/", nil, 7]
for p in badPaths {
    var args: [String: Any] = ["body": "{}"]
    args["path"] = p
    precondition(post(server.root, args).error == "invalid path", "\(String(describing: p))")
}
precondition(post(server.root, ["path": "/api/invite-requests"]).error == "invalid body")
precondition(post(server.root, ["path": "/api/invite-requests", "body": 42]).error == "invalid body")
precondition(post(server.root, ["path": "/api/attest/feedback", "body": String(repeating: "a", count: BasePost.maxBody + 1)]).error == "body too large")
let badHeaders: [Any] = [
    ["Cookie": "a=b"], ["Content-Type": "text/plain"], ["x-attest-key-id": "k"],
    ["X-Attest-Key-Id": String(repeating: "a", count: 9 * 1024)], ["X-Attest-Key-Id": 1],
    ["X-Attest-Key-Id": "a\r\nX-Evil: 1"], "X-Attest-Key-Id",
]
for h in badHeaders {
    precondition(post(server.root, ["path": "/api/attest/feedback", "body": "{}", "headers": h]).error == "invalid headers", "\(h)")
}
precondition(server.requests.isEmpty)
var noBase: String?
BasePost.call(base: "", args: ["path": "/api/invite-requests", "body": "{}"]) { _, e in noBase = e }
precondition(noBase == "no base")

// Verbatim body (non-ASCII, an escape, a number form a re-serializer would change, trailing
// spaces), the three response headers and not a fourth, shell-set Content-Type/Accept, no cookie.
server.respond { c, _ in
    Loopback.write(c, Loopback.raw(202, ["X-Attest-Challenge: c2", "X-Trial-Remaining: 3", "Retry-After: 5", "X-Other: no"], Data(#"{"ok":true}"#.utf8)))
}
let verbatim = "{\"text\":\"h\u{e9}llo \u{1F642}\",\"esc\":\"\\u00e9\",\"n\":1.50,\"x\":\"\u{2028}\"}  "
let ok = post(server.root, ["path": "/api/attest/feedback", "body": verbatim, "headers": ["X-Attest-Key-Id": "kid", "X-Attest-Assertion": "sig"]])
precondition(ok.reply?.status == 202 && ok.reply?.body == #"{"ok":true}"#, "\(String(describing: ok.error))")
precondition(ok.reply?.headers == ["X-Attest-Challenge": "c2", "X-Trial-Remaining": "3", "Retry-After": "5"], "\(String(describing: ok.reply?.headers))")
let received = server.requests
precondition(received.count == 1 && received[0].path == "/api/attest/feedback")
precondition(received[0].body == Data(verbatim.utf8)) // byte-equal, so the same SHA-256
precondition(received[0].headers["x-attest-key-id"] == "kid" && received[0].headers["x-attest-assertion"] == "sig")
precondition(received[0].headers["content-type"] == "application/json" && received[0].headers["accept"] == "application/json")
precondition(received[0].headers["cookie"] == nil && received[0].headers["origin"] == nil)

// A redirect is the reply, never followed.
server.respond { c, _ in Loopback.write(c, Loopback.raw(302, ["Location: \(server.root)/elsewhere"])) }
let redirect = post(server.root, ["path": "/api/invite-requests", "body": "{}"])
precondition(redirect.reply?.status == 302, "\(String(describing: redirect.error))")
Thread.sleep(forTimeInterval: 0.2)
precondition(server.requests.count == 2 && server.requests[1].path == "/api/invite-requests")

// Any HTTP status is a reply; 204 → "".
server.respond { c, _ in Loopback.write(c, Loopback.raw(429, ["Retry-After: 60"], Data(#"{"error":"busy"}"#.utf8))) }
let busy = post(server.root, ["path": "/api/invite-requests", "body": "{}"])
precondition(busy.reply?.status == 429 && busy.reply?.body == #"{"error":"busy"}"# && busy.reply?.headers == ["Retry-After": "60"])
server.respond { c, _ in Loopback.write(c, Data("HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n".utf8)) }
let empty = post(server.root, ["path": "/api/attest/feedback", "body": "{}"])
precondition(empty.reply?.status == 204 && empty.reply?.body == "")

// Response cap.
server.respond { c, _ in Loopback.write(c, Loopback.raw(200, [], Data(repeating: 0x61, count: BasePost.maxResponse + 1))) }
precondition(post(server.root, ["path": "/api/attest/challenge", "body": "{}"]).error == "response too large")

// The server took the whole POST and hung up without a status: "network", one request, no silent resend.
let before = server.requests.count
server.respond { _, _ in }
precondition(post(server.root, ["path": "/api/invite-requests", "body": "{}"]).error == "network")
Thread.sleep(forTimeInterval: 0.3)
precondition(server.requests.count == before + 1, "\(server.requests.count - before) requests")

// The whole-call deadline: a stalled server and a dripping one (each byte well inside any idle
// timeout) both end as "network" on time, answered exactly once; the late outcome is dropped.
server.respond { c, _ in Thread.sleep(forTimeInterval: 2); Loopback.write(c, Loopback.raw(200)) }
let stalled = post(server.root, ["path": "/api/attest/enroll", "body": "{}"], timeout: 0.5, settle: 2.5)
precondition(stalled.error == "network" && stalled.answers == 1 && stalled.took < 1.5, "\(stalled)")
server.respond { c, _ in
    Loopback.write(c, Data("HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n".utf8))
    for _ in 0..<50 { Loopback.write(c, Data("a".utf8)); Thread.sleep(forTimeInterval: 0.1) }
}
let drip = post(server.root, ["path": "/api/attest/enroll", "body": ""], timeout: 1)
precondition(drip.error == "network" && drip.took < 3, "\(drip)")

// Nothing listening: "network".
let (closed, closedPort) = loopbackSocket()
close(closed)
precondition(post("http://127.0.0.1:\(closedPort)", ["path": "/api/attest/enroll", "body": "{}"]).error == "network")
print("BasePost: ok")
