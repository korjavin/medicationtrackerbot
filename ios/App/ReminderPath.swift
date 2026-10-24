import Foundation

/// What a reminder tap may open (bd med-w6gx.20): the app's own root with only
/// the query keys of web/cloud/js/reminder-deeplink.js — the same allowlist as
/// web/cloud/sw.js reminderOpenUrl. Never an arbitrary string out of userInfo.
/// Foundation only, so ios/Tests/main.swift checks it without a simulator.
enum ReminderPath {
    static let fallback = "/?tab=today"
    /// 'page': the Settings sub-page of ?tab=settings&page=… (deeplink-router.js
    /// routes only a fixed list), e.g. Push.paths' add-device.
    static let keys: Set<String> = ["tab", "action", "ids", "scheduled", "page"]
    /// An already-encoded query: no space, quote, fragment or non-ASCII.
    private static let allowed = CharacterSet.urlQueryAllowed.union(CharacterSet(charactersIn: "%"))

    /// A relative "/?…" path, re-encoded, or `fallback`.
    static func sanitize(_ raw: String?) -> String {
        // Checked here, not left to URLComponents, which percent-encodes invalid
        // characters instead of failing on newer SDKs.
        guard let raw, raw.hasPrefix("/?"),
              raw.unicodeScalars.allSatisfy({ allowed.contains($0) }),
              let parts = URLComponents(string: raw),
              parts.scheme == nil, parts.host == nil, parts.path == "/", parts.fragment == nil,
              let items = parts.queryItems, !items.isEmpty,
              items.allSatisfy({ keys.contains($0.name) }),
              let query = parts.percentEncodedQuery
        else { return fallback }
        return "/?" + query
    }

    /// The sections a reminder without a url — from a page or build before bd
    /// med-w6gx.20 — may open (stable section ids, CLAUDE.md rule 6).
    static let sections: Set<String> = ["today", "meds", "bp", "weight", "workouts", "health"]

    static func legacy(_ section: Any?) -> String {
        guard let section = section as? String, sections.contains(section) else { return fallback }
        return "/?tab=" + section
    }
}
