package com.example.medtracker

import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.BloodPressureRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.SleepSessionRecord
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneOffset
import java.time.Instant
import androidx.health.connect.client.records.metadata.DataOrigin
import androidx.health.connect.client.testing.populatedWithTestValues
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.time.TimeRangeFilter
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.Duration

// The HealthKit codes healthimport.js reads (SLEEP_PHASE, WORKOUT_NAMES, STRENGTH_TYPES).
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class HealthConnectTest {
    @Test
    fun onlyActualHistoryPermissionMakesTheWindowUnbounded() {
        val now = 1700000000000L
        val reads = setOf(HealthPermission.getReadPermission(BloodPressureRecord::class))
        // No feature flag enters this calculation: unavailable and denied both
        // retain a conservative rolling restriction, without reading prefs.
        assertEquals(now - Duration.ofDays(30).toMillis(), HealthConnect.readableFrom(reads, now))
        assertEquals(0L, HealthConnect.readableFrom(reads + HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY, now))
        assertEquals(now - Duration.ofDays(30).toMillis(), HealthConnect.readableFrom(emptySet(), now))
        assertEquals(now - Duration.ofDays(30).toMillis(), HealthConnect.readableFrom(
            setOf(HealthPermission.getWritePermission(WeightRecord::class)), now))
    }

    @Test
    fun eachAccessUsesTodaysWindowEvenIfAllPermissionsWereRegrantedWhileTheAppWasStopped() {
        val grants = setOf(HealthPermission.getReadPermission(BloodPressureRecord::class))
        val now = 1700000000000L
        val day = Duration.ofDays(1).toMillis()
        assertEquals(HealthConnect.readableFrom(grants, now) + day, HealthConnect.readableFrom(grants, now + day))
        val regrantedMonthsLater = now + 90 * day
        assertEquals(regrantedMonthsLater - 30 * day, HealthConnect.readableFrom(grants, regrantedMonthsLater))
    }

    private fun batchBody(index: Int): JSONObject = JSONObject().put("id", "batch-$index").put("version", 17L)
        .put("at", 1700000000000L).apply {
            when (index % 3) {
                0 -> put("type", "bp").put("systolic", 121).put("diastolic", 81)
                1 -> put("type", "weight").put("kg", 72.5)
                else -> put("type", "hr").put("bpm", 66)
            }
        }

    @Test
    fun fiftyMixedBodiesUseOneRealPassInsertionAndKeepOrderIdentityAndVersions() = runBlocking {
        var calls = 0
        val results = HealthConnect.writeEntries(JSONArray().apply { repeat(50) { put(batchBody(it)) } }, {}, { records ->
            calls++
            assertEquals(50, records.size)
            records.forEachIndexed { i, record ->
                assertEquals("batch-$i", record.metadata.clientRecordId)
                assertEquals(17L, record.metadata.clientRecordVersion)
            }
            assertEquals(17, records.filterIsInstance<BloodPressureRecord>().size)
            assertEquals(17, records.filterIsInstance<WeightRecord>().size)
            assertEquals(16, records.filterIsInstance<HeartRateRecord>().size)
        })
        assertEquals(1, calls)
        assertEquals(List(50) { true }, (0 until results.length()).map { results.get(it) })
    }

    @Test
    fun malformedAndDeniedBodiesReturnTheirOwnErrorsWhileOtherRecordsShareOneInsert() = runBlocking {
        var calls = 0
        val entries = JSONArray().apply { repeat(50) { put(batchBody(it)) } }
        entries.getJSONObject(20).put("bpm", 0)
        val result = HealthConnect.writeEntries(entries, {}, { records ->
            calls++
            assertEquals(49, records.size)
            assertFalse(records.any { it.metadata.clientRecordId == "batch-20" })
        })
        assertEquals(1, calls)
        assertEquals("invalid heart rate", result.getString(20))
        assertTrue((0 until 50).filter { it != 20 }.all { result.get(it) == true })
        val denied = HealthConnect.writeEntries(JSONArray().put(batchBody(0)).put(batchBody(1)), {
            if (it == "bp") throw SecurityException("denied")
        }, { assertEquals(listOf("batch-1"), it.map { r -> r.metadata.clientRecordId }) })
        assertEquals("denied", denied.getString(0))
        assertEquals(true, denied.get(1))
    }

    @Test
    fun wholeStoreFailurePropagatesAndAllInvalidOrEmptyBatchesDoNotInsert() = runBlocking {
        val failure = SecurityException("revoked during insert")
        var observed: Exception? = null
        try { HealthConnect.writeEntries(JSONArray().put(batchBody(0)), {}, { throw failure }) }
        catch (e: Exception) { observed = e }
        assertTrue(observed === failure)
        val bad = HealthConnect.writeEntries(JSONArray().put(JSONObject().put("type", "other")), {
            throw SecurityException("denied")
        }, { throw AssertionError("inserted invalid batch") })
        assertEquals("denied", bad.getString(0))
        assertEquals(0, HealthConnect.writeEntries(JSONArray(), {}, { throw AssertionError("inserted empty batch") }).length())
    }

    @Test
    fun onlyOurClientIdentifiedCopiesAreExcludedFromImport() {
        assertTrue(HealthConnect.isOwnWrite("our.app", "bp-42", "our.app"))
        assertFalse(HealthConnect.isOwnWrite("our.app", null, "our.app")) // QaHealthWrite must still import
        assertFalse(HealthConnect.isOwnWrite("other.app", "bp-42", "our.app"))
    }

    @Test
    fun writeMappingKeepsVaultIdentityVersionAndManualProvenance() {
        val bp = HealthConnect.writeRecord("bp", "bp-42", 1700000000001L, 1700000000000L, 123.0, 82.0) as BloodPressureRecord
        assertEquals("bp-42", bp.metadata.clientRecordId)
        assertEquals(1700000000001L, bp.metadata.clientRecordVersion)
        assertEquals(Metadata.RECORDING_METHOD_MANUAL_ENTRY, bp.metadata.recordingMethod)
        assertEquals(1700000000000L, bp.time.toEpochMilli())
        assertEquals(123.0, bp.systolic.inMillimetersOfMercury, 0.0)
        assertEquals(82.0, bp.diastolic.inMillimetersOfMercury, 0.0)
        val weight = HealthConnect.writeRecord("weight", "weight-42", 9L, 1700000000000L, kg = 72.5) as WeightRecord
        assertEquals("weight-42", weight.metadata.clientRecordId)
        assertEquals(9L, weight.metadata.clientRecordVersion)
        assertEquals(Metadata.RECORDING_METHOD_MANUAL_ENTRY, weight.metadata.recordingMethod)
        assertEquals(72.5, weight.weight.inKilograms, 0.0)
    }

    @Test
    fun writeAccessUsesWriteGrantsAndPreservesPartialAccess() {
        val reads = setOf(HealthPermission.getReadPermission(BloodPressureRecord::class))
        val weightOnly = reads + HealthPermission.getWritePermission(WeightRecord::class)
        assertEquals(emptyList<String>(), HealthConnect.writableKinds(listOf("bp", "weight"), reads))
        assertEquals(listOf("weight"), HealthConnect.writableKinds(listOf("bp", "weight", "sleep"), weightOnly))
        assertEquals(listOf("bp", "weight"), HealthConnect.writableKinds(listOf("bp", "weight"),
            weightOnly + HealthPermission.getWritePermission(BloodPressureRecord::class)))
        val bpWeight = weightOnly + HealthPermission.getWritePermission(BloodPressureRecord::class)
        assertEquals(listOf("bp", "weight", "hr", "workout"), HealthConnect.WRITABLE.keys.toList())
        assertEquals(listOf("bp", "weight"), HealthConnect.writableKinds(listOf("bp", "weight", "hr"), bpWeight))
        assertEquals(listOf("bp", "weight", "hr"), HealthConnect.writableKinds(listOf("bp", "weight", "hr"),
            bpWeight + HealthPermission.getWritePermission(HeartRateRecord::class)))
        val allKinds = listOf("bp", "weight", "hr", "workout")
        val bpWeightHr = bpWeight + HealthPermission.getWritePermission(HeartRateRecord::class)
        assertEquals(listOf("bp", "weight", "hr"), HealthConnect.writableKinds(allKinds, bpWeightHr))
        assertEquals(allKinds, HealthConnect.writableKinds(allKinds,
            bpWeightHr + HealthPermission.getWritePermission(ExerciseSessionRecord::class)))
    }

    @Test
    fun pulseKeepsItsSeparateVerbatimIdentityAndOneSampleAtTheBpInstant() {
        val pulse = HealthConnect.writeRecord("hr", "tg-42/pulse", 17L, 1700000000000L, bpm = 66.4) as HeartRateRecord
        assertEquals("tg-42/pulse", pulse.metadata.clientRecordId)
        assertEquals(17L, pulse.metadata.clientRecordVersion)
        assertEquals(Metadata.RECORDING_METHOD_MANUAL_ENTRY, pulse.metadata.recordingMethod)
        assertEquals(1700000000000L, pulse.startTime.toEpochMilli())
        assertEquals(pulse.startTime, pulse.endTime)
        assertEquals(pulse.startZoneOffset, pulse.endZoneOffset)
        assertEquals(listOf(HeartRateRecord.Sample(pulse.startTime, 66L)), pulse.samples)
    }

    @Test
    fun pulseRejectsInvalidValues() {
        for (bpm in listOf(Double.NaN, Double.POSITIVE_INFINITY, 0.0, -1.0)) {
            var rejected = false
            try { HealthConnect.writeRecord("hr", "bp-42/pulse", 1L, 1700000000000L, bpm = bpm) }
            catch (_: IllegalArgumentException) { rejected = true }
            assertTrue("accepted $bpm", rejected)
        }
    }

    @Test
    fun pulseImportKeepsForeignAndUnmarkedRecords() {
        val at = Instant.ofEpochMilli(1700000000000L)
        fun pulse(origin: String, id: String?) = HeartRateRecord(at, ZoneOffset.UTC, at.plusSeconds(1), ZoneOffset.UTC,
            listOf(HeartRateRecord.Sample(at, 66L)), (id?.let { Metadata.manualEntry(clientRecordId = it) } ?: Metadata.manualEntry())
                .populatedWithTestValues(id = "store-id", dataOrigin = DataOrigin(origin)))
        val ours = pulse("our.app", "bp-42/pulse")
        val unmarked = pulse("our.app", null)
        val foreign = pulse("other.app", "bp-42/pulse")
        assertEquals(listOf(unmarked, foreign), listOf(ours, unmarked, foreign).filterNot {
            HealthConnect.isOwnWrite(it.metadata.dataOrigin.packageName, it.metadata.clientRecordId, "our.app")
        })
    }

    @Test
    fun workoutAverageRemainsScopedToTheImportedWorkoutsOrigin() {
        val at = Instant.ofEpochMilli(1700000000000L)
        val workout = ExerciseSessionRecord(at, ZoneOffset.UTC, at.plusSeconds(60), ZoneOffset.UTC,
            Metadata.manualEntry().populatedWithTestValues(dataOrigin = DataOrigin("watch.app")), ExerciseSessionRecord.EXERCISE_TYPE_RUNNING)
        val request = HealthConnect.workoutRequest(workout, setOf(HeartRateRecord.BPM_AVG))
        assertEquals(AggregateRequest(setOf(HeartRateRecord.BPM_AVG), TimeRangeFilter.between(at, at.plusSeconds(60)),
            setOf(DataOrigin("watch.app"))), request)
        assertNotEquals(AggregateRequest(setOf(HeartRateRecord.BPM_AVG), TimeRangeFilter.between(at, at.plusSeconds(60)),
            setOf(DataOrigin("our.app"))), request)
        // Unmarked same-package QA workouts share our origin; no marker-level aggregate filter is claimed.
    }

    @Test
    fun workoutWritesOnlyTheFinalSpanTypeAndManualVaultIdentity() {
        for ((activity, type) in listOf(50.0 to ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING,
            3000.0 to ExerciseSessionRecord.EXERCISE_TYPE_OTHER_WORKOUT)) {
            val workout = HealthConnect.writeRecord("workout", "session-42", 17L,
                start = 1700000000000L, end = 1700003600000L, activity = activity) as ExerciseSessionRecord
            assertEquals("session-42", workout.metadata.clientRecordId)
            assertEquals(17L, workout.metadata.clientRecordVersion)
            assertEquals(Metadata.RECORDING_METHOD_MANUAL_ENTRY, workout.metadata.recordingMethod)
            assertEquals(1700000000000L, workout.startTime.toEpochMilli())
            assertEquals(1700003600000L, workout.endTime.toEpochMilli())
            assertEquals(type, workout.exerciseType)
            assertNull(workout.title)
            assertNull(workout.notes)
            assertTrue(workout.segments.isEmpty())
            assertTrue(workout.laps.isEmpty())
        }
    }

    @Test
    fun workoutRejectsUnknownFractionalMissingTypesAndInvalidSpans() {
        for (activity in listOf(Double.NaN, Double.POSITIVE_INFINITY, 0.0, 37.0, 50.1, 3000.1)) {
            try {
                HealthConnect.writeRecord("workout", "session-42", 1, start = 10, end = 20, activity = activity)
                throw AssertionError("accepted activity $activity")
            } catch (e: IllegalArgumentException) { assertEquals("bad write: activity", e.message) }
        }
        for (end in listOf(10L, 9L)) {
            try {
                HealthConnect.writeRecord("workout", "session-42", 1, start = 10, end = end, activity = 50.0)
                throw AssertionError("accepted end $end")
            } catch (e: IllegalArgumentException) { assertEquals("bad write: end", e.message) }
        }
        for (value in listOf(null, "1700000000000", true, Double.NaN, Double.POSITIVE_INFINITY, 10.5, 1e20)) {
            try {
                HealthConnect.workoutMillis(value, "start")
                throw AssertionError("accepted start $value")
            } catch (e: IllegalArgumentException) { assertEquals("bad write: start", e.message) }
        }
        assertEquals(1700000000000L, HealthConnect.workoutMillis(1700000000000L, "start"))
    }

    @Test
    fun workoutReadPathDropsOurMarkerButKeepsUnmarkedAndForeignSessions() {
        val at = Instant.ofEpochMilli(1700000000000L)
        fun workout(origin: String, id: String?) = ExerciseSessionRecord(at, ZoneOffset.UTC, at.plusSeconds(60), ZoneOffset.UTC,
            (id?.let { Metadata.manualEntry(clientRecordId = it) } ?: Metadata.manualEntry())
                .populatedWithTestValues(id = "store-id", dataOrigin = DataOrigin(origin)),
            ExerciseSessionRecord.EXERCISE_TYPE_OTHER_WORKOUT)
        val ours = workout("our.app", "session-42")
        val unmarked = workout("our.app", null)
        val foreign = workout("watch.app", "session-42")
        assertEquals(listOf(unmarked, foreign), HealthConnect.importableWorkouts(listOf(ours, unmarked, foreign), "our.app"))
    }

    @Test
    fun sleepValue() {
        assertEquals(1, HealthConnect.sleepValue(SleepSessionRecord.STAGE_TYPE_SLEEPING))
        assertEquals(2, HealthConnect.sleepValue(SleepSessionRecord.STAGE_TYPE_AWAKE))
        assertEquals(3, HealthConnect.sleepValue(SleepSessionRecord.STAGE_TYPE_LIGHT))
        assertEquals(4, HealthConnect.sleepValue(SleepSessionRecord.STAGE_TYPE_DEEP))
        assertEquals(5, HealthConnect.sleepValue(SleepSessionRecord.STAGE_TYPE_REM))
        assertNull(HealthConnect.sleepValue(SleepSessionRecord.STAGE_TYPE_OUT_OF_BED))
    }

    @Test
    fun hkActivity() {
        assertEquals(37, HealthConnect.hkActivity(ExerciseSessionRecord.EXERCISE_TYPE_RUNNING))
        assertEquals(13, HealthConnect.hkActivity(ExerciseSessionRecord.EXERCISE_TYPE_BIKING))
        assertEquals(50, HealthConnect.hkActivity(ExerciseSessionRecord.EXERCISE_TYPE_WEIGHTLIFTING))
        assertEquals(3000, HealthConnect.hkActivity(ExerciseSessionRecord.EXERCISE_TYPE_GOLF))
    }

    @Test
    fun zoneName() {
        assertEquals("Etc/GMT-2", HealthConnect.zoneName(ZoneOffset.ofHours(2)))
        assertEquals("Etc/GMT+5", HealthConnect.zoneName(ZoneOffset.ofHours(-5)))
        assertEquals("UTC", HealthConnect.zoneName(ZoneOffset.UTC))
        assertEquals("+05:30", HealthConnect.zoneName(ZoneOffset.ofHoursMinutes(5, 30)))
        assertNull(HealthConnect.zoneName(null))
    }
}
