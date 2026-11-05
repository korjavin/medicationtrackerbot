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

// The HealthKit codes healthimport.js reads (SLEEP_PHASE, WORKOUT_NAMES, STRENGTH_TYPES).
class HealthConnectTest {
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
