package com.example.medtracker

import android.app.Activity
import android.os.Bundle
import android.util.Log
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.records.BloodPressureRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.temporal.ChronoUnit
import kotlin.reflect.KClass

/** Debug QA only: independently read Health Connect after the real page writes (med-8f4s.2). */
class QaHealthRead : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!DebugHooks.qa()) return finish()
        val request = intent.getStringExtra("request").orEmpty()
        CoroutineScope(Dispatchers.Main).launch {
            runCatching {
                val client = HealthConnectClient.getOrCreate(this@QaHealthRead)
                val out = JSONArray()
                for ((kind, type) in mapOf("bp" to BloodPressureRecord::class, "weight" to WeightRecord::class, "hr" to HeartRateRecord::class)) {
                    var token: String? = null
                    do {
                        @Suppress("UNCHECKED_CAST")
                        val page = client.readRecords(ReadRecordsRequest(type as KClass<Record>,
                            TimeRangeFilter.after(Instant.now().minus(1, ChronoUnit.DAYS)), pageToken = token))
                        page.records.filter { it.metadata.dataOrigin.packageName == packageName }.forEach { record ->
                            val row = JSONObject().put("type", kind).put("id", record.metadata.id)
                                .put("clientId", record.metadata.clientRecordId ?: JSONObject.NULL)
                                .put("version", record.metadata.clientRecordVersion)
                                .put("recordingMethod", record.metadata.recordingMethod)
                            when (record) {
                                is BloodPressureRecord -> row.put("systolic", record.systolic.inMillimetersOfMercury)
                                    .put("diastolic", record.diastolic.inMillimetersOfMercury)
                                    .put("at", record.time.toEpochMilli())
                                is WeightRecord -> row.put("kg", record.weight.inKilograms)
                                is HeartRateRecord -> row.put("samples", JSONArray().apply {
                                    record.samples.forEach { put(JSONObject().put("at", it.time.toEpochMilli()).put("bpm", it.beatsPerMinute)) }
                                }).put("at", record.startTime.toEpochMilli()).put("end", record.endTime.toEpochMilli())
                            }
                            out.put(row)
                        }
                        token = page.pageToken
                    } while (token != null)
                }
                JSONObject().put("request", request).put("records", out)
            }.onSuccess { Log.i("qa-health-read", it.toString()) }
                .onFailure { Log.e("qa-health-read", JSONObject().put("request", request).put("error", it.toString()).toString()) }
            finish()
        }
    }
}
