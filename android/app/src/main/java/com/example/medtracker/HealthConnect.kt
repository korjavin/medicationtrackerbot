package com.example.medtracker

import android.app.Activity
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.changes.UpsertionChange
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.BloodPressureRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.ChangesTokenRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.reflect.KClass

/**
 * window.Health on Android (bd med-nt9p.8): Health Connect, READ-ONLY — the
 * twin of ios/App/Health.swift, answering the same ops with the same sample
 * shapes; web/domain/healthimport.js maps them into the vault.
 *
 *   health.authorize {types}             → Boolean (false: no Health Connect on this device)
 *   health.query {type, anchor?, limit?} → {samples, anchor, returned, more}
 *
 * Kinds: "bp" {uuid, start, systolic, diastolic} and "weight" {uuid, start, kg}.
 * "sleep" and "workout" (med-nt9p.9) answer an empty page for now.
 *
 * Anchor = "hc1:" + a Health Connect Changes token. No anchor (or an expired
 * token) reads the last 30 days and starts a token; older history needs
 * READ_HEALTH_DATA_HISTORY, out of v1. Reads happen only when the page asks,
 * i.e. while the app is in the foreground — never in the background.
 */
class HealthConnect(private val activity: Activity) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val client by lazy { HealthConnectClient.getOrCreate(activity) }
    /** Resumed by onRequestPermissionsResult: Health Connect permissions are runtime permissions from Android 14. */
    private var pendingAuth: (() -> Unit)? = null

    fun handle(op: String, args: JSONObject?, answer: (Any?, String?) -> Unit) {
        scope.launch {
            val (result, error) = try {
                dispatch(op, args ?: JSONObject()) to null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                null to (e.message ?: e.javaClass.simpleName)
            }
            runCatching { answer(result, error) } // the WebView may be gone by now
        }
    }

    /** MainActivity forwards its permission results; true when the request was ours. */
    fun onRequestPermissionsResult(requestCode: Int): Boolean {
        if (requestCode != REQUEST_PERMISSIONS) return false
        pendingAuth?.also { pendingAuth = null }?.invoke()
        return true
    }

    fun close() {
        pendingAuth = null
        scope.cancel()
    }

    private fun available() =
        HealthConnectClient.getSdkStatus(activity) == HealthConnectClient.SDK_AVAILABLE

    private suspend fun dispatch(op: String, args: JSONObject): Any = when (op) {
        "health.authorize" -> authorize(args)
        "health.query" -> query(args)
        else -> throw IllegalArgumentException("unsupported: $op")
    }

    /** Like HealthKit, says only whether a store exists: a denied type just returns no samples. */
    private suspend fun authorize(args: JSONObject): Boolean {
        if (!available()) return false
        val kinds = args.optJSONArray("types") ?: JSONArray()
        val perms = (0 until kinds.length()).mapNotNull { TYPES[kinds.optString(it)] }
            .map { HealthPermission.getReadPermission(it) }.toSet()
        if (perms.isEmpty()) {
            // Only kinds this build does not read yet (sleep/workout, med-nt9p.9).
            if (kinds.length() > 0) return true
            throw IllegalArgumentException("no known types")
        }
        if (client.permissionController.getGrantedPermissions().containsAll(perms)) return true
        suspendCancellableCoroutine { cont ->
            pendingAuth?.invoke()
            pendingAuth = { if (cont.isActive) cont.resume(Unit) }
            try {
                activity.requestPermissions(perms.toTypedArray(), REQUEST_PERMISSIONS)
            } catch (e: Exception) {
                pendingAuth = null
                cont.resume(Unit)
            }
        }
        return true
    }

    private suspend fun query(args: JSONObject): JSONObject {
        val type = TYPES[args.optString("type")] ?: return page(JSONArray(), null, 0, false)
        if (!available()) return page(JSONArray(), null, 0, false)
        // Denied: no samples, no anchor — the page keeps its anchor for when access is granted.
        if (HealthPermission.getReadPermission(type) !in client.permissionController.getGrantedPermissions()) {
            return page(JSONArray(), null, 0, false)
        }
        val token = args.optString("anchor").takeIf { it.startsWith(PREFIX) }?.removePrefix(PREFIX)
        if (token != null) {
            val r = client.getChanges(token)
            if (!r.changesTokenExpired) {
                val samples = JSONArray()
                r.changes.forEach { c -> (c as? UpsertionChange)?.record?.let(::sample)?.let { samples.put(it) } }
                return page(samples, PREFIX + r.nextChangesToken, r.changes.size, r.hasMore)
            }
            // Unused for 30 days: start over below (known readings are skipped by id).
        }
        // The token first, so a reading saved during the read comes back as a change (a no-op by id).
        val next = client.getChangesToken(ChangesTokenRequest(setOf(type)))
        val since = Instant.now().minus(HISTORY_DAYS, ChronoUnit.DAYS)
        val samples = JSONArray()
        var count = 0
        var pageToken: String? = null
        // ponytail: the whole 30-day window in one answer (limit ignored) — a
        // month of BP/weight is small; page it if a scale's history ever isn't.
        do {
            @Suppress("UNCHECKED_CAST")
            val r = client.readRecords(
                ReadRecordsRequest(type as KClass<Record>, TimeRangeFilter.after(since), pageSize = 1000, pageToken = pageToken)
            )
            r.records.forEach { rec -> sample(rec)?.let { samples.put(it) } }
            count += r.records.size
            pageToken = r.pageToken
        } while (pageToken != null)
        return page(samples, PREFIX + next, count, false)
    }

    private fun page(samples: JSONArray, anchor: String?, returned: Int, more: Boolean) =
        JSONObject().put("samples", samples).put("returned", returned).put("more", more)
            .apply { if (anchor != null) put("anchor", anchor) }

    private fun sample(r: Record): JSONObject? = when (r) {
        is BloodPressureRecord -> JSONObject().put("uuid", uuid(r.metadata.id)).put("start", r.time.toEpochMilli())
            .put("systolic", r.systolic.inMillimetersOfMercury).put("diastolic", r.diastolic.inMillimetersOfMercury)
        is WeightRecord -> JSONObject().put("uuid", uuid(r.metadata.id)).put("start", r.time.toEpochMilli())
            .put("kg", r.weight.inKilograms)
        else -> null
    }

    private companion object {
        val TYPES: Map<String, KClass<out Record>> = mapOf("bp" to BloodPressureRecord::class, "weight" to WeightRecord::class)
        const val PREFIX = "hc1:"
        const val HISTORY_DAYS = 30L
        const val REQUEST_PERMISSIONS = 7301
        val UUID_RE = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

        /** Health Connect ids are UUIDs; anything else gets a stable name-based one (the vault id needs a UUID). */
        fun uuid(id: String): String =
            if (UUID_RE.matches(id)) id else UUID.nameUUIDFromBytes(id.toByteArray()).toString()
    }
}
