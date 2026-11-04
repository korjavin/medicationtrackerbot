package com.example.medtracker

import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.BloodPressureRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.SleepSessionRecord
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneOffset

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
