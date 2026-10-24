// bd med-wi09.10 — dose lineage across a zone change or a schedule edit
// (web/domain/lineage.js) and the named DST policy (medschedule.js
// localWallToUtcMs). web/domain is a pure layer with no UI entry point for the
// preview yet, so this pure-unit suite owns it; the cases are Socrates'
// acceptance list from epic med-wi09 Phase 2 (b).
import { describe, expect, it } from 'vitest';
import {
    boundary, transitionPreview, lineageTable, applyLineage
} from '../../../domain/lineage.js';
import { localWallToUtcMs, localDateTimeParts } from '../../../domain/medschedule.js';
import { projectOccurrences } from '../../../domain/medintake.js';
import { createTzPlanDomain } from '../../../domain/tzplan.js';
import { createMedicationsDomain } from '../../../domain/medications.js';
import { createInMemoryRecordsPort } from './helpers/cloud-shim-harness.js';

const daily = (...times) => JSON.stringify({ type: 'daily', times });
const med = (times, extra = {}) => ({ recordId: 1, name: 'Metformin', schedule: daily(...times), ...extra });
const id = (iso, medId = 1) => `intake-${medId}-${Date.parse(iso) / 1000}`;
const at = (iso) => Date.parse(iso);
const gen = (timeZone, times) => ({ timeZone, medications: [med(times)] });
const one = (args) => {
    const out = boundary(args);
    expect(out).toHaveLength(1);
    return out[0];
};
const taken = (iso, medId = 1) => ({
    recordId: id(iso, medId), medication_id: medId, scheduled_at: iso, status: 'TAKEN', taken_at: iso
});

describe('boundary() — switch-day rule (one dose per logical slot)', () => {
    const SWITCH = at('2026-07-01T06:00:00Z');

    it('UTC → UTC+3 at 06:00Z: the old 08:00Z stands, the new 05:00Z (already past) is cancelled into it', () => {
        const e = one({ oldGen: gen('UTC', ['08:00']), newGen: gen('Etc/GMT-3', ['08:00']), switchAt: SWITCH });
        expect(e.kept).toContain(id('2026-07-01T08:00:00Z'));
        expect(e.cancelled).not.toContain(id('2026-07-01T08:00:00Z'));
        expect(e.replacement[id('2026-07-01T05:00:00Z')]).toBe(id('2026-07-01T08:00:00Z'));
        // Tomorrow is fully in the new zone.
        expect(e.replacement[id('2026-07-02T08:00:00Z')]).toBe(id('2026-07-02T05:00:00Z'));
    });

    it('UTC+3 → UTC at 06:00Z: the old 05:00Z was real; the new 08:00Z is cancelled into it', () => {
        const e = one({ oldGen: gen('Etc/GMT-3', ['08:00']), newGen: gen('UTC', ['08:00']), switchAt: SWITCH });
        expect(e.kept).toContain(id('2026-07-01T05:00:00Z'));
        expect(e.replacement[id('2026-07-01T08:00:00Z')]).toBe(id('2026-07-01T05:00:00Z'));
        expect(e.replacement[id('2026-07-02T05:00:00Z')]).toBe(id('2026-07-02T08:00:00Z'));
    });

    it('UTC+14 → UTC−12: 26 h apart, still one dose per local date', () => {
        const e = one({ oldGen: gen('Pacific/Kiritimati', ['08:00']), newGen: gen('Etc/GMT+12', ['08:00']), switchAt: SWITCH });
        // 07-01 08:00 +14 = 06-30 18:00Z, before the switch: it stands, and the
        // new 07-01 08:00 −12 (07-01 20:00Z) folds into it.
        expect(e.replacement[id('2026-07-01T20:00:00Z')]).toBe(id('2026-06-30T18:00:00Z'));
        // 07-02 08:00 +14 = 07-01 18:00Z, after the switch: replaced by the new
        // zone's 07-02 08:00 −12 = 07-02 20:00Z (outside ±36 h, still found).
        expect(e.replacement[id('2026-07-01T18:00:00Z')]).toBe(id('2026-07-02T20:00:00Z'));
    });

    it('UTC+14 → UTC−12 at the window edge still finds the partner 26 h away', () => {
        const e = one({ oldGen: gen('Pacific/Kiritimati', ['07:00']), newGen: gen('Etc/GMT+12', ['07:00']), switchAt: SWITCH });
        expect(e.replacement[id('2026-07-02T17:00:00Z')]).toBe(id('2026-07-03T19:00:00Z'));
    });

    it('UTC−12 → UTC+14: the new instant is already past, so the old one stands', () => {
        const e = one({ oldGen: gen('Etc/GMT+12', ['08:00']), newGen: gen('Pacific/Kiritimati', ['08:00']), switchAt: SWITCH });
        expect(e.kept).toContain(id('2026-07-01T20:00:00Z'));
        expect(e.replacement[id('2026-06-30T18:00:00Z')]).toBe(id('2026-07-01T20:00:00Z'));
    });

    it('two times a day: each slot decided on its own', () => {
        const e = one({ oldGen: gen('UTC', ['08:00', '20:00']), newGen: gen('Etc/GMT-3', ['08:00', '20:00']), switchAt: SWITCH });
        expect(e.kept).toContain(id('2026-07-01T08:00:00Z'));
        expect(e.replacement[id('2026-07-01T05:00:00Z')]).toBe(id('2026-07-01T08:00:00Z'));
        expect(e.replacement[id('2026-07-01T20:00:00Z')]).toBe(id('2026-07-01T17:00:00Z'));
    });

    it('two slots never fold into one instant (08:00 + 11:00, UTC → UTC+3)', () => {
        const e = one({ oldGen: gen('UTC', ['08:00', '11:00']), newGen: gen('Etc/GMT-3', ['08:00', '11:00']), switchAt: SWITCH });
        // The new 11:00 (+3) is the kept old 08:00Z: the 11:00 slot keeps 11:00Z.
        expect(e.kept).toEqual(expect.arrayContaining([id('2026-07-01T08:00:00Z'), id('2026-07-01T11:00:00Z')]));
        expect(e.cancelled).not.toContain(id('2026-07-01T11:00:00Z'));
        expect(e.cancelled).not.toContain(id('2026-07-01T08:00:00Z'));
    });

    it('a no-op generation cancels nothing', () => {
        expect(boundary({ oldGen: gen('UTC', ['08:00']), newGen: gen('UTC', ['08:00']), switchAt: SWITCH })).toEqual([]);
    });
});

describe('boundary() — schedule edit 08:00 → 20:00', () => {
    it('made after the 08:00 reminder was queued: aliases to the first new dose that day', () => {
        const e = one({ oldGen: gen('UTC', ['08:00']), newGen: gen('UTC', ['20:00']), switchAt: at('2026-07-01T07:00:00Z') });
        expect(e.replacement[id('2026-07-01T08:00:00Z')]).toBe(id('2026-07-01T20:00:00Z'));
        expect(e.replacement[id('2026-07-02T08:00:00Z')]).toBe(id('2026-07-02T20:00:00Z'));
    });

    it('no new dose later that day → no replacement', () => {
        const e = one({ oldGen: gen('UTC', ['08:00']), newGen: gen('UTC', ['07:00']), switchAt: at('2026-07-01T07:30:00Z') });
        expect(e.replacement[id('2026-07-01T08:00:00Z')]).toBeNull();
    });

    it('made after 08:00 has passed: that dose was real and stays', () => {
        const e = one({ oldGen: gen('UTC', ['08:00']), newGen: gen('UTC', ['20:00']), switchAt: at('2026-07-01T09:00:00Z') });
        expect(e.cancelled).not.toContain(id('2026-07-01T08:00:00Z'));
        expect(e.replacement[id('2026-07-02T08:00:00Z')]).toBe(id('2026-07-02T20:00:00Z'));
    });
});

describe('boundary() — evidence keeps the old instant', () => {
    it('a dose taken early keeps its id across the change and gets no replacement', () => {
        // Tomorrow's 08:20 Berlin (06:20Z) taken early, then Berlin → Lisbon.
        const early = taken('2026-07-02T06:20:00Z');
        const e = one({
            oldGen: gen('Europe/Berlin', ['08:20']),
            newGen: gen('Europe/Lisbon', ['08:20']),
            switchAt: at('2026-07-01T20:00:00Z'),
            evidence: [early]
        });
        expect(e.kept).toContain(early.recordId);
        expect(e.cancelled).not.toContain(early.recordId);
        // Its new twin (08:20 Lisbon = 07:20Z) is cancelled into it.
        expect(e.replacement[id('2026-07-02T07:20:00Z')]).toBe(early.recordId);
    });

    it('a tombstone is evidence too', () => {
        const e = one({
            oldGen: gen('Europe/Berlin', ['08:20']),
            newGen: gen('Europe/Lisbon', ['08:20']),
            switchAt: at('2026-07-01T20:00:00Z'),
            evidence: [{ recordId: id('2026-07-02T06:20:00Z'), deleted: true }]
        });
        expect(e.kept).toContain(id('2026-07-02T06:20:00Z'));
    });
});

describe('named DST policy — localWallToUtcMs round trip', () => {
    const TZ = 'Europe/Berlin';
    const wall = (ms) => {
        const p = localDateTimeParts(ms, TZ);
        return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
    };

    it('an ordinary wall time round-trips', () => {
        expect(wall(localWallToUtcMs(Date.UTC(2026, 6, 1, 8, 0), TZ))).toBe('2026-07-01 08:00');
    });

    it('spring gap: 2026-03-29 02:30 does not exist and moves forward by the gap to 03:30', () => {
        const ms = localWallToUtcMs(Date.UTC(2026, 2, 29, 2, 30), TZ);
        expect(new Date(ms).toISOString()).toBe('2026-03-29T01:30:00.000Z');
        expect(wall(ms)).toBe('2026-03-29 03:30');
    });

    it('fall fold: 2026-10-25 02:30 happens twice and takes the earlier instant', () => {
        const ms = localWallToUtcMs(Date.UTC(2026, 9, 25, 2, 30), TZ);
        expect(new Date(ms).toISOString()).toBe('2026-10-25T00:30:00.000Z');
        expect(wall(ms)).toBe('2026-10-25 02:30');
    });

    it('the same policy west of UTC (New York)', () => {
        expect(new Date(localWallToUtcMs(Date.UTC(2026, 2, 8, 2, 30), 'America/New_York')).toISOString())
            .toBe('2026-03-08T07:30:00.000Z');
        expect(new Date(localWallToUtcMs(Date.UTC(2026, 10, 1, 1, 30), 'America/New_York')).toISOString())
            .toBe('2026-11-01T05:30:00.000Z');
    });
});

describe('projection resolves evidence through declared aliases only', () => {
    // Berlin → Lisbon at 20:00Z; tomorrow's 08:20 Berlin was taken early.
    const SWITCH = at('2026-07-01T20:00:00Z');
    const early = taken('2026-07-02T06:20:00Z');
    const lisbonTwin = id('2026-07-02T07:20:00Z');
    const table = (evidence) => lineageTable([{
        recordId: 'tztransition-1-a',
        switch_at: new Date(SWITCH).toISOString(),
        boundary: boundary({
            oldGen: gen('Europe/Berlin', ['08:20']), newGen: gen('Europe/Lisbon', ['08:20']), switchAt: SWITCH, evidence
        })
    }]);
    const project = (intakes, lineage) => projectOccurrences({
        medications: [med(['08:20'])],
        intakes,
        timeZone: 'Europe/Lisbon',
        nowMs: SWITCH + 60_000,
        fromMs: at('2026-07-02T00:00:00Z'),
        toMs: at('2026-07-02T12:00:00Z'),
        lineage
    }).map((r) => [r.occId, r.state, r.loggedTwice || null]);

    it('without lineage the early dose and its new twin both show (the bug)', () => {
        expect(project([early], null)).toHaveLength(2);
    });

    it('with lineage: one row, the taken one', () => {
        expect(project([early], table([early]))).toEqual([[early.recordId, 'taken', null]]);
    });

    it('evidence on both sides: both rows stay, flagged "logged twice", nothing settled', () => {
        const both = [early, taken('2026-07-02T07:20:00Z')];
        expect(project(both, table([early]))).toEqual([
            [early.recordId, 'taken', lisbonTwin],
            [lisbonTwin, 'taken', early.recordId]
        ]);
    });

    it('a cancelled id with no evidence is hidden; its replacement is the dose', () => {
        const rows = [
            { occId: 'intake-1-100', medId: 1, plannedAt: new Date(100_000).toISOString(), source: 'schedule', state: 'due' },
            { occId: 'intake-1-200', medId: 1, plannedAt: new Date(200_000).toISOString(), source: 'schedule', state: 'upcoming' }
        ];
        const t = lineageTable([{ recordId: 'medsched-1-1-a', from: '2026-07-01T00:00:00Z', boundary: [{ medId: 1, kept: [], cancelled: ['intake-1-100'], replacement: { 'intake-1-100': 'intake-1-200' } }] }]);
        expect(applyLineage(rows, t, []).map((r) => r.occId)).toEqual(['intake-1-200']);
        // A late tap on the cancelled id is the dose; the replacement goes.
        const tapped = [{ recordId: 'intake-1-100', medication_id: 1, scheduled_at: new Date(100_000).toISOString(), status: 'TAKEN' }];
        expect(applyLineage(rows, t, tapped).map((r) => r.occId)).toEqual(['intake-1-100']);
    });

    it('until the past is regenerated, a canonical the projection does not list leaves the cancelled row as stand-in', () => {
        const rows = [{ occId: 'intake-1-100', medId: 1, plannedAt: new Date(100_000).toISOString(), source: 'schedule', state: 'due' }];
        const t = lineageTable([{ recordId: 'tztransition-1-a', switch_at: '2026-07-01T00:00:00Z', boundary: [{ medId: 1, kept: ['intake-1-300'], cancelled: ['intake-1-100'], replacement: { 'intake-1-100': 'intake-1-300' } }] }]);
        expect(applyLineage(rows, t, []).map((r) => r.occId)).toEqual(['intake-1-100']);
    });

    it('evidence on two links of an A → B → C chain is flagged, C (no evidence) hidden', () => {
        const row = (s) => ({ occId: `intake-1-${s}`, medId: 1, plannedAt: new Date(s * 1000).toISOString(), source: 'schedule', state: 'due' });
        const log = (s) => ({ recordId: `intake-1-${s}`, medication_id: 1, scheduled_at: new Date(s * 1000).toISOString(), status: 'TAKEN' });
        const t = lineageTable([
            { recordId: 'tztransition-1-a', switch_at: '2026-07-01T00:00:00Z', boundary: [{ medId: 1, kept: [], cancelled: ['intake-1-100'], replacement: { 'intake-1-100': 'intake-1-200' } }] },
            { recordId: 'tztransition-2-a', switch_at: '2026-07-02T00:00:00Z', boundary: [{ medId: 1, kept: [], cancelled: ['intake-1-200'], replacement: { 'intake-1-200': 'intake-1-300' } }] }
        ]);
        const out = applyLineage([row(100), row(200), row(300)], t, [log(100), log(200)]);
        expect(out.map((r) => [r.occId, r.loggedTwice])).toEqual([['intake-1-100', 'intake-1-200'], ['intake-1-200', 'intake-1-100']]);
    });

    it('a later boundary that moves back revives the id (back-and-forth zones)', () => {
        const t = lineageTable([
            { recordId: 'tztransition-1-a', switch_at: '2026-07-01T06:00:00Z', boundary: [{ medId: 1, kept: [], cancelled: ['X'], replacement: { X: 'Y' } }] },
            { recordId: 'tztransition-2-a', switch_at: '2026-07-02T06:00:00Z', boundary: [{ medId: 1, kept: [], cancelled: ['Y'], replacement: { Y: 'X' } }] }
        ]);
        expect([...t.entries()]).toEqual([['Y', 'X']]);
    });
});

describe('transitionPreview — MT7 Before / After', () => {
    it('a dose already taken at its old time is kept in both lists with no replacement', () => {
        // Saturday 08:30 Berlin; the 08:20 Berlin dose is taken; Berlin → Lisbon.
        const morning = taken('2026-07-04T06:20:00Z');
        const { before, after } = transitionPreview({
            oldGen: gen('Europe/Berlin', ['08:20', '21:30']),
            newGen: gen('Europe/Lisbon', ['08:20', '21:30']),
            switchAt: at('2026-07-04T06:30:00Z'),
            evidence: [morning]
        });
        const mark = (rows, occId) => (rows.find((r) => r.occId === occId) || {}).mark;
        expect(mark(before, morning.recordId)).toBe('kept');
        expect(mark(after, morning.recordId)).toBe('kept');
        // Its Lisbon twin (07:20Z) never appears After.
        expect(after.some((r) => r.occId === id('2026-07-04T07:20:00Z'))).toBe(false);
        // 21:30 Berlin moves to 21:30 Lisbon.
        expect(mark(before, id('2026-07-04T19:30:00Z'))).toBe('moves');
        expect(mark(after, id('2026-07-04T20:30:00Z'))).toBe('moved');
    });

    it('After lists nothing from before the switch unless it cancels a future twin', () => {
        const { after } = transitionPreview({
            oldGen: gen('UTC', ['08:00', '20:00']), newGen: gen('UTC', ['09:00', '20:00']), switchAt: at('2026-07-01T06:00:00Z')
        });
        expect(after.every((r) => Date.parse(r.plannedAt) >= at('2026-07-01T06:00:00Z'))).toBe(true);
    });

    it('a schedule edit marks the replacement "replaces"', () => {
        const { before, after } = transitionPreview({
            oldGen: gen('UTC', ['08:00']), newGen: gen('UTC', ['20:00']), switchAt: at('2026-07-01T07:00:00Z')
        });
        expect(before[0]).toMatchObject({ occId: id('2026-07-01T08:00:00Z'), mark: 'cancelled' });
        expect(after[0]).toMatchObject({ occId: id('2026-07-01T20:00:00Z'), mark: 'replaces', replaces: id('2026-07-01T08:00:00Z') });
    });
});

describe('writers store the boundary at the change', () => {
    const NOW = at('2026-07-01T06:00:00Z');

    it('a zone change writes it on the tztransition row and returns the preview', async () => {
        const records = createInMemoryRecordsPort({
            settings: [{ recordId: 'settings', clientTs: 1, deleted: false, timezone: 'UTC' }],
            medication: [{ ...med(['08:00']), deleted: false, tz_shift_policy: 'flexible' }]
        });
        const tz = createTzPlanDomain({ records, now: () => NOW, timeZone: 'UTC' });
        const res = await tz.proposeTimezoneChange('Etc/GMT-3');
        expect(res).toMatchObject({ changed: true, planCreated: false });
        expect(res.preview.before.length).toBeGreaterThan(0);
        const [row] = await records.list('tztransition');
        expect(row.boundary).toEqual(boundary({
            oldGen: gen('UTC', ['08:00']), newGen: gen('Etc/GMT-3', ['08:00']), switchAt: NOW
        }));
    });

    it('a schedule edit writes it on the medsched row', async () => {
        const records = createInMemoryRecordsPort({
            medication: [{ ...med(['08:00']), deleted: false, dosage: '500mg', created_at: '2026-01-01T00:00:00.000Z' }]
        });
        const meds = createMedicationsDomain({ records, now: () => at('2026-07-01T07:00:00Z'), timeZone: 'UTC' });
        await meds.update(1, { name: 'Metformin', dosage: '500mg', schedule: daily('20:00') });
        const edit = (await records.list('medsched')).find((r) => !r.recordId.endsWith('-base'));
        expect(edit.boundary[0].replacement[id('2026-07-01T08:00:00Z')]).toBe(id('2026-07-01T20:00:00Z'));
    });
});
