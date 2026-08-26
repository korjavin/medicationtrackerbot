// analysis.cardiovascular.test.js
//
// Task 2 of the cloud composite-analysis plan (docs/plans/20260717-cloud-analysis-pathb.md):
// web/domain/analysis.js reproduces bot mode's analyze_cardiovascular composite
// tool client-side over vault data. Expectations are hand-ported from the Go
// oracle internal/mcp/cardiovascular_test.go (Path B runs no Go in tests).

import { describe, it, expect } from 'vitest';
import { createInMemoryRecordsPort } from './helpers/cloud-shim-harness.js';
import { createBPDomain } from '../../../domain/bp.js';
import { createVitalsDomain } from '../../../domain/vitals.js';
import { createNotesDomain } from '../../../domain/notes.js';
import { createMedicationsDomain } from '../../../domain/medications.js';
import { createIntakeDomain } from '../../../domain/medintake.js';
import { createAnalysis } from '../../../domain/analysis.js';

const NOW = Date.parse('2026-07-17T00:00:00Z');

function build(seed) {
  const records = createInMemoryRecordsPort(seed);
  const now = () => NOW;
  const timeZone = 'UTC';
  const bp = createBPDomain({ records, now, timeZone });
  const vitals = createVitalsDomain({ records, now, timeZone });
  const notes = createNotesDomain({ records, now });
  const medications = createMedicationsDomain({
    records, now, timeZone, rxnorm: { normalize: async () => null },
  });
  const intake = createIntakeDomain({ records, now, timeZone });
  return createAnalysis({
    bp, vitals, medications, intake, notes, now, timeZone,
  });
}

function hrBatch(day, samples) {
  return {
    recordId: `hrsample-${day}`, deleted: false, day,
    samples: samples.map(([date_time, value]) => ({ date_time, tz_offset: 0, value })),
  };
}
function spo2Batch(day, samples) {
  return {
    recordId: `spo2sample-${day}`, deleted: false, day,
    samples: samples.map(([date_time, value]) => ({ date_time, tz_offset: 0, value })),
  };
}

describe('analysis.cardiovascular', () => {
  it('aggregates every domain into the bot-shaped summary', async () => {
    const analysis = build({
      bp: [{
        recordId: 'bp-1', deleted: false, measured_at: '2026-07-10T09:00:00Z',
        systolic: 120, diastolic: 80, category: 'Normal',
      }],
      medication: [{
        recordId: 'med-1', deleted: false, archived: false,
        name: 'Lisinopril', dosage: '10mg', schedule: '09:00',
      }],
      sleep: [{
        recordId: 'sleep-1', deleted: false, day: '2026-07-10',
        start_time: '2026-07-09T23:00:00Z', end_time: '2026-07-10T06:00:00Z',
        total_minutes: 420, deep_minutes: 90,
      }],
      hrsample: [hrBatch('2026-07-10', [
        ['2026-07-10T08:00:00Z', 65], ['2026-07-10T12:00:00Z', 85],
      ])],
      spo2sample: [spo2Batch('2026-07-10', [
        ['2026-07-10T08:00:00Z', 97], ['2026-07-10T12:00:00Z', 99],
      ])],
      note: [{
        recordId: '1000', deleted: false, content: 'started new medication today',
        created_at: '2026-07-10T10:00:00Z',
      }],
    });

    const resp = await analysis.cardiovascular({ from: '2026-07-04', to: '2026-07-17' });

    expect(resp.blood_pressure).toBeTruthy();
    expect(resp.blood_pressure.readings).toHaveLength(1);
    expect(resp.blood_pressure.avg_systolic).toBe(120);
    expect(resp.blood_pressure.avg_diastolic).toBe(80);
    expect(resp.blood_pressure.days_measured).toBe(1);

    expect(resp.medications).toBeTruthy();
    expect(resp.medications.active).toEqual([{ name: 'Lisinopril', dosage: '10mg', schedule: '09:00' }]);

    expect(resp.sleep).toBeTruthy();
    expect(resp.sleep.logs).toHaveLength(1);
    expect(resp.sleep.avg_duration_minutes).toBe(420);
    expect(resp.sleep.avg_deep_minutes).toBe(90);

    expect(resp.heart_rate).toEqual({
      avg: 75, min: 65, max: 85, readings_count: 2,
    });
    expect(resp.spo2).toEqual({ avg: 98, min: 97, readings_count: 2 });

    expect(resp.diary_notes).toHaveLength(1);
    expect(resp.diary_notes[0].content).toBe('started new medication today');

    expect(resp.period).toBe('2026-07-04 to 2026-07-17');
    // No unavailable sections and no truncation → no warning.
    expect(resp.warning).toBeUndefined();
  });

  it('computes adherence over resolved intakes, skipping future PENDING', async () => {
    const analysis = build({
      medication: [{
        recordId: 'med-1', deleted: false, archived: false, name: 'Aspirin', dosage: '81mg', schedule: '08:00',
      }],
      intake: [
        {
          recordId: 'i-1', deleted: false, medication_id: 'med-1', status: 'TAKEN',
          scheduled_at: '2026-07-11T08:00:00Z', taken_at: '2026-07-11T08:05:00Z',
        },
        {
          recordId: 'i-2', deleted: false, medication_id: 'med-1', status: 'SKIPPED',
          scheduled_at: '2026-07-12T08:00:00Z',
        },
        {
          recordId: 'i-3', deleted: false, medication_id: 'med-1', status: 'PENDING',
          scheduled_at: '2026-07-15T08:00:00Z', // overdue (< now) → counts
        },
        {
          recordId: 'i-4', deleted: false, medication_id: 'med-1', status: 'PENDING',
          scheduled_at: '2026-07-20T08:00:00Z', // future (> now) → skipped
        },
      ],
    });

    const resp = await analysis.cardiovascular({ from: '2026-07-10', to: '2026-07-25' });

    // total = TAKEN + SKIPPED + overdue PENDING = 3; taken = 1 → 33.33%.
    expect(resp.medications.adherence_rate).toBeCloseTo(100 / 3, 5);
    expect(resp.medications.intake_log).toHaveLength(4);
    // intake_log carries the Go MedicationIntakeResult shape (joined med
    // name + dosage), matching the advertised response_example and bot mode —
    // and the uncapped windowed read must not drop a past-dated slice.
    expect(resp.medications.intake_log[0]).toMatchObject({
      medication_name: 'Aspirin', dosage: '81mg', scheduled_at: '2026-07-11T08:00:00Z', status: 'TAKEN',
    });
  });

  // bd med-29gh.1: an as-needed med never gets a materialized dose (planDoses
  // skips it), so every row it has is a manual TAKEN log. Folding those into
  // adherence reported fabricated compliance and dragged the overall rate up.
  it('excludes unscheduled medications from adherence — a PRN log is not a kept dose', async () => {
    const seed = {
      medication: [
        {
          recordId: 'med-1', deleted: false, archived: false, name: 'Aspirin', dosage: '81mg', schedule: '08:00',
        },
        {
          recordId: 'med-2',
          deleted: false,
          archived: false,
          name: 'Ibuprofen',
          dosage: '200mg',
          schedule: JSON.stringify({ type: 'as_needed' }),
        },
        {
          // Unparseable schedule → planDoses skips it too → unscheduled.
          recordId: 'med-3', deleted: false, archived: false, name: 'Mystery', dosage: '1 tab', schedule: 'when needed',
        },
        {
          // Archived PRN: gone from `active`, but listWindow still emits its
          // rows, so the fold has to classify it from the archived list.
          recordId: 'med-4',
          deleted: false,
          archived: true,
          name: 'Naproxen',
          dosage: '250mg',
          schedule: JSON.stringify({ type: 'as_needed' }),
        },
      ],
      intake: [
        {
          recordId: 'i-1', deleted: false, medication_id: 'med-1', status: 'TAKEN',
          scheduled_at: '2026-07-11T08:00:00Z', taken_at: '2026-07-11T08:05:00Z',
        },
        {
          recordId: 'i-2', deleted: false, medication_id: 'med-1', status: 'SKIPPED',
          scheduled_at: '2026-07-12T08:00:00Z',
        },
        // Three manual PRN logs + one for the unparseable med, all TAKEN, all
        // scheduled_at == taken_at the way medintake.logPast writes them.
        ...['2026-07-11T13:00:00Z', '2026-07-12T14:00:00Z', '2026-07-13T15:00:00Z'].map((t, n) => ({
          recordId: `intake-manual-${n}`, deleted: false, medication_id: 'med-2', status: 'TAKEN',
          scheduled_at: t, taken_at: t,
        })),
        {
          recordId: 'intake-manual-9', deleted: false, medication_id: 'med-3', status: 'TAKEN',
          scheduled_at: '2026-07-14T10:00:00Z', taken_at: '2026-07-14T10:00:00Z',
        },
        {
          recordId: 'intake-manual-10', deleted: false, medication_id: 'med-4', status: 'TAKEN',
          scheduled_at: '2026-07-15T10:00:00Z', taken_at: '2026-07-15T10:00:00Z',
        },
      ],
    };

    const resp = await build(seed).cardiovascular({ from: '2026-07-10', to: '2026-07-25' });

    // Aspirin alone: 1 TAKEN of 2 resolved. The five unscheduled rows would
    // have pushed this to 6/7 = 85.7%.
    expect(resp.medications.adherence_rate).toBe(50);
    // They are still reported — a doctor wants to see the PRN usage.
    expect(resp.medications.intake_log).toHaveLength(7);
    // …and `active` still lists only the non-archived meds.
    expect(resp.medications.active.map((m) => m.name)).toEqual(['Aspirin', 'Ibuprofen', 'Mystery']);

    // Nothing scheduled at all still reports 0, not null: shipped MCP
    // semantics that brief.js deliberately does NOT share.
    const prnOnly = { medication: seed.medication.slice(1), intake: seed.intake.slice(2) };
    const only = await build(prnOnly).cardiovascular({ from: '2026-07-10', to: '2026-07-25' });
    expect(only.medications.adherence_rate).toBe(0);
  });

  it('degrades a section whose read throws into an unavailable warning', async () => {
    // A failing domain read must not abort the whole analysis — it drops that
    // one section and adds `<label> (query failed)`, mirroring the Go handlers.
    const now = () => NOW;
    const timeZone = 'UTC';
    const throwingBp = { list: async () => { throw new Error('boom'); } };
    const records = createInMemoryRecordsPort({});
    const vitals = createVitalsDomain({ records, now, timeZone });
    const notes = createNotesDomain({ records, now });
    const medications = createMedicationsDomain({
      records, now, timeZone, rxnorm: { normalize: async () => null },
    });
    const intake = createIntakeDomain({ records, now, timeZone });
    const analysis = createAnalysis({
      bp: throwingBp, vitals, medications, intake, notes, now, timeZone,
    });

    const resp = await analysis.cardiovascular({ from: '2026-07-10', to: '2026-07-17' });

    expect(resp.blood_pressure).toBeUndefined();
    expect(resp.warning).toContain('blood_pressure (query failed)');
    // The rest of the analysis still resolves.
    expect(resp.sleep).toBeTruthy();
    expect(resp.medications).toBeTruthy();
  });

  it('days shorthand extends the window to end-of-today, not the now instant', async () => {
    // NOW is midnight; a reading later today is after the wall-clock instant but
    // within the day. Go's days-shorthand path ends at 23:59:59, so it counts.
    const analysis = build({
      bp: [{
        recordId: 'bp-today', deleted: false, measured_at: '2026-07-17T10:00:00Z',
        systolic: 130, diastolic: 85, category: 'Elevated',
      }],
    });

    const resp = await analysis.cardiovascular({ days: 1 });

    expect(resp.blood_pressure.readings).toHaveLength(1);
    expect(resp.period).toBe('2026-07-17 to 2026-07-17');
  });

  it('degrades a failed diary-notes read instead of aborting the whole analysis', async () => {
    // The notes read was previously unguarded, so a notes failure rejected the
    // entire analysis. It must degrade like every other section (Go parity).
    const now = () => NOW;
    const timeZone = 'UTC';
    const records = createInMemoryRecordsPort({
      bp: [{
        recordId: 'bp-1', deleted: false, measured_at: '2026-07-10T09:00:00Z',
        systolic: 120, diastolic: 80, category: 'Normal',
      }],
    });
    const bp = createBPDomain({ records, now, timeZone });
    const vitals = createVitalsDomain({ records, now, timeZone });
    const medications = createMedicationsDomain({
      records, now, timeZone, rxnorm: { normalize: async () => null },
    });
    const intake = createIntakeDomain({ records, now, timeZone });
    const throwingNotes = { list: async () => { throw new Error('notes boom'); } };
    const analysis = createAnalysis({
      bp, vitals, medications, intake, notes: throwingNotes, now, timeZone,
    });

    const resp = await analysis.cardiovascular({ from: '2026-07-10', to: '2026-07-17' });

    expect(resp.blood_pressure).toBeTruthy(); // other sections still resolved
    expect(resp.diary_notes).toBeUndefined();
    expect(resp.warning).toContain('diary notes (query failed)');
  });

  it('resolves the window by local date under a UTC+14 timezone', async () => {
    // A noon-UTC anchor lands on the next local date at UTC+14, shifting the
    // whole window forward a day; the period must name the requested dates.
    const now = () => NOW;
    const timeZone = 'Pacific/Kiritimati'; // UTC+14
    const records = createInMemoryRecordsPort({});
    const bp = createBPDomain({ records, now, timeZone });
    const vitals = createVitalsDomain({ records, now, timeZone });
    const notes = createNotesDomain({ records, now });
    const medications = createMedicationsDomain({
      records, now, timeZone, rxnorm: { normalize: async () => null },
    });
    const intake = createIntakeDomain({ records, now, timeZone });
    const analysis = createAnalysis({
      bp, vitals, medications, intake, notes, now, timeZone,
    });

    const resp = await analysis.cardiovascular({ from: '2026-07-10', to: '2026-07-12' });
    expect(resp.period).toBe('2026-07-10 to 2026-07-12');
  });

  it('omits a gated-off section and lists it as unavailable', async () => {
    const analysis = build({
      medication: [{
        recordId: 'med-1', deleted: false, archived: false, name: 'Aspirin', dosage: '81mg', schedule: '08:00',
      }],
    });

    const resp = await analysis.cardiovascular({
      from: '2026-07-10', to: '2026-07-17', features: { bp: false, medication: true },
    });

    expect(resp.blood_pressure).toBeUndefined();
    expect(resp.medications).toBeTruthy();
    expect(resp.warning).toContain('blood_pressure (feature disabled)');
    // Empty sleep/hr/spo2 still resolve: sleep present-but-empty, hr/spo2 omitted.
    expect(resp.sleep).toEqual({ logs: [], avg_duration_minutes: 0, avg_deep_minutes: 0 });
    expect(resp.heart_rate).toBeUndefined();
    expect(resp.spo2).toBeUndefined();
  });
});
