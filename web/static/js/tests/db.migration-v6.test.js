// Dexie v5 → v6 migration coverage (history guard).
// Task 4 of the SW handler unification plan added version 6 of MedTrackerDB
// for the pending_sw_actions queue. Versions 1-6 are preserved verbatim so
// an upgrade from any older profile replays the full history; v7 drops the
// bot-mode write queues (see db.migration-v7.test.js).
//
// This test parses db.js to:
//   1. confirm the v6 version block exists and adds pending_sw_actions
//   2. confirm every store named in version(5).stores({...}) is still
//      present in version(6).stores({...})

import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowConsoleNoise } from './helpers/setup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const DB_JS = path.join(REPO_ROOT, 'web/static/js/db.js');
const SOURCE = fs.readFileSync(DB_JS, 'utf-8');

// Parse a `db.version(N).stores({ ... })` block out of the source.
// Returns the map of tableName -> schemaString, or null if not found.
function parseVersionStores(source, version) {
    const re = new RegExp(`db\\.version\\(${version}\\)\\.stores\\(\\{([\\s\\S]*?)\\}\\)`);
    const m = source.match(re);
    if (!m) return null;
    const body = m[1];
    const stores = {};
    // Match  table_name: 'schema string'
    const entryRe = /(\w+)\s*:\s*['"]([^'"]+)['"]/g;
    let em;
    while ((em = entryRe.exec(body)) !== null) {
        stores[em[1]] = em[2];
    }
    return stores;
}

describe('db.js v5 → v6 schema migration', () => {
    beforeEach(() => {
        allowConsoleNoise();
    });

    it('v5 schema is parseable and includes the eight expected tables', () => {
        const v5 = parseVersionStores(SOURCE, 5);
        expect(v5).not.toBeNull();
        // Sanity guard — if v5 is restructured, the preservation check below
        // gives a useful diff against the new shape.
        expect(Object.keys(v5).sort()).toEqual([
            'api_cache',
            'bp_readings',
            'food_products_cache',
            'intake_history_cache',
            'intake_queue',
            'medication_cache',
            'weight_logs',
            'workout_cache',
        ]);
    });

    it('v6 schema is parseable and adds pending_sw_actions', () => {
        const v6 = parseVersionStores(SOURCE, 6);
        expect(v6).not.toBeNull();
        expect(v6.pending_sw_actions).toBeDefined();
        // Required indices: ++localId for the auto-increment PK, plus
        // endpoint / syncStatus / createdAt for the queue drain query
        // shape in sync.js.
        expect(v6.pending_sw_actions).toContain('++localId');
        expect(v6.pending_sw_actions).toContain('endpoint');
        expect(v6.pending_sw_actions).toContain('syncStatus');
        expect(v6.pending_sw_actions).toContain('createdAt');
    });

    it('every store declared in v5 is re-declared in v6 (no silent table drop)', () => {
        const v5 = parseVersionStores(SOURCE, 5);
        const v6 = parseVersionStores(SOURCE, 6);
        expect(v5).not.toBeNull();
        expect(v6).not.toBeNull();

        const missing = [];
        for (const [name, schema] of Object.entries(v5)) {
            if (!(name in v6)) {
                missing.push(`${name} (in v5 but missing in v6)`);
                continue;
            }
            // Schema strings must match — changing the primary key or
            // dropping an index in a subsequent version is a separate
            // concern that requires a real migration step.
            if (v6[name] !== schema) {
                missing.push(`${name} schema changed: v5="${schema}" v6="${v6[name]}"`);
            }
        }
        expect(missing).toEqual([]);
    });

});
