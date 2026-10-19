package com.example.medtracker

import java.io.File

/**
 * The local → cloud move's stash (bd med-nt9p.32.17): the vault v1 JSON the local origin exported
 * (move.stash), picked up by the new account's page (move.take, move.clear). The two origins share
 * no storage, so the shell carries it in one app-private file: [dir] is noBackupFilesDir/move, never
 * backed up (and outside the Auto Backup include-list anyway), in the same sandbox as the local
 * origin's plaintext IndexedDB, so no new exposure. Never log the contents. No Android types, so
 * MoveTest runs it on the JVM. Twin: the same ops in ios/App/Shell.swift (iOS epic).
 */
class Move(private val dir: File) {
    class Failure(message: String) : Exception(message)

    private val file get() = File(dir, "vault.json")

    val exists get() = file.isFile

    /** One stash at a time: a new one replaces the old, via a temp file + rename. */
    fun stash(vault: Any?) {
        if (vault !is String || vault.isEmpty()) throw Failure("invalid vault")
        val bytes = vault.toByteArray()
        if (bytes.size > MAX_BYTES) throw Failure("too large")
        dir.mkdirs()
        val tmp = File(dir, "vault.json.tmp")
        tmp.writeBytes(bytes)
        if (!tmp.renameTo(file)) {
            tmp.delete()
            throw Failure("write failed")
        }
    }

    /** The stash, or null when there is none; the page clears it once imported. */
    fun take(): String? = if (exists) file.readText() else null

    fun clear() {
        dir.listFiles()?.forEach { it.delete() } // the stash and any leftover temp file
    }

    companion object {
        const val MAX_BYTES = 64 * 1024 * 1024
    }
}
