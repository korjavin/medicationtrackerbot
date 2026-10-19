package com.example.medtracker

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

// The same vectors as internal/playintegrity/vectors_test.go (bd med-nt9p.32.8.4).
class AttestTest {
    private val std = Base64.getDecoder()
    private val spki = std.decode("MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEzGYJQtUGrDQLlbhnpu5m7FpJWXKdyz2t3aPcZl7hzL//l14nuDgbLKoeYahIBARHu4HLq1m9dpmpXe+UrDAZRA==")
    private val challenge = std.decode("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=")
    private val bodySha = std.decode("o9O/8yZ9pMhwboNHptZVx4i4nsqlpeMeo0yi9Sj9Nt0=")
    private val cdh = std.decode("FP/0RIIEpZDVmjTeuN6w/hqNznmfwPSYxfnroOEyGSk=")
    private val goAssertion = std.decode("AAAABzBGAiEAlgEpsJErU/Yhwd4gYYkDdFWGpcL5D7gcvLeAOIs7Le4CIQDZ8vieZzkuy5O49jZdx/0oe8X7Aja/68yOXZ9GSWaQig==")

    @Test
    fun derivationsMatchTheServer() {
        val keyId = AttestWire.keyId(spki)
        assertEquals("sMWYpk6crsaslQBz45WxqHi8LJ2Odh408gDcvi_IYhM", keyId)
        assertEquals("V8MTBbLV2H-_wX5oNckgSyPGhwvIAUOFELnxUajsCN0", AttestWire.requestHash(challenge, keyId, spki))
        assertArrayEquals(cdh, AttestWire.clientDataHash(challenge, bodySha))
    }

    @Test
    fun assertionLayout() {
        // The Go side's assertion verifies with the layout this client signs.
        val pub = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(spki))
        assertArrayEquals(byteArrayOf(0, 0, 0, 7), goAssertion.copyOfRange(0, 4))
        assertTrue(Signature.getInstance("SHA256withECDSA").run {
            initVerify(pub)
            update(AttestWire.signedMessage(cdh, 7))
            verify(goAssertion.copyOfRange(4, goAssertion.size))
        })
        // And one signed here round-trips: counterBE32 ‖ DER sig over clientDataHash ‖ counterBE32.
        val kp = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val counter = 0x01020304L
        val sig = Signature.getInstance("SHA256withECDSA").run {
            initSign(kp.private)
            update(AttestWire.signedMessage(cdh, counter))
            sign()
        }
        val wire = AttestWire.assertion(counter, sig)
        assertArrayEquals(byteArrayOf(1, 2, 3, 4), wire.copyOfRange(0, 4))
        assertArrayEquals(cdh + byteArrayOf(1, 2, 3, 4), AttestWire.signedMessage(cdh, counter))
        assertTrue(Signature.getInstance("SHA256withECDSA").run {
            initVerify(kp.public)
            update(cdh + wire.copyOfRange(0, 4))
            verify(wire.copyOfRange(4, wire.size))
        })
        assertEquals(256, (kp.public as ECPublicKey).params.curve.field.fieldSize)
        assertArrayEquals(byteArrayOf(-1, -1, -1, -1), AttestWire.counterBE(0xFFFF_FFFFL))
    }

    @Test
    fun counterIsStrictlyIncreasing() {
        var c = 0L
        repeat(5) { val n = AttestWire.nextCounter(c)!!; assertTrue(n > c); c = n }
        assertEquals(5L, c)
        assertEquals(0xFFFF_FFFFL, AttestWire.nextCounter(0xFFFF_FFFEL))
        assertNull(AttestWire.nextCounter(0xFFFF_FFFFL))
        assertNull(AttestWire.nextCounter(-1))
    }

    @Test
    fun bytes() {
        assertArrayEquals(challenge, AttestWire.bytes("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="))
        assertNull(AttestWire.bytes(""))
        assertNull(AttestWire.bytes("not base64!"))
        assertNull(AttestWire.bytes(42))
        assertNull(AttestWire.bytes(null))
    }
}
