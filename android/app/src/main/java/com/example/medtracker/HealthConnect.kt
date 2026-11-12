package com.example.medtracker

import android.app.Activity
import android.content.Context
import android.os.Build
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.aggregate.AggregateMetric
import androidx.health.connect.client.changes.Change
import androidx.health.connect.client.changes.DeletionChange
import androidx.health.connect.client.changes.UpsertionChange
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.BloodPressureRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.request.AggregateGroupByPeriodRequest
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.request.ChangesTokenRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import androidx.health.connect.client.units.Mass
import androidx.health.connect.client.units.Pressure
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.time.Duration
import java.time.Instant
import java.time.LocalDateTime
import java.time.Period
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.temporal.ChronoUnit
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.math.abs
import kotlin.math.roundToLong
import kotlin.reflect.KClass

/**
 * window.Health on Android (bd med-nt9p.8, .9, med-8f4s.2): Health Connect —
 * the twin of ios/App/Health.swift, answering the same ops with the same
 * sample shapes; web/domain/healthimport.js maps them into the vault.
 *
 *   health.authorize {types, write?}       → Boolean (false: no Health Connect on this device)
 *   health.writeAccess {types}            → {granted: [...], supported: ["bp", "weight", "hr", "workout"], readableFrom}
 *   health.write {type, id, version, at, systolic?, diastolic?, kg?, bpm?} → true
 *   health.write {type: "workout", id, version, start, end, activity} → true
 *   health.write {entries: [single-write body, ...]} → [true | error string, ...]
 *     activity: exactly 50 (strength training) or 3000 (other workout); end > start.
 *     No title, exercises, sets, weights, segments, calories, distance or heart rate.
 *   health.delete {type, id}              → true (only our clientRecordId, never a store UUID)
 *   health.query {type, anchor?, limit?}   → {samples, anchor, returned, more}
 *   health.query {type: "sleep", from, to} → {samples, from, to, returned: 0, more: false}
 *   health.query {type: "steps", from, to?} → {samples: [{day, steps, tz}], returned, more: false}
 *
 * Kinds: "bp" {uuid, start, systolic, diastolic}, "weight" {uuid, start, kg},
 * "sleep" {uuid, start, end, value, source, tz?} (value = HealthKit's
 * HKCategoryValueSleepAnalysis; a sleep page carries the {from, to} window it
 * covers, padded like Health.swift) and "workout" {uuid, start, end, activity,
 * duration, hr?, energy?, distance?} (activity = HealthKit's
 * HKWorkoutActivityType raw value, so the page's name table applies).
 * "hr" {uuid, start, value} (bpm; one sample per HeartRateRecord series point,
 * uuid "<recordId>-<index>"), "spo2" {uuid, start, value} (percent 0-100) and
 * "steps", a windowed daily aggregate (bd med-0xad.3): one {day: "YYYY-MM-DD",
 * steps, tz} per local day in this device's zone, Health Connect's own
 * cross-app dedupe (aggregateGroupByPeriod) — never a sum of records.
 * The page stores these as `source: 'apple_health'` on purpose: healthsource.js derives the stable -hk- recordId only for that value — do not "fix" it to a Health Connect source.
 *
 * Anchor = "hc1:" + a Health Connect Changes token. No anchor (or an expired
 * token) reads from `from` (ms; the page sends 90 days back for hr/spo2), else
 * the last 30 days, and starts a token; hr/spo2 scans answer about `limit`
 * samples per page with more: true and an "hc1s:" scan anchor until drained, and
 * only then the Changes token. Data older than 30 days before the grant needs
 * READ_HEALTH_DATA_HISTORY, asked for with the read types where the device
 * offers it (bd med-0xad.3); without it the reads answer what is readable.
 * An unknown type: authorize ignores it, query rejects. Reads happen only when the page asks,
 * i.e. while the app is in the foreground — never in the background. Opt-in
 * BP/weight writes use the vault id and committed version for upsert; a BP's
 * pulse uses the supplied <vault id>/pulse verbatim. AndroidX 1.1.0 permits
 * equal start/end times: a pulse has one sample and both endpoints at `at`.
 * Grants are real write permissions; supported lists capabilities even if denied. Our
 * package's records with a clientRecordId are excluded from import; records
 * without one (including QaHealthWrite's external-app stand-in) still import.
 */
class HealthConnect(private val activity: Activity, private val diag: (String) -> Unit = {}) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val client by lazy { HealthConnectClient.getOrCreate(activity) }
    /** The kinds whose permissions this install has requested (see query). */
    private val prefs by lazy { activity.getSharedPreferences("health", Context.MODE_PRIVATE) }
    /** Resumed by onRequestPermissionsResult: Health Connect permissions are runtime permissions from Android 14. */
    private var pendingAuth: (() -> Unit)? = null

    fun handle(op: String, args: JSONObject?, answer: (Any?, String?) -> Unit) {
        scope.launch {
            val (result, error) = try {
                dispatch(op, args ?: JSONObject()) to null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                diag("health $op ${args?.optString("type")} error ${e.javaClass.simpleName}") // never e.message: SDK validation text can echo a record value
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

    // Android 14+ only (bd med-5xx2): on 12/13 the separate Health Connect app's permission flow is out of scope.
    private fun available() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE &&
        HealthConnectClient.getSdkStatus(activity) == HealthConnectClient.SDK_AVAILABLE

    private suspend fun dispatch(op: String, args: JSONObject): Any = when (op) {
        "health.authorize" -> authorize(args)
        "health.query" -> query(args)
        "health.writeAccess" -> writeAccess(args)
        "health.write" -> write(args)
        "health.delete" -> delete(args)
        else -> throw IllegalArgumentException("unsupported: $op")
    }

    /** Like HealthKit, says only whether a store exists: a denied type just returns no samples. */
    private suspend fun authorize(args: JSONObject): Boolean {
        if (!available()) return false
        val types = args.optJSONArray("types") ?: JSONArray()
        val kinds = (0 until types.length()).map { types.optString(it) }.filter { it in KINDS }
        val write = args.optJSONArray("write") ?: JSONArray()
        val writes = (0 until write.length()).map { write.optString(it) }.filter { it in WRITABLE }
        if (kinds.isNotEmpty() || writes.isNotEmpty()) ask(kinds, writes)
        return true
    }

    private suspend fun writeAccess(args: JSONObject): JSONObject {
        // An unavailable/updating store is an error, not an empty grant state:
        // the page keeps its pending ledger and shows the store error.
        check(available()) { "Health Connect unavailable" }
        val types = args.optJSONArray("types") ?: JSONArray()
        val kinds = (0 until types.length()).map { types.optString(it) }
        val granted = client.permissionController.getGrantedPermissions()
        return JSONObject().put("granted", JSONArray(writableKinds(kinds, granted)))
            .put("supported", JSONArray(WRITABLE.keys))
            .put("readableFrom", readableFrom(granted))
    }

    private suspend fun requireWrite(kind: String) {
        val type = WRITABLE[kind] ?: throw IllegalArgumentException("unknown write type: $kind")
        if (!available() || HealthPermission.getWritePermission(type) !in client.permissionController.getGrantedPermissions()) {
            throw SecurityException("denied")
        }
    }

    private suspend fun write(args: JSONObject): Any {
        if (args.has("entries")) {
            check(available()) { "Health Connect unavailable" }
            // One permission snapshot and one insert for the pass, rather than
            // a binder call per entry. A revoked grant still makes insert throw.
            val granted = client.permissionController.getGrantedPermissions()
            return writeEntries(args.getJSONArray("entries"), { kind ->
                val type = WRITABLE[kind] ?: throw IllegalArgumentException("unknown write type: $kind")
                if (HealthPermission.getWritePermission(type) !in granted) throw SecurityException("denied")
            }, { records -> client.insertRecords(records) })
        }
        val kind = args.getString("type")
        requireWrite(kind)
        val record = writeBody(args)
        // Older clientRecordVersions cannot replace a newer record. Android 14
        // accepts equal-version replays: a committed version must keep its payload.
        client.insertRecords(listOf(record))
        return true
    }

    private suspend fun delete(args: JSONObject): Boolean {
        val kind = args.getString("type")
        requireWrite(kind)
        val id = args.getString("id").also { require(it.isNotBlank()) { "missing id" } }
        // The client-ID overload is scoped by Health Connect to this package.
        // Never pass an imported Health UUID in recordIdsList: a vault delete
        // must not erase another app's reading. Unknown client ids are no-ops.
        client.deleteRecords(WRITABLE.getValue(kind), recordIdsList = emptyList(), clientRecordIdsList = listOf(id))
        return true
    }

    private fun asked(): Set<String> = prefs.getStringSet(ASKED, null).orEmpty()

    /** Requests missing reads and optional writes together; existing callers remain read-only. */
    private suspend fun ask(kinds: Collection<String>, writes: Collection<String> = emptyList()) {
        prefs.edit().putStringSet(ASKED, asked() + kinds).apply()
        val history = HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY.takeIf {
            client.features.getFeatureStatus(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_HISTORY) ==
                HealthConnectFeatures.FEATURE_STATUS_AVAILABLE
        }
        val perms = (kinds.flatMap { KINDS.getValue(it) }.map { HealthPermission.getReadPermission(it) } +
            writes.map { HealthPermission.getWritePermission(WRITABLE.getValue(it)) } + listOfNotNull(history)).toSet() -
            client.permissionController.getGrantedPermissions()
        if (perms.isEmpty()) return
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
    }

    private suspend fun query(args: JSONObject): JSONObject {
        val kind = args.optString("type")
        val types = KINDS[kind] ?: throw IllegalArgumentException("unknown type: $kind")
        if (!available()) return page(JSONArray(), null, 0, false)
        // The med-nt9p.8 build answered authorize for sleep/workout without
        // asking, and the page then recorded them as asked (wg.health.asked),
        // so it never asks again: ask here, once, for every kind this install
        // has not requested yet — one dialog, on the first query after update.
        if (kind !in asked()) ask(KINDS.keys - asked())
        val type = types.first()
        val granted = client.permissionController.getGrantedPermissions()
        // Denied: no samples, no anchor — the page keeps its anchor for when access is granted.
        if (HealthPermission.getReadPermission(type) !in granted) {
            diag("health $kind denied")
            return page(JSONArray(), null, 0, false)
        }

        if (kind == "steps") return steps(args)

        if (kind == "sleep") {
            val from = args.optDouble("from"); val to = args.optDouble("to")
            if (!from.isNaN() && !to.isNaN()) {
                val samples = sleepSamples(Instant.ofEpochMilli(from.toLong()), Instant.ofEpochMilli(to.toLong()))
                return page(samples, null, 0, false).put("from", from.toLong()).put("to", to.toLong())
            }
        }

        var changed: List<Record>? = null
        // Ids Health Connect reports deleted since the token; scan modes have none.
        var deleted = emptyList<String>()
        var anchor = ""
        var returned = 0
        var more = false
        var mode = "scan"
        val token = args.optString("anchor").takeIf { it.startsWith(PREFIX) }?.removePrefix(PREFIX)
        if (token != null) {
            val r = client.getChanges(token)
            mode = if (r.changesTokenExpired) "expired-scan" else "changes"
            if (!r.changesTokenExpired) {
                changed = r.changes.mapNotNull { (it as? UpsertionChange)?.record }
                if (kind in DELETES) deleted = deletedIds(r.changes)
                anchor = PREFIX + r.nextChangesToken
                returned = r.changes.size
                more = r.hasMore
            }
            // Unused for 30 days: start over below (known readings are skipped by id).
        }
        // A dense kind's scan cut short by `limit`: "hc1s:<changes token> <from ms> <page token>".
        val cont = args.optString("anchor").takeIf { it.startsWith(SCAN_PREFIX) }
            ?.removePrefix(SCAN_PREFIX)?.split(' ', limit = 3)?.takeIf { it.size == 3 && it[1].toLongOrNull() != null }
        val records = changed ?: run {
            val limit = args.optInt("limit", 0).takeIf { kind in DENSE && it > 0 }
            if (cont != null && limit != null) {
                mode = "scan-cont"
                val from = TimeRangeFilter.after(Instant.ofEpochMilli(cont[1].toLong()))
                // A page token Health Connect no longer takes: rescan from the start (known readings are skipped).
                val next = runCatching { readUntil(type, from, cont[2], limit) }.getOrNull()
                if (next != null) {
                    anchor = next.second?.let { "$SCAN_PREFIX${cont[0]} ${cont[1]} $it" } ?: (PREFIX + cont[0])
                    more = next.second != null
                    return@run next.first.also { returned = it.size }
                }
                mode = "scan"
            }
            // The token first, so a reading saved during the read comes back as a change (a no-op by id).
            val changesToken = client.getChangesToken(ChangesTokenRequest(setOf(type)))
            anchor = PREFIX + changesToken
            val fromMs = args.optDouble("from").takeUnless { it.isNaN() }?.toLong()
                ?: Instant.now().minus(HISTORY_DAYS, ChronoUnit.DAYS).toEpochMilli()
            val filter = TimeRangeFilter.after(Instant.ofEpochMilli(fromMs))
            if (limit == null) {
                // ponytail: bp/weight answer the whole window at once (limit ignored) — a
                // month of readings is small; page them like DENSE if a scale's history ever isn't.
                readAll(type, filter)
            } else {
                // hr/spo2 (a watch writes HR about once a minute): about `limit` samples per answer.
                val (recs, pageToken) = readUntil(type, filter, null, limit)
                if (pageToken != null) {
                    anchor = "$SCAN_PREFIX$changesToken $fromMs $pageToken"
                    more = true
                }
                recs
            }.also { returned = it.size }
        }

        // Copy diagnostics (bd med-nt9p.59): per kind, how it read and how much came back.
        diag("health $kind $mode read=$returned records=${records.size} more=$more" +
            if (kind in DELETES) " deleted=${deleted.size}" else "")
        // Off the main thread: a page of samples can be large; the answer is posted from Main in handle.
        return withContext(Dispatchers.Default) { when (kind) {
            "sleep" -> {
                // Like Health.swift: the changes find what is new; the answer is
                // every sleep sample around it, with the window as from/to.
                val sessions = records.filterIsInstance<SleepSessionRecord>()
                if (sessions.isEmpty()) page(JSONArray(), anchor, returned, more) else {
                    val from = sessions.minOf { it.startTime }.minus(SLEEP_PAD)
                    val to = sessions.maxOf { it.endTime }.plus(SLEEP_PAD)
                    page(sleepSamples(from, to), anchor, returned, more)
                        .put("from", from.toEpochMilli()).put("to", to.toEpochMilli())
                }
            }
            "workout" -> JSONArray().apply {
                importableWorkouts(records, activity.packageName).forEach { put(workout(it, granted)) }
            }.let { page(it, anchor, returned, more) }
            else -> JSONArray().apply { records.filterNot {
                isOwnWrite(it.metadata.dataOrigin.packageName, it.metadata.clientRecordId, activity.packageName)
            }
                .forEach { r -> samples(r).forEach { put(it) } } }
                .let { page(it, anchor, returned, more) }
        }.apply { if (kind in DELETES) put("deleted", JSONArray(deleted)) } }
    }

    private suspend fun readAll(type: KClass<out Record>, filter: TimeRangeFilter): List<Record> {
        val out = mutableListOf<Record>()
        var pageToken: String? = null
        do {
            @Suppress("UNCHECKED_CAST")
            val r = client.readRecords(
                ReadRecordsRequest(type as KClass<Record>, filter, pageSize = 1000, pageToken = pageToken)
            )
            out += r.records
            pageToken = r.pageToken
        } while (pageToken != null)
        return out
    }

    /** Records from `pageToken` on until they hold at least `limit` samples; the token to go on from, null when drained. */
    private suspend fun readUntil(type: KClass<out Record>, filter: TimeRangeFilter, pageToken: String?, limit: Int): Pair<List<Record>, String?> {
        val out = mutableListOf<Record>()
        var points = 0
        var token = pageToken
        do {
            @Suppress("UNCHECKED_CAST")
            val r = client.readRecords(
                ReadRecordsRequest(type as KClass<Record>, filter, pageSize = DENSE_PAGE, pageToken = token)
            )
            out += r.records
            points += r.records.sumOf { (it as? HeartRateRecord)?.samples?.size ?: 1 }
            token = r.pageToken
        } while (token != null && points < limit)
        return out to token
    }

    private fun page(samples: JSONArray, anchor: String?, returned: Int, more: Boolean) =
        JSONObject().put("samples", samples).put("returned", returned).put("more", more)
            .apply { if (anchor != null) put("anchor", anchor) }

    private fun samples(r: Record): List<JSONObject> = when (r) {
        is BloodPressureRecord -> listOf(JSONObject().put("uuid", uuid(r.metadata.id)).put("start", r.time.toEpochMilli())
            .put("systolic", r.systolic.inMillimetersOfMercury).put("diastolic", r.diastolic.inMillimetersOfMercury))
        is WeightRecord -> listOf(JSONObject().put("uuid", uuid(r.metadata.id)).put("start", r.time.toEpochMilli())
            .put("kg", r.weight.inKilograms))
        // A series: the page merges by instant, so a series that grows re-sends its points harmlessly.
        is HeartRateRecord -> r.samples.mapIndexed { i, p ->
            JSONObject().put("uuid", "${r.metadata.id}-$i").put("start", p.time.toEpochMilli()).put("value", p.beatsPerMinute)
        }
        is OxygenSaturationRecord -> listOf(JSONObject().put("uuid", uuid(r.metadata.id)).put("start", r.time.toEpochMilli())
            .put("value", r.percentage.value))
        else -> emptyList()
    }

    /** Daily step totals over [from, to] (default: the last 7 days to now), whole local days in the device zone. */
    private suspend fun steps(args: JSONObject): JSONObject {
        val zone = ZoneId.systemDefault()
        val now = Instant.now()
        val from = args.optDouble("from").takeUnless { it.isNaN() }?.let { Instant.ofEpochMilli(it.toLong()) }
            ?: now.minus(7, ChronoUnit.DAYS)
        val to = args.optDouble("to").takeUnless { it.isNaN() }?.let { Instant.ofEpochMilli(it.toLong()) } ?: now
        val start = from.atZone(zone).toLocalDate().atStartOfDay()
        val end = LocalDateTime.ofInstant(to, zone)
        val out = JSONArray()
        if (end.isAfter(start)) {
            client.aggregateGroupByPeriod(
                AggregateGroupByPeriodRequest(setOf(StepsRecord.COUNT_TOTAL), TimeRangeFilter.between(start, end), Period.ofDays(1))
            ).forEach { g ->
                g.result[StepsRecord.COUNT_TOTAL]?.let {
                    out.put(JSONObject().put("day", g.startTime.toLocalDate().toString()).put("steps", it).put("tz", zone.id))
                }
            }
        }
        diag("health steps aggregate days=${out.length()}")
        return page(out, null, out.length(), false)
    }

    /**
     * Every sleep session (all apps) overlapping [from, to], as HealthKit-style
     * samples: one per stage, or one "asleep" sample for a session without stages.
     */
    private suspend fun sleepSamples(from: Instant, to: Instant): JSONArray {
        val out = JSONArray()
        for (s in readAll(SleepSessionRecord::class, TimeRangeFilter.between(from, to))) {
            if (s !is SleepSessionRecord) continue
            val tz = zoneName(s.endZoneOffset)
            val parts = if (s.stages.isEmpty()) {
                listOf(Triple(s.metadata.id, s.startTime to s.endTime, 1))
            } else {
                s.stages.mapNotNull { st ->
                    sleepValue(st.stage)?.let { Triple("${s.metadata.id}/${st.startTime.toEpochMilli()}", st.startTime to st.endTime, it) }
                }
            }
            for ((id, span, value) in parts) {
                out.put(JSONObject().put("uuid", uuid(id)).put("start", span.first.toEpochMilli())
                    .put("end", span.second.toEpochMilli()).put("value", value)
                    .put("source", s.metadata.dataOrigin.packageName)
                    .apply { if (tz != null) put("tz", tz) })
            }
        }
        return out
    }

    /** Active duration, heart rate, energy and distance from the session's own app over its window — Health.swift's workout statistics. */
    private suspend fun workout(w: ExerciseSessionRecord, granted: Set<String>): JSONObject {
        val o = JSONObject().put("uuid", uuid(w.metadata.id)).put("start", w.startTime.toEpochMilli())
            .put("end", w.endTime.toEpochMilli()).put("activity", hkActivity(w.exerciseType))
            .put("duration", Duration.between(w.startTime, w.endTime).toMillis() / 1000.0)
        val metrics = buildSet<AggregateMetric<*>> {
            add(ExerciseSessionRecord.EXERCISE_DURATION_TOTAL) // without pauses, like HKWorkout.duration
            if (HealthPermission.getReadPermission(HeartRateRecord::class) in granted) add(HeartRateRecord.BPM_AVG)
            if (HealthPermission.getReadPermission(TotalCaloriesBurnedRecord::class) in granted) add(TotalCaloriesBurnedRecord.ENERGY_TOTAL)
            if (HealthPermission.getReadPermission(DistanceRecord::class) in granted) add(DistanceRecord.DISTANCE_TOTAL)
        }
        if (!w.endTime.isAfter(w.startTime)) return o
        val a = client.aggregate(workoutRequest(w, metrics))
        a[ExerciseSessionRecord.EXERCISE_DURATION_TOTAL]?.let { o.put("duration", it.toMillis() / 1000.0) }
        a[HeartRateRecord.BPM_AVG]?.let { o.put("hr", it) }
        a[TotalCaloriesBurnedRecord.ENERGY_TOTAL]?.let { o.put("energy", it.inKilocalories) }
        a[DistanceRecord.DISTANCE_TOTAL]?.let { o.put("distance", it.inMeters) }
        return o
    }

    internal companion object {
        /** A rolling conservative bound: the provider resets its anchor on a
         * full permission revoke, which can happen while our process is gone.
         * Never infer that unseen grant epoch from persisted app preferences.
         */
        fun readableFrom(granted: Set<String>, now: Long = System.currentTimeMillis()): Long =
            if (HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY in granted) 0
            else now - Duration.ofDays(HISTORY_DAYS).toMillis()

        /** The actual pass executor: validation errors are per entry, store errors are not.
         * insertRecords is atomic and throws on service/permission failure:
         * https://developer.android.com/reference/kotlin/androidx/health/connect/client/HealthConnectClient#insertRecords(kotlin.collections.List)
         */
        suspend fun writeEntries(entries: JSONArray, requireWrite: (String) -> Unit,
                                 insert: suspend (List<Record>) -> Unit): JSONArray {
            val results = JSONArray()
            val records = mutableListOf<Record>()
            val valid = mutableListOf<Int>()
            for (i in 0 until entries.length()) {
                try {
                    val body = entries.getJSONObject(i)
                    requireWrite(body.getString("type"))
                    records.add(writeBody(body))
                    valid.add(i)
                    results.put(JSONObject.NULL)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    results.put(e.message ?: e.javaClass.simpleName)
                }
            }
            // Do not catch this: the web must keep every pending id on a whole-call failure.
            if (records.isNotEmpty()) insert(records)
            for (i in valid) results.put(i, true)
            return results
        }

        private fun writeBody(args: JSONObject): Record {
            val kind = args.getString("type")
            return if (kind == "workout") writeRecord(kind, args.getString("id"), args.getLong("version"),
                start = workoutMillis(args.opt("start"), "start"), end = workoutMillis(args.opt("end"), "end"),
                activity = (args.opt("activity") as? Number)?.toDouble() ?: Double.NaN)
            else writeRecord(kind, args.getString("id"), args.getLong("version"), args.getLong("at"),
                args.optDouble("systolic"), args.optDouble("diastolic"), args.optDouble("kg"), args.optDouble("bpm"))
        }

        fun workoutRequest(w: ExerciseSessionRecord, metrics: Set<AggregateMetric<*>>) =
            AggregateRequest(metrics, TimeRangeFilter.between(w.startTime, w.endTime), setOf(w.metadata.dataOrigin))

        val WRITABLE: Map<String, KClass<out Record>> = mapOf(
            "bp" to BloodPressureRecord::class, "weight" to WeightRecord::class, "hr" to HeartRateRecord::class,
            "workout" to ExerciseSessionRecord::class)

        fun writableKinds(kinds: Collection<String>, granted: Set<String>): List<String> = kinds.distinct().filter {
            WRITABLE[it]?.let { type -> HealthPermission.getWritePermission(type) in granted } == true
        }

        fun isOwnWrite(originPackage: String, clientRecordId: String?, packageName: String): Boolean =
            originPackage == packageName && clientRecordId != null

        fun importableWorkouts(records: List<Record>, packageName: String): List<ExerciseSessionRecord> =
            records.filterIsInstance<ExerciseSessionRecord>().filterNot {
                isOwnWrite(it.metadata.dataOrigin.packageName, it.metadata.clientRecordId, packageName)
            }

        /** JSON numbers only: getLong/optInt would silently accept strings or truncate fractions. */
        fun workoutMillis(value: Any?, field: String): Long {
            val number = (value as? Number)?.toDouble()
            require(number != null && number.isFinite() && number % 1.0 == 0.0 &&
                number >= -9007199254740991.0 && number <= 9007199254740991.0) { "bad write: $field" }
            return number.toLong()
        }

        fun writeRecord(kind: String, id: String, version: Long, at: Long = 0,
                        systolic: Double = Double.NaN, diastolic: Double = Double.NaN,
                        kg: Double = Double.NaN, bpm: Double = Double.NaN,
                        start: Long = 0, end: Long = 0, activity: Double = Double.NaN): Record {
            require(id.isNotBlank()) { "missing id" }
            require(version >= 0) { "invalid version" }
            val time = Instant.ofEpochMilli(at)
            val offset = ZoneId.systemDefault().rules.getOffset(time)
            val metadata = Metadata.manualEntry(clientRecordId = id, clientRecordVersion = version)
            return when (kind) {
                "bp" -> {
                    require(systolic.isFinite() && diastolic.isFinite()) { "invalid blood pressure" }
                    BloodPressureRecord(time = time, zoneOffset = offset, metadata = metadata,
                        systolic = Pressure.millimetersOfMercury(systolic), diastolic = Pressure.millimetersOfMercury(diastolic))
                }
                "weight" -> {
                    require(kg.isFinite()) { "invalid weight" }
                    WeightRecord(time = time, zoneOffset = offset, metadata = metadata, weight = Mass.kilograms(kg))
                }
                "hr" -> {
                    require(bpm.isFinite() && bpm > 0) { "invalid heart rate" }
                    HeartRateRecord(startTime = time, startZoneOffset = offset,
                        endTime = time, endZoneOffset = offset,
                        samples = listOf(HeartRateRecord.Sample(time, bpm.roundToLong())), metadata = metadata)
                }
                "workout" -> {
                    val exerciseType = when (activity) {
                        50.0 -> ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING
                        3000.0 -> ExerciseSessionRecord.EXERCISE_TYPE_OTHER_WORKOUT
                        else -> throw IllegalArgumentException("bad write: activity")
                    }
                    require(end > start) { "bad write: end" }
                    val from = Instant.ofEpochMilli(start)
                    val to = Instant.ofEpochMilli(end)
                    ExerciseSessionRecord(startTime = from, startZoneOffset = ZoneId.systemDefault().rules.getOffset(from),
                        endTime = to, endZoneOffset = ZoneId.systemDefault().rules.getOffset(to),
                        metadata = metadata, exerciseType = exerciseType)
                }
                else -> throw IllegalArgumentException("unknown write type: $kind")
            }
        }

        /** Each kind's record types; the first is the one queried, the rest are a workout's totals. */
        val KINDS: Map<String, List<KClass<out Record>>> = mapOf(
            "bp" to listOf(BloodPressureRecord::class),
            "weight" to listOf(WeightRecord::class),
            "steps" to listOf(StepsRecord::class),
            "hr" to listOf(HeartRateRecord::class),
            "spo2" to listOf(OxygenSaturationRecord::class),
            "sleep" to listOf(SleepSessionRecord::class),
            "workout" to listOf(
                ExerciseSessionRecord::class, HeartRateRecord::class,
                TotalCaloriesBurnedRecord::class, DistanceRecord::class,
            ),
        )
        const val PREFIX = "hc1:"
        const val SCAN_PREFIX = "hc1s:"
        /** Kinds whose first scan pages by `limit` (samples), DENSE_PAGE records per Health Connect read. */
        val DENSE = setOf("hr", "spo2")
        const val DENSE_PAGE = 100
        const val ASKED = "asked"
        const val HISTORY_DAYS = 30L
        const val REQUEST_PERMISSIONS = 7301
        /** Health.swift's sleepPad: the window holds every night of each sleep day it touches. */
        val SLEEP_PAD: Duration = Duration.ofHours(48)
        val UUID_RE = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

        /** Health Connect ids are UUIDs; anything else gets a stable name-based one (the vault id needs a UUID). */
        fun uuid(id: String): String =
            if (UUID_RE.matches(id)) id else UUID.nameUUIDFromBytes(id.toByteArray()).toString()

        /** Kinds whose anchored replies carry `deleted`; hr/spo2 merge by instant, steps is an aggregate. */
        val DELETES = setOf("bp", "weight", "sleep", "workout")

        /** A changes page's deleted record ids, through the same uuid() the imported samples use. */
        fun deletedIds(changes: List<Change>): List<String> =
            changes.filterIsInstance<DeletionChange>().map { uuid(it.recordId) }

        /** Health Connect sleep stage → HKCategoryValueSleepAnalysis; null = not sleep data (out of bed, like inBed). */
        fun sleepValue(stage: Int): Int? = when (stage) {
            SleepSessionRecord.STAGE_TYPE_SLEEPING, SleepSessionRecord.STAGE_TYPE_UNKNOWN -> 1 // asleepUnspecified
            SleepSessionRecord.STAGE_TYPE_AWAKE, SleepSessionRecord.STAGE_TYPE_AWAKE_IN_BED -> 2
            SleepSessionRecord.STAGE_TYPE_LIGHT -> 3 // asleepCore
            SleepSessionRecord.STAGE_TYPE_DEEP -> 4
            SleepSessionRecord.STAGE_TYPE_REM -> 5
            else -> null
        }

        /**
         * The night's zone for the page, from the session's own end offset (the
         * page needs only that offset) — never this device's zone, so every
         * device and every rescan names it alike: Etc/GMT∓h for whole hours
         * (any Intl), else the "+05:30" offset form (Intl offset zones; a
         * WebView without them falls back to UTC, the no-tz default).
         */
        fun zoneName(offset: ZoneOffset?): String? {
            if (offset == null) return null
            val h = offset.totalSeconds / 3600
            if (offset.totalSeconds % 3600 == 0 && h in -12..14) {
                return if (h == 0) "UTC" else "Etc/GMT" + (if (h > 0) "-" else "+") + abs(h) // POSIX sign: Etc/GMT-2 is UTC+2
            }
            return offset.id
        }

        /**
         * Health Connect exercise type → HKWorkoutActivityType raw value, for the
         * page's workout name table (healthimport.js WORKOUT_NAMES); 3000 (other)
         * becomes "Workout". 50 and 20 are the strength types.
         */
        fun hkActivity(type: Int): Int = when (type) {
            ExerciseSessionRecord.EXERCISE_TYPE_RUNNING, ExerciseSessionRecord.EXERCISE_TYPE_RUNNING_TREADMILL -> 37
            ExerciseSessionRecord.EXERCISE_TYPE_WALKING -> 52
            ExerciseSessionRecord.EXERCISE_TYPE_BIKING, ExerciseSessionRecord.EXERCISE_TYPE_BIKING_STATIONARY -> 13
            ExerciseSessionRecord.EXERCISE_TYPE_HIKING -> 24
            ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_POOL, ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_OPEN_WATER -> 46
            ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING, ExerciseSessionRecord.EXERCISE_TYPE_WEIGHTLIFTING -> 50
            ExerciseSessionRecord.EXERCISE_TYPE_CALISTHENICS -> 20
            ExerciseSessionRecord.EXERCISE_TYPE_HIGH_INTENSITY_INTERVAL_TRAINING -> 63
            ExerciseSessionRecord.EXERCISE_TYPE_ELLIPTICAL -> 16
            ExerciseSessionRecord.EXERCISE_TYPE_ROWING, ExerciseSessionRecord.EXERCISE_TYPE_ROWING_MACHINE -> 35
            ExerciseSessionRecord.EXERCISE_TYPE_STAIR_CLIMBING, ExerciseSessionRecord.EXERCISE_TYPE_STAIR_CLIMBING_MACHINE -> 44
            ExerciseSessionRecord.EXERCISE_TYPE_YOGA -> 57
            ExerciseSessionRecord.EXERCISE_TYPE_PILATES -> 66
            ExerciseSessionRecord.EXERCISE_TYPE_DANCING -> 14
            else -> 3000
        }
    }
}
