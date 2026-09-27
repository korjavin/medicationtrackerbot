// Dexie v6 → v7 migration coverage (med-a9n5.9).
// v7 drops the bot-mode offline write queues (bp_readings, weight_logs,
// intake_queue, pending_sw_actions) — cloud never wrote to them, so existing
// profiles upgrade with zero data loss. Dexie deletes a table when its
// schema entry is null; versions 1-6 stay verbatim so an upgrade from any
// older profile replays the full history.
//
// This test parses db.js to:
//   1. confirm versions 1-6 are still declared (history preserved)
//   2. confirm v7 nulls exactly the four queue tables
//   3. confirm every other v6 store is re-declared in v7 with an identical
//      schema string (no silent change to the surviving caches)
// and boots the harness to:
//   4. confirm MedTrackerDB no longer exposes the four queue stores
//   5. confirm the dropped tables are gone and the surviving caches operate

import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDbEnv } from './helpers/db-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const DB_JS = path.join(REPO_ROOT, 'web/static/js/db.js');
const SOURCE = fs.readFileSync(DB_JS, 'utf-8');

const DROPPED_TABLES = ['bp_readings', 'weight_logs', 'intake_queue', 'pending_sw_actions'];

// Parse a `db.version(N).stores({ ... })` block out of the source.
// Returns the map of tableName -> schemaString (or null for dropped tables),
// or null if the version block is not found.
function parseVersionStores(source, version) {
    const re = new RegExp(`db\\.version\\(${version}\\)\\.stores\\(\\{([\\s\\S]*?)\\}\\)`);
    const m = source.match(re);
    if (!m) return null;
    const body = m[1];
    const stores = {};
    const entryRe = /(\w+)\s*:\s*(?:['"]([^'"]+)['"]|(null))/g;
    let em;
    while ((em = entryRe.exec(body)) !== null) {
        stores[em[1]] = em[3] === 'null' ? null : em[2];
    }
    return stores;
}

describe('db.js v6 → v7 schema migration', () => {
    beforeEach(() => {
        allowConsoleNoise();
    });

    it('versions 1-6 are still declared (history preserved for old profiles)', () => {
        for (const v of [1, 2, 3, 4, 5, 6]) {
            expect(parseVersionStores(SOURCE, v), `db.version(${v}) missing`).not.toBeNull();
        }
    });

    it('v7 nulls exactly the four bot-mode queue tables', () => {
        const v7 = parseVersionStores(SOURCE, 7);
        expect(v7).not.toBeNull();
        expect(Object.keys(v7).sort()).toEqual([
            'api_cache',
            'bp_readings',
            'food_products_cache',
            'intake_history_cache',
            'intake_queue',
            'medication_cache',
            'pending_sw_actions',
            'weight_logs',
            'workout_cache',
        ]);
        for (const table of DROPPED_TABLES) {
            expect(v7[table], `${table} should be nulled in v7`).toBeNull();
        }
    });

    it('every surviving v6 store is re-declared in v7 with an identical schema', () => {
        const v6 = parseVersionStores(SOURCE, 6);
        const v7 = parseVersionStores(SOURCE, 7);
        expect(v6).not.toBeNull();
        expect(v7).not.toBeNull();

        const changed = [];
        for (const [name, schema] of Object.entries(v6)) {
            if (DROPPED_TABLES.includes(name)) continue;
            if (!(name in v7)) {
                changed.push(`${name} (in v6 but missing in v7)`);
                continue;
            }
            if (v7[name] !== schema) {
                changed.push(`${name} schema changed: v6="${schema}" v7="${v7[name]}"`);
            }
        }
        expect(changed).toEqual([]);
    });

    it('MedTrackerDB no longer exposes the queue stores', () => {
        const { window, cleanup } = loadDbEnv();
        try {
            expect(window.MedTrackerDB.BPStore).toBeUndefined();
            expect(window.MedTrackerDB.WeightStore).toBeUndefined();
            expect(window.MedTrackerDB.IntakeQueueStore).toBeUndefined();
            expect(window.MedTrackerDB.SwActionQueue).toBeUndefined();
            // The read caches stay.
            expect(window.MedTrackerDB.MedicationStore).toBeDefined();
            expect(window.MedTrackerDB.IntakeHistoryStore).toBeDefined();
            expect(window.MedTrackerDB.WorkoutStore).toBeDefined();
            expect(window.MedTrackerDB.FoodProductsStore).toBeDefined();
            expect(window.MedTrackerDB.ApiCache).toBeDefined();
        } finally {
            cleanup();
        }
    });

    it('dropped tables are gone and surviving caches operate after the upgrade', async () => {
        const { window, cleanup } = loadDbEnv();
        try {
            const db = window.MedTrackerDB.db;
            expect(db.bp_readings).toBeUndefined();
            expect(db.weight_logs).toBeUndefined();
            expect(db.intake_queue).toBeUndefined();
            expect(db.pending_sw_actions).toBeUndefined();

            // Pre-populated-profile proxy: the surviving caches write/read.
            await window.MedTrackerDB.MedicationStore.saveCache([{ id: 1, name: 'Aspirin' }]);
            expect(await window.MedTrackerDB.MedicationStore.getCache()).toEqual([{ id: 1, name: 'Aspirin' }]);
            await window.MedTrackerDB.ApiCache.set('bp', { readingsRes: [] });
            expect(await window.MedTrackerDB.ApiCache.get('bp')).toEqual({ readingsRes: [] });
        } finally {
            cleanup();
        }
    });
});
