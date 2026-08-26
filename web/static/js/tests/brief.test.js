// brief.test.js — bd med-5k6t.1, the doctor-visit brief's data half.
//
// Drives the REAL router (web/cloud/js/apishim.js createApiRouter — the single
// entry point the cloud UI and mcp-responder.js share) over an in-memory
// records port, exactly like cloud.shim-contract.meds.test.js. So these fail
// if GET /api/brief stops being routable, if a section stops folding out of
// its owning domain, or if an unselected section starts costing a read.
//
// `now` and `timeZone` are pinned, so every window boundary here is wall-clock
// independent.
import { describe, expect, it } from 'vitest';
import { createInMemoryRecordsPort } from './helpers/cloud-shim-harness.js';
import { createApiRouter } from '../../../cloud/js/apishim.js';
import { createBPDomain } from '../../../domain/bp.js';
import { createVitalsDomain } from '../../../domain/vitals.js';
import { createNotesDomain } from '../../../domain/notes.js';
import { createMedicationsDomain } from '../../../domain/medications.js';
import { createIntakeDomain } from '../../../domain/medintake.js';
import { createAnalysis } from '../../../domain/analysis.js';
import { createWorkoutDomain } from '../../../domain/workout.js';

const TZ = 'UTC';
const NOW = Date.UTC(2026, 7, 20, 12, 0); // 2026-08-20T12:00:00Z
const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

const iso = (ms) => new Date(ms).toISOString();

// A records port that remembers which record types were read, so a test can
// assert that an UNSELECTED section costs no read at all (the bead's
// "only compute selected — do not compute-then-drop").
function spyingPort(seed) {
    const inner = createInMemoryRecordsPort(seed);
    const listed = [];
    return {
        listed,
        port: {
            async list(type) { listed.push(type); return inner.list(type); },
            async listRange(type, from, to) { listed.push(type); return inner.listRange(type, from, to); },
            async put(type, record) { return inner.put(type, record); },
            async del(type, id) { return inner.del(type, id); }
        }
    };
}

function routerWith(seed, records) {
    return createApiRouter({}, {
        records: records || createInMemoryRecordsPort(seed),
        win: {},
        now: () => NOW,
        timeZone: TZ
    });
}

function med(recordId, name, dosage, extra = {}) {
    return {
        recordId,
        deleted: false,
        archived: false,
        name,
        dosage,
        schedule: JSON.stringify({ type: 'daily', times: ['08:00', '20:00'] }),
        start_date: null,
        end_date: null,
        tz_shift_policy: 'flexible',
        created_at: '2026-01-05T00:00:00.000Z',
        ...extra
    };
}

function intake(recordId, medicationId, scheduledAtMs, status, takenAtMs) {
    const r = {
        recordId,
        deleted: false,
        medication_id: medicationId,
        scheduled_at: iso(scheduledAtMs),
        status,
        source: 'schedule'
    };
    // logPast writes source:'schedule' too, so the `intake-manual-` id prefix
    // is the only thing that marks a manual row — same as production.
    if (takenAtMs !== undefined) r.taken_at = iso(takenAtMs);
    return r;
}

function bpReading(recordId, measuredAt, systolic, diastolic, pulse) {
    const r = {
        recordId, deleted: false, measured_at: measuredAt, systolic, diastolic, ignore_calc: false
    };
    if (pulse !== undefined) r.pulse = pulse;
    return r;
}

function session(id, scheduledDate, status) {
    return {
        recordId: `session-${id}`, deleted: false, id, group_id: 1, variant_id: 1,
        scheduled_date: scheduledDate, scheduled_time: '09:00', status, snooze_count: 0
    };
}

// A completed exercise log inside `sessionId`. The scalar (sets/reps/weight)
// shape, not the per-set array — that is what a pre-med-qj4 log looks like and
// it is enough for the stats fold.
function exerciseLog(id, sessionId, name, sets, reps, kg) {
    return {
        recordId: `log-${id}`, deleted: false, id, session_id: sessionId, exercise_id: id,
        exercise_name: name, status: 'completed', sets_completed: sets, reps_completed: reps,
        weight_kg: kg, logged_at: iso(NOW - 5 * DAY)
    };
}

function foodLog(recordId, eatenAt, m) {
    return {
        recordId, deleted: false, eaten_at: eatenAt, name: 'Meal', weight: 300,
        calories: m.calories, protein: m.protein, carbs: m.carbs, fat: m.fat
    };
}

// A vault with something in every section. Adherence over the window:
// Metformin 3 TAKEN / 1 SKIPPED = 75%, Lisinopril 1 TAKEN / 1 SKIPPED = 50%,
// overall 4/6 = 66.7%. Ibuprofen is as-needed: planDoses never materializes a
// dose for it, so its only rows are manual TAKEN logs — they must stay out of
// every percentage (bd med-29gh.1), which is why overall is still 66.7 and not
// 6/8 = 75%.
function fullVault() {
    return {
        medication: [
            med('med-1', 'Metformin', '500mg'),
            med('med-2', 'Lisinopril', '10mg', {
                schedule: JSON.stringify({ type: 'weekly', days: [1, 4], times: ['09:00'] }),
                start_date: '2026-02-01T00:00:00.000Z'
            }),
            med('med-3', 'Ibuprofen', '200mg', {
                schedule: JSON.stringify({ type: 'as_needed' }),
                start_date: '2026-03-01T00:00:00.000Z'
            })
        ],
        intake: [
            intake('i-1', 'med-1', NOW - 4 * DAY, 'TAKEN'),
            intake('i-2', 'med-1', NOW - 3 * DAY, 'TAKEN'),
            intake('i-3', 'med-1', NOW - 2 * DAY, 'TAKEN'),
            intake('i-4', 'med-1', NOW - 1 * DAY, 'SKIPPED'),
            intake('i-5', 'med-2', NOW - 3 * DAY, 'TAKEN'),
            intake('i-6', 'med-2', NOW - 2 * DAY, 'SKIPPED'),
            // Not yet due — must not count against adherence (analysis.js's rule).
            intake('i-7', 'med-1', NOW + 2 * DAY, 'PENDING'),
            // Manual PRN logs, the shape medintake.logPast writes.
            intake('intake-manual-1', 'med-3', NOW - 3 * DAY, 'TAKEN'),
            intake('intake-manual-2', 'med-3', NOW - 1 * DAY, 'TAKEN')
        ],
        bp: [
            bpReading('bp-1', '2026-08-18T09:00:00Z', 120, 80, 60),
            bpReading('bp-2', '2026-08-19T09:00:00Z', 140, 90, 70),
            bpReading('bp-3', '2026-08-20T09:00:00Z', 130, 85)
        ],
        bpgoal: [{
            recordId: 'bpgoal', deleted: false, clientTs: NOW, target_systolic: 130, target_diastolic: 85
        }],
        weight: [
            { recordId: 'w-1', deleted: false, measured_at: iso(NOW - 10 * DAY), weight: 82.0 },
            { recordId: 'w-2', deleted: false, measured_at: iso(NOW - 1 * DAY), weight: 80.5 }
        ],
        sleep: [
            {
                recordId: 'sleep-1', deleted: false, day: '2026-08-18',
                start_time: '2026-08-17T23:00:00Z', end_time: '2026-08-18T06:00:00Z',
                total_minutes: 420, heart_rate_avg: 58
            },
            {
                recordId: 'sleep-2', deleted: false, day: '2026-08-19',
                start_time: '2026-08-18T23:00:00Z', end_time: '2026-08-19T07:00:00Z',
                total_minutes: 480, heart_rate_avg: 62
            }
        ],
        note: [{
            recordId: '1000', deleted: false, content: 'dizzy after the morning dose',
            created_at: '2026-08-19T10:00:00Z'
        }],
        foodlog: [
            foodLog('f-1', '2026-08-18T12:00:00Z', {
                calories: 400, protein: 30, carbs: 40, fat: 10
            }),
            foodLog('f-2', '2026-08-19T12:00:00Z', {
                calories: 600, protein: 50, carbs: 60, fat: 20
            })
        ],
        workoutsession: [
            session(1, iso(NOW - 5 * DAY), 'completed'),
            session(2, iso(NOW - 10 * DAY), 'completed'),
            session(3, iso(NOW - 100 * DAY), 'completed'),
            session(4, iso(NOW - 3 * DAY), 'skipped')
        ]
    };
}

describe('doctor-visit brief — GET /api/brief (med-5k6t.1)', () => {
    it('defaults to a 90-day window and the five clinical sections', async () => {
        const call = routerWith(fullVault());

        const brief = await call('/api/brief', 'GET');

        expect(brief.range).toEqual({
            days: 90,
            from: iso(NOW - 90 * DAY),
            to: iso(NOW),
            generated_at: iso(NOW)
        });
        expect(Object.keys(brief).sort()).toEqual([
            'adherence_detail', 'bp', 'medications', 'notes', 'overall_adherence_pct',
            'range', 'vitals', 'weight'
        ]);
        // Food and workouts are opt-in.
        expect(brief.food).toBeUndefined();
        expect(brief.workouts).toBeUndefined();
    });

    it.each([30, 90, 180])('honors days=%i', async (days) => {
        const call = routerWith(fullVault());

        const brief = await call(`/api/brief?days=${days}`, 'GET');

        expect(brief.range.days).toBe(days);
        expect(brief.range.from).toBe(iso(NOW - days * DAY));
    });

    it('falls back to 90 days for an unsupported or garbage days value', async () => {
        const call = routerWith(fullVault());

        expect((await call('/api/brief?days=45', 'GET')).range.days).toBe(90);
        expect((await call('/api/brief?days=banana', 'GET')).range.days).toBe(90);
        // A whole-value parse: parseInt would have honored both of these as 30.
        expect((await call('/api/brief?days=30junk', 'GET')).range.days).toBe(90);
        expect((await call('/api/brief?days=30.5', 'GET')).range.days).toBe(90);
    });

    it('returns only the selected sections, opt-ins included', async () => {
        const call = routerWith(fullVault());

        const brief = await call('/api/brief?days=30&sections=meds,food,workouts', 'GET');

        expect(Object.keys(brief).sort()).toEqual([
            'adherence_detail', 'food', 'medications', 'overall_adherence_pct', 'range', 'workouts'
        ]);
    });

    it('ignores unknown section names', async () => {
        const call = routerWith(fullVault());

        const brief = await call('/api/brief?sections=bp,telepathy', 'GET');

        expect(Object.keys(brief).sort()).toEqual(['bp', 'range']);
    });

    it('never reads a domain whose section was not selected', async () => {
        const { port, listed } = spyingPort(fullVault());
        const call = routerWith(null, port);

        await call('/api/brief?sections=bp', 'GET');

        expect(listed).toContain('bp');
        for (const unselected of ['weight', 'sleep', 'note', 'intake', 'foodlog', 'workoutsession']) {
            expect(listed).not.toContain(unselected);
        }
    });

    it('folds medications with per-med and overall adherence', async () => {
        const call = routerWith(fullVault());

        const brief = await call('/api/brief?days=30&sections=meds', 'GET');

        expect(brief.medications).toEqual([
            {
                name: 'Ibuprofen',
                dosage: '200mg',
                schedule_summary: 'as needed',
                started_at: '2026-03-01T00:00:00.000Z',
                // No schedule to be adherent to: a count, never a percentage.
                adherence_pct: null,
                as_needed: true,
                times_taken: 2
            },
            {
                name: 'Lisinopril',
                dosage: '10mg',
                schedule_summary: 'Mon, Thu at 09:00',
                started_at: '2026-02-01T00:00:00.000Z',
                adherence_pct: 50,
                as_needed: false,
                times_taken: 1
            },
            {
                name: 'Metformin',
                dosage: '500mg',
                schedule_summary: 'daily at 08:00, 20:00',
                started_at: '2026-01-05T00:00:00.000Z',
                adherence_pct: 75,
                as_needed: false,
                times_taken: 3
            }
        ]);
        // 4 kept of 6 scheduled doses. The two Ibuprofen logs are excluded from
        // the overall fold too — counting them would report 6/8 = 75%.
        expect(brief.overall_adherence_pct).toBe(66.7);
    });

    // bd med-29gh.2 — the breakdown behind the percentage. Ten slots for one
    // scheduled med: 6 taken within minutes, 2 taken 90 minutes late, 1 skipped,
    // 1 still PENDING an hour after its slot (overdue, so it counts as missed).
    function tenSlotVault(extraIntakes = [], extraMeds = []) {
        const slot = (i) => NOW - (i + 2) * DAY;
        const intakes = [];
        for (let i = 0; i < 6; i++) {
            intakes.push(intake(`intake-med-1-${i}`, 'med-1', slot(i), 'TAKEN', slot(i) + 5 * MIN));
        }
        for (let i = 6; i < 8; i++) {
            intakes.push(intake(`intake-med-1-${i}`, 'med-1', slot(i), 'TAKEN', slot(i) + 90 * MIN));
        }
        intakes.push(intake('intake-med-1-8', 'med-1', slot(8), 'SKIPPED'));
        intakes.push(intake('intake-med-1-9', 'med-1', NOW - 60 * MIN, 'PENDING'));
        return {
            medication: [med('med-1', 'Metformin', '500mg'), ...extraMeds],
            intake: [...intakes, ...extraIntakes]
        };
    }

    it('reports missed, delayed and average delay alongside the percentage', async () => {
        const call = routerWith(tenSlotVault());

        const brief = await call('/api/brief?days=30&sections=meds', 'GET');

        expect(brief.overall_adherence_pct).toBe(80);
        expect(brief.adherence_detail).toEqual({
            missed: 2, delayed: 2, avg_delay_minutes: 90
        });
    });

    // The trap the fold has to survive: a manual log-past row fakes
    // scheduled_at == taken_at, and updateIntakes will later re-stamp its
    // taken_at to now() while scheduled_at stays days back — a multi-day
    // phantom "delay". It still counts as a dose taken. A dose taken EARLY is
    // not late either, and an as-needed med has no slot to be late against.
    it('keeps manual, early and as-needed doses out of the delay numbers', async () => {
        const call = routerWith(tenSlotVault(
            [
                // Manual row for the SAME scheduled med, taken_at re-stamped to
                // now: five days "late" on paper, not a delay in fact.
                intake('intake-manual-1', 'med-1', NOW - 5 * DAY, 'TAKEN', NOW),
                // Taken five hours BEFORE its slot — clamp, never abs().
                intake('intake-med-1-early', 'med-1', NOW - 12 * DAY, 'TAKEN', NOW - 12 * DAY - 5 * 60 * MIN),
                // As-needed rows: excluded from adherence entirely, so they can
                // never reach the delay math however late they look.
                intake('intake-manual-2', 'med-2', NOW - 3 * DAY, 'TAKEN', NOW),
                intake('intake-manual-3', 'med-2', NOW - 2 * DAY, 'TAKEN', NOW)
            ],
            [med('med-2', 'Ibuprofen', '200mg', { schedule: JSON.stringify({ type: 'as_needed' }) })]
        ));

        const brief = await call('/api/brief?days=30&sections=meds', 'GET');

        // 12 scheduled doses now, 10 of them taken — the manual and early rows
        // both counted toward the percentage...
        expect(brief.overall_adherence_pct).toBe(83.3);
        // ...and neither moved a single delay number.
        expect(brief.adherence_detail).toEqual({
            missed: 2, delayed: 2, avg_delay_minutes: 90
        });
        expect(brief.medications.find((m) => m.name === 'Ibuprofen'))
            .toMatchObject({ as_needed: true, times_taken: 2 });
    });

    it('reports zero delay detail for a window with nothing late', async () => {
        const call = routerWith(fullVault());

        const brief = await call('/api/brief?days=30&sections=meds', 'GET');

        // No intake in the vault carries a taken_at, so nothing can be delayed;
        // the two non-TAKEN scheduled rows are the missed ones.
        expect(brief.adherence_detail).toEqual({
            missed: 2, delayed: 0, avg_delay_minutes: null
        });
    });

    // bd med-29gh.1 acceptance: one scheduled med at 50% plus a PRN med with
    // logs must read 50% overall, not something dragged toward 100.
    it('never prints a percentage for a medication with no schedule', async () => {
        const call = routerWith({
            medication: [
                med('med-1', 'Lisinopril', '10mg'),
                med('med-2', 'Ibuprofen', '200mg', { schedule: JSON.stringify({ type: 'as_needed' }) }),
                // Unparseable schedule → planDoses skips it → unscheduled too.
                med('med-3', 'Mystery', '1 tab', { schedule: 'when needed' }),
                // Parses fine but can never produce a slot, so planDoses skips
                // it exactly like an as-needed med.
                med('med-4', 'Slotless', '5mg', {
                    schedule: JSON.stringify({ type: 'daily', times: [] })
                }),
                // Nothing validates a schedule on the way in, so junk times and
                // out-of-range weekdays reach the fold. planDoses skips both.
                med('med-5', 'Junktime', '5mg', {
                    schedule: JSON.stringify({ type: 'daily', times: ['bad'] })
                }),
                med('med-6', 'Noday', '5mg', {
                    schedule: JSON.stringify({ type: 'weekly', days: [9], times: ['08:00'] })
                })
            ],
            intake: [
                intake('i-1', 'med-1', NOW - 2 * DAY, 'TAKEN'),
                intake('i-2', 'med-1', NOW - 1 * DAY, 'SKIPPED'),
                intake('intake-manual-1', 'med-2', NOW - 5 * DAY, 'TAKEN'),
                intake('intake-manual-2', 'med-2', NOW - 4 * DAY, 'TAKEN'),
                intake('intake-manual-3', 'med-2', NOW - 3 * DAY, 'TAKEN'),
                intake('intake-manual-4', 'med-2', NOW - 2 * DAY, 'TAKEN'),
                intake('intake-manual-5', 'med-2', NOW - 1 * DAY, 'TAKEN'),
                intake('intake-manual-6', 'med-3', NOW - 1 * DAY, 'TAKEN'),
                intake('intake-manual-7', 'med-4', NOW - 1 * DAY, 'TAKEN'),
                intake('intake-manual-8', 'med-5', NOW - 1 * DAY, 'TAKEN'),
                intake('intake-manual-9', 'med-6', NOW - 1 * DAY, 'TAKEN')
            ]
        });

        const brief = await call('/api/brief?days=30&sections=meds', 'GET');
        const byName = Object.fromEntries(brief.medications.map((m) => [m.name, m]));

        // Still listed — a doctor wants to know the patient takes ibuprofen.
        expect(Object.keys(byName).sort()).toEqual([
            'Ibuprofen', 'Junktime', 'Lisinopril', 'Mystery', 'Noday', 'Slotless'
        ]);
        expect(byName.Ibuprofen).toMatchObject({ adherence_pct: null, as_needed: true, times_taken: 5 });
        expect(byName.Mystery).toMatchObject({ adherence_pct: null, as_needed: true, times_taken: 1 });
        expect(byName.Slotless).toMatchObject({ adherence_pct: null, as_needed: true, times_taken: 1 });
        expect(byName.Junktime).toMatchObject({ adherence_pct: null, as_needed: true, times_taken: 1 });
        expect(byName.Noday).toMatchObject({ adherence_pct: null, as_needed: true, times_taken: 1 });
        expect(byName.Lisinopril).toMatchObject({ adherence_pct: 50, as_needed: false, times_taken: 1 });
        // 1 of 2 scheduled doses. Folding the 9 unscheduled TAKEN rows in would
        // have reported 10/11 = 90.9%.
        expect(brief.overall_adherence_pct).toBe(50);
    });

    // An archived PRN med keeps its rows in listWindow but drops out of the
    // active medications list, so a fold that only classifies active meds would
    // let it go on faking adherence from beyond the grave.
    it('keeps an archived as-needed medication out of adherence too', async () => {
        const call = routerWith({
            medication: [
                med('med-1', 'Lisinopril', '10mg'),
                med('med-2', 'Ibuprofen', '200mg', {
                    archived: true, schedule: JSON.stringify({ type: 'as_needed' })
                })
            ],
            intake: [
                intake('i-1', 'med-1', NOW - 2 * DAY, 'TAKEN'),
                intake('i-2', 'med-1', NOW - 1 * DAY, 'SKIPPED'),
                intake('intake-manual-1', 'med-2', NOW - 5 * DAY, 'TAKEN'),
                intake('intake-manual-2', 'med-2', NOW - 4 * DAY, 'TAKEN'),
                intake('intake-manual-3', 'med-2', NOW - 3 * DAY, 'TAKEN')
            ]
        });

        const brief = await call('/api/brief?days=30&sections=meds', 'GET');

        // Archived meds stay out of the printed list…
        expect(brief.medications.map((m) => m.name)).toEqual(['Lisinopril']);
        // …but their PRN rows must stay out of the number as well: 1 of 2, not 4 of 5.
        expect(brief.overall_adherence_pct).toBe(50);
    });

    // The acceptance pin: the brief must never disagree with the composite
    // analysis about the same window, because it folds the same rows the same
    // way (analysis.js's medications section) rather than re-deriving them.
    it('reports the adherence analysis.js reports for the same window', async () => {
        const seed = fullVault();
        const call = routerWith(seed);
        const records = createInMemoryRecordsPort(seed);
        const now = () => NOW;
        const analysis = createAnalysis({
            bp: createBPDomain({ records, now, timeZone: TZ }),
            vitals: createVitalsDomain({ records, now, timeZone: TZ }),
            notes: createNotesDomain({ records, now }),
            medications: createMedicationsDomain({
                records, now, timeZone: TZ, rxnorm: { normalize: async () => null }
            }),
            intake: createIntakeDomain({ records, now, timeZone: TZ }),
            now,
            timeZone: TZ
        });

        const brief = await call('/api/brief?days=30&sections=meds', 'GET');
        const composite = await analysis.cardiovascular({ days: 30 });

        const rate = composite.medications.adherence_rate;
        expect(brief.overall_adherence_pct).toBe(Math.round(rate * 10) / 10);
    });

    it('folds BP into avg/min/max plus the chart series and the goal', async () => {
        const call = routerWith(fullVault());

        const { bp } = await call('/api/brief?days=30&sections=bp', 'GET');

        expect(bp.count).toBe(3);
        expect(bp.systolic).toEqual({ avg: 130, min: 120, max: 140 });
        expect(bp.diastolic).toEqual({ avg: 85, min: 80, max: 90 });
        expect(bp.pulse).toEqual({ avg: 65, min: 60, max: 70 });
        expect(bp.goal).toEqual({ target_systolic: 130, target_diastolic: 85 });
        // Oldest first — the printed chart reads left-to-right.
        expect(bp.readings.map((r) => r.measured_at)).toEqual([
            '2026-08-18T09:00:00Z', '2026-08-19T09:00:00Z', '2026-08-20T09:00:00Z'
        ]);
        expect(bp.readings[2].pulse).toBeNull();
    });

    // The vault stores kilograms and every other surface converts at render
    // time (core/utils.js formatWeight), so the brief ships kg and lets the doc
    // builder do the one conversion — a second KG_PER_LB down here would drift.
    it('folds weight into start/end/delta plus the chart series, in stored kg', async () => {
        const call = routerWith(fullVault());

        const { weight } = await call('/api/brief?days=30&sections=weight', 'GET');

        expect(weight).toEqual({
            start: 82.0,
            end: 80.5,
            delta: -1.5,
            unit: 'kg',
            points: [
                { measured_at: iso(NOW - 10 * DAY), weight: 82.0 },
                { measured_at: iso(NOW - 1 * DAY), weight: 80.5 }
            ]
        });
    });

    it('folds vitals into average sleep and a resting-HR proxy', async () => {
        const call = routerWith(fullVault());

        const { vitals } = await call('/api/brief?days=30&sections=vitals', 'GET');

        expect(vitals).toEqual({
            avg_sleep_minutes: 450,
            resting_hr: 60,
            // The same per-local-day fold the Vitals screen charts
            // (vitals.js foldSleepDaily) — not a second derivation here.
            sleep_daily: [
                {
                    date: '2026-08-18', light_mins: 0, deep_mins: 0, rem_mins: 0, awake_mins: 0,
                    total_mins: 420, heart_rate_avg: 58
                },
                {
                    date: '2026-08-19', light_mins: 0, deep_mins: 0, rem_mins: 0, awake_mins: 0,
                    total_mins: 480, heart_rate_avg: 62
                }
            ]
        });
    });

    // bd med-29gh.3 — the brief's sleep chart must plot the Vitals screen's
    // numbers, so both go through vitals.js foldSleepDaily. If the brief ever
    // grew its own fold this is what would catch the drift.
    it('folds sleep_daily to the same per-day numbers vitals.overview() charts', async () => {
        const vault = fullVault();
        const records = createInMemoryRecordsPort(vault);
        const now = () => NOW;
        const vitalsDomain = createVitalsDomain({ records, now, timeZone: TZ });
        const call = routerWith(vault);

        const [{ vitals }, overview] = await Promise.all([
            call('/api/brief?days=30&sections=vitals', 'GET'),
            vitalsDomain.overview()
        ]);

        expect(vitals.sleep_daily).toEqual(overview.sleep_stats_30d);
    });

    // A window with no sleep in it yields an empty array, not a hole: the
    // presentation layer branches on `.length`, and undefined would throw.
    it('returns an empty sleep_daily when nothing was slept in the window', async () => {
        const vault = fullVault();
        vault.sleep = [];
        const call = routerWith(vault);

        const { vitals } = await call('/api/brief?days=30&sections=vitals', 'GET');

        expect(vitals).toEqual({ avg_sleep_minutes: null, resting_hr: null, sleep_daily: [] });
    });

    // `id` is what the app's per-note include picker (med-29gh.5) ticks against,
    // so it is part of the wire shape, not an incidental field.
    it('lists diary notes as id + date + text', async () => {
        const call = routerWith(fullVault());

        const { notes } = await call('/api/brief?days=30&sections=notes', 'GET');

        expect(notes).toEqual([{ id: '1000', date: '2026-08-19', text: 'dizzy after the morning dose' }]);
    });

    it('averages food over the days actually logged, with the stored targets', async () => {
        const call = routerWith(fullVault());

        const { food } = await call('/api/brief?days=30&sections=food', 'GET');

        expect(food).toEqual({
            days_logged: 2,
            avg_kcal: 500,
            avg_protein: 40,
            avg_carbs: 50,
            avg_fat: 15,
            targets: { calories: 0, carbs: 0, protein: 0, fat: 0 }
        });
    });

    it('counts completed workouts over the requested window, 180 days included', async () => {
        const call = routerWith(fullVault());

        // 2 completed in the last 30 days (the third is 100 days back, the
        // fourth was skipped).
        expect((await call('/api/brief?days=30&sections=workouts', 'GET')).workouts)
            .toMatchObject({ session_count: 2, per_week: 0.5 });
        // 180 must not silently fall back to the 30-day range — it would still
        // say 2 if it did.
        expect((await call('/api/brief?days=180&sections=workouts', 'GET')).workouts)
            .toMatchObject({ session_count: 3, per_week: 0.1 });
    });

    // bd med-29gh.4 — the brief's Workouts section used to be two numbers and
    // throw the rest of the getStats response away. The chart and the stats
    // line in the printed doc are fed from these, out of the SAME single call.
    it('carries the chart series, totals, streak and top exercises alongside the counts', async () => {
        const vault = fullVault();
        vault.exerciselog = [
            exerciseLog(1, 1, 'Squat', 3, 5, 100),
            exerciseLog(2, 2, 'Squat', 3, 5, 100),
            exerciseLog(3, 1, 'Bench press', 3, 8, 60),
            // A 0 kg log, the shape bd med-45u is about. It must still be
            // countable by NAME — what must never reach paper is its weight.
            exerciseLog(4, 1, 'Plank', 0, 0, 0)
        ];
        const call = routerWith(vault);

        const { workouts } = await call('/api/brief?days=30&sections=workouts', 'GET');

        expect(workouts).toEqual({
            session_count: 2,
            per_week: 0.5,
            // Range-independent by contract: a streak is a property of the
            // whole history, not of the window being printed.
            current_streak_weeks: 1,
            totals: {
                volume_kg: 4440, hard_sets: 9, easy_sets: 0, reps: 54, pr_count: 2
            },
            // ISO-Monday buckets, exactly the shape WGWorkoutChart's `sessions`
            // option consumes.
            weekly_activity: [
                { week: '2026-08-10', completed: 2, skipped: 0 },
                { week: '2026-08-17', completed: 0, skipped: 1 }
            ],
            top_exercises: [
                { exercise_name: 'Squat', session_count: 2 },
                { exercise_name: 'Bench press', session_count: 1 },
                { exercise_name: 'Plank', session_count: 1 }
            ]
        });
        // The point of the trim, asserted rather than implied: no per-exercise
        // weight or volume can reach the document (bd med-45u would print a
        // "0 kg" Plank row at a doctor).
        for (const e of workouts.top_exercises) {
            expect(Object.keys(e).sort()).toEqual(['exercise_name', 'session_count']);
        }
    });

    // The drift guard (the counterpart of the sleep_daily one above). Nothing
    // in the brief re-derives a workout number: if workoutsSection ever grows
    // its own fold, or getStats changes shape under it, this fails.
    it('passes the workout series through byte-identical from workout.getStats', async () => {
        const vault = fullVault();
        vault.exerciselog = [exerciseLog(1, 1, 'Squat', 3, 5, 100)];
        const records = createInMemoryRecordsPort(vault);
        const call = routerWith(null, records);
        const workoutDomain = createWorkoutDomain({ records, now: () => NOW, timeZone: TZ });

        const [{ workouts }, stats] = await Promise.all([
            call('/api/brief?days=90&sections=workouts', 'GET'),
            workoutDomain.getStats({ range: '90d' })
        ]);

        expect(workouts.session_count).toBe(stats.completed_sessions);
        expect(workouts.current_streak_weeks).toBe(stats.current_streak_weeks);
        expect(workouts.totals).toEqual(stats.totals);
        expect(workouts.weekly_activity).toEqual(stats.weekly_activity);
        // top_exercises is the one deliberately narrowed field — same rows,
        // same order, weights dropped.
        expect(workouts.top_exercises).toEqual(
            stats.top_exercises.map((e) => ({
                exercise_name: e.exercise_name, session_count: e.session_count
            }))
        );
    });

    it('degrades an empty section to null/empty instead of throwing', async () => {
        // A vault with meds + BP only: no weight, notes, sleep, food or workouts.
        const call = routerWith({
            medication: [med('med-1', 'Metformin', '500mg')],
            bp: [bpReading('bp-1', '2026-08-18T09:00:00Z', 120, 80, 60)]
        });

        const brief = await call('/api/brief?sections=meds,bp,weight,vitals,notes,food,workouts', 'GET');

        expect(brief.weight).toEqual({
            start: null, end: null, delta: null, unit: 'kg', points: []
        });
        expect(brief.vitals).toEqual({ avg_sleep_minutes: null, resting_hr: null, sleep_daily: [] });
        expect(brief.notes).toEqual([]);
        expect(brief.food.days_logged).toBe(0);
        expect(brief.food.avg_kcal).toBeNull();
        // Empty window: weekly_activity and top_exercises are null, NEVER [] —
        // a Go-contract passthrough (workout.js getStats header) that both the
        // chart branch and the doc read with Array.isArray.
        expect(brief.workouts).toEqual({
            session_count: 0,
            per_week: 0,
            current_streak_weeks: 0,
            totals: {
                volume_kg: 0, hard_sets: 0, easy_sets: 0, reps: 0, pr_count: 0
            },
            weekly_activity: null,
            top_exercises: null
        });
        // No intakes at all — "nothing scheduled" is null, not 0% adherence.
        expect(brief.medications[0].adherence_pct).toBeNull();
        expect(brief.overall_adherence_pct).toBeNull();
        expect(brief.bp.count).toBe(1);
        expect(brief.bp.pulse).toEqual({ avg: 60, min: 60, max: 60 });
    });

    it('reports an empty BP window without inventing statistics', async () => {
        const call = routerWith({ medication: [med('med-1', 'Metformin', '500mg')] });

        const { bp } = await call('/api/brief?sections=bp', 'GET');

        expect(bp).toEqual({
            count: 0, systolic: null, diastolic: null, pulse: null, goal: {}, readings: []
        });
    });
});
