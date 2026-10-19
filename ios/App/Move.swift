import Foundation

/// The local → cloud move's stash (bd med-o7zq.35, twin of Android Move.kt,
/// med-nt9p.32.17): the vault v1 JSON the local origin exported (move.stash),
/// picked up by the new account's page (move.take, move.clear). The two
/// origins share no storage, so the shell carries it in one app-private file,
/// `dir`/vault.json, in Application Support/move — excluded from backup, in
/// the same sandbox as the local origin's plaintext website data, so no new
/// exposure. Never log the contents or the path. Foundation only, so
/// Tests/main.swift checks it.
struct Move {
    struct Failure: Error, LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    static let maxBytes = 64 * 1024 * 1024

    static let appDir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("move", isDirectory: true)

    let dir: URL
    private var file: URL { dir.appendingPathComponent("vault.json") }

    var exists: Bool { FileManager.default.fileExists(atPath: file.path) }

    /// One stash at a time: a new one replaces the old (temp file + rename).
    func stash(_ vault: Any?) throws {
        guard let vault = vault as? String, !vault.isEmpty else { throw Failure(message: "invalid vault") }
        let bytes = Data(vault.utf8)
        guard bytes.count <= Move.maxBytes else { throw Failure(message: "too large") }
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            // Excluding the directory excludes everything in it, whatever the atomic write renames in.
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var url = dir
            try url.setResourceValues(values)
            try bytes.write(to: file, options: .atomic)
        } catch {
            throw Failure(message: "write failed") // the system error names the path
        }
    }

    /// The stash, or nil when there is none; the page clears it once imported.
    func take() throws -> String? {
        guard exists else { return nil }
        guard let data = try? Data(contentsOf: file), let s = String(data: data, encoding: .utf8) else {
            throw Failure(message: "read failed")
        }
        return s
    }

    func clear() {
        try? FileManager.default.removeItem(at: dir) // the stash and any leftover temp file
    }
}
