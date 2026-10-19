package com.example.medtracker

import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.Base64

/**
 * The bytes of the Android trial protocol (bd med-nt9p.32.8.4), no Android types so AttestTest
 * runs them on the JVM. Server twin: internal/playintegrity (KeyID, RequestHash,
 * VerifyAssertion); both suites pin the same vectors (vectors_test.go).
 */
object AttestWire {
    private val url = Base64.getUrlEncoder().withoutPadding()

    private fun sha256(vararg parts: ByteArray): ByteArray =
        MessageDigest.getInstance("SHA-256").apply { parts.forEach { update(it) } }.digest()

    /** base64url-nopad(SHA256(SPKI DER)): derived, never chosen. */
    fun keyId(spki: ByteArray): String = url.encodeToString(sha256(spki))

    /** setRequestHash for the standard request: base64url-nopad(SHA256(challenge ‖ keyId ‖ SPKI DER)). */
    fun requestHash(challenge: ByteArray, keyId: String, spki: ByteArray): String =
        url.encodeToString(sha256(challenge, keyId.toByteArray(), spki))

    /** Attest.swift's contract: SHA256(challenge ‖ bodySha256). */
    fun clientDataHash(challenge: ByteArray, bodySha256: ByteArray): ByteArray = sha256(challenge, bodySha256)

    fun counterBE(counter: Long): ByteArray = ByteBuffer.allocate(4).putInt(counter.toInt()).array()

    /** What the Keystore signs (SHA256withECDSA): clientDataHash ‖ counterBE32. */
    fun signedMessage(clientDataHash: ByteArray, counter: Long): ByteArray = clientDataHash + counterBE(counter)

    /** Wire assertion: counterBE32 ‖ DER signature. */
    fun assertion(counter: Long, derSig: ByteArray): ByteArray = counterBE(counter) + derSig

    /** The next counter: strictly increasing, uint32 on the wire; null once exhausted (2^32 signatures — never in practice). */
    fun nextCounter(stored: Long): Long? = (stored + 1).takeIf { stored >= 0 && it <= 0xFFFF_FFFFL }

    /** Standard base64 the page sends; null when it is not, or empty. */
    fun bytes(raw: Any?): ByteArray? =
        (raw as? String)?.let { runCatching { Base64.getDecoder().decode(it) }.getOrNull() }?.takeIf { it.isNotEmpty() }
}
