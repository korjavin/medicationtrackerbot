// Self-check for AccountURL, LocalOrigin, LocalLock, ReminderPath and Move, run by .github/workflows/ios.yml:
//   swiftc -D DEBUG App/AccountURL.swift App/LocalOrigin.swift App/LocalLock.swift App/ReminderPath.swift App/Move.swift Tests/main.swift -o <bin> && <bin>
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
for (u, want) in [("https://abc.app.example.com/unlock", true),
                  ("https://abc.app.example.com/unlock#claim=TOKEN", true),
                  ("https://ABC.app.example.com/claim?x=1#slot.tk", true),
                  ("https://abc.app.example.com/recover#kit", true),
                  ("https://abc.app.example.com/", false),
                  ("https://abc.app.example.com/?tab=meds", false),
                  ("https://abc.app.example.com/unlocked", false),
                  ("https://app.example.com/unlock", false),
                  ("https://evil.com/unlock", false),
                  ("http://abc.app.example.com/unlock", false),
                  ("wgapp://local/unlock", false)] {
    precondition(AccountURL.isCeremony(URL(string: u), base: base) == want, "isCeremony \(u)")
}
// accountGone (bd med-w6gx.22): only the server's marked 404, header name in any case.
precondition(AccountURL.accountGone(404, ["X-Account-Gone": "1"]))
precondition(AccountURL.accountGone(404, ["x-account-gone": " 1 "]))
precondition(!AccountURL.accountGone(404, ["X-Account-Gone": "0"]))
precondition(!AccountURL.accountGone(503, ["X-Account-Gone": "1"]))
precondition(!AccountURL.accountGone(404, [:]))
precondition(!AccountURL.isCeremony(nil, base: base))
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

// First-run after an update (bd med-o7zq.31): no host, not local, local data present ⇒ offer to continue.
precondition(LocalOrigin.offersResume(host: nil, local: false, dataDirs: 1))
precondition(!LocalOrigin.offersResume(host: nil, local: false, dataDirs: 0)) // a real fresh install
precondition(!LocalOrigin.offersResume(host: "abc.app.example.com", local: false, dataDirs: 2))
precondition(!LocalOrigin.offersResume(host: nil, local: true, dataDirs: 1))
print("LocalOrigin.offersResume: ok")

// LocalLock (bd med-o7zq.8): the lock's lifecycle without LocalAuthentication.
var lock = LocalLock(on: true)
precondition(lock.holds(local: true) && !lock.holds(local: false), "cold launch: locked, local mode only")
var attempt = lock.activate(local: true, setting: true)!
precondition(lock.activate(local: true, setting: true) == nil, "the prompt's own inactive -> active must not prompt again")
lock.finish(attempt, .failed, setting: true)
precondition(lock.holds(local: true) && lock.state == .locked, "cancel stays locked")
precondition(lock.activate(local: true, setting: true) == nil, "no prompt loop after a cancel")
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
print("LocalOrigin.ops: ok")

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
