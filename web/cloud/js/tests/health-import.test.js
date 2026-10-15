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
            expect(desc()).toBe('Import blood pressure and weight');

            await flip(true);
            await new Promise((r) => setTimeout(r, 0));
            expect(health.requestAuthorization).toHaveBeenCalledWith(['bp', 'weight']);
            expect(records.rows.has(`bp-hk-${U1}`)).toBe(true);
            expect(afterImport).toHaveBeenCalledTimes(1);
            expect(desc()).toMatch(/^Last imported .* · 1 reading so far$/);
            expect(healthStatusText(storage)).toBe(desc());

            // Off and on again is the manual rescan: it starts from no anchor.
            await flip(false);
            const before = health.calls.length;
            await flip(true);
            await new Promise((r) => setTimeout(r, 0));
            expect(health.calls.slice(before).map((c) => c.anchor)).toEqual([null, null]);
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
    });
});
