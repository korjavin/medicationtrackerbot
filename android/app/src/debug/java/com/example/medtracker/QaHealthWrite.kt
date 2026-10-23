package com.example.medtracker

import android.app.Activity
import android.os.Bundle
import android.util.Log
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.records.BloodPressureRecord
import androidx.health.connect.client.records.metadata.Metadata
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
 * page's visibilitychange import runs as on a real return. QA build (qa.test base) only; logs
 * "ok"/"failed" under the logcat tag qa-health-write.
 */
class QaHealthWrite : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!DebugHooks.qa()) return finish()
        val sys = intent.getIntExtra("sys", 0).toDouble()
        val dia = intent.getIntExtra("dia", 0).toDouble()
        CoroutineScope(Dispatchers.Main).launch {
            runCatching {
                HealthConnectClient.getOrCreate(this@QaHealthWrite).insertRecords(
                    listOf(
                        BloodPressureRecord(
                            time = Instant.now().minusSeconds(5),
                            zoneOffset = ZoneOffset.UTC,
                            metadata = Metadata.manualEntry(),
                            systolic = Pressure.millimetersOfMercury(sys),
                            diastolic = Pressure.millimetersOfMercury(dia),
                        )
                    )
                )
            }.onSuccess { Log.i(TAG, "ok $sys/$dia ${it.recordIdsList}") }
                .onFailure { Log.e(TAG, "failed ${it.javaClass.simpleName}: ${it.message}") }
            finish()
        }
    }

    private companion object {
        const val TAG = "qa-health-write"
    }
}
