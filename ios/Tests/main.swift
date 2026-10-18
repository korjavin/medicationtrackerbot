// Self-check for AccountURL and LocalOrigin, run by .github/workflows/ios.yml:
//   swiftc App/AccountURL.swift App/LocalOrigin.swift Tests/main.swift -o <bin> && <bin>
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
print("AccountURL: ok")

// LocalOrigin (bd med-o7zq.4): request routing, CSP, the bridge's host list.
func route(_ path: String, _ want: String?) {
    let got = LocalOrigin.file(for: path)
    precondition(got == want, "\(path): got \(got ?? "nil"), want \(want ?? "nil")")
}
route("/", "index.html")
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
precondition(csp.contains("connect-src 'self' https://api.openai.com;"), csp)
precondition(!csp.contains("https:;") && !csp.contains("https: ") && !csp.contains("wss:"), "wildcard in \(csp)")
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
print("LocalOrigin: ok")
