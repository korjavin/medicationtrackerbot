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
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../sync.js', () => ({
    recordsPort: vi.fn(),
    ORIGIN_EXTERNAL: 'external',
    flushConfirmed: vi.fn(async () => true),
}));

import { runHealthImport, startHealthImport, healthStatusText } from '../health-import.js';
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
            expect(desc()).toBe('Import blood pressure, weight, sleep and workouts');

            await flip(true);
            await new Promise((r) => setTimeout(r, 0));
            expect(health.requestAuthorization).toHaveBeenCalledWith(['bp', 'weight', 'sleep', 'workout']);
            expect(records.rows.has(`bp-hk-${U1}`)).toBe(true);
            expect(afterImport).toHaveBeenCalledTimes(1);
            expect(desc()).toMatch(/^Last imported .* · 1 reading so far$/);
            expect(healthStatusText(storage)).toBe(desc());

            // Off and on again is the manual rescan: it starts from no anchor.
            await flip(false);
            const before = health.calls.length;
            await flip(true);
            await new Promise((r) => setTimeout(r, 0));
            expect(health.calls.slice(before).map((c) => c.anchor)).toEqual([null, null, null, null]);
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

        it('a toggle switched on by an older build asks once for the new kinds', async () => {
            storage.setItem('wg.health.enabled', 'true');
            const health = fakeHealth({});
            await startHealthImport({}, { health, storage, doc: document, run: vi.fn(async () => null) });
            expect(health.requestAuthorization).toHaveBeenCalledWith(['bp', 'weight', 'sleep', 'workout']);
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

        it('a night already in the vault (Mi Band, manual) wins; a night clipped by the window waits', async () => {
            await records.put('sleep', {
                recordId: `sleep-${N0 + H}`, clientTs: 5, deleted: false,
                start_time: '2026-10-01T22:00:00Z', end_time: '2026-10-02T04:00:00Z', total_minutes: 360, day: '2026-10-02',
            });
            expect(await runHealthImport({}, opts({ sleep: night }))).toEqual({ added: 0 });
            const domain = createHealthImportDomain({ records: memRecords(), now: () => W0, timeZone: 'UTC' });
            expect(await domain.importSamples('sleep', night, { from: N0 - 30 * 60_000, to: N0 + 20 * H })).toEqual({ added: 0 });
            expect(await domain.importSamples('sleep', night, { from: N0 - 2 * H, to: N0 + 20 * H })).toEqual({ added: 1 });
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
                .toEqual({ added: 1 });
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

        it('the first settled version of a night wins; a fuller one later is not applied', async () => {
            const at = createHealthImportDomain({ records, now: () => W0, timeZone: 'UTC' });
            const window = { from: N0 - 48 * H, to: N0 + 60 * H };
            expect(await at.importSamples('sleep', night.slice(0, 1), window)).toEqual({ added: 1 });
            expect(await at.importSamples('sleep', night, window)).toEqual({ added: 0 });
            expect(records.rows.get(DAY_ID)).toMatchObject({ clientTs: 0, total_minutes: 120 });
        });

        it('two sources\' copies of a night end as one row for the day', async () => {
            const copy = night.map((s, i) => ({ ...s, uuid: uid(20 + i), source: 'com.other.app' }));
            copy[4] = { ...copy[4], end: copy[4].end - 60 * 60_000 }; // the other app saw an hour less
            const at = createHealthImportDomain({ records, now: () => W0, timeZone: 'UTC' });
            const window = { from: N0 - 48 * H, to: N0 + 60 * H };
            expect(await at.importSamples('sleep', [...copy, ...night], window)).toEqual({ added: 1 });
            expect([...records.rows.values()]).toEqual([expect.objectContaining({ recordId: DAY_ID, total_minutes: 470 })]);
            expect(await at.importSamples('sleep', [...night, ...copy], window)).toEqual({ added: 0 });
        });

        it('an edit outranks a rescan, and a deleted night stays deleted', async () => {
            const at = createHealthImportDomain({ records, now: () => W0, timeZone: 'UTC' });
            const window = { from: N0 - 48 * H, to: N0 + 60 * H };
            await at.importSamples('sleep', night, window);
            await records.put('sleep', { ...records.rows.get(DAY_ID), clientTs: W0, notes: 'woke up twice' });
            expect(await at.importSamples('sleep', night, window)).toEqual({ added: 0 });
            expect(records.rows.get(DAY_ID)).toMatchObject({ notes: 'woke up twice', total_minutes: 470 });
            await records.del('sleep', DAY_ID);
            expect(await at.importSamples('sleep', night, window)).toEqual({ added: 0 });
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

        it('a Health workout id never equals a Mi Band row id, so delete removes only its own row', async () => {
            // A UUID whose last 48 bits read as the Mi Band row's epoch-ms id.
            const uuid = `00000000-0000-4000-8000-${W0.toString(16).padStart(12, '0')}`;
            await records.put('miband', {
                recordId: `miband-${W0}`, clientTs: 5, deleted: false, id: W0, source: 'miband',
                activity_name: 'cycling', source_start_ms: W0, source_end_ms: W0 + H,
            });
            const domain = createHealthImportDomain({ records, now: () => W0 + 2 * 24 * H, timeZone: 'UTC' });
            expect(await domain.importSamples('workout', [{ ...run(1, W0 + 5 * H, W0 + 6 * H, 37), uuid }])).toEqual({ added: 1 });
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
    });
});
