import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDbEnv } from './helpers/db-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

// Guards the sw.js:193 ConstraintError root-cause fix (Wandergeek round-2 defect #17).
// Saved note / BP / weight / food writes triggered a `changes?since` replay that
// fanned out IndexedDB writes; a single duplicate-key insert was aborting the
// whole batch and suppressing the downstream "list re-render" signal, surfacing
// as stale BP lists, zeroed Today macro bars, and a notes list stuck on
// "Loading notes…". The fix makes the writes idempotent / error-isolated.

function installConstraintErrorOnceFor(table) {
  const originalAdd = table.add.bind(table);
  let fired = false;
  table.add = async (record) => {
    if (!fired) {
      fired = true;
      const err = new Error('Key already exists in the object store.');
      err.name = 'ConstraintError';
      throw err;
    }
    return originalAdd(record);
  };
  return () => fired;
}

describe('db.js sync replay — ConstraintError isolation', () => {
  beforeEach(() => {
    allowConsoleNoise();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('MedicationStore.saveCache is idempotent under repeated calls (no ConstraintError)', async () => {
    const { window, cleanup } = loadDbEnv();

    try {
      const { MedicationStore, db } = window.MedTrackerDB;

      // Simulate concurrent saveCache() fan-out: two writers land the fixed
      // id='medications_list' row back-to-back. With clear()+add() this threw
      // a ConstraintError on the second add() (Dexie prod) — with put() it
      // silently upserts.
      await MedicationStore.saveCache([{ id: 1, name: 'Aspirin' }]);
      await expect(
        MedicationStore.saveCache([{ id: 1, name: 'Aspirin' }, { id: 2, name: 'Magnesium' }])
      ).resolves.toBeUndefined();

      const cached = await MedicationStore.getCache();
      expect(cached).toEqual([{ id: 1, name: 'Aspirin' }, { id: 2, name: 'Magnesium' }]);

      // Confirm exactly one medications_list row exists (no orphans from
      // a failed add() followed by a retry).
      const rows = await db.medication_cache.toArray();
      expect(rows.filter((r) => r.id === 'medications_list')).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('BPStore.syncFromServer swallows a duplicate-key ConstraintError and finishes the batch', async () => {
    const { window, cleanup } = loadDbEnv();

    try {
      const { BPStore, db } = window.MedTrackerDB;

      // First item throws ConstraintError (simulating the optimistic insert
      // already being in the store); the second must still land.
      const wasFired = installConstraintErrorOnceFor(db.bp_readings);

      await expect(
        BPStore.syncFromServer([
          { id: 100, systolic: 120, diastolic: 80, measured_at: '2026-04-01T10:00:00.000Z' },
          { id: 200, systolic: 118, diastolic: 78, measured_at: '2026-04-02T10:00:00.000Z' }
        ])
      ).resolves.toBeUndefined();

      expect(wasFired()).toBe(true);

      const all = await BPStore.getAll();
      const serverIds = all.map((r) => r.serverId).sort();
      expect(serverIds).toContain(200);
    } finally {
      cleanup();
    }
  });

  it('WeightStore.syncFromServer swallows a duplicate-key ConstraintError and finishes the batch', async () => {
    const { window, cleanup } = loadDbEnv();

    try {
      const { WeightStore, db } = window.MedTrackerDB;

      const wasFired = installConstraintErrorOnceFor(db.weight_logs);

      await expect(
        WeightStore.syncFromServer([
          { id: 9001, weight: 80.2, measured_at: '2026-04-01T08:00:00.000Z' },
          { id: 9002, weight: 79.4, measured_at: '2026-04-02T08:00:00.000Z' }
        ])
      ).resolves.toBeUndefined();

      expect(wasFired()).toBe(true);

      const all = await WeightStore.getAll();
      const serverIds = all.map((l) => l.serverId).sort();
      expect(serverIds).toContain(9002);
    } finally {
      cleanup();
    }
  });

  it('non-ConstraintError propagates so we do not silently swallow real failures', async () => {
    const { window, cleanup } = loadDbEnv();

    try {
      const { BPStore, db } = window.MedTrackerDB;

      db.bp_readings.add = async () => {
        const err = new Error('Database quota exceeded.');
        err.name = 'QuotaExceededError';
        throw err;
      };

      await expect(
        BPStore.syncFromServer([
          { id: 300, systolic: 122, diastolic: 82, measured_at: '2026-04-03T10:00:00.000Z' }
        ])
      ).rejects.toHaveProperty('name', 'QuotaExceededError');
    } finally {
      cleanup();
    }
  });
});
