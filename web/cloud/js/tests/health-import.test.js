/**
 * @vitest-environment jsdom
 *
 * health-import.test.js (bd med-w6gx.6)
 *
 * Apple Health → vault: the runner (web/cloud/js/health-import.js) over a fake
 * window.Health and an in-memory records port with the real putIfAbsent
 * semantics (a tombstone occupies the slot), through the real domain layer
 * (web/domain/healthimport.js → bp.js / weight.js).
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The real write path (stampAndPut, its onLocalWrite seam, localRecordsPort,
// pullOnOpen) for the write-back suite; only the account port and the flush
// are stubbed for the import suites.
vi.mock('../sync.js', async (importOriginal) => ({
    ...(await importOriginal()),
    recordsPort: vi.fn(),
    flushConfirmed: vi.fn(async () => true),
}));

import { runHealthImport, startHealthImport, healthStatusText, resetHealthAnchors, startHealthWriteBack } from '../health-import.js';
import { localRecordsPort, onLocalWrite, pullOnOpen, ORIGIN_EXTERNAL } from '../sync.js';
import { dropCachedDb, openDb } from '../localdb.js';
import { createApiRouter } from '../apishim.js';
import { applyTGCommand, TG_COMMAND } from '../inbox-apply.js';
import { deriveDataKeys, encryptRecord, generateDEK, toBase64 } from '../crypto.js';
import { createBPDomain } from '../../../domain/bp.js';
import { createWeightDomain } from '../../../domain/weight.js';
import { recordsToVault, vaultToRecords } from '../../../domain/vault.js';
import { createVitalsDomain } from '../../../domain/vitals.js';
import { createWorkoutDomain } from '../../../domain/workout.js';
import { createHealthImportDomain } from '../../../domain/healthimport.js';
import { healthNumericId } from '../../../domain/healthsource.js';
import { allowConsoleNoise } from '../../../static/js/tests/helpers/setup.js';

const U1 = '11111111-2222-4333-8444-555555555555';
const U2 = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const U3 = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const T0 = Date.parse('2026-10-01T07:30:00Z');

function memRecords() {
    const rows = new Map(); // recordId -> row (tombstones included)
    const of = (type) => [...rows.values()].filter((r) => r.recordType === type);
    return {
        rows,
        list: async (type) => of(type).filter((r) => !r.deleted),
        listRaw: async (type) => of(type),
        listRange: async (type, from, to) => of(type).filter((r) => !r.deleted && r.recordId >= from && r.recordId <= to),
        put: async (type, r) => { rows.set(r.recordId, { ...r, recordType: type }); return r; },
        putIfAbsent: async (type, r) => {
            if (!rows.has(r.recordId)) rows.set(r.recordId, { ...r, recordType: type });
            return rows.get(r.recordId);
        },
        del: async (type, id) => { rows.set(id, { recordId: id, recordType: type, clientTs: Date.now(), deleted: true }); },
    };
}

function memStorage() {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

// A Health store holding `data` per kind; the anchor is the count already seen.
function fakeHealth(data) {
    return {
        calls: [],
        isSupported: () => true,
        requestAuthorization: vi.fn(async () => true),
        async query({ type, anchor, limit }) {
            this.calls.push({ type, anchor, limit });
            const from = anchor ? Number(anchor) : 0;
            const all = data[type] || [];
            const page = all.slice(from, from + limit);
            return { samples: page, anchor: String(from + page.length), returned: page.length, more: from + page.length < all.length };
        },
    };
}

const bpSample = (uuid, start, systolic, diastolic) => ({ uuid, start, systolic, diastolic });
const kgSample = (uuid, start, kg) => ({ uuid, start, kg });

describe('Apple Health import', () => {
    let records;
    let storage;
    let flush;

    beforeEach(() => {
        records = memRecords();
        storage = memStorage();
        storage.setItem('wg.health.enabled', 'true');
        flush = vi.fn(async () => true);
    });

    it('imports BP and weight once into the existing record shapes, marked as Apple Health', async () => {
        const health = fakeHealth({
            bp: [bpSample(U1, T0, 121.0, 79.4)],
            weight: [kgSample(U2, T0 + 60_000, 72.3456)],
        });
        const opts = { health, storage, records, flush, now: () => T0 + 3_600_000 };

        expect(await runHealthImport({}, opts)).toEqual({ added: 2 });
        // Second run: the anchors moved on, nothing comes back, nothing is added.
        expect(await runHealthImport({}, opts)).toEqual({ added: 0 });
        expect(flush).toHaveBeenCalledTimes(1);

        const bp = records.rows.get(`bp-hk-${U1}`);
        expect(bp).toMatchObject({
            recordType: 'bp', clientTs: 0, deleted: false, source: 'apple_health',
            measured_at: '2026-10-01T07:30:00.000Z', systolic: 121, diastolic: 79,
            category: 'Elevated',
        });
        const w = records.rows.get(`weight-hk-${U2}`);
        expect(w).toMatchObject({ recordType: 'weight', clientTs: 0, weight: 72.35, source: 'apple_health' });

        // The existing BP domain reads it like any reading; source is additive.
        const listed = await createBPDomain({ records, now: () => T0 + 3_600_000, timeZone: 'UTC' }).list({ days: 0 });
        expect(listed).toEqual([expect.objectContaining({ id: `bp-hk-${U1}`, systolic: 121, diastolic: 79, source: 'apple_health' })]);
    });

    it('is idempotent across a reset anchor and never resurrects a deleted or edited reading', async () => {
        const data = { bp: [bpSample(U1, T0, 130, 85), bpSample(U3, T0 + 1000, 118, 76)], weight: [] };
        await runHealthImport({}, { health: fakeHealth(data), storage, records, flush });
        // The user deletes one and edits the other in the app...
        await records.del('bp', `bp-hk-${U1}`);
        await records.put('bp', { ...records.rows.get(`bp-hk-${U3}`), clientTs: 99, notes: 'after coffee' });
        // ...then the anchors are lost (reinstall / second iPhone): a full re-scan.
        storage.setItem('wg.health.anchors', '{}');
        expect(await runHealthImport({}, { health: fakeHealth(data), storage, records, flush })).toEqual({ added: 0 });
        expect(records.rows.get(`bp-hk-${U1}`).deleted).toBe(true);
        expect(records.rows.get(`bp-hk-${U3}`)).toMatchObject({ clientTs: 99, notes: 'after coffee' });
    });

    it('pages through a long history and resumes from the saved anchor', async () => {
        const weight = Array.from({ length: 1200 }, (_, i) => kgSample(
            `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, T0 + i * 86_400_000, 80 - i / 100));
        const health = fakeHealth({ bp: [], weight });
        expect(await runHealthImport({}, { health, storage, records, flush })).toEqual({ added: 1200 });
        expect(health.calls.filter((c) => c.type === 'weight').map((c) => c.anchor)).toEqual([null, '500', '1000']);
        // bp returned nothing (none recorded, or read access denied): no anchor
        // is kept, so history granted later is still read from the start.
        expect(JSON.parse(storage.getItem('wg.health.anchors'))).toEqual({ weight: '1200' });
    });

    it('a vault backup and restore keeps the Health-derived ids, so the next scan finds them', async () => {
        const data = { bp: [bpSample(U1, T0, 125, 82)], weight: [kgSample(U2, T0, 70)] };
        await runHealthImport({}, { health: fakeHealth(data), storage, records, flush });
        const vault = recordsToVault([...records.rows.values()], { now: T0 });
        expect(vault.data.bp.readings[0]).toMatchObject({ source: 'apple_health', source_id: U1 });
        const restored = memRecords();
        for (const r of vaultToRecords(vault, { now: T0 })) restored.rows.set(r.recordId, r);
        expect(restored.rows.has(`bp-hk-${U1}`)).toBe(true);
        expect(restored.rows.has(`weight-hk-${U2}`)).toBe(true);
        storage.setItem('wg.health.anchors', '{}');
        expect(await runHealthImport({}, { health: fakeHealth(data), storage, records: restored, flush })).toEqual({ added: 0 });
    });

    // bd med-8f4s.1: an edited Health weight keeps its source (the write-back
    // skips it, the UI keeps its label) but not its source_id, so a restore
    // mints it a normal id instead of folding it into the Health slot.
    it('an edited Health weight stays from Health through re-edits, and restores under a normal id', async () => {
        await runHealthImport({}, { health: fakeHealth({ weight: [kgSample(U2, T0, 70)] }), storage, records, flush });
        const weight = createWeightDomain({ records, now: () => T0 + 60_000, timeZone: 'UTC' });
        const edited = await weight.create({ measured_at: T0, weight: 71 }, { replacesId: `weight-hk-${U2}` });
        const row = records.rows.get(edited.id);
        expect(row.source).toBe('apple_health');
        expect(row).not.toHaveProperty('source_id');
        const again = await createWeightDomain({ records, now: () => T0 + 120_000, timeZone: 'UTC' })
            .create({ measured_at: T0, weight: 72 }, { replacesId: edited.id });
        expect(records.rows.get(again.id).source).toBe('apple_health');
        // A manual edit stays manual.
        const manual = await weight.create({ measured_at: T0 + 1000, weight: 80 });
        const manualEdit = await weight.create({ measured_at: T0 + 1000, weight: 81 }, { replacesId: manual.id });
        expect(records.rows.get(manualEdit.id)).not.toHaveProperty('source');

        const restored = vaultToRecords(recordsToVault([records.rows.get(again.id)], { now: T0 }), { now: T0 })
            .filter((r) => r.recordType === 'weight');
        expect(restored).toHaveLength(1);
        expect(restored[0].recordId).not.toMatch(/-hk-/);
        expect(restored[0].source).toBe('apple_health');
    });

    it('a deleted Health reading stays deleted across a backup, restore and full rescan', async () => {
        const data = { bp: [bpSample(U1, T0, 125, 82)], weight: [kgSample(U2, T0, 70)] };
        await runHealthImport({}, { health: fakeHealth(data), storage, records, flush });
        await records.del('bp', `bp-hk-${U1}`);
        await records.del('weight', `weight-hk-${U2}`);
        const vault = recordsToVault([...records.rows.values()], { now: T0 });
        expect(vault.data.tombstones).toEqual([
            { recordType: 'bp', recordId: `bp-hk-${U1}` },
            { recordType: 'weight', recordId: `weight-hk-${U2}` },
        ]);
        const restored = memRecords();
        for (const r of vaultToRecords(vault, { now: T0 })) restored.rows.set(r.recordId, r);
        storage.setItem('wg.health.anchors', '{}');
        expect(await runHealthImport({}, { health: fakeHealth(data), storage, records: restored, flush })).toEqual({ added: 0 });
        expect(restored.rows.get(`bp-hk-${U1}`).deleted).toBe(true);
    });

    it('a reading restored under a fresh id (older client) is still recognised by its source_id', async () => {
        const data = { bp: [bpSample(U1, T0, 125, 82)], weight: [kgSample(U2, T0, 70)] };
        await runHealthImport({}, { health: fakeHealth(data), storage, records, flush });
        const restored = memRecords();
        for (const r of records.rows.values()) {
            const fresh = r.recordType === 'bp' ? 'bp-1' : 'weight-2';
            restored.rows.set(fresh, { ...r, recordId: fresh, clientTs: T0 });
        }
        storage.setItem('wg.health.anchors', '{}');
        expect(await runHealthImport({}, { health: fakeHealth(data), storage, records: restored, flush })).toEqual({ added: 0 });
        expect(restored.rows.size).toBe(2);
    });

    it('two devices with different histories write the same body for one sample', async () => {
        const sample = { weight: [kgSample(U2, T0, 70)] };
        const a = memRecords();
        const b = memRecords();
        await b.put('weight', { recordId: 'weight_1_x', clientTs: 5, deleted: false, measured_at: '2026-10-05T07:00:00.000Z', weight: 100, weight_trend: 100 });
        await runHealthImport({}, { health: fakeHealth(sample), storage, records: a, flush });
        const s2 = memStorage();
        s2.setItem('wg.health.enabled', 'true');
        await runHealthImport({}, { health: fakeHealth(sample), storage: s2, records: b, flush });
        expect(a.rows.get(`weight-hk-${U2}`)).toEqual(b.rows.get(`weight-hk-${U2}`));
        expect(a.rows.get(`weight-hk-${U2}`).weight_trend).toBeNull();
    });

    it('Health weights feed the trend EMA, and the trend shown matches the one a restore rebuilds', async () => {
        const DAY = 86_400_000;
        const data = { bp: [], weight: [kgSample(U1, T0, 70), kgSample(U2, T0 + DAY, 100)] };
        await runHealthImport({}, { health: fakeHealth(data), storage, records, flush });
        const weight = createWeightDomain({ records, now: () => T0 + 3 * DAY, timeZone: 'UTC' });
        const manual = await weight.create({ measured_at: T0 + 2 * DAY, weight: 100 });
        expect(manual.weight_trend).toBeCloseTo(75.7, 6); // 70 → 73 → 75.7, not reset to 100
        const shown = (await weight.list({ days: 0 })).map((l) => l.weight_trend);
        const restored = memRecords();
        for (const r of vaultToRecords(recordsToVault([...records.rows.values()], { now: T0 }), { now: T0 })) {
            restored.rows.set(r.recordId, r);
        }
        const after = (await createWeightDomain({ records: restored, now: () => T0 + 3 * DAY, timeZone: 'UTC' })
            .list({ days: 0 })).map((l) => l.weight_trend);
        expect(after).toEqual(shown);
        expect(shown.map((t) => Math.round(t * 10) / 10)).toEqual([75.7, 73, 70]);
    });

    it('a manual-only weight history keeps its stored trends', async () => {
        await records.put('weight', { recordId: 'w1', clientTs: 1, deleted: false, measured_at: '2026-10-01T07:00:00.000Z', weight: 80, weight_trend: 81 });
        await records.put('weight', { recordId: 'w2', clientTs: 2, deleted: false, measured_at: '2026-10-02T07:00:00.000Z', weight: 90, weight_trend: 85 });
        const weight = createWeightDomain({ records, now: () => T0 + 86_400_000 * 5, timeZone: 'UTC' });
        expect((await weight.list({ days: 0 })).map((l) => l.weight_trend)).toEqual([85, 81]);
        expect((await weight.create({ measured_at: '2026-10-03T07:00:00.000Z', weight: 95 })).weight_trend).toBeCloseTo(86, 6);
    });

    describe('weight trend around Apple Health rows', () => {
        const NOW = () => Date.parse('2026-10-20T00:00:00Z');
        const hkRow = (weight, measured_at) => ({
            recordId: `weight-hk-${U1}`, clientTs: 0, deleted: false, weight, weight_trend: null, measured_at,
            source: 'apple_health', source_id: U1,
        });
        const trends = async (recs) => (await createWeightDomain({ records: recs, now: NOW, timeZone: 'UTC' })
            .list({ days: 0 })).map((l) => l.weight_trend);
        const restoreOf = (recs) => {
            const out = memRecords();
            for (const r of vaultToRecords(recordsToVault([...recs.rows.values()], { now: T0 }), { now: T0 })) {
                out.rows.set(r.recordId, r);
            }
            return out;
        };

        it('a history without Health rows reads as stored, a missing trend included', async () => {
            await records.put('weight', { recordId: 'w1', clientTs: 1, deleted: false, measured_at: '2026-10-01T00:00:00Z', weight: 70, weight_trend: null });
            await records.put('weight', { recordId: 'w2', clientTs: 2, deleted: false, measured_at: '2026-10-02T00:00:00Z', weight: 100, weight_trend: 90 });
            expect(await trends(records)).toEqual([90, undefined]);
            const next = await createWeightDomain({ records, now: NOW, timeZone: 'UTC' })
                .create({ measured_at: '2026-10-03T00:00:00Z', weight: 100 });
            expect(next.weight_trend).toBeCloseTo(91, 6);
        });

        it('a restore keeps Health rows trend-less, so later deletes read the same with or without it', async () => {
            await records.put('weight', { recordId: 'w1', clientTs: 1, deleted: false, measured_at: '2026-10-01T00:00:00Z', weight: 70, weight_trend: 70 });
            await records.put('weight', hkRow(100, '2026-10-02T00:00:00Z'));
            await records.put('weight', { recordId: 'w3', clientTs: 3, deleted: false, measured_at: '2026-10-03T00:00:00Z', weight: 100, weight_trend: 75.7 });
            const restored = restoreOf(records);
            expect(restored.rows.get(`weight-hk-${U1}`).weight_trend).toBeNull();
            const restoredFirst = [...restored.rows.values()].find((r) => r.weight === 70).recordId;
            await createWeightDomain({ records, now: NOW, timeZone: 'UTC' }).remove('w1');
            await createWeightDomain({ records: restored, now: NOW, timeZone: 'UTC' }).remove(restoredFirst);
            expect(await trends(records)).toEqual([100, 100]);
            expect(await trends(restored)).toEqual([100, 100]);
        });

        it('timestamps with an RFC3339 offset order the same before and after a restore', async () => {
            await records.put('weight', hkRow(70, '2026-10-02T00:00:00Z'));
            await records.put('weight', { recordId: 'w1', clientTs: 1, deleted: false, measured_at: '2026-10-01T23:00:00-02:00', weight: 100, weight_trend: 100 });
            // The manual reading is 01:00Z, after the Health one: 70, then 73.
            expect(await trends(records)).toEqual([73, 70]);
            expect(await trends(restoreOf(records))).toEqual([73, 70]);
        });

        it('readings at the same instant keep one chain order across a restore', async () => {
            const at = '2026-10-02T00:00:00Z';
            await records.put('weight', { recordId: 'w1', clientTs: 1, deleted: false, measured_at: at, weight: 80, weight_trend: 80 });
            await records.put('weight', hkRow(70, at));
            const pairs = async (recs) => (await createWeightDomain({ records: recs, now: NOW, timeZone: 'UTC' })
                .list({ days: 0 })).map((l) => [l.weight, l.weight_trend]);
            expect(await pairs(records)).toEqual([[70, 70], [80, 71]]);
            expect(await pairs(restoreOf(records))).toEqual([[70, 70], [80, 71]]);
        });

        it('a Health and a manual reading tied on instant and weight keep their trends across a restore', async () => {
            const at = '2026-10-02T00:00:00Z';
            await records.put('weight', { recordId: 'w0', clientTs: 1, deleted: false, measured_at: '2026-10-01T00:00:00Z', weight: 60, weight_trend: 60 });
            await records.put('weight', { recordId: 'z-manual', clientTs: 2, deleted: false, measured_at: at, weight: 80, weight_trend: 80 });
            await records.put('weight', hkRow(80, at));
            const bySource = async (recs) => Object.fromEntries((await createWeightDomain({ records: recs, now: NOW, timeZone: 'UTC' })
                .list({ days: 0 })).map((l) => [l.source || (l.weight === 60 ? 'first' : 'manual'), l.weight_trend]));
            const live = await bySource(records);
            expect(live.apple_health).toBeCloseTo(62, 6);
            expect(live.manual).toBeCloseTo(63.8, 6);
            expect(await bySource(restoreOf(records))).toEqual(live);
        });

        it('after a restore, deleting the last Health row leaves the trends that were shown', async () => {
            await records.put('weight', hkRow(70, '2026-10-01T00:00:00Z'));
            await records.put('weight', { recordId: 'a', clientTs: 1, deleted: false, measured_at: '2026-10-01T23:00:00-02:00', weight: 100, weight_trend: 100 });
            await records.put('weight', { recordId: 'b', clientTs: 2, deleted: false, measured_at: '2026-10-02T00:30:00Z', weight: 80, weight_trend: 80 });
            const shown = await trends(records); // 70, then 80 → 71, then 100 → 73.9 (time order)
            const restored = restoreOf(records);
            await createWeightDomain({ records: restored, now: NOW, timeZone: 'UTC' }).remove(`weight-hk-${U1}`);
            const left = await trends(restored);
            expect(left[0]).toBeCloseTo(73.9, 6);
            expect(left[1]).toBeCloseTo(71, 6);
            expect(left).toEqual(shown.slice(0, 2));
        });
    });

    it('deleting a reading restored under a fresh id (older client) keeps it deleted on a full rescan', async () => {
        const data = { bp: [bpSample(U1, T0, 125, 82)], weight: [kgSample(U2, T0, 70)] };
        await runHealthImport({}, { health: fakeHealth(data), storage, records, flush });
        const restored = memRecords();
        for (const r of records.rows.values()) {
            const fresh = r.recordType === 'bp' ? 'bp-1' : 'weight-2';
            restored.rows.set(fresh, { ...r, recordId: fresh, clientTs: T0 });
        }
        const deps = { records: restored, now: () => T0, timeZone: 'UTC' };
        await createBPDomain(deps).remove('bp-1');
        await createWeightDomain(deps).remove('weight-2');
        storage.setItem('wg.health.anchors', '{}');
        expect(await runHealthImport({}, { health: fakeHealth(data), storage, records: restored, flush })).toEqual({ added: 0 });
        expect(await restored.list('bp')).toEqual([]);
        expect(await restored.list('weight')).toEqual([]);
    });

    it('skips malformed samples instead of stalling the import', async () => {
        const health = fakeHealth({
            bp: [bpSample('not-a-uuid', T0, 120, 80), bpSample(U1, NaN, 120, 80), bpSample(U3, T0, 0, 80), bpSample(U2, T0, 120, 80)],
            weight: [kgSample(U1, T0, -1)],
        });
        expect(await runHealthImport({}, { health, storage, records, flush })).toEqual({ added: 1 });
        expect([...records.rows.keys()]).toEqual([`bp-hk-${U2}`]);
    });

    it('does nothing while the toggle is off, and when Health is unsupported (web)', async () => {
        storage.setItem('wg.health.enabled', 'false');
        const health = fakeHealth({ bp: [bpSample(U1, T0, 120, 80)] });
        expect(await runHealthImport({}, { health, storage, records, flush })).toBeNull();
        storage.setItem('wg.health.enabled', 'true');
        expect(await runHealthImport({}, { health: { isSupported: () => false }, storage, records, flush })).toBeNull();
        expect(startHealthImport({}, { health: { isSupported: () => false }, storage, doc: document })).toBeNull();
        expect(health.calls).toEqual([]);
        expect(records.rows.size).toBe(0);
    });

    describe('Settings row', () => {
        beforeEach(() => {
            document.body.innerHTML = '<div id="settings-view"><div class="wg-settings-home"><div class="wg-list"></div></div></div>';
            storage.setItem('wg.health.enabled', 'false');
        });

        const desc = () => document.querySelector('#health-import-row .wg-setting__desc').textContent;
        const toggle = () => document.getElementById('health-import-toggle');
        const flip = async (on) => {
            toggle().checked = on;
            toggle().dispatchEvent(new window.Event('change'));
            await new Promise((r) => setTimeout(r, 0));
        };

        it('turning it on asks Health for read access, imports, and shows the status', async () => {
            const health = fakeHealth({ bp: [bpSample(U1, T0, 120, 80)] });
            const run = vi.fn((o) => runHealthImport({}, { ...o, records, flush }));
            const afterImport = vi.fn(async () => {});
            await startHealthImport({}, { health, storage, doc: document, run, afterImport });
            expect(toggle().checked).toBe(false);
            expect(desc()).toBe('Import blood pressure, weight, sleep, workouts, steps, heart rate and SpO2');

            await flip(true);
            await new Promise((r) => setTimeout(r, 0));
            expect(health.requestAuthorization).toHaveBeenCalledWith(['bp', 'weight', 'sleep', 'workout', 'steps', 'hr', 'spo2']);
            expect(records.rows.has(`bp-hk-${U1}`)).toBe(true);
            expect(afterImport).toHaveBeenCalledTimes(1);
            expect(desc()).toMatch(/^Checked .* · 1 reading so far \(last new .*\)\. No sleep found: .*\.$/); // BP only: the Sleep switch hint
            expect(healthStatusText(storage)).toBe(desc());

            // Off and on again is the manual rescan: it starts from no anchor.
            await flip(false);
            const before = health.calls.length;
            await flip(true);
            await new Promise((r) => setTimeout(r, 0));
            // Steps are read by window, never by anchor.
            expect(health.calls.slice(before).map((c) => c.anchor)).toEqual([null, null, null, null, undefined, null, null]);
        });

        it('flips back with a message when this device has no Health store', async () => {
            const health = fakeHealth({});
            health.requestAuthorization = vi.fn(async () => false);
            await startHealthImport({}, { health, storage, doc: document, run: vi.fn(async () => null) });
            await flip(true);
            expect(toggle().checked).toBe(false);
            expect(desc()).toBe('Apple Health is not available on this device.');
            expect(storage.getItem('wg.health.enabled')).toBe('false');
        });

        it('says where to look when access was denied (Health returns nothing)', async () => {
            const health = fakeHealth({});
            await startHealthImport({}, { health, storage, doc: document, run: (o) => runHealthImport({}, { ...o, records, flush }) });
            await flip(true);
            await new Promise((r) => setTimeout(r, 0));
            expect(desc()).toMatch(/nothing yet\. Check access in Settings → Health/);
        });

        // bd med-nt9p.8: the Android shell's capability names Health Connect.
        it('takes the store name and access hint from the capability', async () => {
            const health = { ...fakeHealth({}), label: 'Health Connect', accessHint: 'Health Connect → App permissions' };
            health.requestAuthorization = vi.fn(async () => false);
            await startHealthImport({}, { health, storage, doc: document, run: vi.fn(async () => null) });
            expect(document.querySelector('#health-import-row .wg-setting__title').textContent).toBe('Health Connect');
            expect(toggle().getAttribute('aria-label')).toBe('Import from Health Connect');
            await flip(true);
            expect(desc()).toBe('Health Connect is not available on this device.');
            storage.setItem('wg.health.enabled', 'true');
            storage.setItem('wg.health.last', JSON.stringify({ checkedAt: Date.now(), total: 0 }));
            expect(healthStatusText(storage, health)).toMatch(/nothing yet\. Check access in Health Connect → App permissions\.$/);
        });

        it('a toggle switched on by an older build asks once for the new kinds', async () => {
            storage.setItem('wg.health.enabled', 'true');
            // A med-w6gx.7 build asked for these; steps/HR/SpO2 (med-0xad.1) are new.
            storage.setItem('wg.health.asked', JSON.stringify(['bp', 'weight', 'sleep', 'workout']));
            const health = fakeHealth({});
            await startHealthImport({}, { health, storage, doc: document, run: vi.fn(async () => null) });
            expect(health.requestAuthorization).toHaveBeenCalledWith(['bp', 'weight', 'sleep', 'workout', 'steps', 'hr', 'spo2']);
            await startHealthImport({}, { health, storage, doc: document, run: vi.fn(async () => null) });
            expect(health.requestAuthorization).toHaveBeenCalledTimes(1);
        });
    });

    // bd med-w6gx.7: sleep nights and workouts.
    describe('sleep and workouts', () => {
        const H = 3_600_000;
        const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
        const N0 = Date.parse('2026-10-01T21:00:00Z');
        const WATCH = 'com.apple.health.watch';
        const slp = (n, start, end, value, source = WATCH, tz = 'Europe/Berlin') => ({ uuid: uid(n), start, end, value, source, tz });
        // One Watch night (core/deep/awake/rem/core) under an iPhone in-bed span.
        const night = [
            slp(1, N0, N0 + 2 * H, 3),
            slp(2, N0 + 2 * H, N0 + 3 * H, 4),
            slp(3, N0 + 3 * H, N0 + 3 * H + 10 * 60_000, 2),
            slp(4, N0 + 3 * H + 10 * 60_000, N0 + 4 * H + 10 * 60_000, 5),
            slp(5, N0 + 4 * H + 10 * 60_000, N0 + 8 * H, 3),
            slp(6, N0 - 30 * 60_000, N0 + 8.5 * H, 0, 'com.apple.iphone'),
        ];
        const run = (id, start, end, activity, extra = {}) => ({ uuid: uid(id), start, end, activity, duration: (end - start) / 1000, ...extra });
        const W0 = Date.parse('2026-10-03T06:00:00Z');
        // The night above ends 07:00 Berlin on 2 Oct: that sleep day's record.
        const DAY_ID = 'sleep-hk-2026-10-02';

        // Like Health.swift: a sleep page is every sleep sample, with the
        // window padded 18h around them; other kinds page as fakeHealth does.
        function healthOf(data) {
            const h = fakeHealth(data);
            const page = h.query.bind(h);
            h.query = async (args) => {
                if (args.type === 'sleep' && Number.isFinite(args.from)) {
                    h.calls.push(args);
                    const samples = data.sleep.filter((s) => s.start < args.to && s.end > args.from);
                    return { samples, from: args.from, to: args.to, returned: 0, more: false };
                }
                const res = await page(args);
                if (args.type !== 'sleep' || !res.samples.length) return res;
                const from = Math.min(...res.samples.map((s) => s.start)) - 48 * H;
                const to = Math.max(...res.samples.map((s) => s.end)) + 48 * H;
                return { ...res, from, to, samples: data.sleep.filter((s) => s.start < to && s.end > from) };
            };
            return h;
        }
        const opts = (data, recs = records) => ({ health: healthOf(data), storage, records: recs, flush, now: () => W0 + 24 * H });

        it('imports one night into the existing sleep shape, on its own wake day and offset', async () => {
            const mi = slp(7, N0 + 0.5 * H, N0 + 7.5 * H, 1, 'com.mi.fitness'); // a second source, shorter: yields
            expect(await runHealthImport({}, opts({ sleep: [...night, mi] }))).toEqual({ added: 1 });
            const row = records.rows.get(DAY_ID);
            const body = {
                start_time: '2026-10-01T21:00:00Z', end_time: '2026-10-02T05:00:00Z',
                timezone_offset: -120, day: '2026-10-02',
                light_minutes: 350, deep_minutes: 60, rem_minutes: 60, awake_minutes: 10, total_minutes: 470,
                user_modified: false, source: 'apple_health', source_id: '2026-10-02',
            };
            expect(row).toEqual({
                recordId: DAY_ID, recordType: 'sleep', clientTs: 0, deleted: false, ...body,
            });
            const vitals = createVitalsDomain({ records, now: () => W0, timeZone: 'UTC' });
            expect(await vitals.sleepDaily({ from: N0 - 24 * H })).toEqual([
                expect.objectContaining({ date: '2026-10-02', total_mins: 470, deep_mins: 60 }),
            ]);
            // Rescan: nothing new.
            storage.setItem('wg.health.anchors', '{}');
            expect(await runHealthImport({}, opts({ sleep: [...night, mi] }))).toEqual({ added: 0 });
        });

        it('a night clipped by the window waits', async () => {
            const domain = createHealthImportDomain({ records: memRecords(), now: () => W0, timeZone: 'UTC' });
            expect(await domain.importSamples('sleep', night, { from: N0 - 30 * 60_000, to: N0 + 20 * H })).toMatchObject({ added: 0 });
            expect(await domain.importSamples('sleep', night, { from: N0 - 2 * H, to: N0 + 20 * H })).toMatchObject({ added: 1 });
        });

        // bd med-w6gx.31, med-0xad.4: a sleep day holds one row. A .nxk import
        // folds its sessions into the day (vitals.js importSamples →
        // healthsource.js unifySleep): the more asleep minutes win, a tie
        // against Health to the band. Legacy rows still stored are picked on
        // read (visibleSleep) until the boot pass converts them.
        describe('a sleep day held by Health and a Mi Band shows one source', () => {
            const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
            // A Mi Band session (Berlin, minutes west), no phases unless given.
            const band = (start, end, extra = {}) => ({
                start_time: iso(start), end_time: iso(end), day: '2026-10-02',
                total_minutes: (end - start) / 60_000, timezone_offset: -120, ...extra,
            });
            // A Health day as the importer writes it (unstaged: awake set, no phases).
            const hk = (total) => ({
                recordId: DAY_ID, clientTs: 0, deleted: false, start_time: iso(N0), end_time: iso(N0 + 8 * H),
                timezone_offset: -120, day: '2026-10-02', light_minutes: null, deep_minutes: null, rem_minutes: null,
                awake_minutes: 10, total_minutes: total, user_modified: false, source: 'apple_health', source_id: '2026-10-02',
            });
            const night2 = night.map((s, i) => ({ ...s, uuid: uid(11 + i), start: s.start + 24 * H, end: s.end + 24 * H }));
            const DAY2_ID = 'sleep-hk-2026-10-03';
            const vitals = (recs = records) => createVitalsDomain({ records: recs, now: () => W0 + 24 * H, timeZone: 'UTC' });
            const shown = async (recs = records) => (await vitals(recs).sleep({ from: iso(N0 - 48 * H) })).map((r) => r.id).sort();
            const noneDeleted = (recs = records) => [...recs.rows.values()].every((r) => !r.deleted);

            it('either import order keeps the fuller night on the day id; a rescan and a replay change nothing', async () => {
                const full = band(N0 - 30 * 60_000, N0 + 8 * H); // 510 min vs Health 470
                const want = [DAY_ID, DAY2_ID];
                expect(await runHealthImport({}, opts({ sleep: [...night, ...night2] }))).toEqual({ added: 2 });
                const day2 = records.rows.get(DAY2_ID);
                await vitals().importSamples({ sleep: [full] });
                expect(await shown()).toEqual(want);
                expect(records.rows.get(DAY_ID)).toMatchObject({ source: 'miband', total_minutes: 510 });
                expect(records.rows.get(DAY2_ID)).toBe(day2); // another night: untouched, shown
                expect([...records.rows.keys()].sort()).toEqual([`sleep-${N0 - 30 * 60_000}`, DAY_ID, DAY2_ID]); // the session is the ledger
                expect(noneDeleted()).toBe(true);
                storage.setItem('wg.health.anchors', '{}');
                expect(await runHealthImport({}, opts({ sleep: [...night, ...night2] }))).toEqual({ added: 0 });
                const before = JSON.stringify([...records.rows.entries()]);
                await vitals().importSamples({ sleep: [full] });
                expect(JSON.stringify([...records.rows.entries()])).toBe(before);

                const other = memRecords();
                await vitals(other).importSamples({ sleep: [full] });
                storage.setItem('wg.health.anchors', '{}'); // a fresh vault reads Health from the start
                expect(await runHealthImport({}, opts({ sleep: [...night, ...night2] }, other))).toEqual({ added: 1 });
                expect(await shown(other)).toEqual(want);
                expect(other.rows.get(DAY_ID)).toMatchObject({ source: 'miband', total_minutes: 510 });
                expect(noneDeleted(other)).toBe(true);
            });

            it('a truncated band night that lands first yields to the fuller Health night', async () => {
                await vitals().importSamples({ sleep: [band(N0, N0 + 3 * H)] }); // band off the wrist
                expect(records.rows.get(DAY_ID)).toMatchObject({ source: 'miband', total_minutes: 180 });
                expect(await runHealthImport({}, opts({ sleep: night }))).toEqual({ added: 1 });
                expect(records.rows.get(DAY_ID)).toMatchObject({ source: 'apple_health', total_minutes: 470, clientTs: W0 + 24 * H });
                storage.setItem('wg.health.anchors', '{}');
                expect(await runHealthImport({}, opts({ sleep: night }))).toEqual({ added: 0 });
                await vitals().importSamples({ sleep: [band(N0, N0 + 3 * H)] }); // the re-upload changes nothing
                expect(records.rows.get(DAY_ID)).toMatchObject({ source: 'apple_health', total_minutes: 470 });
            });

            it('a 30-minute band nap does not replace a Health 8h night plus nap', async () => {
                const nap = slp(20, N0 + 15 * H, N0 + 16 * H, 1);
                expect(await runHealthImport({}, opts({ sleep: [...night, nap] }))).toEqual({ added: 1 });
                await vitals().importSamples({ sleep: [band(N0 + 11 * H, N0 + 11.5 * H)] });
                expect(await shown()).toEqual([DAY_ID]);
                expect((await vitals().sleepDaily({ from: N0 - 24 * H }))).toEqual([
                    expect.objectContaining({ date: '2026-10-02', total_mins: 530 }),
                ]);
                expect(records.rows.size).toBe(2); // the nap is kept in the ledger, hidden
            });

            it.each([
                ['a truncated 3h band night loses to 8h Health', [band(N0 + H, N0 + 4 * H)], 480, 'health'],
                ['7h vs 7h: the tie goes to the band', [band(N0, N0 + 7 * H)], 420, 'band'],
                ['band sessions of one day are summed', [band(N0, N0 + 5 * H), band(N0 + 12 * H, N0 + 15 * H)], 470, 'band'],
                ['awake minutes do not count (420 asleep vs 450)', [band(N0, N0 + 8 * H, { awake_minutes: 60 })], 450, 'health'],
                ['phases are the asleep minutes (150+200+70 vs 450)',
                    [band(N0, N0 + 8 * H, { awake_minutes: 60, light_minutes: 150, deep_minutes: 200, rem_minutes: 70 })], 450, 'health'],
            ])('%s', async (_name, sessions, healthTotal, winner) => {
                await records.put('sleep', hk(healthTotal));
                await vitals().importSamples({ sleep: sessions });
                expect(await shown()).toEqual([DAY_ID]);
                expect(records.rows.get(DAY_ID).source).toBe(winner === 'health' ? 'apple_health' : 'miband');
                expect(records.rows.size).toBe(1 + sessions.length); // each session kept as its ledger row
            });

            it('a bot-era row (timezone_offset in seconds east) files on its own night', async () => {
                await records.put('sleep', hk(450));
                await records.put('sleep', { recordId: `sleep-${N0}`, clientTs: 1, deleted: false, ...band(N0, N0 + 8 * H), timezone_offset: 10800 });
                expect(await shown()).toEqual([`sleep-${N0}`]);
                expect(noneDeleted()).toBe(true);
            });

            it('a later, fuller .nxk flips the day to the band; a backup round trip keeps the row and the view', async () => {
                await records.put('sleep', hk(450));
                await vitals().importSamples({ sleep: [band(N0, N0 + 3 * H)] }); // battery died
                expect(records.rows.get(DAY_ID).source).toBe('apple_health');
                await vitals().importSamples({ sleep: [band(N0, N0 + 8 * H)] }); // the cumulative re-upload
                expect(records.rows.get(DAY_ID)).toMatchObject({ source: 'miband', total_minutes: 480 });
                expect(await shown()).toEqual([DAY_ID]);
                expect(noneDeleted()).toBe(true);

                const vault = recordsToVault([...records.rows.values()], { now: W0 });
                expect(vault.data.vitals.sleep).toHaveLength(2); // the session and its day row
                const restored = memRecords();
                for (const r of vaultToRecords(vault, { now: W0 })) restored.rows.set(r.recordId, r);
                expect(await vitals(restored).sleep({ from: iso(N0 - 48 * H) })).toEqual(await vitals().sleep({ from: iso(N0 - 48 * H) }));
                expect((await restored.listRaw('sleep')).map((r) => r.recordId).sort()).toEqual([`sleep-${N0}`, DAY_ID]);
            });

            // Archie 5372: a cumulative re-upload costs only the nights that changed.
            it('re-uploading the same backup writes nothing; one fuller night writes one row', async () => {
                const backup = [band(N0, N0 + 7 * H), band(N0 + 24 * H, N0 + 31 * H, { day: '2026-10-03' })];
                await vitals().importSamples({ sleep: backup });
                expect([...records.rows.keys()].sort()).toEqual([`sleep-${N0}`, `sleep-${N0 + 24 * H}`, DAY_ID, DAY2_ID]);
                const ops = [];
                const { put, del } = records;
                records.put = (t, r) => { ops.push(`put ${r.recordId}`); return put(t, r); };
                records.del = (t, id) => { ops.push(`del ${id}`); return del(t, id); };
                await vitals().importSamples({ sleep: backup });
                expect(ops).toEqual([]);
                await vitals().importSamples({ sleep: [backup[0], band(N0 + 24 * H, N0 + 32 * H, { day: '2026-10-03' })] });
                expect(ops).toEqual([`put sleep-${N0 + 24 * H}`, `put ${DAY2_ID}`]);
            });

            // bd med-0xad.9 (e): an nxk upload stores its sessions; a re-upload writes nothing.
            it('an upload stores each session as its ledger row before folding', async () => {
                const s1 = band(N0, N0 + 7 * H);
                const s2 = band(N0 + 15 * H, N0 + 15.5 * H);
                await vitals().importSamples({ sleep: [s1, s2] });
                expect(records.rows.get(`sleep-${N0}`)).toMatchObject({ ...s1, deleted: false });
                expect(records.rows.get(`sleep-${N0 + 15 * H}`)).toMatchObject({ ...s2, deleted: false });
                expect(records.rows.get(DAY_ID)).toMatchObject({ source: 'miband', total_minutes: 450 });
                expect(await shown()).toEqual([DAY_ID]);
                const before = JSON.stringify([...records.rows.entries()]);
                await vitals().importSamples({ sleep: [s1, s2] });
                expect(JSON.stringify([...records.rows.entries()])).toBe(before);
            });

            // bd med-0xad.9 (d): a projected day ties its ledger; the read shows the day row only.
            it('a day row tying its live sessions is shown alone; a fuller ledger shows instead', async () => {
                const s1 = band(N0, N0 + 7 * H);
                await vitals().importSamples({ sleep: [s1] });
                expect(await shown()).toEqual([DAY_ID]);
                expect(await vitals().sleepDaily({ from: N0 - 24 * H })).toEqual([
                    expect.objectContaining({ date: '2026-10-02', total_mins: 420 }),
                ]);
                // A session synced in before the next fold: the ledger is fuller.
                await records.put('sleep', { recordId: `sleep-${N0 + 15 * H}`, clientTs: 9, deleted: false, ...band(N0 + 15 * H, N0 + 16 * H) });
                expect(await shown()).toEqual([`sleep-${N0}`, `sleep-${N0 + 15 * H}`]);
            });
        });

        // bd med-0xad.4: one sleep model. vitals.unifyLegacy turns the legacy
        // per-session rows into one sleep-hk-<day> row and drops stress.
        describe('legacy sleep sessions convert to day rows', () => {
            const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
            const NOW = W0 + 24 * H;
            const vitals = (recs = records) => createVitalsDomain({ records: recs, now: () => NOW, timeZone: 'UTC' });
            const legacy = (start, end, extra = {}) => ({
                recordId: `sleep-${start}`, clientTs: 5, deleted: false, start_time: iso(start), end_time: iso(end),
                timezone_offset: -120, day: '2026-10-02', total_minutes: (end - start) / 60_000, user_modified: false, notes: '', ...extra,
            });
            // Two sessions of one night and an afternoon nap: one sleep day (2 Oct, Berlin).
            const a = legacy(N0 - 30 * 60_000, N0 + 3 * H, { light_minutes: 100, deep_minutes: 60, rem_minutes: 30, awake_minutes: 20, heart_rate_avg: 60 });
            const b = legacy(N0 + 3.5 * H, N0 + 8 * H, { light_minutes: 150, deep_minutes: 50, rem_minutes: 40, awake_minutes: 30, heart_rate_avg: 54 });
            const nap = legacy(N0 + 15 * H, N0 + 16 * H, { awake_minutes: 10, notes: 'nap' });
            const seed = async (rows, recs = records) => { for (const r of rows) await recs.put('sleep', r); };
            const writes = (recs) => {
                const n = { put: 0, del: 0 };
                const { put, del } = recs;
                recs.put = (...args) => { n.put++; return put(...args); };
                recs.del = (...args) => { n.del++; return del(...args); };
                return n;
            };
            const hk = (total) => ({
                recordId: DAY_ID, clientTs: 0, deleted: false, start_time: iso(N0), end_time: iso(N0 + 8 * H),
                timezone_offset: -120, day: '2026-10-02', light_minutes: null, deep_minutes: null, rem_minutes: null,
                awake_minutes: 10, total_minutes: total, user_modified: false, source: 'apple_health', source_id: '2026-10-02',
            });

            it('two sessions and a nap become one day row; the ledger stays live; a second run writes nothing', async () => {
                await seed([a, b, nap]);
                const daysBefore = (await vitals().sleepDaily({ from: N0 - 24 * H })).map((d) => d.date);
                await vitals().unifyLegacy();
                expect(records.rows.get(DAY_ID)).toEqual({
                    recordId: DAY_ID, recordType: 'sleep', clientTs: NOW, deleted: false,
                    start_time: '2026-10-01T20:30:00Z', end_time: '2026-10-02T13:00:00Z', timezone_offset: -120, day: '2026-10-02',
                    light_minutes: 250, deep_minutes: 110, rem_minutes: 70, awake_minutes: 60,
                    // asleep: 190 + 240 (phases) + 50 (nap: total − awake)
                    total_minutes: 480, turn_over_count: null,
                    heart_rate_avg: 57, spo2_avg: null, // (60·210 + 54·270) / 480 min
                    user_modified: false, notes: 'nap', source: 'miband', source_id: '2026-10-02',
                });
                for (const r of [a, b, nap]) expect(records.rows.get(r.recordId)).toEqual({ ...r, recordType: 'sleep' });
                // Same nights on screen, one row per day.
                expect((await vitals().sleepDaily({ from: N0 - 24 * H })).map((d) => d.date)).toEqual(daysBefore);
                const shown = await vitals().sleep({ from: iso(N0 - 48 * H) });
                expect(shown).toEqual([expect.objectContaining({ id: DAY_ID, total_minutes: 480, deep_minutes: 110 })]);

                const n = writes(records);
                await vitals().unifyLegacy();
                expect(n).toEqual({ put: 0, del: 0 });
            });

            it('a bot-era row (seconds east) lands on its own sleep day, offset normalized', async () => {
                // Ends 16:30Z = 18:30 at UTC+2: past the 18:00 boundary, so the next day.
                const end = Date.parse('2026-10-02T16:30:00Z');
                await seed([legacy(end - H, end, { timezone_offset: 7200 })]);
                await vitals().unifyLegacy();
                expect(records.rows.get('sleep-hk-2026-10-03')).toMatchObject({ day: '2026-10-03', timezone_offset: -120, total_minutes: 60 });
            });

            it.each([
                ['a Health day with fewer asleep minutes is replaced', 400, 'converted'],
                ['a Health day with more asleep minutes is kept', 500, 'health'],
                // visibleSleep showed the band on a tie, so the screen does not change.
                ['a tie goes to the converted sessions', 480, 'converted'],
            ])('%s; the ledger stays either way, hidden behind the day row', async (_name, healthTotal, winner) => {
                await seed([hk(healthTotal), a, b, nap]);
                await vitals().unifyLegacy();
                const row = records.rows.get(DAY_ID);
                if (winner === 'health') expect(row).toMatchObject({ clientTs: 0, source: 'apple_health', total_minutes: healthTotal });
                else expect(row).toMatchObject({ clientTs: NOW, source: 'miband', total_minutes: 480 });
                for (const r of [a, b, nap]) expect(records.rows.get(r.recordId).deleted).toBe(false);
                expect((await vitals().sleep({ from: iso(N0 - 48 * H) })).map((r) => r.id)).toEqual([DAY_ID]);
                // The Health importer meets the converted day as present and skips it.
                storage.setItem('wg.health.anchors', '{}');
                expect(await runHealthImport({}, opts({ sleep: night }))).toEqual({ added: 0 });
                expect(records.rows.get(DAY_ID)).toEqual(row);
            });

            it('a Health day restored under a fresh id is not summed with the band sessions of its day', async () => {
                const alias = (total) => ({ ...hk(total), recordId: `sleep-${N0}`, clientTs: 7 });
                await seed([alias(500), a, b, nap]); // Health 500 vs band 480: Health
                await vitals().unifyLegacy();
                expect(records.rows.get(DAY_ID)).toMatchObject({ source: 'apple_health', total_minutes: 500, light_minutes: null });

                const other = memRecords();
                await seed([alias(480), a, b, nap], other); // a tie goes to the band, as visibleSleep shows it
                await vitals(other).unifyLegacy();
                expect(other.rows.get(DAY_ID)).toMatchObject({ source: 'miband', total_minutes: 480, light_minutes: 250 });
                // The alias stays in the ledger but never shows beside the day row.
                for (const recs of [records, other]) {
                    expect((await vitals(recs).sleep({ from: iso(N0 - 48 * H) })).map((r) => r.id)).toEqual([DAY_ID]);
                }
            });

            it('stress batches are deleted; no legacy rows means no writes', async () => {
                await records.put('stresssample', { recordId: 'stresssample-2026-10-01', clientTs: 5, deleted: false, day: '2026-10-01', samples: [] });
                await records.put('stresssample', { recordId: 'stresssample-2026-10-01#1', clientTs: 5, deleted: false, day: '2026-10-01', samples: [] });
                await seed([hk(470)]);
                await vitals().unifyLegacy();
                expect(await records.list('stresssample')).toEqual([]);
                expect(records.rows.get(DAY_ID).clientTs).toBe(0);
                const n = writes(records);
                await vitals().unifyLegacy();
                expect(n).toEqual({ put: 0, del: 0 });
            });

            it('an export after conversion carries the ledger plus one day row keyed by its day and no stress; a restore keeps the ids', async () => {
                await seed([a, b, nap]);
                await records.put('stresssample', { recordId: 'stresssample-2026-10-01', clientTs: 5, deleted: false, day: '2026-10-01', samples: [{ date_time: iso(N0), tz_offset: 0, value: 30 }] });
                await vitals().unifyLegacy();
                const vault = recordsToVault([...records.rows.values()], { now: W0 });
                expect('stress' in vault.data.vitals).toBe(false);
                expect(vault.data.vitals.sleep).toHaveLength(4);
                expect(vault.data.vitals.sleep.filter((s) => s.source_id)).toEqual([expect.objectContaining({ day: '2026-10-02', source_id: '2026-10-02', source: 'miband' })]);
                const restored = memRecords();
                for (const r of vaultToRecords(vault, { now: W0 })) restored.rows.set(r.recordId, r);
                expect((await restored.list('sleep')).map((r) => r.recordId).sort()).toEqual([a, b, nap].map((r) => r.recordId).concat(DAY_ID).sort());
                const n = writes(restored);
                await vitals(restored).unifyLegacy();
                expect(n).toEqual({ put: 0, del: 0 });
                expect(await vitals(restored).sleep({ from: iso(N0 - 48 * H) })).toEqual(await vitals().sleep({ from: iso(N0 - 48 * H) }));
            });

            it('an older client restoring a new export (fresh id) is converted back onto the day id', async () => {
                await seed([a, b, nap]);
                await vitals().unifyLegacy();
                const day = records.rows.get(DAY_ID);
                const restored = memRecords();
                // Older clients key a sleep restore on source === 'apple_health' only: a converted day lands at sleep-<start>.
                await restored.put('sleep', { ...day, recordId: `sleep-${Date.parse(day.start_time)}`, clientTs: W0 });
                await vitals(restored).unifyLegacy();
                const { clientTs, recordType, ...body } = day;
                expect(restored.rows.get(DAY_ID)).toMatchObject(body);
                expect((await vitals(restored).sleep({ from: iso(N0 - 48 * H) })).map((r) => r.id)).toEqual([DAY_ID]);
            });

            // bd med-0xad.9: the ledger is never deleted, so a later partial set folds with it.
            describe('the ledger is kept, so late and divergent sessions fold', () => {
                const sleepWrites = (recs) => {
                    const ops = [];
                    const { put, del } = recs;
                    recs.put = (t, r) => { ops.push(`put ${r.recordId}`); return put(t, r); };
                    recs.del = (t, id) => { ops.push(`del ${id}`); return del(t, id); };
                    return ops;
                };

                it('a late 40-minute nap folds into a converted day: one put, both sessions, no deletes', async () => {
                    const main = legacy(N0 - 30 * 60_000, N0 + 7.5 * H, { total_minutes: 450 });
                    await seed([main]);
                    await vitals().unifyLegacy();
                    expect(records.rows.get(DAY_ID)).toMatchObject({ total_minutes: 450 });
                    const late = legacy(N0 + 15 * H, N0 + 15 * H + 40 * 60_000);
                    await seed([late]); // an old vault merged in, or a sync from an old tab
                    const ops = sleepWrites(records);
                    await vitals().unifyLegacy();
                    expect(ops).toEqual([`put ${DAY_ID}`]);
                    expect(records.rows.get(DAY_ID)).toMatchObject({
                        total_minutes: 490, start_time: main.start_time, end_time: late.end_time, source: 'miband',
                    });
                    expect([main, late].every((r) => !records.rows.get(r.recordId).deleted)).toBe(true);
                    expect((await vitals().sleep({ from: iso(N0 - 48 * H) })).map((r) => r.id)).toEqual([DAY_ID]);
                });

                it('two devices with divergent ledgers converge on identical bytes once the union syncs', async () => {
                    const s1 = legacy(N0 - 30 * 60_000, N0 + 7.5 * H, { total_minutes: 450, heart_rate_avg: 58 });
                    const s2 = legacy(N0 + 15 * H, N0 + 16 * H, { heart_rate_avg: 70, notes: 'nap' });
                    const devA = memRecords();
                    const devB = memRecords();
                    await seed([s1], devA);
                    await seed([s1, s2], devB);
                    await vitals(devA).unifyLegacy();
                    await vitals(devB).unifyLegacy();
                    expect(devA.rows.get(DAY_ID).total_minutes).toBe(450);
                    expect(devB.rows.get(DAY_ID).total_minutes).toBe(510);
                    // Sync: distinct ids union; LWW keeps A's smaller day row everywhere.
                    const aDay = devA.rows.get(DAY_ID);
                    for (const recs of [devA, devB]) {
                        await seed([s1, s2], recs);
                        recs.rows.set(DAY_ID, { ...aDay });
                    }
                    await vitals(devA).unifyLegacy();
                    await vitals(devB).unifyLegacy();
                    expect(JSON.stringify(devA.rows.get(DAY_ID))).toBe(JSON.stringify(devB.rows.get(DAY_ID)));
                    expect(devA.rows.get(DAY_ID)).toMatchObject({ total_minutes: 510, notes: 'nap', heart_rate_avg: 59 });
                    expect([...devA.rows.values()].every((r) => !r.deleted)).toBe(true);
                    // Converged: neither device writes again.
                    const ops = [...sleepWrites(devA), ...sleepWrites(devB)];
                    await vitals(devA).unifyLegacy();
                    await vitals(devB).unifyLegacy();
                    expect(ops).toEqual([]);
                });

                it('a resurrected session (old nxk over a #1413 tombstone) writes nothing and is not counted twice', async () => {
                    const s1 = legacy(N0 - 30 * 60_000, N0 + 7.5 * H, { total_minutes: 450 });
                    const s2 = legacy(N0 + 15 * H, N0 + 16 * H);
                    await seed([s1, s2]);
                    await vitals().unifyLegacy();
                    expect(records.rows.get(DAY_ID).total_minutes).toBe(510);
                    // #1413 tombstoned the ledger; an old bundle re-puts s1 alone.
                    await records.del('sleep', s1.recordId);
                    await records.del('sleep', s2.recordId);
                    await seed([s1]);
                    const ops = sleepWrites(records);
                    await vitals().unifyLegacy();
                    expect(ops).toEqual([]);
                    expect(await vitals().sleepDaily({ from: N0 - 24 * H })).toEqual([
                        expect.objectContaining({ date: '2026-10-02', total_mins: 510 }),
                    ]);
                    expect((await vitals().sleep({ from: iso(N0 - 48 * H) })).map((r) => r.id)).toEqual([DAY_ID]);
                });

                it('a deleted day row is never re-projected, and its live ledger stays hidden', async () => {
                    await seed([a, b, nap]);
                    await vitals().unifyLegacy();
                    await records.del('sleep', DAY_ID); // the user deletes the night
                    const ops = sleepWrites(records);
                    await vitals().unifyLegacy();
                    await vitals().importSamples({ sleep: [{ ...a, recordId: undefined }] }); // a re-upload of the same session
                    expect(ops).toEqual([]);
                    expect(records.rows.get(DAY_ID).deleted).toBe(true);
                    expect(await vitals().sleep({ from: iso(N0 - 48 * H) })).toEqual([]);
                    expect(await vitals().sleepDaily({ from: N0 - 24 * H })).toEqual([]);
                });

                it('an equal-minutes correction to a session (stages, notes) reaches the day row', async () => {
                    await seed([a, b, nap]);
                    await vitals().unifyLegacy();
                    await seed([{ ...nap, notes: 'nap on the couch', clientTs: 6 }]);
                    const ops = sleepWrites(records);
                    await vitals().unifyLegacy();
                    expect(ops).toEqual([`put ${DAY_ID}`]);
                    expect(records.rows.get(DAY_ID)).toMatchObject({ total_minutes: 480, notes: 'nap on the couch' });
                    await vitals().unifyLegacy();
                    expect(ops).toEqual([`put ${DAY_ID}`]);
                });

                it('no code path deletes a sleep row', async () => {
                    await seed([hk(400), a, b, nap]);
                    const ops = sleepWrites(records);
                    await vitals().unifyLegacy();
                    await vitals().importSamples({ sleep: [{ ...nap, recordId: undefined, total_minutes: 90 }] });
                    expect(ops.filter((o) => o.startsWith('del sleep'))).toEqual([]);
                });
            });
        });

        it('every device writes the same night body, whatever its own time zone', async () => {
            const bodies = [];
            for (const timeZone of ['UTC', 'America/New_York']) {
                const recs = memRecords();
                await createHealthImportDomain({ records: recs, now: () => W0, timeZone })
                    .importSamples('sleep', [...night].reverse(), { from: N0 - 18 * H, to: N0 + 26 * H });
                bodies.push([...recs.rows.values()]);
            }
            expect(bodies[0]).toEqual(bodies[1]);
        });

        it('imports workouts as activities beside strength sessions, never into them', async () => {
            // An in-app strength session 18:00–19:00 (per-set logging) and a Mi Band ride.
            await records.put('workoutsession', {
                recordId: 'session-1-2026-10-02', clientTs: 5, deleted: false, id: 1, status: 'completed',
                started_at: '2026-10-02T18:00:00Z', completed_at: '2026-10-02T19:00:00Z',
            });
            await records.put('miband', {
                recordId: `miband-${W0 - 20 * H}`, clientTs: 5, deleted: false, id: W0 - 20 * H, source: 'miband',
                activity_name: 'cycling', source_start_ms: W0 - 20 * H, source_end_ms: W0 - 19 * H,
            });
            const S0 = Date.parse('2026-10-02T18:05:00Z');
            const workout = [
                run(1, W0, W0 + H, 37, { distance: 10_012.4, energy: 650.6, hr: 151.2 }),
                run(2, W0 + 60_000, W0 + 50 * 60_000, 37), // the same run via another app: shorter, yields
                run(3, S0, S0 + 50 * 60_000, 50), // the Watch's strength workout of the in-app session
                run(4, S0, S0 + 20 * 60_000, 13), // a ride during it: not strength, imported
                run(5, W0 - 20 * H + 60_000, W0 - 19.5 * H, 13), // the Mi Band ride again
                run(6, W0 + 30 * H, W0 + 31 * H, 50), // a strength workout with no session
            ];
            expect(await runHealthImport({}, opts({ workout }))).toEqual({ added: 3 });
            expect(records.rows.get(`miband-hk-${uid(1)}`)).toEqual({
                recordId: `miband-hk-${uid(1)}`, recordType: 'miband', clientTs: 0, deleted: false,
                id: healthNumericId(uid(1)), activity_type: 0, activity_name: 'running',
                source_start_ms: W0, source_end_ms: W0 + H, duration_sec: 3600, distance_m: 10012, steps: 0,
                calories: 651, heart_rate_avg: 151, spo2_avg: 0, pause_ms: 0, tz_offset: 0,
                source: 'apple_health', source_id: uid(1),
            });
            expect(records.rows.has(`miband-hk-${uid(4)}`)).toBe(true);
            expect(records.rows.has(`miband-hk-${uid(6)}`)).toBe(true);
            expect(await records.list('workoutsession')).toHaveLength(1);
            expect(await records.list('exerciselog')).toEqual([]);

            const listed = await createWorkoutDomain({ records, now: () => W0 + 2 * 24 * H, timeZone: 'UTC' }).listMiBand();
            expect(listed.find((w) => w.id === healthNumericId(uid(1)))).toMatchObject({
                activity_name: 'running', distance_m: 10012, source: 'apple_health',
            });
        });

        it('a deleted workout stays deleted across a backup, restore and full rescan; nights and workouts keep their ids', async () => {
            const workout = [run(1, W0, W0 + H, 37), run(2, W0 + 60_000, W0 + 50 * 60_000, 37), run(3, W0 + 5 * H, W0 + 6 * H, 13)];
            const data = { sleep: night, workout };
            await runHealthImport({}, opts(data));
            await createWorkoutDomain({ records, now: () => W0, timeZone: 'UTC' }).deleteMiBand(healthNumericId(uid(1)));

            const vault = recordsToVault([...records.rows.values()], { now: W0 });
            expect(vault.data.tombstones).toEqual([{ recordType: 'miband', recordId: `miband-hk-${uid(1)}` }]);
            const restored = memRecords();
            for (const r of vaultToRecords(vault, { now: W0 })) restored.rows.set(r.recordId, r);
            const strip = (rows) => rows.filter((r) => !r.deleted && ['sleep', 'miband'].includes(r.recordType))
                .map(({ clientTs, ...r }) => r)
                .sort((a, b) => (a.recordId < b.recordId ? -1 : 1));
            const before = strip([...records.rows.values()]);
            expect(strip([...restored.rows.values()])).toEqual(before);
            // Restore → re-export is byte-identical.
            expect(recordsToVault([...restored.rows.values()], { now: W0 })).toEqual(vault);

            storage.setItem('wg.health.anchors', '{}');
            // The deleted run stays deleted, and the other app's copy does not take its place.
            expect(await runHealthImport({}, opts(data, restored))).toEqual({ added: 0 });
            expect(restored.rows.get(`miband-hk-${uid(1)}`).deleted).toBe(true);
            expect(restored.rows.has(`miband-hk-${uid(2)}`)).toBe(false);
        });

        it('rows restored under fresh ids (older client) are recognised, and deleting one keeps its Health id deleted', async () => {
            const data = { sleep: night, workout: [run(1, W0, W0 + H, 37)] };
            await runHealthImport({}, opts(data));
            const restored = memRecords();
            for (const r of records.rows.values()) {
                const fresh = r.recordType === 'sleep' ? `sleep-${N0}` : `miband-${W0}`;
                restored.rows.set(fresh, { ...r, recordId: fresh, clientTs: W0, ...(r.recordType === 'miband' ? { id: W0 } : {}) });
            }
            storage.setItem('wg.health.anchors', '{}');
            expect(await runHealthImport({}, opts(data, restored))).toEqual({ added: 0 });
            await createWorkoutDomain({ records: restored, now: () => W0, timeZone: 'UTC' }).deleteMiBand(W0);
            expect(restored.rows.get(`miband-hk-${uid(1)}`).deleted).toBe(true);
            storage.setItem('wg.health.anchors', '{}');
            expect(await runHealthImport({}, opts(data, restored))).toEqual({ added: 0 });
            expect(await restored.list('miband')).toEqual([]);
        });

        it('overlapping samples of one night count each minute once, stages over unspecified', async () => {
            const domain = createHealthImportDomain({ records, now: () => W0, timeZone: 'UTC' });
            const summary = slp(9, N0, N0 + 8 * H, 1); // an unspecified "asleep" span under the stages
            const dup = slp(8, N0, N0 + 2 * H, 3); // a duplicate of the first core sample
            expect(await domain.importSamples('sleep', [...night, summary, dup], { from: N0 - 18 * H, to: N0 + 26 * H }))
                .toMatchObject({ added: 1 });
            expect(records.rows.get(DAY_ID)).toMatchObject({
                light_minutes: 350, deep_minutes: 60, rem_minutes: 60, awake_minutes: 10, total_minutes: 470,
            });
        });

        it('a night without a time zone is filed in UTC on every device', async () => {
            const bare = night.map(({ tz, ...s }) => s);
            const bodies = [];
            for (const timeZone of ['UTC', 'America/Los_Angeles']) {
                const recs = memRecords();
                await createHealthImportDomain({ records: recs, now: () => W0, timeZone })
                    .importSamples('sleep', bare, { from: N0 - 18 * H, to: N0 + 26 * H });
                bodies.push([...recs.rows.values()]);
            }
            expect(bodies[0]).toEqual(bodies[1]);
            expect(bodies[0][0]).toMatchObject({ day: '2026-10-02', timezone_offset: 0 });
        });

        it('a night still being written waits, then is re-read whole by time window', async () => {
            const data = { sleep: night.slice(0, 1) }; // only the first 2h are in Health yet
            const at = (now) => ({ ...opts(data), now: () => now });
            expect(await runHealthImport({}, at(N0 + 2.5 * H))).toEqual({ added: 0 });
            expect(JSON.parse(storage.getItem('wg.health.sleepPending'))).toBe(N0);
            // The rest of the night lands; the anchored page and the window re-read see it.
            data.sleep = night;
            expect(await runHealthImport({}, at(N0 + 8.5 * H))).toEqual({ added: 0 }); // ended 30 min ago: still settling
            const health = healthOf(data);
            expect(await runHealthImport({}, { ...at(N0 + 12 * H), health })).toEqual({ added: 1 });
            expect(health.calls.find((c) => c.type === 'sleep')).toMatchObject({ from: N0 - 48 * H, to: N0 + 12 * H });
            expect(records.rows.get(DAY_ID)).toMatchObject({ total_minutes: 470, end_time: '2026-10-02T05:00:00Z' });
            expect(JSON.parse(storage.getItem('wg.health.sleepPending'))).toBe(null);
        });

        it('a failed next page does not lose a night still settling', async () => {
            allowConsoleNoise(); // the failed page is logged by design
            const data = { sleep: night };
            const health = healthOf(data);
            const page = health.query;
            let fail = true;
            health.query = async (args) => {
                if (args.type === 'sleep' && args.anchor && fail) throw new Error('transient');
                const res = await page(args);
                return args.type === 'sleep' && !args.anchor && !Number.isFinite(args.from) ? { ...res, more: true } : res;
            };
            const at = (now) => ({ health, storage, records, flush, now: () => now });
            expect(await runHealthImport({}, at(N0 + 8.5 * H))).toEqual({ added: 0 });
            expect(JSON.parse(storage.getItem('wg.health.anchors')).sleep).toBe('6'); // the anchor moved on
            expect(JSON.parse(storage.getItem('wg.health.sleepPending'))).toBe(N0);
            fail = false;
            expect(await runHealthImport({}, at(N0 + 12 * H))).toEqual({ added: 1 });
            expect(records.rows.get(DAY_ID)).toMatchObject({ total_minutes: 470 });
        });

        it('an empty re-read (read access revoked) keeps a settling night pending', async () => {
            const health = healthOf({ sleep: night });
            const page = health.query;
            let denied = false;
            health.query = async (args) => {
                if (!denied) return page(args);
                return Number.isFinite(args.from)
                    ? { samples: [], from: args.from, to: args.to, returned: 0, more: false }
                    : { samples: [], anchor: args.anchor, returned: 0, more: false };
            };
            const at = (now) => ({ health, storage, records, flush, now: () => now });
            expect(await runHealthImport({}, at(N0 + 8.5 * H))).toEqual({ added: 0 });
            expect(JSON.parse(storage.getItem('wg.health.sleepPending'))).toBe(N0);
            denied = true;
            expect(await runHealthImport({}, at(N0 + 10 * H))).toEqual({ added: 0 });
            expect(JSON.parse(storage.getItem('wg.health.sleepPending'))).toBe(N0);
            denied = false;
            expect(await runHealthImport({}, at(N0 + 24 * H))).toEqual({ added: 1 });
            expect(records.rows.get(DAY_ID)).toMatchObject({ total_minutes: 470 });
            expect(JSON.parse(storage.getItem('wg.health.sleepPending'))).toBe(null);
            // Past the 7-day cap an empty re-read lets it go.
            storage.setItem('wg.health.sleepPending', JSON.stringify(N0));
            denied = true;
            await runHealthImport({}, at(N0 + 8 * 24 * H));
            expect(JSON.parse(storage.getItem('wg.health.sleepPending'))).toBe(null);
        });

        // bd med-y1gh: trackers write a partial session first, the whole night later.
        it('the first settled version wins; a fuller one later replaces it', async () => {
            const at = createHealthImportDomain({ records, now: () => W0, timeZone: 'UTC' });
            const window = { from: N0 - 48 * H, to: N0 + 60 * H };
            expect(await at.importSamples('sleep', night.slice(0, 1), window)).toMatchObject({ added: 1 });
            expect(records.rows.get(DAY_ID)).toMatchObject({ clientTs: 0, total_minutes: 120 });
            expect(await at.importSamples('sleep', night, window)).toMatchObject({ added: 1, skip: { exists: 0 } });
            expect(records.rows.get(DAY_ID)).toMatchObject({ clientTs: W0, total_minutes: 470, user_modified: false });
            // A tie keeps the row, clientTs included; so does a thinner copy.
            const later = createHealthImportDomain({ records, now: () => W0 + H, timeZone: 'UTC' });
            expect(await later.importSamples('sleep', night, window)).toMatchObject({ added: 0, skip: { exists: 1 } });
            expect(await later.importSamples('sleep', night.slice(0, 1), window)).toMatchObject({ added: 0, skip: { exists: 1 } });
            expect(records.rows.get(DAY_ID)).toMatchObject({ clientTs: W0, total_minutes: 470 });
        });

        it('Developer\'s night: a short session then the full one ends as the union, in both orders', async () => {
            const T = (hm) => Date.parse(`2026-10-02T${hm}:00Z`);
            const short = slp(30, T('02:41'), T('05:33'), 1, 'com.tracker', 'UTC');
            const full = slp(31, T('02:45'), T('09:52'), 1, 'com.tracker', 'UTC');
            const window = { from: T('02:41') - 48 * H, to: T('09:52') + 48 * H };
            for (const first of [short, full]) {
                const recs = memRecords();
                const at = createHealthImportDomain({ records: recs, now: () => W0, timeZone: 'UTC' });
                expect(await at.importSamples('sleep', [first], window)).toMatchObject({ added: 1 });
                expect(await at.importSamples('sleep', [short, full], window)).toMatchObject({ added: 1 });
                expect(recs.rows.get(DAY_ID)).toMatchObject({ total_minutes: 431, clientTs: W0 });
            }
        });

        it('a day stuck short before the fix heals once on the next run, with no anchor reset', async () => {
            // The anchors moved past the full night long ago; the vault holds its first 2h.
            const at = createHealthImportDomain({ records, now: () => W0, timeZone: 'UTC' });
            await at.importSamples('sleep', night.slice(0, 1), { from: N0 - 48 * H, to: N0 + 60 * H });
            storage.setItem('wg.health.anchors', JSON.stringify({ sleep: String(night.length), bp: '0' }));
            const o = opts({ sleep: night });
            expect(await runHealthImport({}, o)).toEqual({ added: 1 });
            expect(records.rows.get(DAY_ID)).toMatchObject({ total_minutes: 470 });
            expect(o.health.calls.find((c) => c.type === 'sleep')).toMatchObject({ from: W0 + 24 * H - 30 * 24 * H - 48 * H });
            expect(JSON.parse(storage.getItem('wg.health.anchors'))).toMatchObject({ sleep: '6', bp: '0', sleepHeal: 1 });
            expect(JSON.parse(storage.getItem('wg.health.sleepPending'))).toBe(null);
            // Once only: the next run reads no window.
            const again = opts({ sleep: night });
            expect(await runHealthImport({}, again)).toEqual({ added: 0 });
            expect(again.health.calls.filter((c) => c.type === 'sleep' && Number.isFinite(c.from))).toEqual([]);
        });

        it('a denied (empty) first heal read keeps the heal and a recent pending night for later', async () => {
            const at = createHealthImportDomain({ records, now: () => W0, timeZone: 'UTC' });
            await at.importSamples('sleep', night.slice(0, 1), { from: N0 - 48 * H, to: N0 + 60 * H });
            storage.setItem('wg.health.anchors', JSON.stringify({ sleep: String(night.length) }));
            storage.setItem('wg.health.sleepPending', JSON.stringify(N0));
            expect(await runHealthImport({}, opts({ sleep: [] }))).toEqual({ added: 0 });
            expect(JSON.parse(storage.getItem('wg.health.anchors')).sleepHeal).toBeUndefined();
            expect(JSON.parse(storage.getItem('wg.health.sleepPending'))).toBe(N0);
            // Access restored: the heal runs then.
            expect(await runHealthImport({}, opts({ sleep: night }))).toEqual({ added: 1 });
            expect(records.rows.get(DAY_ID)).toMatchObject({ total_minutes: 470 });
            expect(JSON.parse(storage.getItem('wg.health.anchors')).sleepHeal).toBe(1);
        });

        it('two sources\' copies of a night end as one row for the day', async () => {
            const copy = night.map((s, i) => ({ ...s, uuid: uid(20 + i), source: 'com.other.app' }));
            copy[4] = { ...copy[4], end: copy[4].end - 60 * 60_000 }; // the other app saw an hour less
            const at = createHealthImportDomain({ records, now: () => W0, timeZone: 'UTC' });
            const window = { from: N0 - 48 * H, to: N0 + 60 * H };
            expect(await at.importSamples('sleep', [...copy, ...night], window)).toMatchObject({ added: 1 });
            expect([...records.rows.values()]).toEqual([expect.objectContaining({ recordId: DAY_ID, total_minutes: 470 })]);
            expect(await at.importSamples('sleep', [...night, ...copy], window)).toMatchObject({ added: 0 });
        });

        it('an edit outranks a rescan, and a deleted night stays deleted', async () => {
            const at = createHealthImportDomain({ records, now: () => W0, timeZone: 'UTC' });
            const window = { from: N0 - 48 * H, to: N0 + 60 * H };
            await at.importSamples('sleep', night, window);
            await records.put('sleep', { ...records.rows.get(DAY_ID), clientTs: W0, notes: 'woke up twice', user_modified: true });
            expect(await at.importSamples('sleep', night, window)).toMatchObject({ added: 0 });
            expect(records.rows.get(DAY_ID)).toMatchObject({ notes: 'woke up twice', total_minutes: 470 });
            // An edited day is never replaced, even by a fuller version.
            const edited = memRecords();
            const e = createHealthImportDomain({ records: edited, now: () => W0, timeZone: 'UTC' });
            await e.importSamples('sleep', night.slice(0, 1), window);
            await edited.put('sleep', { ...edited.rows.get(DAY_ID), clientTs: W0, user_modified: true });
            expect(await e.importSamples('sleep', night, window)).toMatchObject({ added: 0, skip: { exists: 1 } });
            expect(edited.rows.get(DAY_ID)).toMatchObject({ total_minutes: 120, user_modified: true });
            await records.del('sleep', DAY_ID);
            expect(await at.importSamples('sleep', night, window)).toMatchObject({ added: 0 });
            expect(records.rows.get(DAY_ID).deleted).toBe(true);
        });

        // bd med-poeu: the user deletes the short day first; a fuller version must not bring it back.
        it('a short day the user deleted is not brought back by a later, fuller import', async () => {
            const at = createHealthImportDomain({ records, now: () => W0, timeZone: 'UTC' });
            const window = { from: N0 - 48 * H, to: N0 + 60 * H };
            await at.importSamples('sleep', night.slice(0, 1), window);
            expect(records.rows.get(DAY_ID)).toMatchObject({ total_minutes: 120 });
            await records.del('sleep', DAY_ID);
            const later = createHealthImportDomain({ records, now: () => W0 + H, timeZone: 'UTC' });
            expect(await later.importSamples('sleep', night, window)).toMatchObject({ added: 0 });
            expect(records.rows.get(DAY_ID).deleted).toBe(true);
        });

        it('a deleted night stays deleted across a backup, restore and full rescan', async () => {
            await runHealthImport({}, opts({ sleep: night }));
            await records.del('sleep', DAY_ID);
            const vault = recordsToVault([...records.rows.values()], { now: W0 });
            expect(vault.data.tombstones).toEqual([{ recordType: 'sleep', recordId: DAY_ID }]);
            const restored = memRecords();
            for (const r of vaultToRecords(vault, { now: W0 })) restored.rows.set(r.recordId, r);
            expect(recordsToVault([...restored.rows.values()], { now: W0 })).toEqual(vault);
            storage.setItem('wg.health.anchors', '{}');
            expect(await runHealthImport({}, opts({ sleep: night }, restored))).toEqual({ added: 0 });
            expect(restored.rows.get(DAY_ID).deleted).toBe(true);
            // An ordinary (Mi Band, manual) night's tombstone stays delete-by-absence.
            const vault2 = recordsToVault([{ recordType: 'sleep', recordId: `sleep-${N0}`, clientTs: 1, deleted: true }], { now: W0 });
            expect(vault2.data.tombstones).toBeUndefined();
        });

        it('a nap joins its day\'s record', async () => {
            const nap = slp(30, N0 + 17 * H, N0 + 18 * H, 1); // 16:00–17:00 Berlin on the wake day
            const at = createHealthImportDomain({ records, now: () => W0 + 24 * H, timeZone: 'UTC' });
            await at.importSamples('sleep', [...night, nap], { from: N0 - 48 * H, to: N0 + 60 * H });
            expect([...records.rows.values()]).toEqual([expect.objectContaining({
                recordId: DAY_ID, start_time: '2026-10-01T21:00:00Z', end_time: '2026-10-02T15:00:00Z', total_minutes: 530,
            })]);
        });

        // bd med-w6gx.30: a night entered by hand in the Health app.
        const HAND = 'com.apple.Health';
        const inBed = slp(40, N0, N0 + 8 * H, 0, HAND, null);
        const lines = [];
        const sleepLine = () => lines.filter((l) => l.startsWith('[health] sleep ')).pop();
        beforeEach(() => { lines.length = 0; });

        it('posts one counts-only diagnostics line per kind; a rescan names the day already there', async () => {
            const data = { sleep: night };
            expect(await runHealthImport({}, { ...opts(data), diag: (l) => lines.push(l) })).toEqual({ added: 1 });
            expect(lines).toEqual([
                '[health] bp returned=0 samples=0 written=0 skip{invalid:0,exists:0} anchor=kept',
                '[health] weight returned=0 samples=0 written=0 skip{invalid:0,exists:0} anchor=kept',
                '[health] sleep returned=6 samples=6 values={0:1,2:1,3:2,4:1,5:1} nights=1 written=1 '
                    + 'skip{inBed:1,unsettled:0,clipped:0,exists:0} anchor=moved',
                '[health] workout returned=0 samples=0 written=0 skip{invalid:0,exists:0,overlap:0} anchor=kept',
                '[health] steps returned=0 samples=0 written=0 skip{invalid:0} anchor=kept',
                '[health] hr returned=0 samples=0 written=0 skip{invalid:0} anchor=kept',
                '[health] spo2 returned=0 samples=0 written=0 skip{invalid:0} anchor=kept',
            ]);
            storage.setItem('wg.health.anchors', '{}');
            await runHealthImport({}, { ...opts(data), diag: (l) => lines.push(l) });
            expect(sleepLine()).toMatch(/ nights=1 written=0 skip\{inBed:1,unsettled:0,clipped:0,exists:1\} anchor=moved$/);
        });

        it('an In Bed-only night is still left out, and the line says so', async () => {
            expect(await runHealthImport({}, { ...opts({ sleep: [inBed] }), diag: (l) => lines.push(l) })).toEqual({ added: 0 });
            expect(sleepLine()).toBe('[health] sleep returned=1 samples=1 values={0:1} nights=0 written=0 '
                + 'skip{inBed:1,unsettled:0,clipped:0,exists:0} anchor=moved');
        });

        it('a hand-entered Asleep + In Bed night opened right after waking waits to settle, then is written', async () => {
            const asleep = slp(42, N0, N0 + 8 * H, 1, HAND, null);
            const data = { sleep: [asleep, inBed] };
            const at = (now) => ({ ...opts(data), now: () => now, diag: (l) => lines.push(l) });
            expect(await runHealthImport({}, at(N0 + 8 * H + 10 * 60_000))).toEqual({ added: 0 });
            expect(sleepLine()).toBe('[health] sleep returned=2 samples=2 values={0:1,1:1} nights=1 written=0 '
                + 'skip{inBed:1,unsettled:1,clipped:0,exists:0} anchor=moved');
            expect(JSON.parse(storage.getItem('wg.health.sleepPending'))).toBe(N0);
            // The anchor has moved past both samples; the time-window re-read still finds the night.
            expect(await runHealthImport({}, at(N0 + 11.5 * H))).toEqual({ added: 1 });
            expect(records.rows.get(DAY_ID)).toMatchObject({ total_minutes: 480 });
            expect(sleepLine()).toBe('[health] sleep returned=0 samples=2 values={0:1,1:1} nights=1 written=1 '
                + 'skip{inBed:1,unsettled:0,clipped:0,exists:0} anchor=kept');
        });

        it('a failing kind logs its error name in its line', async () => {
            allowConsoleNoise(); // the failed kind is logged by design
            const health = healthOf({});
            const query = health.query;
            health.query = async (args) => {
                if (args.type === 'sleep') throw new TypeError('denied');
                return query(args);
            };
            await runHealthImport({}, { health, storage, records, flush, diag: (l) => lines.push(l) });
            expect(sleepLine()).toBe('[health] sleep returned=0 samples=0 values={} nights=0 written=0 skip{} anchor=kept error=TypeError');
        });

        it('sleep never returning a sample while BP does points at the Sleep switch', async () => {
            await runHealthImport({}, opts({ bp: [bpSample(U1, T0, 120, 80)] }));
            expect(healthStatusText(storage)).toMatch(/1 reading so far \(last new .*\)\. No sleep found: if you track sleep, turn on Sleep for Med Tracker in Settings → Health → Data Access & Devices\.$/);
            await runHealthImport({}, opts({ bp: [bpSample(U1, T0, 120, 80)], sleep: [inBed] }));
            expect(healthStatusText(storage)).not.toMatch(/No sleep found/);
        });

        it('a Health workout id never equals a Mi Band row id, so delete removes only its own row', async () => {
            // A UUID whose last 48 bits read as the Mi Band row's epoch-ms id.
            const uuid = `00000000-0000-4000-8000-${W0.toString(16).padStart(12, '0')}`;
            await records.put('miband', {
                recordId: `miband-${W0}`, clientTs: 5, deleted: false, id: W0, source: 'miband',
                activity_name: 'cycling', source_start_ms: W0, source_end_ms: W0 + H,
            });
            const domain = createHealthImportDomain({ records, now: () => W0 + 2 * 24 * H, timeZone: 'UTC' });
            expect(await domain.importSamples('workout', [{ ...run(1, W0 + 5 * H, W0 + 6 * H, 37), uuid }])).toMatchObject({ added: 1 });
            const workouts = createWorkoutDomain({ records, now: () => W0 + 2 * 24 * H, timeZone: 'UTC' });
            const ids = (await workouts.listMiBand()).map((w) => w.id);
            expect(new Set(ids).size).toBe(2);
            expect(healthNumericId(uuid)).toBeGreaterThan(W0);
            expect(healthNumericId(uuid)).toBeLessThan(Number.MAX_SAFE_INTEGER);
            await workouts.deleteMiBand(healthNumericId(uuid));
            expect(records.rows.get(`miband-${W0}`).deleted).toBe(false);
            expect(records.rows.get(`miband-hk-${uuid}`).deleted).toBe(true);
        });

        it('one kind failing does not stop the others', async () => {
            allowConsoleNoise(); // the failed kind is logged by design
            const health = healthOf({ weight: [kgSample(U2, T0, 70)] });
            const query = health.query;
            health.query = async (args) => {
                if (args.type === 'bp') throw new Error('Authorization not determined');
                return query(args);
            };
            expect(await runHealthImport({}, { health, storage, records, flush })).toEqual({ added: 1 });
            expect(JSON.parse(storage.getItem('wg.health.anchors'))).toEqual({ weight: '1' });
        });

        it('every kind failing rejects, so pull to refresh can name the fix (med-y7b4.6)', async () => {
            allowConsoleNoise(); // the failed kinds are logged by design
            const health = healthOf({});
            health.query = async () => { throw new Error('Health Connect unavailable'); };
            await expect(runHealthImport({}, { health, storage, records, flush })).rejects.toThrow('Health Connect unavailable');
        });
    });

    // bd med-0xad.1: steps, heart rate and SpO2 into the existing vitals rows.
    describe('steps, heart rate and SpO2', () => {
        const D = 86_400_000;
        const NOW = Date.parse('2026-10-10T12:00:00Z');
        // Like the bridges: steps answer a time window with one total per
        // local day; hr/spo2 page by anchor like bp. Every query's args are kept.
        function vitalsHealth(data) {
            const h = fakeHealth(data);
            const page = h.query.bind(h);
            h.args = [];
            h.query = async (args) => {
                h.args.push(args);
                if (args.type !== 'steps') return page(args);
                // returned: 0 like the sleep window read: the steps window
                // must key on the samples, not on `returned`.
                return { samples: data.steps || [], returned: 0, more: false };
            };
            return h;
        }
        const opts = (health) => ({ health, storage, records, flush, now: () => NOW });
        const steps = (today) => [
            { day: '2026-10-08', steps: 4000, tz: 'Europe/Berlin' },
            { day: '2026-10-09', steps: 9000, tz: 'Europe/Berlin' },
            { day: '2026-10-10', steps: today, tz: 'Europe/Berlin' },
        ];
        const at = (iso) => Date.parse(iso);

        it('writes one daystats row per day, and a re-read only ever raises a day', async () => {
            const h1 = vitalsHealth({ steps: steps(1200) });
            expect(await runHealthImport({}, opts(h1))).toEqual({ added: 3 });
            expect(records.rows.get('daystats-2026-10-08')).toMatchObject({ recordType: 'daystats', day: '2026-10-08', steps: 4000 });
            expect(records.rows.get('daystats-2026-10-10')).toMatchObject({ steps: 1200 });

            const h2 = vitalsHealth({ steps: steps(3000) });
            expect(await runHealthImport({}, opts(h2))).toEqual({ added: 1 });
            expect(records.rows.get('daystats-2026-10-10')).toMatchObject({ steps: 3000 });

            const h3 = vitalsHealth({ steps: steps(2500) });
            expect(await runHealthImport({}, opts(h3))).toEqual({ added: 0 });
            expect(records.rows.get('daystats-2026-10-10')).toMatchObject({ steps: 3000 });

            // Read by window, never by anchor: a year back until days came
            // back, then a week before the last such read.
            const windows = [h1, h2, h3].map((h) => h.args.find((a) => a.type === 'steps'));
            expect(windows).toEqual([
                { type: 'steps', from: NOW - 365 * D, to: NOW },
                { type: 'steps', from: NOW - 7 * D, to: NOW },
                { type: 'steps', from: NOW - 7 * D, to: NOW },
            ]);

            // Closed for three weeks: the read reaches back past the gap.
            const later = NOW + 21 * D;
            const h4 = vitalsHealth({ steps: steps(3000) });
            await runHealthImport({}, { ...opts(h4), now: () => later });
            expect(h4.args.find((a) => a.type === 'steps')).toEqual({ type: 'steps', from: NOW - 7 * D, to: later });

            // The switch-on rescan / reset forgets the window with the anchors.
            resetHealthAnchors(storage);
            const h5 = vitalsHealth({ steps: [] });
            await runHealthImport({}, opts(h5));
            expect(h5.args.find((a) => a.type === 'steps')).toEqual({ type: 'steps', from: NOW - 365 * D, to: NOW });
            // Nothing came back (access denied): the next read is a year again.
            const h6 = vitalsHealth({ steps: [] });
            await runHealthImport({}, opts(h6));
            expect(h6.args.find((a) => a.type === 'steps').from).toBe(NOW - 365 * D);
        });

        it('a kind an older shell rejects is no longer counted as asked', async () => {
            allowConsoleNoise(); // the rejected kind is logged by design
            storage.setItem('wg.health.asked', JSON.stringify(['bp', 'weight', 'sleep', 'workout', 'steps', 'hr', 'spo2']));
            const h = vitalsHealth({});
            const query = h.query;
            h.query = async (args) => {
                if (args.type === 'steps' || args.type === 'spo2') throw new Error('unknown type');
                return query(args);
            };
            await runHealthImport({}, opts(h));
            expect(JSON.parse(storage.getItem('wg.health.asked'))).toEqual(['bp', 'weight', 'sleep', 'workout', 'hr']);
        });

        it('day-batches HR and SpO2 by UTC day; a re-read of the same instants adds nothing', async () => {
            const data = {
                hr: [
                    { uuid: U1, start: at('2026-10-09T23:59:00Z'), value: 61.4 },
                    { uuid: U2, start: at('2026-10-10T00:01:00Z'), value: 64 },
                ],
                spo2: [{ uuid: U3, start: at('2026-10-10T03:00:00Z'), value: 97 }],
            };
            const h = vitalsHealth(data);
            expect(await runHealthImport({}, opts(h))).toEqual({ added: 3 });
            expect(records.rows.get('hrsample-2026-10-09')).toMatchObject({
                recordType: 'hrsample', day: '2026-10-09', samples: [{ date_time: '2026-10-09T23:59:00Z', value: 61 }],
            });
            expect(records.rows.get('hrsample-2026-10-10').samples).toEqual([{ date_time: '2026-10-10T00:01:00Z', value: 64 }]);
            expect(records.rows.get('spo2sample-2026-10-10').samples).toEqual([{ date_time: '2026-10-10T03:00:00Z', value: 97 }]);
            // The first read has no anchor: it starts 90 days back.
            expect(h.args.find((a) => a.type === 'hr')).toEqual({ type: 'hr', anchor: null, limit: 500, from: NOW - 90 * D });
            expect(JSON.parse(storage.getItem('wg.health.anchors'))).toMatchObject({ hr: '2', spo2: '1' });

            // A lost anchor re-reads everything: nothing new is written.
            storage.setItem('wg.health.anchors', '{}');
            expect(await runHealthImport({}, opts(vitalsHealth(data)))).toEqual({ added: 0 });
            // Never stress.
            expect([...records.rows.values()].some((r) => r.recordType === 'stresssample')).toBe(false);
        });

        it('the Vitals overview reads what the import wrote, through the existing readers', async () => {
            await runHealthImport({}, opts(vitalsHealth({
                steps: steps(3000),
                hr: [
                    { uuid: U1, start: at('2026-10-09T23:59:00Z'), value: 61 },
                    { uuid: U2, start: at('2026-10-10T00:01:00Z'), value: 64 },
                ],
                spo2: [{ uuid: U3, start: at('2026-10-10T03:00:00Z'), value: 97 }],
            })));
            const ov = await createVitalsDomain({ records, now: () => NOW, timeZone: 'UTC' }).overview();
            expect(ov.average_steps_7d).toBe(5333);
            expect(ov.heart_rate_history_7d).toEqual([
                { timestamp: at('2026-10-09T23:00:00Z'), min: 61, max: 61, avg: 61 },
                { timestamp: at('2026-10-10T00:00:00Z'), min: 64, max: 64, avg: 64 },
            ]);
            expect(ov.spo2_history_7d).toEqual([{ timestamp: at('2026-10-10T03:00:00Z'), min: 97, max: 97, avg: 97 }]);
        });

        it('skips malformed samples (a day without steps, SpO2 as a 0-1 fraction or above 100)', async () => {
            const h = vitalsHealth({
                steps: [{ day: '10/08/2026', steps: 10 }, { day: '2026-10-08', steps: 0 }, { day: '2026-10-09', steps: 50 }],
                spo2: [
                    { uuid: U1, start: at('2026-10-10T03:00:00Z'), value: 970 },
                    { uuid: U2, start: at('2026-10-10T04:00:00Z'), value: 0.97 },
                ],
            });
            const lines = [];
            expect(await runHealthImport({}, { ...opts(h), diag: (l) => lines.push(l) })).toEqual({ added: 1 });
            expect(lines).toContain('[health] steps returned=0 samples=3 written=1 skip{invalid:2} anchor=moved');
            expect(lines).toContain('[health] spo2 returned=2 samples=2 written=0 skip{invalid:2} anchor=moved');
            expect(records.rows.has('spo2sample-2026-10-10')).toBe(false);
        });
    });
});

// bd med-8f4s.1: "Also write my entries" — the ledger and its executor over
// the real write path (sync.js stampAndPut → onLocalWrite, on-device store).
describe('Health write-back', () => {
    let storage;
    let health;
    let records;
    let api;

    // A shell writer from a per-entry `single` (bd med-8f4s.15): the single
    // form answers it; { entries } answers one result per entry, in order (a
    // string from `single` is that entry's error); a throw fails the whole call.
    const answer = (single = async () => true) => async (a) => {
        if (!a.entries) {
            // The single form rejects with what a batch answers as a string.
            const r = await single(a);
            if (typeof r === 'string') throw new Error(r);
            return r;
        }
        const out = [];
        for (const e of a.entries) out.push(await single(e));
        return out;
    };
    const shellWrite = (single) => vi.fn(answer(single));
    const writeHealth = () => ({
        isSupported: () => true,
        canWrite: async () => true,
        writeAccess: vi.fn(async () => ({ granted: ['bp', 'weight', 'hr'] })),
        write: shellWrite(),
        remove: vi.fn(async () => true),
    });
    const ALL = ['bp', 'weight', 'hr', 'workout'];
    // What a med-8f4s.6 shell (.7/.8) can write: no workouts.
    const HR = ['bp', 'weight', 'hr'];
    const dirty = () => JSON.parse(storage.getItem('wg.health.dirty') || '{}');
    const ledgerSize = () => Object.values(dirty()).reduce((n, m) => n + Object.keys(m).length, 0);
    // Every write body sent, a batch's entries one by one.
    const wrote = () => health.write.mock.calls.flatMap(([a]) => a.entries || [a]);
    const calls = () => [
        ...wrote().map((a) => ({ op: 'write', ...a })),
        ...health.remove.mock.calls.map(([a]) => ({ op: 'remove', ...a })),
    ];
    const raw = async (type, id) => (await records.listRaw(type)).find((r) => r.recordId === id);
    const idle = () => vi.waitFor(() => expect(ledgerSize()).toBe(0));

    beforeEach(async () => {
        dropCachedDb();
        await new Promise((resolve, reject) => {
            const req = indexedDB.deleteDatabase('medtracker-cloud');
            req.onsuccess = resolve;
            req.onerror = () => reject(req.error);
        });
        storage = memStorage();
        storage.setItem('wg.health.enabled', 'true');
        storage.setItem('wg.health.write', 'true');
        health = writeHealth();
        records = localRecordsPort(ORIGIN_EXTERNAL);
        api = createApiRouter({}, {
            records, origin: ORIGIN_EXTERNAL, timeZone: 'UTC',
            effects: {
                scheduleReminderRecompute: () => {}, cancelReminderRefire: async () => {},
                cancelMedRefire: async () => {}, rearmMedRefire: async () => {}, sendTestPush: async () => {},
            },
        });
    });

    afterEach(() => {
        onLocalWrite(null);
        vi.unstubAllGlobals();
    });

    it('an entry, its edit and its delete reach Health under the vault id and the stored clientTs', async () => {
        startHealthWriteBack({ health, storage, records });
        const created = await api('/api/bp', 'POST', { measured_at: '2026-10-01T07:30:00Z', systolic: 128, diastolic: 84, pulse: 66 });
        await idle();
        const v1 = (await raw('bp', created.id)).clientTs;
        const at = Date.parse('2026-10-01T07:30:00Z');
        // bd med-8f4s.6: its pulse as a heart-rate entry under its own key, bp first.
        expect(health.write.mock.calls.map(([a]) => a)).toEqual([
            { type: 'bp', id: created.id, version: v1, at, systolic: 128, diastolic: 84 },
            { type: 'hr', id: `${created.id}/pulse`, version: v1, at, bpm: 66 },
        ]);
        expect(dirty()).toEqual({ bp: {}, hr: {} }); // the ledger is keyed by the recordId

        await api(`/api/bp/${created.id}`, 'PUT', { systolic: 130 });
        await idle();
        const v2 = (await raw('bp', created.id)).clientTs;
        expect(v2).toBeGreaterThan(v1);
        expect(health.write.mock.calls.slice(2).map(([a]) => a)).toEqual([
            expect.objectContaining({ type: 'bp', id: created.id, version: v2, systolic: 130 }),
            { type: 'hr', id: `${created.id}/pulse`, version: v2, at, bpm: 66 },
        ]);

        // Clearing the pulse removes the heart-rate entry; the bp write moves on.
        health.write.mockClear();
        await api(`/api/bp/${created.id}`, 'PUT', { pulse: null });
        await idle();
        const v3 = (await raw('bp', created.id)).clientTs;
        expect(health.write.mock.calls.map(([a]) => a)).toEqual([expect.objectContaining({ type: 'bp', version: v3 })]);
        expect(health.remove).toHaveBeenLastCalledWith({ type: 'hr', id: `${created.id}/pulse` });

        // Setting it again brings it back.
        await api(`/api/bp/${created.id}`, 'PUT', { pulse: 70 });
        await idle();
        const v4 = (await raw('bp', created.id)).clientTs;
        expect(health.write).toHaveBeenLastCalledWith({ type: 'hr', id: `${created.id}/pulse`, version: v4, at, bpm: 70 });

        health.remove.mockClear();
        await api(`/api/bp/${created.id}`, 'DELETE');
        await idle();
        expect(health.remove.mock.calls.map(([a]) => a)).toEqual([
            { type: 'bp', id: created.id },
            { type: 'hr', id: `${created.id}/pulse` },
        ]);
    });

    it('a bp row that came from Health never gets an hr call; its tombstone still sends the remove', async () => {
        startHealthWriteBack({ health, storage, records });
        const id = `bp-hk-${U1}`;
        await records.put('bp', { recordId: id, clientTs: 0, deleted: false, measured_at: '2026-10-01T07:30:00.000Z', systolic: 120, diastolic: 80, pulse: 66, source: 'apple_health', source_id: U1 });
        await api(`/api/bp/${id}`, 'PUT', { pulse: 70 });
        await new Promise((r) => setTimeout(r, 10));
        expect(calls()).toEqual([]);
        await api(`/api/bp/${id}`, 'DELETE');
        await idle();
        expect(calls()).toEqual([
            { op: 'remove', type: 'bp', id },
            { op: 'remove', type: 'hr', id: `${id}/pulse` },
        ]);
    });

    it('a plain Telegram /bp drain is written, and a re-drain re-upserts the same record', async () => {
        startHealthWriteBack({ health, storage, records });
        const now = Date.now;
        const deps = { bp: createBPDomain({ records, now, timeZone: 'UTC' }), weight: createWeightDomain({ records, now, timeZone: 'UTC' }), records, now, editReply: async () => {} };
        const event = { kind: TG_COMMAND, text: '/bp 128 84', at_unix: 1_790_000_000, reply_message_id: 1 };
        await applyTGCommand(event, 7, deps);
        await idle();
        await applyTGCommand(event, 7, deps);
        await idle();
        expect(new Set(health.write.mock.calls.map(([a]) => a.id))).toEqual(new Set(['tg-7']));
        expect(health.write).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'bp', id: 'tg-7', version: (await raw('bp', 'tg-7')).clientTs, systolic: 128, diastolic: 84 }));
    });

    it('create then immediate delete ends with a remove', async () => {
        startHealthWriteBack({ health, storage, records });
        const created = await api('/api/weight', 'POST', { measured_at: '2026-10-01T07:30:00Z', weight: 80 });
        await api(`/api/weight/${created.id}`, 'DELETE');
        await idle();
        expect(calls().at(-1)).toEqual({ op: 'remove', type: 'weight', id: created.id });
    });

    it('a delete queued behind a blocked write survives a restart and is delivered next pass', async () => {
        health.write = vi.fn(() => new Promise(() => {})); // the shell never answers
        startHealthWriteBack({ health, storage, records });
        const created = await api('/api/bp', 'POST', { measured_at: '2026-10-01T07:30:00Z', systolic: 120, diastolic: 80 });
        await vi.waitFor(() => expect(health.write).toHaveBeenCalled());
        await api(`/api/bp/${created.id}`, 'DELETE');
        const tomb = await raw('bp', created.id);
        expect(dirty().bp).toEqual({ [created.id]: tomb.clientTs });

        // The page dies; a new one over the same storage and vault.
        const next = writeHealth();
        await startHealthWriteBack({ health: next, storage, records }).drain();
        expect(next.remove).toHaveBeenCalledWith({ type: 'bp', id: created.id });
        expect(next.write).not.toHaveBeenCalled();
        expect(ledgerSize()).toBe(0);
    });

    it('a failed remove stays in the ledger and is retried on the next pass', async () => {
        health.remove = vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValue(true);
        const wb = startHealthWriteBack({ health, storage, records, diag: () => {} });
        storage.setItem('wg.health.dirty', JSON.stringify({ bp: { 'bp-gone': 5 } }));
        await wb.drain();
        expect(dirty()).toEqual({ bp: { 'bp-gone': 5 } });
        await wb.drain();
        expect(health.remove).toHaveBeenCalledTimes(2);
        expect(ledgerSize()).toBe(0);
    });

    it('a single write whose wg.health.copied save fails stays queued, is resent, and ends with its marker (breakage review 1588 #2)', async () => {
        await records.put('weight', { recordId: 'w-1', clientTs: 7, deleted: false, measured_at: '2026-10-01T07:30:00.000Z', weight: 80 });
        const set = storage.setItem;
        let failOnce = true;
        storage.setItem = (k, v) => {
            if (k === 'wg.health.copied' && failOnce) { failOnce = false; throw new Error('quota'); }
            return set(k, v);
        };
        const wb = startHealthWriteBack({ health, storage, records, diag: () => {} });
        storage.setItem('wg.health.dirty', JSON.stringify({ weight: { 'w-1': 7 } }));
        expect(await wb.drain()).toBe(0);
        expect(dirty()).toEqual({ weight: { 'w-1': 7 } });
        expect(storage.getItem('wg.health.copied')).toBeNull();
        await wb.drain();
        expect(wrote().map((a) => a.id)).toEqual(['w-1', 'w-1']);
        expect(ledgerSize()).toBe(0);
        expect(JSON.parse(storage.getItem('wg.health.copied'))).toEqual({ weight: { 'w-1': 7 } });
    });

    it('120 bp rows with pulses drain both kinds over passes, interleaved, none dropped', async () => {
        const rows = Array.from({ length: 120 }, (_, i) => ({ recordId: `bp-${i}`, clientTs: 10, deleted: false, measured_at: '2026-10-01T07:30:00.000Z', systolic: 120, diastolic: 80, pulse: 60 + (i % 30) }));
        for (const r of rows) await records.put('bp', r); // before the hook: marked by hand below
        const wb = startHealthWriteBack({ health, storage, records });
        storage.setItem('wg.health.dirty', JSON.stringify({
            bp: Object.fromEntries(rows.map((r) => [r.recordId, 10])),
            hr: Object.fromEntries(rows.map((r) => [r.recordId, 10])),
        }));
        const counts = [];
        for (let i = 0; i < 5; i++) {
            await wb.drain();
            counts.push(health.write.mock.calls.length);
        }
        expect(counts).toEqual([50, 100, 150, 200, 240]);
        // The first pass took both kinds, alternating.
        expect(health.write.mock.calls.slice(0, 50).filter(([a]) => a.type === 'hr')).toHaveLength(25);
        expect(new Set(health.write.mock.calls.filter(([a]) => a.type === 'hr').map(([a]) => a.id)))
            .toEqual(new Set(rows.map((r) => `${r.recordId}/pulse`)));
        expect(ledgerSize()).toBe(0);
    });

    it('a batch reply shorter than its entries: the missing ones stay queued, moved back (bd med-8f4s.15)', async () => {
        for (const id of ['w-a', 'w-b', 'w-c']) await records.put('weight', { recordId: id, clientTs: 4, deleted: false, measured_at: '2026-10-01T07:30:00.000Z', weight: 80 });
        health.writeAccess = vi.fn(async () => ({ granted: ALL, supported: ALL, readableFrom: 0 }));
        health.write = vi.fn(async () => [true]);
        const diag = vi.fn();
        const wb = startHealthWriteBack({ health, storage, records, diag });
        storage.setItem('wg.health.dirty', JSON.stringify({ weight: { 'w-a': 4, 'w-b': 4, 'w-c': 4 } }));
        expect(await wb.drain()).toBe(1);
        expect(health.write).toHaveBeenCalledWith({ entries: [expect.objectContaining({ id: 'w-a' }), expect.objectContaining({ id: 'w-b' }), expect.objectContaining({ id: 'w-c' })] });
        expect(dirty()).toEqual({ weight: { 'w-b': 4, 'w-c': 4 } });
        expect(diag).toHaveBeenCalledWith('[health] write batch reply 1 of 3');
    });

    it('120 dirty ids (absent from the vault) drain over three passes, none dropped', async () => {
        const ids = Array.from({ length: 120 }, (_, i) => `weight-${i}`);
        storage.setItem('wg.health.dirty', JSON.stringify({ weight: Object.fromEntries(ids.map((id) => [id, 1])) }));
        const wb = startHealthWriteBack({ health, storage, records });
        const counts = [];
        for (let i = 0; i < 3; i++) {
            await wb.drain();
            counts.push(health.remove.mock.calls.length);
        }
        expect(counts).toEqual([50, 100, 120]);
        expect(new Set(health.remove.mock.calls.map(([a]) => a.id))).toEqual(new Set(ids));
        expect(ledgerSize()).toBe(0);
    });

    it('a reading that came from Health is never written, nor is its edit', async () => {
        startHealthWriteBack({ health, storage, records });
        await records.put('bp', { recordId: `bp-hk-${U1}`, clientTs: 0, deleted: false, measured_at: '2026-10-01T07:30:00.000Z', systolic: 120, diastolic: 80, source: 'apple_health', source_id: U1 });
        await api(`/api/bp/bp-hk-${U1}`, 'PUT', { systolic: 125 });
        const imported = await records.put('weight', { recordId: `weight-hk-${U2}`, clientTs: 0, deleted: false, measured_at: '2026-10-01T07:30:00.000Z', weight: 80, source: 'apple_health', source_id: U2 });
        await api(`/api/weight?replaces=${imported.recordId}`, 'POST', { measured_at: '2026-10-01T07:30:00Z', weight: 81 });
        await new Promise((r) => setTimeout(r, 10));
        expect(health.write).not.toHaveBeenCalled();
        expect(ledgerSize()).toBe(0);
    });

    // Archie 14798: the boundary is the operation, not the row's device of origin.
    it('a row that arrived by sync is not mirrored until it is edited on this phone', async () => {
        const accountId = 'acct-wb';
        const ctx = { accountId, ...(await deriveDataKeys(generateDEK())) };
        const db = await openDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction('sync_meta', 'readwrite');
            tx.objectStore('sync_meta').put(5, 'localLastSeq');
            tx.objectStore('sync_meta').put(0, 'lastSnapshotSeq');
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
        db.close();
        const body = { recordId: 'bp-other', clientTs: 9000, deleted: false, measured_at: '2026-10-01T07:30:00.000Z', systolic: 140, diastolic: 90 };
        const { nonce, ct } = await encryptRecord({ kData: ctx.kData, accountId, recordType: 'bp', recordId: 'bp-other', seq: 6, plaintext: new TextEncoder().encode(JSON.stringify(body)) });
        let ops = [{ seq: 6, record_type_tag: 'bp:bp-other', nonce: toBase64(nonce), ct: toBase64(new Uint8Array(ct)) }];
        vi.stubGlobal('fetch', vi.fn(async (url) => {
            const u = String(url);
            if (u === '/api/sync/snapshot') return new Response(null, { status: 204 });
            if (u.startsWith('/api/sync/ops?')) {
                const out = ops;
                ops = [];
                return new Response(JSON.stringify({ ops: out, next: false }), { status: 200 });
            }
            throw new Error(`unexpected fetch: ${u}`);
        }));
        startHealthWriteBack({ health, storage, records });
        await pullOnOpen(ctx);
        expect((await raw('bp', 'bp-other')).systolic).toBe(140);
        expect(ledgerSize()).toBe(0);

        await api('/api/bp/bp-other', 'PUT', { systolic: 138 });
        await idle();
        expect(health.write).toHaveBeenCalledWith(expect.objectContaining({ id: 'bp-other', systolic: 138 }));
    });

    // Breakage review (PR1): a denied kind must not cost a Health call per entry.
    it('a kind without write access waits in the ledger, never sent, while the other is delivered', async () => {
        health.writeAccess = vi.fn(async () => ({ granted: ['weight'] }));
        const wb = startHealthWriteBack({ health, storage, records, diag: () => {} });
        const b = await api('/api/bp', 'POST', { measured_at: '2026-10-01T07:30:00Z', systolic: 120, diastolic: 80 });
        await api(`/api/bp/${b.id}`, 'PUT', { systolic: 121 });
        const w = await api('/api/weight', 'POST', { measured_at: '2026-10-01T07:30:00Z', weight: 80 });
        await vi.waitFor(() => expect(dirty().weight).toEqual({}));
        await wb.drain();
        expect(Object.keys(dirty().bp)).toEqual([b.id]);
        expect(health.write.mock.calls.map(([a]) => a.type)).toEqual(['weight']);
        expect(health.write).toHaveBeenCalledWith(expect.objectContaining({ type: 'weight', id: w.id, kg: 80 }));

        // Allowed later: the next pass delivers the latest version.
        health.writeAccess = vi.fn(async () => ({ granted: ALL }));
        await wb.drain();
        expect(health.write).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'bp', id: b.id, systolic: 121 }));
        expect(ledgerSize()).toBe(0);
    });

    it('a write refused as denied holds its kind back until the next access read', async () => {
        health.write = vi.fn(async (a) => { if (a.type === 'bp') throw new Error('denied'); return true; });
        startHealthWriteBack({ health, storage, records, diag: () => {} });
        await api('/api/bp', 'POST', { measured_at: '2026-10-01T07:30:00Z', systolic: 120, diastolic: 80 });
        await vi.waitFor(() => expect(health.write).toHaveBeenCalledTimes(1));
        await api('/api/bp', 'POST', { measured_at: '2026-10-01T08:30:00Z', systolic: 121, diastolic: 81 });
        await new Promise((r) => setTimeout(r, 10));
        expect(health.write).toHaveBeenCalledTimes(1);
        expect(Object.keys(dirty().bp)).toHaveLength(2);
    });

    it('a newer access read dropping a kind while a step reads the row stops that step', async () => {
        let release;
        const paused = { ...records, listRaw: async (t) => { await new Promise((r) => { release = r; }); return records.listRaw(t); } };
        storage.setItem('wg.health.dirty', JSON.stringify({ bp: { 'bp-x': 3 } }));
        const wb = startHealthWriteBack({ health, storage, records: paused });
        const pass = wb.drain();
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        health.writeAccess.mockResolvedValue({ granted: ['weight'] });
        await wb.readAccess();
        release();
        await pass;
        expect(calls()).toEqual([]);
        expect(dirty()).toEqual({ bp: { 'bp-x': 3 } });
    });

    it('switched off while a step waits on a pending access read: nothing is sent, the entry is kept', async () => {
        let release;
        let reply;
        const paused = { ...records, listRaw: async (t) => { await new Promise((r) => { release = r; }); return records.listRaw(t); } };
        storage.setItem('wg.health.dirty', JSON.stringify({ bp: { 'bp-x': 3 } }));
        const wb = startHealthWriteBack({ health, storage, records: paused });
        const pass = wb.drain();
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        health.writeAccess.mockImplementation(() => new Promise((r) => { reply = r; }));
        const read = wb.readAccess();
        await vi.waitFor(() => expect(reply).toBeTypeOf('function'));
        release();
        await new Promise((r) => setTimeout(r, 0));
        storage.setItem('wg.health.write', 'false');
        reply({ granted: ['bp', 'weight'] });
        await read;
        await pass;
        expect(calls()).toEqual([]);
        expect(dirty()).toEqual({ bp: { 'bp-x': 3 } });
    });

    it('overlapping denied writes of both kinds hold both back until the next access read', async () => {
        let failBp;
        health.write = vi.fn((a) => (a.type === 'bp'
            ? new Promise((_, rej) => { failBp = () => rej(new Error('denied')); })
            : Promise.reject(new Error('denied'))));
        startHealthWriteBack({ health, storage, records, diag: () => {} });
        await api('/api/bp', 'POST', { measured_at: '2026-10-01T07:30:00Z', systolic: 120, diastolic: 80 });
        await vi.waitFor(() => expect(failBp).toBeTypeOf('function'));
        await api('/api/weight', 'POST', { measured_at: '2026-10-01T07:30:00Z', weight: 80 });
        await vi.waitFor(() => expect(health.write).toHaveBeenCalledTimes(2));
        failBp();
        await new Promise((r) => setTimeout(r, 10));
        await api('/api/weight', 'POST', { measured_at: '2026-10-01T08:30:00Z', weight: 81 });
        await api('/api/bp', 'POST', { measured_at: '2026-10-01T08:30:00Z', systolic: 121, diastolic: 81 });
        await new Promise((r) => setTimeout(r, 10));
        expect(health.write.mock.calls.map(([a]) => a.type)).toEqual(['bp', 'weight']);
        expect(ledgerSize()).toBe(4);
    });

    // Breakage review (PR1): Android's bridge call has no timeout, so an older
    // shell must never get a write op, whatever is stored.
    it('a shell without health.write in shell.ops gets no write op, even with the switch stored on', async () => {
        health.canWrite = async () => false;
        const wb = startHealthWriteBack({ health, storage, records });
        const b = await api('/api/bp', 'POST', { measured_at: '2026-10-01T07:30:00Z', systolic: 120, diastolic: 80 });
        await wb.drain();
        await new Promise((r) => setTimeout(r, 10));
        expect(health.writeAccess).not.toHaveBeenCalled();
        expect(calls()).toEqual([]);
        expect(Object.keys(dirty().bp)).toEqual([b.id]);
    });

    it('switched off: nothing is marked or sent, the ledger is kept and drains when on again', async () => {
        storage.setItem('wg.health.dirty', JSON.stringify({ bp: { 'bp-old': 3 } }));
        storage.setItem('wg.health.write', 'false');
        const wb = startHealthWriteBack({ health, storage, records });
        await api('/api/bp', 'POST', { measured_at: '2026-10-01T07:30:00Z', systolic: 120, diastolic: 80 });
        await wb.drain();
        expect(calls()).toEqual([]);
        expect(dirty()).toEqual({ bp: { 'bp-old': 3 } });

        storage.setItem('wg.health.write', 'true');
        await wb.drain();
        expect(calls()).toEqual([{ op: 'remove', type: 'bp', id: 'bp-old' }]);
        expect(ledgerSize()).toBe(0);
    });

    it('switched off while a step waits for the commit: nothing is sent and the entry is kept', async () => {
        let release;
        const settled = () => new Promise((r) => { release = r; });
        storage.setItem('wg.health.dirty', JSON.stringify({ bp: { 'bp-x': 3 } }));
        const pass = startHealthWriteBack({ health, storage, records, settled }).drain();
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        storage.setItem('wg.health.write', 'false');
        release();
        await pass;
        expect(calls()).toEqual([]);
        expect(dirty()).toEqual({ bp: { 'bp-x': 3 } });
    });

    it('with no write switch stored (this release), nothing is marked or sent', async () => {
        storage = memStorage();
        storage.setItem('wg.health.enabled', 'true');
        const wb = startHealthWriteBack({ health, storage, records });
        await api('/api/bp', 'POST', { measured_at: '2026-10-01T07:30:00Z', systolic: 120, diastolic: 80 });
        await wb.drain();
        expect(calls()).toEqual([]);
        expect(health.writeAccess).not.toHaveBeenCalled();
        expect(storage.getItem('wg.health.dirty')).toBeNull();
    });

    // bd med-8f4s.5: a completed workout session is one workout in Health,
    // start, end and type only (Archie 15354, 15360).
    describe('workouts', () => {
        const tick = () => new Promise((r) => setTimeout(r, 5));
        const plan = (recordId, id) => records.put('workoutsession', {
            recordId, clientTs: Date.now(), deleted: false, id, user_id: 1, group_id: 7, variant_id: 9,
            scheduled_date: `${new Date().toISOString().slice(0, 10)}T00:00:00Z`, scheduled_time: '07:00',
            status: 'pending', started_at: null, completed_at: null, snoozed_until: null, snooze_count: 0,
            notification_message_id: null, notes: '',
        });
        const complete = (id) => api(`/api/workout/sessions/status?id=${id}`, 'PUT', { status: 'completed' });
        const workoutCall = async (recordId, activity) => {
            const s = await raw('workoutsession', recordId);
            return { op: 'write', type: 'workout', id: recordId, version: s.clientTs, start: Date.parse(s.started_at), end: Date.parse(s.completed_at), activity };
        };

        beforeEach(() => {
            health.writeAccess = vi.fn(async () => ({ granted: ALL, supported: ALL }));
        });

        it('(a) a completed plan session is one strength workout; create, start, snooze and skip send nothing; delete removes it', async () => {
            startHealthWriteBack({ health, storage, records });
            await plan('session-7-a', 101);
            await plan('session-7-b', 102);
            await api('/api/workout/sessions/101/start', 'POST');
            await api('/api/workout/sessions/101/snooze', 'POST', { minutes: 10 });
            await api('/api/workout/sessions/102/skip', 'POST');
            await tick();
            expect(calls()).toEqual([]);
            expect(storage.getItem('wg.health.dirty')).toBeNull();

            await complete(101);
            await idle();
            expect(calls()).toEqual([await workoutCall('session-7-a', 50)]);

            await api('/api/workout/sessions/delete?id=101', 'DELETE');
            await idle();
            expect(calls().at(-1)).toEqual({ op: 'remove', type: 'workout', id: 'session-7-a' });
        });

        // bd med-8f4s.12 rule D: a plan day marked Done without a start spans
        // its scheduled time + 5 min per exercise, in the account zone.
        describe('a plan day completed without a start', () => {
            const at = (iso) => Date.parse(iso);
            const span = () => Object.fromEntries(calls().map((c) => [c.id, c.op === 'write' ? [c.start, c.end, c.activity] : c.op]));
            const day = (recordId, id, date, time) => records.put('workoutsession', {
                recordId, clientTs: Date.now(), deleted: false, id, user_id: 1, group_id: 7, variant_id: 9,
                scheduled_date: `${date}T00:00:00+02:00`, scheduled_time: time,
                status: 'pending', started_at: null, completed_at: null, notes: '',
            });
            const planned = async (n) => {
                for (let i = 1; i <= n; i++) {
                    await records.put('workoutexercise', { recordId: `ex-${i}`, clientTs: 1, deleted: false, id: i, variant_id: 9, exercise_name: `Ex ${i}`, target_sets: 3, target_reps_min: 5, order_index: i });
                }
            };
            const log = (n, sessionId, exerciseId, name) => records.put('exerciselog', { recordId: `log-${n}`, clientTs: 1, deleted: false, id: n, session_id: sessionId, exercise_id: exerciseId, exercise_name: name, logged_at: '2026-07-01T17:00:00.000Z' });

            beforeEach(async () => {
                await records.put('settings', { recordId: 'settings', clientTs: 1, deleted: false, timezone: 'Europe/Berlin' });
            });

            it('(a) 4 planned exercises, no logs: 18:00 → 18:20 local, strength; DST gap moves forward', async () => {
                startHealthWriteBack({ health, storage, records });
                await planned(4);
                await day('session-7-c', 103, '2026-07-01', '18:00');
                await day('session-7-dst', 105, '2026-03-29', '02:30');
                await complete(103);
                await complete(105);
                await idle();
                expect((await raw('workoutsession', 'session-7-c')).exercise_snapshot).toHaveLength(4);
                expect(span()).toEqual({
                    'session-7-c': [at('2026-07-01T16:00:00Z'), at('2026-07-01T16:20:00Z'), 50],
                    // Berlin 02:30 does not exist that night: 03:30 CEST.
                    'session-7-dst': [at('2026-03-29T01:30:00Z'), at('2026-03-29T01:50:00Z'), 50],
                });
            });

            it('(b) logs on 2 distinct exercises (one twice) win over the snapshot: 18:10', async () => {
                startHealthWriteBack({ health, storage, records });
                await planned(4);
                await day('session-7-c', 103, '2026-07-01', '18:00');
                await log(1, 103, 1, 'Ex 1');
                await log(2, 103, 1, 'Ex 1');
                await log(3, 103, 0, ' my  Curl');
                await log(4, 103, 0, 'My curl');
                await complete(103);
                await idle();
                expect(span()).toEqual({ 'session-7-c': [at('2026-07-01T16:00:00Z'), at('2026-07-01T16:10:00Z'), 50] });
            });

            it('(c) no exercises, or no scheduled_time, is never written; a legacy row without a snapshot counts the live plan', async () => {
                startHealthWriteBack({ health, storage, records });
                await day('session-7-empty', 106, '2026-07-01', '18:00');
                await complete(106);
                await day('session-7-notime', 107, '2026-07-01', '');
                await records.put('exerciselog', { recordId: 'log-9', clientTs: 1, deleted: false, id: 9, session_id: 107, exercise_id: 1, exercise_name: 'Ex 1', logged_at: '2026-07-01T17:00:00.000Z' });
                await complete(107);
                await idle();
                await planned(2);
                await records.put('workoutsession', {
                    recordId: 'session-7-legacy', clientTs: Date.now(), deleted: false, id: 108, group_id: 7, variant_id: 9,
                    scheduled_date: '2026-07-01T00:00:00+02:00', scheduled_time: '18:00', status: 'completed', completed_at: '2026-07-01T20:00:00.000Z',
                });
                await idle();
                expect(span()).toEqual({
                    'session-7-empty': 'remove',
                    'session-7-notime': 'remove',
                    'session-7-legacy': [at('2026-07-01T16:00:00Z'), at('2026-07-01T16:10:00Z'), 50],
                });
            });

            it('the #1559 reversals still remove it: back to in progress, and delete', async () => {
                startHealthWriteBack({ health, storage, records });
                await planned(1);
                await day('session-7-c', 103, '2026-07-01', '18:00');
                await day('session-7-del', 104, '2026-07-01', '19:00');
                await complete(103);
                await complete(104);
                await idle();
                await api('/api/workout/sessions/status?id=103', 'PUT', { status: 'in_progress' });
                await api('/api/workout/sessions/delete?id=104', 'DELETE');
                await idle();
                expect(calls().map((c) => `${c.op} ${c.id}`)).toEqual([
                    'write session-7-c', 'write session-7-del', 'remove session-7-c', 'remove session-7-del',
                ]);
            });
        });

        it('moving a completed session back to in progress removes its workout; completing it again does not re-send', async () => {
            startHealthWriteBack({ health, storage, records });
            await plan('session-7-d', 104);
            await api('/api/workout/sessions/104/start', 'POST');
            await tick();
            await complete(104);
            await idle();
            await api('/api/workout/sessions/status?id=104', 'PUT', { status: 'in_progress' });
            await idle();
            expect(calls().at(-1)).toEqual({ op: 'remove', type: 'workout', id: 'session-7-d' });
        });

        it('an ad-hoc session is strength only when every log is a strength-tagged library exercise, else other', async () => {
            startHealthWriteBack({ health, storage, records });
            const lib = (recordId, id, name, body_part) => records.put('exerciselibrary', { recordId, clientTs: 1, deleted: false, id, name, body_part });
            await lib('lib-1', 1, 'Bench press', 'chest');
            await lib('lib-2', 2, 'Treadmill', 'cardio');
            await lib('lib-3', 3, 'Plank', '');
            const adhoc = async (names) => {
                const { session } = await api('/api/workout/sessions/adhoc', 'POST');
                const ids = { 'Bench press': 1, Treadmill: 2, Plank: 3 };
                for (const name of names) {
                    await api('/api/workout/sessions/logs/create', 'POST', { session_id: session.id, exercise_id: ids[name], exercise_name: name, source: 'library', target_sets: 3, target_reps_min: 5 });
                }
                await tick();
                await complete(session.id);
                await idle();
                return (await records.listRaw('workoutsession')).find((r) => r.id === session.id).recordId;
            };
            const strength = await adhoc(['Bench press']);
            const mixed = await adhoc(['Bench press', 'Treadmill']);
            const untagged = await adhoc(['Plank']);
            const empty = await adhoc([]);
            expect(calls()).toEqual([
                await workoutCall(strength, 50),
                await workoutCall(mixed, 3000),
                await workoutCall(untagged, 3000),
                await workoutCall(empty, 3000),
            ]);
        });

        // Archie 15658: a session left open and finished hours later.
        it('a span over 4 h ends at the last log, else 4 h after the start', async () => {
            startHealthWriteBack({ health, storage, records });
            const done = (recordId, id) => records.put('workoutsession', {
                recordId, clientTs: Date.now(), deleted: false, id, group_id: 7, variant_id: 9, status: 'completed',
                started_at: '2026-10-01T08:00:00.000Z', completed_at: '2026-10-01T23:00:00.000Z',
            });
            await records.put('exerciselog', { recordId: 'log-a', clientTs: 1, deleted: false, id: 1, session_id: 201, exercise_id: 1, exercise_name: 'Bench press', logged_at: '2026-10-01T08:30:00.000Z' });
            await records.put('exerciselog', { recordId: 'log-b', clientTs: 1, deleted: false, id: 2, session_id: 201, exercise_id: 1, exercise_name: 'Bench press', logged_at: '2026-10-01T09:10:00.000Z' });
            await done('session-7-long', 201);
            await done('session-7-nologs', 202);
            await idle();
            const ends = Object.fromEntries(health.write.mock.calls.map(([a]) => [a.id, [a.start, a.end]]));
            expect(ends).toEqual({
                'session-7-long': [Date.parse('2026-10-01T08:00:00Z'), Date.parse('2026-10-01T09:10:00Z')],
                'session-7-nologs': [Date.parse('2026-10-01T08:00:00Z'), Date.parse('2026-10-01T12:00:00Z')],
            });
        });

        // inbox-apply.js "I did a workout": created and completed on the
        // message's sent instant, so started_at === completed_at.
        it('a Telegram "I did a workout" log (a zero-length span) is never written', async () => {
            startHealthWriteBack({ health, storage, records });
            const sentMs = Date.now();
            const workout = createWorkoutDomain({ records, now: () => sentMs, timeZone: 'UTC' });
            const session = await workout.createAdHocSession({ recordId: 'tg-9', notes: 'gym' });
            await workout.setSessionStatus(session.id, 'completed');
            await idle();
            expect((await raw('workoutsession', 'tg-9')).status).toBe('completed');
            expect(calls()).toEqual([{ op: 'remove', type: 'workout', id: 'tg-9' }]);
        });

        // No re-import: the shells drop their own workouts before the page.
        it('a workout page holding only our own (dropped by the shell) moves the anchor and writes nothing', async () => {
            const mem = memRecords();
            const h = {
                isSupported: () => true,
                requestAuthorization: async () => true,
                query: vi.fn(async ({ type }) => (type === 'workout'
                    ? { samples: [], anchor: 'w1', returned: 2, more: false }
                    : { samples: [], anchor: null, returned: 0, more: false })),
            };
            const st = memStorage();
            st.setItem('wg.health.enabled', 'true');
            expect(await runHealthImport({}, { health: h, storage: st, records: mem, flush: async () => true, diag: () => {} })).toEqual({ added: 0 });
            expect(JSON.parse(st.getItem('wg.health.anchors')).workout).toBe('w1');
            expect(mem.rows.size).toBe(0);
        });
    });

    // Kit HW0-HW4 (screens-health-write.html): the "Also write my entries" row.
    describe('Settings write row', () => {
        const writeRow = () => document.getElementById('health-write-row');
        const writeToggle = () => document.getElementById('health-write-toggle');
        const writeDesc = () => writeRow().querySelector('.wg-setting__desc')?.textContent ?? null;
        const flip = async (el, on) => {
            el.checked = on;
            el.dispatchEvent(new window.Event('change'));
            await new Promise((r) => setTimeout(r, 0));
            await vi.waitFor(() => expect(el.disabled).toBe(false));
        };
        let toast;
        const start = async (h = health) => {
            await startHealthImport({}, {
                health: { ...fakeHealth({}), label: 'Health Connect', accessHint: 'Health Connect → App permissions', ...h },
                // An entry made right after switch-on can draw the HW6 offer: Not now.
                storage, doc: document, records, run: vi.fn(async () => null), toast, ask: async () => false,
            });
            await new Promise((r) => setTimeout(r, 0));
        };
        const home = '<div id="settings-view"><div class="wg-settings-home"><div class="wg-list"></div></div></div>';
        // jsdom starts 'prerender': come back to the foreground for real.
        const foreground = () => {
            const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
            document.dispatchEvent(new window.Event('visibilitychange'));
            spy.mockRestore();
        };

        beforeEach(() => {
            document.body.innerHTML = home;
            storage.setItem('wg.health.write', 'false');
            toast = vi.fn();
        });

        it('shows only while the import is on and the shell lists health.write (HW0/HW1)', async () => {
            await start({ ...health, canWrite: async () => false });
            expect(writeRow()).toBeNull();

            document.body.innerHTML = home;
            storage.setItem('wg.health.enabled', 'false');
            await start();
            expect(writeRow()).toBeNull(); // HW0
            await flip(document.getElementById('health-import-toggle'), true);
            // HW1: in the import row's group, title and switch only, off.
            expect(writeRow().parentNode).toBe(document.getElementById('health-import-row').parentNode);
            expect(writeRow().querySelector('.wg-setting__title').textContent).toBe('Also write my entries');
            expect(writeDesc()).toBeNull();
            expect(writeToggle().checked).toBe(false);
            expect(writeToggle().getAttribute('aria-label')).toBe('Also write my entries to Health Connect');
            expect(health.writeAccess).not.toHaveBeenCalled();
        });

        it('switching it on asks one sheet for read and write, stays on, and a new entry reaches Health (HW2)', async () => {
            const requestAuthorization = vi.fn(async () => true);
            await start({ ...health, requestAuthorization });
            await start(); // a second mount adds nothing
            expect(document.querySelectorAll('#health-write-row')).toHaveLength(1);
            await flip(writeToggle(), true);
            expect(requestAuthorization).toHaveBeenCalledWith(['bp', 'weight', 'sleep', 'workout', 'steps', 'hr', 'spo2'], { write: ALL });
            expect(health.writeAccess).toHaveBeenCalledWith(ALL);
            expect(writeToggle().checked).toBe(true);
            expect(storage.getItem('wg.health.write')).toBe('true');
            expect(writeDesc()).toBeNull();
            const b = await api('/api/bp', 'POST', { measured_at: '2026-10-01T07:30:00Z', systolic: 120, diastolic: 80 });
            await idle();
            expect(health.write).toHaveBeenCalledWith(expect.objectContaining({ type: 'bp', id: b.id }));
        });

        it('refused: flips back off with where to allow it, and nothing is marked (HW3)', async () => {
            health.writeAccess = vi.fn(async () => ({ granted: [] }));
            await start();
            await flip(writeToggle(), true);
            expect(writeToggle().checked).toBe(false);
            expect(storage.getItem('wg.health.write')).toBe('false');
            expect(writeDesc()).toBe("Writing isn't allowed yet. Allow it in Health Connect → App permissions, then turn this on.");
            await api('/api/bp', 'POST', { measured_at: '2026-10-01T07:30:00Z', systolic: 120, diastolic: 80 });
            expect(ledgerSize()).toBe(0);

            // Allowed now: the next turn-on clears the line.
            health.writeAccess.mockResolvedValue({ granted: ALL });
            await flip(writeToggle(), true);
            expect(writeToggle().checked).toBe(true);
            expect(writeDesc()).toBeNull();
        });

        it('partly granted: stays on and names the missing kind; its entries wait unsent (HW4)', async () => {
            health.writeAccess = vi.fn(async () => ({ granted: ['weight'] }));
            await start();
            await flip(writeToggle(), true);
            expect(writeToggle().checked).toBe(true);
            expect(writeDesc()).toBe("Writing weight only. Blood pressure isn't allowed: allow it in Health Connect → App permissions.");
            const b = await api('/api/bp', 'POST', { measured_at: '2026-10-01T07:30:00Z', systolic: 120, diastolic: 80 });
            await new Promise((r) => setTimeout(r, 10));
            expect(health.write).not.toHaveBeenCalled();
            expect(Object.keys(dirty().bp)).toEqual([b.id]);

            // Blood pressure allowed later: the next foreground pass delivers it and the line goes.
            health.writeAccess.mockResolvedValue({ granted: ALL });
            foreground();
            await idle();
            expect(health.write).toHaveBeenCalledWith(expect.objectContaining({ type: 'bp', id: b.id }));
            expect(writeDesc()).toBeNull();
        });

        it('partly granted the other way round names weight (HW4 reverse)', async () => {
            health.writeAccess = vi.fn(async () => ({ granted: ['bp'] }));
            await start();
            await flip(writeToggle(), true);
            expect(writeToggle().checked).toBe(true);
            expect(writeDesc()).toBe("Writing blood pressure only. Weight isn't allowed: allow it in Health Connect → App permissions.");
        });

        // Breakage review of #1547: the Health Connect activity's resume fires a
        // pass while the turn-on flow still waits on its access read.
        it('a pass racing the turn-on shows no second write sheet; a rejected later sheet is not re-asked', async () => {
            allowConsoleNoise();
            const requestAuthorization = vi.fn(async () => true);
            let release;
            const reply = { granted: ['bp', 'weight'], supported: ALL };
            health.writeAccess = vi.fn()
                .mockImplementationOnce(() => new Promise((r) => { release = () => r(reply); }))
                .mockResolvedValue(reply);
            await start({ ...health, requestAuthorization });
            writeToggle().checked = true;
            writeToggle().dispatchEvent(new window.Event('change'));
            await vi.waitFor(() => expect(release).toBeTypeOf('function'));
            foreground();
            await vi.waitFor(() => expect(health.writeAccess).toHaveBeenCalledTimes(2));
            await new Promise((r) => setTimeout(r, 10));
            release();
            await vi.waitFor(() => expect(writeToggle().disabled).toBe(false));
            expect(requestAuthorization.mock.calls.filter(([, o]) => o)).toHaveLength(1);
            expect(storage.getItem('wg.health.writeAsked')).toBe(JSON.stringify(ALL));

            // A shell asked for hr whose sheet rejects: asked once, not on every pass.
            storage.setItem('wg.health.writeAsked', JSON.stringify(['bp', 'weight']));
            requestAuthorization.mockClear();
            requestAuthorization.mockRejectedValue(new Error('bridge gone'));
            foreground();
            await new Promise((r) => setTimeout(r, 10));
            foreground();
            await new Promise((r) => setTimeout(r, 10));
            expect(requestAuthorization.mock.calls.filter(([, o]) => o)).toEqual([[expect.any(Array), { write: ['hr', 'workout'] }]]);
        });

        it('two kinds missing read in the plural (Miles 15460)', async () => {
            health.writeAccess = vi.fn(async () => ({ granted: ['bp'], supported: HR }));
            await start();
            await flip(writeToggle(), true);
            expect(writeDesc()).toBe("Writing blood pressure only. Weight and pulse (heart rate) aren't allowed: allow them in Health Connect → App permissions.");
        });

        // bd med-8f4s.6: heart rate denied on a shell that can write it.
        it('pulse denied: bp and weight arrive, the pulses wait and the line names pulse; allowed later, they arrive', async () => {
            health.writeAccess = vi.fn(async () => ({ granted: ['bp', 'weight'], supported: HR }));
            await start();
            await flip(writeToggle(), true);
            expect(writeToggle().checked).toBe(true);
            expect(writeDesc()).toBe("Writing blood pressure and weight only. Pulse (heart rate) isn't allowed: allow it in Health Connect → App permissions.");
            const b = await api('/api/bp', 'POST', { measured_at: '2026-10-01T07:30:00Z', systolic: 120, diastolic: 80, pulse: 66 });
            const w = await api('/api/weight', 'POST', { measured_at: '2026-10-01T07:30:00Z', weight: 80 });
            await vi.waitFor(() => expect(dirty()).toEqual({ bp: {}, weight: {}, hr: { [b.id]: expect.any(Number) } }));
            expect(calls().map((c) => c.type)).toEqual(['bp', 'weight']);
            expect(health.write).toHaveBeenCalledWith(expect.objectContaining({ type: 'weight', id: w.id }));

            health.writeAccess.mockResolvedValue({ granted: HR, supported: HR });
            foreground();
            await idle();
            expect(health.write).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'hr', id: `${b.id}/pulse`, bpm: 66 }));
            expect(writeDesc()).toBeNull();
        });

        // An updated page on a shell that predates hr (no `supported`).
        it('an older shell: no pulse line, the pulses wait; once the shell supports hr the sheet is asked once and they arrive', async () => {
            const requestAuthorization = vi.fn(async () => true);
            health.writeAccess = vi.fn(async () => ({ granted: ['bp', 'weight'] }));
            await start({ ...health, requestAuthorization });
            await flip(writeToggle(), true);
            expect(writeToggle().checked).toBe(true);
            expect(writeDesc()).toBeNull();
            const b = await api('/api/bp', 'POST', { measured_at: '2026-10-01T07:30:00Z', systolic: 120, diastolic: 80, pulse: 66 });
            await vi.waitFor(() => expect(dirty().bp).toEqual({}));
            foreground();
            await new Promise((r) => setTimeout(r, 10));
            expect(Object.keys(dirty().hr)).toEqual([b.id]);
            expect(calls().map((c) => c.type)).toEqual(['bp']);
            // The switch-on write sheet only.
            expect(requestAuthorization.mock.calls.filter(([, o]) => o)).toEqual([[expect.any(Array), { write: ALL }]]);

            // The shell updates: it now writes hr, never asked on this device.
            requestAuthorization.mockClear();
            health.writeAccess.mockResolvedValue({ granted: HR, supported: HR });
            foreground();
            await idle();
            expect(requestAuthorization).toHaveBeenCalledWith(['bp', 'weight', 'sleep', 'workout', 'steps', 'hr', 'spo2'], { write: ['hr'] });
            expect(health.write).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'hr', id: `${b.id}/pulse` }));
            foreground();
            await new Promise((r) => setTimeout(r, 10));
            expect(requestAuthorization).toHaveBeenCalledTimes(1);
            expect(storage.getItem('wg.health.writeAsked')).toBe(JSON.stringify(HR));

            // bd med-8f4s.5: the next shell writes workouts; asked once, on its own.
            requestAuthorization.mockClear();
            health.writeAccess.mockResolvedValue({ granted: ALL, supported: ALL });
            foreground();
            await vi.waitFor(() => expect(requestAuthorization).toHaveBeenCalledWith(expect.any(Array), { write: ['workout'] }));
            foreground();
            await new Promise((r) => setTimeout(r, 10));
            expect(requestAuthorization).toHaveBeenCalledTimes(1);
            expect(storage.getItem('wg.health.writeAsked')).toBe(JSON.stringify(ALL));
        });

        // bd med-8f4s.5 (b): workouts denied on a shell that can write them.
        it('workouts denied: bp, pulse and weight arrive, the workouts wait and the line names them; allowed later, they arrive', async () => {
            health.writeAccess = vi.fn(async () => ({ granted: HR, supported: ALL }));
            await start();
            await flip(writeToggle(), true);
            expect(writeToggle().checked).toBe(true);
            expect(writeDesc()).toBe("Writing blood pressure, weight and pulse (heart rate) only. Workouts aren't allowed: allow them in Health Connect → App permissions.");
            const s = await api('/api/workout/sessions/adhoc', 'POST');
            await new Promise((r) => setTimeout(r, 5));
            await api(`/api/workout/sessions/status?id=${s.session.id}`, 'PUT', { status: 'completed' });
            const b = await api('/api/bp', 'POST', { measured_at: '2026-10-01T07:30:00Z', systolic: 120, diastolic: 80, pulse: 66 });
            const w = await api('/api/weight', 'POST', { measured_at: '2026-10-01T07:30:00Z', weight: 80 });
            const sessionId = (await records.listRaw('workoutsession'))[0].recordId;
            await vi.waitFor(() => expect(dirty()).toEqual({ bp: {}, weight: {}, hr: {}, workout: { [sessionId]: expect.any(Number) } }));
            expect(calls().map((c) => c.type).sort()).toEqual(['bp', 'hr', 'weight']);
            expect(health.write).toHaveBeenCalledWith(expect.objectContaining({ type: 'weight', id: w.id }));
            expect(health.write).toHaveBeenCalledWith(expect.objectContaining({ type: 'hr', id: `${b.id}/pulse` }));

            health.writeAccess.mockResolvedValue({ granted: ALL, supported: ALL });
            foreground();
            await idle();
            expect(health.write).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'workout', id: sessionId, activity: 3000 }));
            expect(writeDesc()).toBeNull();
        });

        it('on a shell that cannot write workouts (no `supported`, or a .7/.8 shell) no workout line shows', async () => {
            health.writeAccess = vi.fn(async () => ({ granted: ['bp', 'weight'] }));
            await start();
            await flip(writeToggle(), true);
            expect(writeDesc()).toBeNull();
            health.writeAccess.mockResolvedValue({ granted: HR, supported: HR });
            foreground();
            await new Promise((r) => setTimeout(r, 10));
            expect(writeDesc()).toBeNull();
        });

        // Miles 15063, Iris 15065: access removed later pauses, never turns it off.
        it('access removed later: stays on, reads paused, and resumes when access returns (HW5)', async () => {
            await start();
            await flip(writeToggle(), true);
            expect(writeToggle().checked).toBe(true);

            health.writeAccess.mockResolvedValue({ granted: [] });
            foreground();
            await vi.waitFor(() => expect(writeDesc()).toBe('Writing paused: access was removed. Allow it in Health Connect → App permissions.'));
            expect(writeToggle().checked).toBe(true);
            expect(storage.getItem('wg.health.write')).toBe('true');
            const b = await api('/api/bp', 'POST', { measured_at: '2026-10-01T07:30:00Z', systolic: 120, diastolic: 80 });
            await new Promise((r) => setTimeout(r, 10));
            expect(health.write).not.toHaveBeenCalled();
            expect(Object.keys(dirty().bp)).toEqual([b.id]);

            health.writeAccess.mockResolvedValue({ granted: ALL });
            foreground();
            await idle();
            expect(health.write).toHaveBeenCalledWith(expect.objectContaining({ type: 'bp', id: b.id }));
            expect(writeDesc()).toBeNull();
            expect(writeToggle().checked).toBe(true);
        });

        // Breakage review of 29319f450: a failed call is not a refusal.
        it('a failing sheet or access read at turn-on toasts the error and stays off, no HW3 line', async () => {
            allowConsoleNoise();
            let sheetFails = true;
            const requestAuthorization = vi.fn(async (kinds, opts) => { if (opts && sheetFails) throw new Error('bridge gone'); return true; });
            await start({ ...health, requestAuthorization });
            await flip(writeToggle(), true);
            expect(toast).toHaveBeenCalledWith("Couldn't reach Health Connect — try again.", 'error');
            expect(writeToggle().checked).toBe(false);
            expect(storage.getItem('wg.health.write')).toBe('false');
            expect(writeDesc()).toBeNull();
            expect(health.writeAccess).not.toHaveBeenCalled();

            sheetFails = false;
            for (const reply of [() => Promise.reject(new Error('timeout')), async () => ({ granted: 'bp' }), async () => null]) {
                toast.mockClear();
                health.writeAccess.mockImplementation(reply);
                await flip(writeToggle(), true);
                expect(toast).toHaveBeenCalledWith("Couldn't reach Health Connect — try again.", 'error');
                expect(writeToggle().checked).toBe(false);
                expect(storage.getItem('wg.health.write')).toBe('false');
                expect(writeDesc()).toBeNull();
            }
        });

        it('a malformed access reply on a pass changes nothing', async () => {
            health.writeAccess = vi.fn(async () => ({ granted: ['weight'] }));
            await start();
            await flip(writeToggle(), true);
            const hw4 = writeDesc();
            for (const reply of [{ granted: undefined }, null, { granted: 'bp' }]) {
                health.writeAccess.mockResolvedValue(reply);
                foreground();
                await new Promise((r) => setTimeout(r, 10));
                expect(writeToggle().checked).toBe(true);
                expect(storage.getItem('wg.health.write')).toBe('true');
                expect(writeDesc()).toBe(hw4);
            }
        });

        it('import switched off (and on again) while the write sheet is open voids the opt-in', async () => {
            let answer;
            const requestAuthorization = vi.fn((kinds, opts) => (opts ? new Promise((r) => { answer = r; }) : Promise.resolve(true)));
            await start({ ...health, requestAuthorization });
            writeToggle().checked = true;
            writeToggle().dispatchEvent(new window.Event('change'));
            await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
            const importToggle = document.getElementById('health-import-toggle');
            await flip(importToggle, false);
            await flip(importToggle, true);
            answer(true);
            await vi.waitFor(() => expect(writeToggle().disabled).toBe(false));
            expect(storage.getItem('wg.health.write')).toBe('false');
            expect(writeToggle().checked).toBe(false);
            expect(health.writeAccess).not.toHaveBeenCalled();
        });

        it('turning the import off turns writing off and hides the row', async () => {
            storage.setItem('wg.health.write', 'true');
            await start();
            expect(writeToggle().checked).toBe(true);
            await flip(document.getElementById('health-import-toggle'), false);
            expect(storage.getItem('wg.health.write')).toBe('false');
            expect(writeRow()).toBeNull();
        });

        // bd med-8f4s.11, kit HW6-HW9b (screens-health-copy.html).
        describe('copy past entries', () => {
            const at = (iso) => Date.parse(iso);
            const tick = () => new Promise((r) => setTimeout(r, 5));
            const copyRow = () => document.getElementById('health-copy-row');
            const rowText = () => [copyRow().querySelector('.wg-setting__title').textContent, copyRow().querySelector('.wg-setting__desc')?.textContent ?? null];
            const job = () => JSON.parse(storage.getItem('wg.health.backfill'));
            const ANCHORS = JSON.stringify({ bp: 'hc1:keep', weight: 'hc1:w' });
            const OFFER = ['5 past entries from this app.', {
                title: 'Copy your past entries too?',
                hint: 'Readings that came from Health Connect stay as they are, and nothing is copied twice.',
                confirmLabel: 'Copy', cancelLabel: 'Not now',
            }];
            let confirm;
            let alert;
            // What other apps hold in Health, per kind; null = read denied
            // (Android: no samples and no anchor). Pages of two.
            let theirs;
            const query = vi.fn(async ({ type, anchor }) => {
                const all = theirs[type];
                if (all === null) return { samples: [], returned: 0, more: false };
                const from = anchor ? Number(anchor.slice(1)) : 0;
                const page = (all || []).slice(from, from + 2);
                return { samples: page, anchor: `p${from + page.length}`, returned: page.length, more: from + page.length < (all || []).length };
            });
            const open = async (h = health, opts = {}) => {
                await startHealthImport({}, {
                    health: { label: 'Health Connect', accessHint: 'Health Connect → App permissions', requestAuthorization: vi.fn(async () => true), query, ...h },
                    storage, doc: document, records, run: vi.fn(async () => null), toast, ask: confirm, tell: alert, copyGapMs: 0, ...opts,
                });
                await tick();
            };
            const tap = async () => {
                copyRow().click();
                await tick();
            };
            const finished = () => vi.waitFor(() => expect(rowText()[0]).toBe('Copied to Health Connect'));
            const bp = (recordId, iso, systolic, diastolic, extra = {}) => records.put('bp', { recordId, clientTs: 1, deleted: false, measured_at: iso, systolic, diastolic, ...extra });
            const session = (recordId, id, startIso, endIso, extra = {}) => records.put('workoutsession', {
                recordId, clientTs: 1, deleted: false, id, group_id: 7, variant_id: 9, status: 'completed', started_at: startIso, completed_at: endIso, ...extra,
            });
            const seed = async () => {
                await bp('bp-a', '2026-10-01T07:30:00.000Z', 128, 84, { pulse: 66 });
                await bp('bp-b', '2026-10-02T07:30:00.000Z', 120, 80); // Health holds it 10 min off
                await bp('bp-c', '2026-10-03T07:30:00.000Z', 130, 85); // same numbers 2 h off: not held
                await bp(`bp-hk-${U1}`, '2026-10-03T08:00:00.000Z', 125, 82, { source: 'apple_health', source_id: U1 });
                // Two genuine readings 5 min apart, one Health record: the nearer is held.
                await bp('bp-e', '2026-10-04T07:00:00.000Z', 140, 90, { pulse: 70 });
                await bp('bp-f', '2026-10-04T07:05:00.000Z', 140, 90);
                await records.put('weight', { recordId: 'w-1', clientTs: 1, deleted: false, measured_at: '2026-10-01T08:00:00.000Z', weight: 80 });
                await records.put('weight', { recordId: 'w-2', clientTs: 1, deleted: false, measured_at: '2026-10-01T09:00:00.000Z', weight: 80.1 });
                await session('session-p', 301, null, null, { status: 'pending', scheduled_time: '07:00' });
                await session('session-s1', 302, '2026-10-05T08:00:00.000Z', '2026-10-05T09:00:00.000Z');
                await session('session-s2', 303, '2026-10-06T08:00:00.000Z', '2026-10-06T09:00:00.000Z');
                theirs = {
                    bp: [
                        bpSample(U2, at('2026-10-02T07:40:00Z'), 120, 80),
                        bpSample(U3, at('2026-10-03T09:30:00Z'), 130, 85),
                        bpSample(U1, at('2026-10-04T07:04:00Z'), 140, 90),
                    ],
                    weight: [kgSample(U2, at('2026-10-01T20:00:00Z'), 80)],
                    workout: [
                        // A strength workout overlapping the strength session: held.
                        { uuid: U2, start: at('2026-10-05T08:30:00Z'), end: at('2026-10-05T09:30:00Z'), activity: 50 },
                        // A run overlapping a strength session holds nothing.
                        { uuid: U3, start: at('2026-10-06T08:30:00Z'), end: at('2026-10-06T09:30:00Z'), activity: 37 },
                    ],
                };
            };
            // bp-c has no pulse: no hr call at all (bd med-8f4s.15 item 5).
            const COPIED = ['write bp bp-a', 'write hr bp-a/pulse', 'write bp bp-c', 'write bp bp-e', 'write hr bp-e/pulse', 'write weight w-2', 'write workout session-s2'];
            const sent = () => calls().map((c) => `${c.op} ${c.type} ${c.id}`);

            beforeEach(async () => {
                storage.setItem('wg.health.write', 'true');
                storage.setItem('wg.health.anchors', ANCHORS);
                health.writeAccess = vi.fn(async () => ({ granted: ALL, supported: ALL, readableFrom: 0 }));
                confirm = vi.fn(async () => true);
                alert = vi.fn(async () => {});
                query.mockClear();
                theirs = {};
                await seed();
            });

            it('(a) copies exactly the past entries Health lacks, one total, and never moves the import anchor', async () => {
                await open();
                expect(rowText()).toEqual(['Copy past entries', null]); // HW7: title only
                await tap();
                await vi.waitFor(() => expect(confirm).toHaveBeenCalledWith(...OFFER));
                await finished();
                expect(job()).toEqual({ startedAt: expect.any(Number), total: 5, blocked: {}, ids: { bp: ['bp-a', 'bp-c', 'bp-e'], weight: ['w-2'], workout: ['session-s2'] } });
                expect(sent().sort()).toEqual([...COPIED].sort());
                // One batched call for the pass (bd med-8f4s.15).
                expect(health.write).toHaveBeenCalledTimes(1);
                expect(health.write.mock.calls[0][0].entries).toHaveLength(COPIED.length);
                const version = async (type, id) => (await raw(type, id)).clientTs;
                expect(wrote()).toContainEqual({ type: 'bp', id: 'bp-a', version: await version('bp', 'bp-a'), at: at('2026-10-01T07:30:00Z'), systolic: 128, diastolic: 84 });
                expect(wrote()).toContainEqual({ type: 'hr', id: 'bp-a/pulse', version: await version('bp', 'bp-a'), at: at('2026-10-01T07:30:00Z'), bpm: 66 });
                expect(wrote()).toContainEqual(expect.objectContaining({ type: 'workout', id: 'session-s2', version: await version('workoutsession', 'session-s2'), activity: 50 }));
                expect(rowText()).toEqual(['Copied to Health Connect', '5 entries.']);
                // The dedupe read: no import anchor in, none saved; one read loop per kind.
                expect(query.mock.calls.every(([q]) => q.anchor === undefined || /^p\d+$/.test(q.anchor))).toBe(true);
                expect(query.mock.calls.filter(([q]) => q.type === 'bp')).toHaveLength(2);
                expect(storage.getItem('wg.health.anchors')).toBe(ANCHORS);
                expect(storage.getItem('wg.health.last')).toBeNull();
            });

            it('(b)(h) after a copy nothing is offered again; a later edit sends a higher version; a row synced in later is offered alone', async () => {
                await open();
                await tap();
                await finished();
                const first = calls();
                // One entry per delivered entry id, at the version sent.
                const v1 = async (type, id) => (await raw(type, id)).clientTs;
                expect(JSON.parse(storage.getItem('wg.health.copied'))).toEqual({
                    bp: { 'bp-a': await v1('bp', 'bp-a'), 'bp-c': await v1('bp', 'bp-c'), 'bp-e': await v1('bp', 'bp-e') },
                    weight: { 'w-2': await v1('weight', 'w-2') },
                    workout: { 'session-s2': await v1('workoutsession', 'session-s2') },
                });
                // Leaving Settings ends the result: the row is the action again.
                const view = document.getElementById('settings-view');
                view.classList.add('active');
                await tick();
                view.classList.remove('active');
                await tick();
                expect(rowText()).toEqual(['Copy past entries', null]);
                expect(storage.getItem('wg.health.backfill')).toBe('null');

                // The shells hide our own records from the read, yet nothing is offered again.
                health.write.mockClear();
                health.remove.mockClear();
                await tap();
                await vi.waitFor(() => expect(alert).toHaveBeenCalledWith('Everything is already in Health Connect.', { title: 'Copy past entries' }));
                expect(confirm).toHaveBeenCalledTimes(1);
                expect(calls()).toEqual([]);
                expect(storage.getItem('wg.health.backfill')).toBe('null');

                await api('/api/bp/bp-a', 'PUT', { systolic: 129 });
                await idle();
                const v = (await raw('bp', 'bp-a')).clientTs;
                expect(v).toBeGreaterThan(first.find((c) => c.id === 'bp-a').version);
                expect(health.write).toHaveBeenCalledWith(expect.objectContaining({ type: 'bp', id: 'bp-a', version: v, systolic: 129 }));

                // A weight synced in from another device (unmarked: put with the switch off).
                storage.setItem('wg.health.write', 'false');
                await records.put('weight', { recordId: 'w-3', clientTs: 1, deleted: false, measured_at: '2026-10-07T08:00:00.000Z', weight: 79 });
                storage.setItem('wg.health.write', 'true');
                health.write.mockClear();
                await tap();
                await vi.waitFor(() => expect(confirm).toHaveBeenCalledWith('1 past entry from this app.', expect.any(Object)));
                await finished();
                expect(sent()).toEqual(['write weight w-3']);
            });

            it('(c) every call failing pauses the copy (HW8b, no meter); a foreground return resumes and completes it', async () => {
                allowConsoleNoise();
                health.write = vi.fn(async () => { throw new Error('busy'); });
                health.remove = vi.fn(async () => { throw new Error('busy'); });
                await open();
                await tap();
                await vi.waitFor(() => expect(rowText()[0]).toBe('Copy paused'));
                expect(rowText()[1]).toBe('Health Connect is busy. 0 of 5 so far; it continues when the app is open.');
                expect(copyRow().querySelector('progress')).toBeNull();

                health.write.mockImplementation(answer());
                health.remove.mockImplementation(async () => true);
                foreground();
                await finished();
                expect(rowText()).toEqual(['Copied to Health Connect', '5 entries.']);
                expect(sent().filter((s) => COPIED.includes(s)).length).toBeGreaterThanOrEqual(COPIED.length);
            });

            it('(c) Health Connect\'s rate limit pauses the copy (HW8b) even when a few calls get through; no hammering, not a step to stuck', async () => {
                allowConsoleNoise();
                // Two passes' worth: the first batch gets through, the second hits the quota.
                for (let i = 0; i < 60; i++) await bp(`bp-n${i}`, new Date(at('2026-09-01T07:00:00Z') + i * 3600e3).toISOString(), 110, 70);
                let allowance = 1;
                const quota = async () => {
                    if (allowance <= 0) throw new Error('android.health.connect.HealthConnectException: API call quota exceeded, availableQuota: 0.62 requested: 1');
                    allowance--;
                    return true;
                };
                // The quota is per call: a refused batch throws as a whole.
                health.write = vi.fn(async (a) => { await quota(); return answer()(a); });
                health.remove = vi.fn(quota);
                await open();
                await tap();
                await vi.waitFor(() => expect(rowText()[0]).toBe('Copy paused'));
                expect(rowText()[1]).toMatch(/^Health Connect is busy\. [1-9]\d* of 65 so far; it continues when the app is open\.$/);
                expect(job().fails || 0).toBe(0);
                expect(health.write).toHaveBeenCalledTimes(2);
                // Paused for the minute-scale back-off: no further calls meanwhile.
                const n = health.write.mock.calls.length + health.remove.mock.calls.length;
                await new Promise((r) => setTimeout(r, 100));
                expect(health.write.mock.calls.length + health.remove.mock.calls.length).toBe(n);

                allowance = 100;
                foreground();
                await finished();
                expect(rowText()).toEqual(['Copied to Health Connect', '65 entries.']);
            });

            it('(c) a pass where every call hits the rate limit is no step to stuck (Argus 16138 #1)', async () => {
                allowConsoleNoise();
                const quota = async () => { throw new Error('API call quota exceeded, availableQuota: 0'); };
                storage.setItem('wg.health.dirty', JSON.stringify({ bp: { 'bp-c': 1 } }));
                storage.setItem('wg.health.backfill', JSON.stringify({ startedAt: 1, total: 1, ids: { bp: ['bp-c'] }, blocked: {}, fails: 5 }));
                await open({ ...health, write: vi.fn(quota), remove: vi.fn(quota) });
                await vi.waitFor(() => expect(rowText()[0]).toBe('Copy paused'));
                expect(job().fails).toBe(5);
                const view = document.getElementById('settings-view');
                view.classList.add('active');
                view.classList.remove('active');
                await tick();
                expect(job().ids).toEqual({ bp: ['bp-c'] });
            });

            it('(g)(i) blocked ids rejoin only under the current window; a saved job of only blocked ids closes at launch, unread (Argus 16138 #2, bd med-8f4s.17)', async () => {
                const saved = JSON.stringify({ startedAt: 1, total: 2, ids: {}, blocked: { weight: ['w-1', 'w-2'] } });
                // A shell without readableFrom: no row, no read, nothing marked or written.
                storage.setItem('wg.health.backfill', saved);
                health.writeAccess = vi.fn(async () => ({ granted: ALL, supported: ALL }));
                await open();
                foreground();
                await tick();
                expect(copyRow()).toBeNull();
                expect(query).not.toHaveBeenCalled();
                expect(dirty().weight).toBeUndefined();
                expect(storage.getItem('wg.health.backfill')).toBe('null');

                // A window moved to 01.10 12:00 after the Copy: w-1 (08:00) and w-2 (09:00) are older, dropped unsent.
                document.body.innerHTML = home;
                health.writeAccess = vi.fn(async () => ({ granted: ALL, supported: ALL, readableFrom: 0 }));
                theirs.weight = null;
                await open();
                await tap();
                await finished();
                expect(job().blocked).toEqual({ weight: ['w-1', 'w-2'] });
                health.writeAccess.mockResolvedValue({ granted: ALL, supported: ALL, readableFrom: at('2026-10-01T12:00:00Z') });
                theirs.weight = [];
                foreground();
                await vi.waitFor(() => expect(job()).toMatchObject({ total: 4, ids: { weight: [] }, blocked: {} }));
                await finished();
                expect(health.write).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'weight' }));
            });

            it('(c) a relaunch mid-copy resumes from the ledger and the job', async () => {
                allowConsoleNoise();
                health.write = vi.fn(async () => { throw new Error('busy'); });
                health.remove = vi.fn(async () => { throw new Error('busy'); });
                await open();
                await tap();
                await vi.waitFor(() => expect(rowText()[0]).toBe('Copy paused'));

                // The page dies; a new one over the same storage and vault.
                document.body.innerHTML = home;
                const next = { ...health, write: shellWrite(), remove: vi.fn(async () => true) };
                await open(next);
                await finished();
                expect(rowText()).toEqual(['Copied to Health Connect', '5 entries.']);
                expect(next.write.mock.calls.flatMap(([a]) => a.entries || [a]).map((a) => a.id).sort()).toEqual(['bp-a', 'bp-a/pulse', 'bp-c', 'bp-e', 'bp-e/pulse', 'session-s2', 'w-2']);
                expect(confirm).toHaveBeenCalledTimes(1);
            });

            it('(c) 120 entries go out as ceil(ids/50) batched calls, the copied map written once per pass (bd med-8f4s.15 (a))', async () => {
                // 60 bp with pulse + 60 weights, plus the seed's 5 entries and 2 pulses: 187 ids.
                for (let i = 0; i < 60; i++) {
                    const iso = new Date(at('2026-09-01T07:00:00Z') + i * 3600e3).toISOString();
                    await bp(`bp-n${i}`, iso, 110, 70, { pulse: 60 + (i % 20) });
                    await records.put('weight', { recordId: `w-n${i}`, clientTs: 1, deleted: false, measured_at: iso, weight: 60 + i / 10 });
                }
                const setItem = storage.setItem.bind(storage);
                let copiedWrites = 0;
                storage.setItem = (k, v) => {
                    if (k === 'wg.health.copied') copiedWrites++;
                    return setItem(k, v);
                };
                await open();
                await tap();
                await finished();
                expect(rowText()).toEqual(['Copied to Health Connect', '125 entries.']);
                expect(health.write).toHaveBeenCalledTimes(Math.ceil(187 / 50));
                expect(health.write.mock.calls.every(([a]) => Array.isArray(a.entries) && a.entries.length <= 50)).toBe(true);
                expect(health.remove).not.toHaveBeenCalled();
                expect(copiedWrites).toBe(health.write.mock.calls.length);
                expect(ledgerSize()).toBe(0);
                const copied = JSON.parse(storage.getItem('wg.health.copied'));
                expect(Object.values(copied).reduce((n, m) => n + Object.keys(m).length, 0)).toBe(125);
            });

            it('(c) one entry the store rejects in a batch reply: the rest clear, it leaves the job and is named (bd med-8f4s.15 (b), item 6)', async () => {
                allowConsoleNoise();
                health.write = shellWrite(async (a) => (a.id === 'bp-c' ? 'bad write: systolic' : true));
                await open();
                await tap();
                await finished();
                expect(health.write).toHaveBeenCalledTimes(1);
                expect(rowText()).toEqual(['Copied to Health Connect', "4 entries. 1 entry couldn't be copied. It's still in the app."]);
                expect(job()).toMatchObject({ dropped: { bp: ['bp-c'] }, ids: { bp: ['bp-a', 'bp-e'] } });
                expect(ledgerSize()).toBe(0);
                expect(JSON.parse(storage.getItem('wg.health.copied')).bp).not.toHaveProperty('bp-c');
            });

            it('(c) a failed wg.health.copied write after a batch keeps its ids queued and resends them: no lost markers (breakage review 1588 #1)', async () => {
                allowConsoleNoise();
                const set = storage.setItem;
                let failOnce = true;
                storage.setItem = (k, v) => {
                    if (k === 'wg.health.copied' && failOnce) { failOnce = false; throw new Error('quota'); }
                    return set(k, v);
                };
                // The ledger as the second batch starts = what the first pass left queued.
                let queuedBeforeSecond = null;
                const batch = shellWrite(async () => true);
                health.write = vi.fn(async (a) => {
                    if (a.entries && health.write.mock.calls.filter(([x]) => x.entries).length === 2) {
                        queuedBeforeSecond = Object.entries(dirty()).flatMap(([k, m]) => Object.keys(m).map((id) => `${k}:${id}`)).sort();
                    }
                    return batch(a);
                });
                await open();
                await tap();
                await finished();
                const batches = health.write.mock.calls.filter(([a]) => a.entries).map(([a]) => a.entries.map((e) => `${e.type}:${e.id}`).sort());
                expect(batches).toHaveLength(2);
                const firstEntries = batches[0].filter((s) => !s.startsWith('hr:')); // pulses carry no copied marker
                expect(firstEntries.length).toBeGreaterThan(1);
                expect(queuedBeforeSecond).toEqual(firstEntries);
                expect(batches[1]).toEqual(firstEntries);
                expect(rowText()).toEqual(['Copied to Health Connect', '5 entries.']);
                expect(ledgerSize()).toBe(0);
                const copied = JSON.parse(storage.getItem('wg.health.copied'));
                expect(Object.values(copied).reduce((n, m) => n + Object.keys(m).length, 0)).toBe(5);
            });

            it('(c) two rejected entries read in the plural (Miles 17327)', async () => {
                allowConsoleNoise();
                health.write = shellWrite(async (a) => (a.id === 'bp-c' || a.id === 'bp-e' ? 'bad write: systolic' : true));
                await open();
                await tap();
                await finished();
                expect(rowText()).toEqual(['Copied to Health Connect', "3 entries. 2 entries couldn't be copied. They're still in the app."]);
            });

            it('(c) a drop the page died in the middle of (job written, ledger not) replays once, counted once (Argus 17242 #1)', async () => {
                allowConsoleNoise();
                storage.setItem('wg.health.dirty', JSON.stringify({ bp: { 'bp-c': 1 } }));
                storage.setItem('wg.health.backfill', JSON.stringify({ startedAt: 1, total: 1, ids: { bp: [] }, blocked: {}, dropped: { bp: ['bp-c'] } }));
                await open({ ...health, write: vi.fn(async () => { throw new Error('bad write: systolic'); }) });
                await vi.waitFor(() => expect(dirty().bp).toEqual({}));
                expect(job().dropped).toEqual({ bp: ['bp-c'] });
                await vi.waitFor(() => expect(rowText()).toEqual(['Copied to Health Connect', "0 entries. 1 entry couldn't be copied. It's still in the app."]));
            });

            it('(c) a reading and its pulse both rejected, in one batch or across passes: neither stays queued, one entry named (Argus 17229 #1)', async () => {
                allowConsoleNoise();
                health.write = shellWrite(async (a) => (a.id === 'bp-a' ? 'bad write: systolic' : a.id === 'bp-a/pulse' ? 'invalid heart rate' : true));
                await open();
                await tap();
                await finished();
                expect(rowText()).toEqual(['Copied to Health Connect', "4 entries. 1 entry couldn't be copied. It's still in the app."]);
                expect(ledgerSize()).toBe(0);
                expect(job().dropped).toEqual({ bp: ['bp-a'] });

                // Across passes: the pulse is held ("denied") while its reading is dropped, then rejected alone.
                // The next Copy offers bp-a again (never written, nothing queued).
                await leaveSettings();
                let held = false;
                health.write.mockImplementation(answer(async (a) => {
                    if (a.id === 'bp-a') return 'bad write: systolic';
                    if (a.id === 'bp-a/pulse') {
                        if (!held) {
                            held = true;
                            return 'denied';
                        }
                        return 'invalid heart rate';
                    }
                    return true;
                }));
                await tap();
                await finished();
                await vi.waitFor(() => expect(ledgerSize()).toBe(0));
                expect(held).toBe(true);
                expect(job().dropped).toEqual({ bp: ['bp-a'] });
                expect(rowText()).toEqual(['Copied to Health Connect', "0 entries. 1 entry couldn't be copied. It's still in the app."]);
            });

            it('(c) a row read failing while a batch is prepared sends that id per id; the rest go in the batch (Argus 17229 #2)', async () => {
                allowConsoleNoise();
                let breakReads = 0;
                const flaky = { ...records, listRaw: async (t) => {
                    if (t === 'workoutsession' && breakReads > 0) {
                        breakReads--;
                        throw new Error('idb busy');
                    }
                    return records.listRaw(t);
                } };
                confirm.mockImplementation(async () => { breakReads = 1; return true; });
                await open(health, { records: flaky });
                await tap();
                await finished();
                expect(rowText()).toEqual(['Copied to Health Connect', '5 entries.']);
                expect(health.write.mock.calls[0][0].entries.map((a) => a.id)).not.toContain('session-s2');
                expect(health.write).toHaveBeenCalledWith(expect.objectContaining({ type: 'workout', id: 'session-s2' }));
                expect(ledgerSize()).toBe(0);
            });

            it('(c) an entry answered "denied" (Android) is kept, moved back and its kind held until the next access read', async () => {
                allowConsoleNoise();
                let refuse = true;
                health.write = shellWrite(async (a) => (a.type === 'weight' && refuse ? 'denied' : true));
                await open();
                await tap();
                // The batch delivers the rest; the next pass sends w-2 alone (single form), refused again.
                await vi.waitFor(() => expect(rowText()[0]).toBe('Copy paused'));
                expect(health.write.mock.calls.map(([a]) => (a.entries ? a.entries.length : a.id))).toEqual([7, 'w-2']);
                expect(Object.keys(dirty().weight)).toEqual(['w-2']);
                expect(job().dropped).toBeUndefined();
                refuse = false;
                foreground();
                await vi.waitFor(() => expect(rowText()).toEqual(['Copied to Health Connect', '5 entries.']));
                expect(ledgerSize()).toBe(0);
            });

            it('(c) a thrown single write the store always rejects drops the Copy id; a live id keeps the retry rule', async () => {
                allowConsoleNoise();
                // One entry left: the single form (and an old-shell pass) takes the same rule.
                storage.setItem('wg.health.dirty', JSON.stringify({ bp: { 'bp-c': 1 } }));
                storage.setItem('wg.health.backfill', JSON.stringify({ startedAt: 1, total: 1, ids: { bp: ['bp-c'] }, blocked: {} }));
                const write = vi.fn(async () => { throw new Error('invalid blood pressure'); });
                await open({ ...health, write });
                await vi.waitFor(() => expect(rowText()).toEqual(['Copied to Health Connect', "0 entries. 1 entry couldn't be copied. It's still in the app."]));
                expect(write.mock.calls.map(([a]) => a.entries)).toEqual([undefined]);
                expect(dirty().bp).toEqual({});
                expect(job()).toMatchObject({ dropped: { bp: ['bp-c'] }, ids: { bp: [] } });
                // An edit outside the Copy, rejected the same way, stays queued.
                await api('/api/bp/bp-f', 'PUT', { systolic: 141 });
                await vi.waitFor(() => expect(write).toHaveBeenCalledWith(expect.objectContaining({ id: 'bp-f', systolic: 141 })));
                await tick();
                expect(Object.keys(dirty().bp)).toEqual(['bp-f']);
            });

            it('(c) a whole-call failure the store repeats: once the back-off fails again at its cap, across relaunches, leaving Settings frees Copy and keeps it queued', async () => {
                allowConsoleNoise();
                // A batch carrying bp-c fails as a whole, every time.
                const rejectC = answer(async (a) => { if (a.id === 'bp-c') throw new Error('busy'); return true; });
                health.write = vi.fn(rejectC);
                // Slow enough on the first page to stop it at 2 or 3 failed passes.
                await open(health, { copyBackoffMs: 60 });
                await tap();
                await vi.waitFor(() => expect(rowText()).toEqual(['Copy paused', 'Health Connect is busy. 0 of 5 so far; it continues when the app is open.']));
                await vi.waitFor(() => expect(job().fails).toBeGreaterThanOrEqual(2), { interval: 5 });
                expect(job().fails).toBeLessThan(6);
                // A relaunch keeps the count (Argus 16051): it goes on, never back to 1.
                // The old page dies: its writer never answers again.
                health.write.mockImplementation(() => new Promise(() => {}));
                const before = job().fails;
                document.body.innerHTML = home;
                const next = { ...health, write: vi.fn(rejectC) };
                await open(next, { copyBackoffMs: 1 });
                await vi.waitFor(() => expect(next.write.mock.calls.flatMap(([a]) => a.entries || [a])).toContainEqual(expect.objectContaining({ id: 'bp-c' })));
                await vi.waitFor(() => expect(job().fails).toBeGreaterThan(before));
                // 1, 2, 4, 8, 15, then a failure at the cap.
                await vi.waitFor(() => expect(job().fails).toBeGreaterThanOrEqual(6));
                const view = document.getElementById('settings-view');
                view.classList.add('active');
                view.classList.remove('active');
                await tick();
                expect(rowText()).toEqual(['Copy past entries', null]);
                expect(storage.getItem('wg.health.backfill')).toBe('null');
                expect(Object.keys(dirty().bp).sort()).toEqual(['bp-a', 'bp-c', 'bp-e']);
            });

            it('(c) a pulse that failed once is retried while the row already shows the result', async () => {
                allowConsoleNoise();
                let failed = false;
                // Refused once ("denied": held to the next access read), then taken.
                health.write = shellWrite(async (a) => {
                    if (a.id === 'bp-a/pulse' && !failed) {
                        failed = true;
                        return 'denied';
                    }
                    return true;
                });
                await open();
                await tap();
                await finished();
                await vi.waitFor(() => expect(dirty().hr || {}).toEqual({}));
                expect(wrote().filter((a) => a.id === 'bp-a/pulse')).toHaveLength(2);
                expect(rowText()).toEqual(['Copied to Health Connect', '5 entries.']);
            });

            it('(d) a dedupe read that does not finish fails the count rather than copy from part of it', async () => {
                allowConsoleNoise();
                // 1,000 pages of other readings, the match for bp-c after them.
                theirs.bp = [...Array.from({ length: 2000 }, (_, i) => bpSample(U3, at('2026-09-01T00:00:00Z') + i * 6e4, 99, 59)), bpSample(U1, at('2026-10-03T07:35:00Z'), 130, 85)];
                await open();
                await tap();
                await vi.waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't reach Health Connect — try again.", 'error'));
                expect(confirm).not.toHaveBeenCalled();
                expect(storage.getItem('wg.health.backfill')).toBeNull();
                expect(ledgerSize()).toBe(0);
            });

            it('(d) pulse refused: readings copy, their pulses wait, and the write row names pulse (HW4)', async () => {
                health.writeAccess = vi.fn(async () => ({ granted: ['bp', 'weight', 'workout'], supported: ALL, readableFrom: 0 }));
                await open();
                await tap();
                await finished();
                expect(rowText()).toEqual(['Copied to Health Connect', '5 entries.']);
                expect(Object.keys(dirty().hr).sort()).toEqual(['bp-a', 'bp-e']); // bp-c has no pulse
                expect(writeDesc()).toBe("Writing blood pressure, weight and workouts only. Pulse (heart rate) isn't allowed: allow it in Health Connect → App permissions.");
            });

            it('(d) weight write refused: HW9b names it and the waiting one follows once allowed', async () => {
                health.writeAccess = vi.fn(async () => ({ granted: ['bp', 'hr', 'workout'], supported: ALL, readableFrom: 0 }));
                await open();
                await tap();
                await finished();
                expect(rowText()).toEqual(['Copied to Health Connect', "4 entries. Weight isn't allowed: allow it in Health Connect settings, then tap Copy past entries again."]);
                health.writeAccess.mockResolvedValue({ granted: ALL, supported: ALL, readableFrom: 0 });
                foreground();
                await vi.waitFor(() => expect(rowText()).toEqual(['Copied to Health Connect', '5 entries.']));
                expect(health.write).toHaveBeenCalledWith(expect.objectContaining({ type: 'weight', id: 'w-2' }));
            });

            const leaveSettings = async () => {
                const view = document.getElementById('settings-view');
                view.classList.add('active');
                view.classList.remove('active');
                await tick();
            };
            const DENIED = "4 entries. Weight isn't allowed: allow it in Health Connect settings, then tap Copy past entries again.";

            it('(d) weight read denied (Android): HW9b names it; leaving Settings closes the job, and the next Copy counts the weights (bd med-8f4s.17)', async () => {
                theirs.weight = null;
                await open();
                await tap();
                await vi.waitFor(() => expect(confirm).toHaveBeenCalledWith('6 past entries from this app.', expect.any(Object)));
                await finished();
                expect(rowText()).toEqual(['Copied to Health Connect', DENIED]);
                expect(dirty().weight).toBeUndefined();
                await leaveSettings();
                expect(rowText()).toEqual(['Copy past entries', null]);
                expect(storage.getItem('wg.health.backfill')).toBe('null');
                // (c) the closed job reads the denied kind no more.
                query.mockClear();
                foreground();
                await tick();
                expect(query).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'weight' }));
                // The next tap recounts the weights: unmarked, nothing was lost.
                theirs.weight = [kgSample(U2, at('2026-10-01T20:00:00Z'), 80)];
                await tap();
                await vi.waitFor(() => expect(confirm).toHaveBeenLastCalledWith('1 past entry from this app.', expect.any(Object)));
                await finished();
                expect(health.write).toHaveBeenCalledWith(expect.objectContaining({ type: 'weight', id: 'w-2' }));
                expect(health.write).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'w-1' }));
            });

            it('(d) weight read denied (Android): granted while still in Settings, its entries join', async () => {
                theirs.weight = null;
                await open();
                await tap();
                await finished();
                expect(rowText()).toEqual(['Copied to Health Connect', DENIED]);
                expect(job().blocked).toEqual({ weight: ['w-1', 'w-2'] });

                // A weight that arrives after the Copy unmarked (synced in; here
                // put with the switch off) is not part of it (Argus 16042 #1).
                storage.setItem('wg.health.write', 'false');
                await records.put('weight', { recordId: 'w-3', clientTs: 1, deleted: false, measured_at: '2026-10-07T08:00:00.000Z', weight: 79 });
                storage.setItem('wg.health.write', 'true');
                await tick();
                expect(dirty().weight).toBeUndefined();
                theirs.weight = [kgSample(U2, at('2026-10-01T20:00:00Z'), 80)];
                foreground();
                await vi.waitFor(() => expect(rowText()).toEqual(['Copied to Health Connect', '5 entries.']));
                expect(job().total).toBe(5);
                expect(health.write).toHaveBeenCalledWith(expect.objectContaining({ type: 'weight', id: 'w-2' }));
                expect(health.write).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'w-1' }));
                expect(health.write).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'w-3' }));
                expect(storage.getItem('wg.health.anchors')).toBe(ANCHORS);
            });

            it('(d) a read that throws toasts the error: no dialog, no job, nothing marked', async () => {
                allowConsoleNoise();
                const failing = vi.fn(async () => { throw new Error('store busy'); });
                await open({ ...health, query: failing });
                await tap();
                await vi.waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't reach Health Connect — try again.", 'error'));
                expect(confirm).not.toHaveBeenCalled();
                expect(storage.getItem('wg.health.backfill')).toBeNull();
                expect(ledgerSize()).toBe(0);
                expect(rowText()).toEqual(['Copy past entries', null]);
            });

            it('(e) the offer shows once after a granting switch-on, with one total; Not now marks nothing', async () => {
                storage.setItem('wg.health.write', 'false');
                confirm.mockResolvedValue(false);
                await open();
                expect(copyRow()).toBeNull(); // only while writing is on
                await flip(writeToggle(), true);
                await vi.waitFor(() => expect(confirm).toHaveBeenCalledWith(...OFFER));
                await tick();
                expect(storage.getItem('wg.health.backfill')).toBeNull();
                expect(ledgerSize()).toBe(0);
                expect(rowText()).toEqual(['Copy past entries', null]);

                await flip(writeToggle(), false);
                expect(copyRow()).toBeNull();
                await flip(writeToggle(), true);
                await tick();
                expect(confirm).toHaveBeenCalledTimes(1);
            });

            it('(e) no offer when nothing is left to copy, nor on a shell that cannot write; an older shell counts no workouts', async () => {
                theirs.bp = [];
                // Stored on, but the shell has no health.write: no row.
                await open({ ...health, canWrite: async () => false });
                expect(copyRow()).toBeNull();

                // Older shell (no `supported`): bp and weight only.
                storage.setItem('wg.health.write', 'false');
                document.body.innerHTML = home;
                health.writeAccess = vi.fn(async () => ({ granted: ['bp', 'weight'], readableFrom: 0 }));
                await open();
                await flip(writeToggle(), true);
                await vi.waitFor(() => expect(confirm).toHaveBeenCalledWith('6 past entries from this app.', expect.any(Object)));
                await finished();
                expect(job().ids.workout).toBeUndefined();

                // Nothing left: no offer, and it is not used up.
                storage.setItem('wg.health.backfillOffered', 'false');
                confirm.mockClear();
                document.body.innerHTML = home;
                await records.put('bp', { recordId: 'bp-hk-x', clientTs: 1, deleted: false, measured_at: '2026-10-01T07:30:00.000Z', systolic: 1, diastolic: 1, source: 'apple_health' });
                for (const id of ['bp-a', 'bp-b', 'bp-c', 'bp-e', 'bp-f']) await records.del('bp', id);
                for (const id of ['w-1', 'w-2']) await records.del('weight', id);
                storage.setItem('wg.health.write', 'false');
                storage.setItem('wg.health.backfill', 'null');
                await open();
                await flip(writeToggle(), true);
                await tick();
                expect(confirm).not.toHaveBeenCalled();
                expect(storage.getItem('wg.health.backfillOffered')).toBe('false');
            });

            it('(i) a shell whose writeAccess carries no readableFrom gets no Copy: no row, no offer, no read', async () => {
                health.writeAccess = vi.fn(async () => ({ granted: ALL, supported: ALL }));
                storage.setItem('wg.health.write', 'false');
                await open();
                await flip(writeToggle(), true);
                await tick();
                expect(copyRow()).toBeNull();
                expect(confirm).not.toHaveBeenCalled();
                expect(query).not.toHaveBeenCalled();
            });

            it('(g) rows older than readableFrom are cut and named; "Allow past data" asks again and reopens with fresh counts', async () => {
                const requestAuthorization = vi.fn(async () => true);
                health.writeAccess = vi.fn(async () => ({ granted: ALL, supported: ALL, readableFrom: at('2026-10-02T12:00:00Z') }));
                confirm.mockImplementationOnce(async (msg, opts) => {
                    opts.link.onClick();
                    return false;
                });
                await open({ ...health, requestAuthorization });
                const before = requestAuthorization.mock.calls.length;
                await tap();
                await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
                // bp-a, bp-b, w-1 and w-2 are older than the window: cut before the dedupe, so counted as cut.
                const cutDialog = ['3 past entries from this app.', {
                    ...OFFER[1],
                    caution: "4 entries before 02.10 won't be copied: Health Connect needs access to past data to check them.",
                    link: { label: 'Allow past data', below: true, onClick: expect.any(Function) },
                }];
                expect(confirm.mock.calls[0]).toEqual(cutDialog);
                // One read sheet (no write kinds): the history permission sits with read.
                expect(requestAuthorization.mock.calls.slice(before)).toEqual([[expect.any(Array)]]);
                // Still denied: the same dialog again.
                expect(confirm.mock.calls[1]).toEqual(cutDialog);
                await finished();
                expect(job().ids).toEqual({ bp: ['bp-c', 'bp-e'], workout: ['session-s2'] });

                // Granted later (readableFrom 0): the older rows are offered, no cut line.
                const view = document.getElementById('settings-view');
                view.classList.add('active');
                view.classList.remove('active');
                await tick();
                health.writeAccess.mockResolvedValue({ granted: ALL, supported: ALL, readableFrom: 0 });
                confirm.mockClear();
                await tap();
                await vi.waitFor(() => expect(confirm).toHaveBeenCalledWith('2 past entries from this app.', OFFER[1]));
            });

            it('(g) an entry is eligible only when its whole dedupe lookback is readable: bp 30 min, weight 1 day, workout span − 1 day (bd med-8f4s.19)', async () => {
                const T = at('2026-10-10T12:00:00Z');
                const iso = (ms) => new Date(ms).toISOString();
                const min = 60e3;
                await bp('bp-in10', iso(T + 10 * min), 101, 61);
                await bp('bp-in31', iso(T + 31 * min), 102, 62);
                await records.put('weight', { recordId: 'w-in23h', clientTs: 1, deleted: false, measured_at: iso(T + 23 * 60 * min), weight: 71 });
                await records.put('weight', { recordId: 'w-in25h', clientTs: 1, deleted: false, measured_at: iso(T + 25 * 60 * min), weight: 72 });
                await session('session-in23h', 401, iso(T + 23 * 60 * min), iso(T + 24 * 60 * min));
                await session('session-in25h', 402, iso(T + 25 * 60 * min), iso(T + 26 * 60 * min));
                health.writeAccess = vi.fn(async () => ({ granted: ALL, supported: ALL, readableFrom: T }));
                confirm.mockResolvedValueOnce(false);
                await open();
                await tap();
                await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
                // Planned: the three "after" rows; the seed (all before T) and the three "inside" rows are cut.
                expect(confirm.mock.calls[0][0]).toBe('3 past entries from this app.');
                expect(confirm.mock.calls[0][1].caution).toMatch(/^12 entries before 10\.10 won't be copied/);
                // The dedupe reads start at the earliest planned lookback, never before T.
                expect(query.mock.calls.every(([q]) => q.from >= T)).toBe(true);

                // readableFrom 0: every row planned, no cut line.
                health.writeAccess.mockResolvedValue({ granted: ALL, supported: ALL, readableFrom: 0 });
                await tap();
                await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
                expect(confirm.mock.calls[1][0]).toBe('11 past entries from this app.');
                expect(confirm.mock.calls[1][1]).not.toHaveProperty('caution');
            });

            it('(g) the cut line is one warn note, "won\'t be copied": singular "check it" in the offer, plural in the nothing-in-window alert', async () => {
                // Only w-1's day-long lookback (from 30.09 08:00) starts before it.
                health.writeAccess = vi.fn(async () => ({ granted: ALL, supported: ALL, readableFrom: at('2026-09-30T08:30:00Z') }));
                confirm.mockResolvedValueOnce(false);
                await open();
                await tap();
                await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
                expect(confirm.mock.calls[0][1].caution).toBe("1 entry before 30.09 won't be copied: Health Connect needs access to past data to check it.");
                expect(confirm.mock.calls[0][1]).not.toHaveProperty('facts');

                health.writeAccess.mockResolvedValue({ granted: ALL, supported: ALL, readableFrom: at('2026-10-07T00:00:00Z') });
                await tap();
                await vi.waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
                expect(alert.mock.calls[0][0]).toBe('');
                expect(alert.mock.calls[0][1].caution).toMatch(/^\d+ entries before 07\.10 won't be copied: Health Connect needs access to past data to check them\.$/);
            });

            it('(e) while a copy runs the row is the progress line with a meter (HW8)', async () => {
                health.write = vi.fn(() => new Promise(() => {}));
                await open();
                await tap();
                await vi.waitFor(() => expect(rowText()).toEqual(['Copying past entries…', '0 of 5']));
                const meter = copyRow().querySelector('progress.wg-meter');
                expect([meter.value, meter.max]).toEqual([0, 5]);
                expect(copyRow().tagName).toBe('DIV');
            });
        });
    });
});
