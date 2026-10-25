package com.example.medtracker

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.tasks.Task
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.StandardIntegrityException
import com.google.android.play.core.integrity.StandardIntegrityManager.PrepareIntegrityTokenRequest
import com.google.android.play.core.integrity.StandardIntegrityManager.StandardIntegrityTokenProvider
import com.google.android.play.core.integrity.StandardIntegrityManager.StandardIntegrityTokenRequest
import com.google.android.play.core.integrity.model.StandardIntegrityErrorCode
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * window.Attest on Android (bd med-nt9p.32.8.4): the twin of ios/App/Attest.swift for local
 * mode's anonymous trial, over a Keystore P-256 key and a Play Integrity standard request.
 * Server half: enrollAndroid in internal/cloudserver/attest.go + internal/playintegrity
 * (docs/cloud-mode.md → Android — Play Integrity); page client: web/cloud/js/local-trial.js over
 * web/static/js/native/attest.js. MainActivity answers these ops only in local mode
 * (LocalOrigin.LOCAL_OPS). The key proves a genuine Play build on a device with integrity, per
 * install — not who asked or what the user meant.
 *
 *   attest.status → {supported, base, attested} (no network): supported = Play services AND a
 *     cloud project number in this build AND a base domain; attested = the current key was
 *     handed to the page by an enroll.
 *   attest.enroll {challenge} → {kind: "android", keyId, publicKey, integrityToken, pass?}: the
 *     current key, or a new one when none is usable. publicKey = SPKI DER (std base64), keyId =
 *     base64url-nopad(SHA256(SPKI)), the token's requestHash binds challenge + key
 *     (AttestWire.requestHash). Failure: the Play error name only.
 *   attest.setPass {pass} → null: keeps the trial pass ("" deletes it).
 *   attest.assert {challenge, bodySha256} → {keyId, assertion}: assertion = counterBE32 ‖
 *     SHA256withECDSA(clientDataHash ‖ counterBE32), clientDataHash = SHA256(challenge ‖
 *     bodySha256); the counter is stored before signing. "no_key" when there is no usable key.
 * Binary values are standard base64. Nothing here logs: Diag is user-copyable, and the token
 * and the pass must never reach it.
 *
 * State: SharedPreferences "wg_trial" (pass, key alias, attested alias, counter), in the Auto
 * Backup include rules (res/xml/data_extraction_rules.xml, bd med-nt9p.32.5). Keystore keys
 * never restore, so after a restore the alias finds no key: the next enroll makes a new one and
 * presents the restored pass, and the install rejoins its trial bucket.
 */
class Attest(private val context: Context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val prefs by lazy { context.getSharedPreferences(PREFS, Context.MODE_PRIVATE) }

    class Failure(message: String) : Exception(message)

    fun handle(op: String, args: JSONObject?, answer: (Any?, String?) -> Unit) {
        scope.launch {
            val (result, error) = try {
                dispatch(op, args ?: JSONObject()) to null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Failure) {
                null to e.message
            } catch (e: StandardIntegrityException) {
                null to playError(e.errorCode)
            } catch (e: Exception) {
                null to e.javaClass.simpleName // never e.message: it could carry what it was handed
            }
            runCatching { answer(result, error) } // the WebView may be gone by now
        }
    }

    fun close() = scope.cancel()

    /**
     * local.reset {dropAttest: true} (bd med-egb3, contract point 4, Archie 4883): our server
     * answered 204 for this key's bucket, so the key material goes and the next enroll mints a key
     * the server cannot link to the erased one. Both aliases' Keystore entries (each in
     * runCatching), then [DROP_KEYS] removed with commit() before local.reset answers. PASS stays
     * (it may name an older bucket the delete did not reach; a pass for a deleted bucket is refused
     * with trial_pass_invalid and the page drops it), and so does KEY_N, so a new alias never
     * reuses an old name.
     */
    fun drop() {
        val ks = runCatching { keyStore() }.getOrNull()
        setOfNotNull(prefs.getString(ALIAS, null), prefs.getString(ATTESTED, null))
            .forEach { alias -> runCatching { ks?.deleteEntry(alias) } }
        prefs.edit().apply { DROP_KEYS.forEach { remove(it) } }.commit()
    }

    private val projectNumber get() = BuildConfig.PLAY_CLOUD_PROJECT_NUMBER.toLongOrNull()

    private val supported
        get() = projectNumber != null && BuildConfig.BASE_DOMAIN.isNotEmpty() &&
            GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS

    private suspend fun dispatch(op: String, args: JSONObject): Any? = when (op) {
        "attest.status" -> withContext(Dispatchers.IO) {
            val alias = usableAlias()
            JSONObject().put("supported", supported).put("base", BuildConfig.BASE_DOMAIN)
                .put("attested", alias != null && alias == prefs.getString(ATTESTED, null))
        }
        "attest.enroll" -> enroll(args)
        "attest.setPass" -> {
            val pass = args.opt("pass") as? String ?: throw Failure("invalid pass")
            withContext(Dispatchers.IO) {
                prefs.edit().apply { if (pass.isEmpty()) remove(PASS) else putString(PASS, pass) }.commit()
            }
            null
        }
        "attest.assert" -> sign(args)
        else -> throw Failure("unsupported: $op")
    }

    private suspend fun enroll(args: JSONObject): JSONObject {
        if (!supported) throw Failure("unsupported")
        val challenge = AttestWire.bytes(args.opt("challenge")) ?: throw Failure("invalid base64")
        val alias = withContext(Dispatchers.IO) { usableAlias() ?: newKey() }
        val spki = withContext(Dispatchers.IO) { keyStore().getCertificate(alias).publicKey.encoded }
        val keyId = AttestWire.keyId(spki)
        val hash = AttestWire.requestHash(challenge, keyId, spki)
        val token = try {
            integrityToken(hash)
        } catch (e: StandardIntegrityException) {
            // A provider Play no longer honours: prepare a fresh one, once.
            if (e.errorCode != StandardIntegrityErrorCode.INTEGRITY_TOKEN_PROVIDER_INVALID) throw e
            provider = null
            integrityToken(hash)
        }
        withContext(Dispatchers.IO) { prefs.edit().putString(ATTESTED, alias).commit() }
        val std = Base64.getEncoder()
        return JSONObject().put("kind", "android").put("keyId", keyId)
            .put("publicKey", std.encodeToString(spki)).put("integrityToken", token)
            .apply { prefs.getString(PASS, null)?.takeIf { it.isNotEmpty() }?.let { put("pass", it) } }
    }

    private suspend fun sign(args: JSONObject): JSONObject {
        if (!supported) throw Failure("unsupported")
        val challenge = AttestWire.bytes(args.opt("challenge")) ?: throw Failure("invalid base64")
        val digest = AttestWire.bytes(args.opt("bodySha256"))?.takeIf { it.size == 32 } ?: throw Failure("invalid bodySha256")
        return withContext(Dispatchers.IO) {
            val alias = usableAlias()?.takeIf { it == prefs.getString(ATTESTED, null) } ?: throw Failure("no_key")
            val ks = keyStore()
            val key = ks.getKey(alias, null) as? PrivateKey ?: throw Failure("no_key")
            val spki = ks.getCertificate(alias).publicKey.encoded
            // Stored before signing: a crash after it costs one number, never a reused one. Locked:
            // overlapping requests (food search while typing) each get their own number.
            val counter = synchronized(counterLock) {
                val next = AttestWire.nextCounter(prefs.getLong(COUNTER, 0)) ?: throw Failure("no_key")
                if (!prefs.edit().putLong(COUNTER, next).commit()) throw Failure("prefs")
                next
            }
            val sig = Signature.getInstance("SHA256withECDSA").run {
                initSign(key)
                update(AttestWire.signedMessage(AttestWire.clientDataHash(challenge, digest), counter))
                sign()
            }
            JSONObject().put("keyId", AttestWire.keyId(spki))
                .put("assertion", Base64.getEncoder().encodeToString(AttestWire.assertion(counter, sig)))
        }
    }

    private suspend fun integrityToken(requestHash: String): String {
        val p = provider ?: IntegrityManagerFactory.createStandard(context.applicationContext)
            .prepareIntegrityToken(PrepareIntegrityTokenRequest.builder().setCloudProjectNumber(projectNumber!!).build())
            .await().also { provider = it }
        return p.request(StandardIntegrityTokenRequest.builder().setRequestHash(requestHash).build()).await().token()
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    /** The stored alias while the Keystore still holds its key (it is gone after a restore). */
    private fun usableAlias(): String? = prefs.getString(ALIAS, null)?.takeIf { keyStore().containsAlias(it) }

    /** A fresh P-256 signing key under the next alias; the previous one is dropped. */
    private fun newKey(): String {
        val n = prefs.getInt(KEY_N, 0) + 1
        val alias = "wg-attest-$n"
        val ks = keyStore()
        prefs.getString(ALIAS, null)?.let { old -> runCatching { ks.deleteEntry(old) } }
        if (ks.containsAlias(alias)) ks.deleteEntry(alias)
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE).apply {
            initialize(
                KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                    .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .build()
            )
        }.generateKeyPair()
        prefs.edit().putInt(KEY_N, n).putString(ALIAS, alias).remove(ATTESTED).commit()
        return alias
    }

    companion object {
        const val PREFS = "wg_trial"
        private const val KEYSTORE = "AndroidKeyStore"
        private const val PASS = "pass"
        private const val ALIAS = "alias"
        private const val KEY_N = "keyN"
        private const val ATTESTED = "attested"
        private const val COUNTER = "counter"

        /** What dropAttest removes from wg_trial (bd med-egb3): never PASS or KEY_N (LocalOriginTest.dropsAttest). */
        internal val DROP_KEYS = setOf(ALIAS, ATTESTED, COUNTER)

        /** Prepared once per process (Play's recommendation), lazily inside the first enroll. */
        @Volatile private var provider: StandardIntegrityTokenProvider? = null
        private val counterLock = Any()

        /** StandardIntegrityErrorCode's constant name for [code]: what the page may see of a Play failure. */
        fun playError(code: Int): String =
            StandardIntegrityErrorCode::class.java.fields.firstOrNull { runCatching { it.getInt(null) == code }.getOrDefault(false) }
                ?.name ?: "integrity_error_$code"
    }
}

private suspend fun <T> Task<T>.await(): T = suspendCancellableCoroutine { cont ->
    addOnCompleteListener { t ->
        val e = t.exception
        when {
            e != null -> cont.resumeWithException(e)
            t.isCanceled -> cont.cancel()
            else -> cont.resume(t.result)
        }
    }
}
