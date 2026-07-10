// bd med-d5t.11 — read-side repair for foodlog rows already written with a
// broken eaten_at (the owner has at least one). The write guard stops new ones;
// these cover the rows that already exist.
//
// Pure-unit rather than an extension of cloud.shim-contract.food-log.test.js
// (repo rule 8's documented exception): a corrupted record cannot be *created*
// through the shim any more — that is the whole point of the fix — so there is
// no integration entry point that can plant one. Injecting the records port
// directly is the only way to reach the legacy state.
import { beforeEach, describe, expect, it } from 'vitest';

import { createFoodDomain } from '../../../domain/food.js';

const LOG = 'foodlog';

// Minimal in-memory stand-in for the records port.
function memoryRecords(seed = []) {
    const store = new Map();
    for (const r of seed) store.set(`${r.recordType || LOG}:${r.recordId}`, { ...r });
    return {
        async list(type) {
            return [...store.values()].filter((r) => (r.recordType || LOG) === type).map((r) => ({ ...r }));
        },
        async put(type, record) {
            store.set(`${type}:${record.recordId}`, { ...record, recordType: type });
            return record;
        },
        async del(type, id) { store.delete(`${type}:${id}`); },
    };
}

const NOON = new Date('2026-07-10T12:00:00Z').getTime();
const NINE_AM = new Date('2026-07-10T09:00:00Z').getTime();

function domainWith(seed) {
    return createFoodDomain({
        records: memoryRecords(seed),
        now: () => NOON,
        timeZone: 'UTC',
        foodDb: null,
    });
}

// A row as the voice agent wrote it before the guard existed: no eaten_at at
// all, but clientTs recording when it was actually logged.
function corruptedRow(overrides = {}) {
    return {
        recordType: LOG,
        recordId: 'foodlog_legacy_1',
        clientTs: NINE_AM,
        deleted: false,
        eaten_at: undefined,
        weight: 100, carbs: 1, protein: 2, fat: 3, calories: 250,
        name: 'Legacy voice meal',
        ...overrides,
    };
}

describe('food domain — legacy rows with an unparseable eaten_at (med-d5t.11)', () => {
    const today = '2026-07-10';
    let food;

    beforeEach(() => { food = domainWith([corruptedRow()]); });

    it('resurfaces the row on the day it was logged, instead of hiding it forever', async () => {
        const groups = await food.listGrouped({ date: today, days: 1 });
        const logs = groups.flatMap((g) => g.logs);

        expect(logs).toHaveLength(1);
        expect(logs[0].name).toBe('Legacy voice meal');
    });

    it('reports a usable timestamp rather than rendering "Invalid Date"', async () => {
        const [log] = (await food.listGrouped({ date: today, days: 1 })).flatMap((g) => g.logs);

        expect(Number.isNaN(Date.parse(log.eaten_at))).toBe(false);
        expect(log.eaten_at).toBe(new Date(NINE_AM).toISOString());
    });

    it('makes the list and the stats agree — they used to disagree', async () => {
        // Before the fix these two reads treated NaN oppositely. listGrouped
        // used `ms >= start && ms < endExclusive` (false -> row dropped) while
        // stats used `if (ms < start || ms >= endExclusive) continue` (also
        // false -> row KEPT). So the day's calories silently counted a meal the
        // user could not see anywhere in the list.
        const logs = (await food.listGrouped({ date: today, days: 1 })).flatMap((g) => g.logs);
        const stats = await food.stats({ date: today, days: 1 });

        expect(stats.calories).toBe(logs.reduce((sum, l) => sum + l.calories, 0));
        expect(stats.calories).toBe(250);
    });

    it('leaves a row with neither a parseable eaten_at nor a usable clientTs out, rather than dating it to 1970', async () => {
        const f = domainWith([corruptedRow({ recordId: 'foodlog_legacy_2', clientTs: undefined })]);

        const logs = (await f.listGrouped({ date: today, days: 1 })).flatMap((g) => g.logs);
        expect(logs).toHaveLength(0);

        // And the read must not throw on it: new Date(undefined).toISOString()
        // is a RangeError, which would take down the whole screen for one bad row.
        await expect(f.stats({ date: today, days: 1 })).resolves.toBeDefined();
    });

    it('does not touch rows whose eaten_at is fine', async () => {
        const good = new Date('2026-07-10T08:15:00Z').toISOString();
        const f = domainWith([corruptedRow({ recordId: 'foodlog_ok', eaten_at: good, name: 'Good meal' })]);

        const [log] = (await f.listGrouped({ date: today, days: 1 })).flatMap((g) => g.logs);
        expect(log.eaten_at).toBe(good);
    });
});
