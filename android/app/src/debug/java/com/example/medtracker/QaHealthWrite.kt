package com.example.medtracker

import android.app.Activity
import android.os.Bundle
import android.util.Log
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.records.BloodPressureRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.units.Percentage
import androidx.health.connect.client.units.Pressure
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneOffset

/**
 * Debug source set only (bd med-nt9p.59): android-qa's stand-in for another app saving a blood
 * pressure reading into Health Connect while Med Tracker is in the background —
 * `am start -n <pkg>/com.example.medtracker.QaHealthWrite --ei sys 157 --ei dia 97`. It opens over
 * MainActivity (same task, opaque), so MainActivity stops and resumes when this finishes: the
 * page's visibilitychange import runs as on a real return. Optional `--ei steps N --ei hr BPM
 * --ei spo2 PCT` (bd med-0xad.3) also save a steps interval, a two-point heart-rate series and an
 * SpO2 reading, all in the last hour; `--ei spo2n N` makes that N SpO2 readings a minute apart
 * (more than one Health Connect page, for the paged scan). QA build (qa.test base) only; logs
 * "ok"/"failed" under the logcat tag qa-health-write.
 */
class QaHealthWrite : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!DebugHooks.qa()) return finish()
        val sys = intent.getIntExtra("sys", 0).toDouble()
        val dia = intent.getIntExtra("dia", 0).toDouble()
        val steps = intent.getIntExtra("steps", 0).toLong()
        val hr = intent.getIntExtra("hr", 0).toLong()
        val spo2 = intent.getIntExtra("spo2", 0).toDouble()
        val spo2n = intent.getIntExtra("spo2n", 1).coerceAtLeast(1)
        val now = Instant.now()
        val utc = ZoneOffset.UTC
        val records = buildList<Record> {
            add(BloodPressureRecord(time = now.minusSeconds(5), zoneOffset = utc, metadata = Metadata.manualEntry(),
                systolic = Pressure.millimetersOfMercury(sys), diastolic = Pressure.millimetersOfMercury(dia)))
            if (steps > 0) add(StepsRecord(startTime = now.minusSeconds(3600), startZoneOffset = utc,
                endTime = now.minusSeconds(60), endZoneOffset = utc, count = steps, metadata = Metadata.manualEntry()))
            if (hr > 0) add(HeartRateRecord(startTime = now.minusSeconds(600), startZoneOffset = utc,
                endTime = now.minusSeconds(60), endZoneOffset = utc, metadata = Metadata.manualEntry(),
                samples = listOf(HeartRateRecord.Sample(now.minusSeconds(600), hr), HeartRateRecord.Sample(now.minusSeconds(120), hr + 1))))
            if (spo2 > 0) for (i in 0 until spo2n) add(OxygenSaturationRecord(time = now.minusSeconds(30L + 60L * i),
                zoneOffset = utc, percentage = Percentage(spo2), metadata = Metadata.manualEntry()))
        }
        CoroutineScope(Dispatchers.Main).launch {
            runCatching {
                HealthConnectClient.getOrCreate(this@QaHealthWrite).insertRecords(records)
            }.onSuccess { Log.i(TAG, "ok $sys/$dia ${it.recordIdsList}") }
                .onFailure { Log.e(TAG, "failed ${it.javaClass.simpleName}: ${it.message}") }
            finish()
        }
    }

    private companion object {
        const val TAG = "qa-health-write"
    }
}
