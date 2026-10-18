package com.example.medtracker

import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.SleepSessionRecord
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.ZoneOffset

// The HealthKit codes healthimport.js reads (SLEEP_PHASE, WORKOUT_NAMES, STRENGTH_TYPES).
class HealthConnectTest {
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
