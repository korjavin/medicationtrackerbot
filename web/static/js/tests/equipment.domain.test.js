// med-niix.1 — equipment inventory domain (web/domain/equipment.js): pure
// load math (achievableLoads / minStep / snapLoad) plus the CRUD surface over
// an in-memory records port. No UI entry point yet (that is med-niix.3), so a
// pure-unit suite is the owning suite for this layer.
import { describe, it, expect } from 'vitest';
import {
  createEquipmentDomain, achievableLoads, loadingFor, minStep, snapLoad,
} from '../../../../web/domain/equipment.js';
import {
  recordsToVault, vaultToRecords, VAULT_MANAGED_TYPES,
} from '../../../../web/domain/vault.js';

function memPort() {
  const store = new Map();
  return {
    async list(type) {
      return [...(store.get(type) || [])].filter((r) => !r.deleted);
    },
    async put(type, record) {
      const rows = store.get(type) || [];
      const i = rows.findIndex((r) => r.recordId === record.recordId);
      if (i === -1) rows.push(record);
      else rows[i] = record;
      store.set(type, rows);
      return record;
    },
    async del(type, recordId) {
      const rows = store.get(type) || [];
      const i = rows.findIndex((r) => r.recordId === recordId);
      if (i !== -1) rows[i] = { ...rows[i], deleted: true };
    },
  };
}

function domain() {
  let t = 1_000_000;
  return createEquipmentDomain({ records: memPort(), now: () => (t += 1000) });
}

const BARBELL = {
  kind: 'plated', name: 'Ohio bar', bar_kg: 20, sides: 2, pair: false,
  plates: [1.25, 2.5, 5, 10, 20].map((kg) => ({ kg, count: 2 })),
};

describe('equipment load math', () => {
  it('plated barbell 20kg + 2x{1.25,2.5,5,10,20} builds 22.5, 25, ... with min_step 2.5', () => {
    const loads = achievableLoads(BARBELL);
    expect(loads[0]).toBe(20);
    expect(loads).toContain(22.5);
    expect(loads).toContain(25);
    expect(minStep(loads)).toBe(2.5);
  });

  it('pair dumbbells with 4x1.25 step 2.5 per implement', () => {
    const loads = achievableLoads({
      kind: 'plated', name: 'Loadable DBs', bar_kg: 2, sides: 2, pair: true,
      plates: [{ kg: 1.25, count: 4 }],
    });
    expect(loads).toEqual([2, 4.5]);
    expect(minStep(loads)).toBe(2.5);
  });

  it('a lone single plate contributes nothing on a sides:2 bar but counts on sides:1', () => {
    expect(achievableLoads({
      kind: 'plated', name: 'Bar', bar_kg: 20, sides: 2, plates: [{ kg: 1.25, count: 1 }],
    })).toEqual([20]);
    expect(achievableLoads({
      kind: 'plated', name: 'KB', bar_kg: 8, sides: 1, plates: [{ kg: 4, count: 1 }],
    })).toEqual([8, 12]);
  });

  it('fixed list snaps 12 (+2.5) to 14; {16,24} snaps 16 (+2.5) to 24; at max to null', () => {
    expect(snapLoad([10, 12, 14, 16], 12, 2.5)).toBe(14);
    expect(snapLoad([16, 24], 16, 2.5)).toBe(24);
    expect(snapLoad([16, 24], 24, 2.5)).toBeNull();
  });

  it('snap ties go to the lower rung and only looks strictly above current', () => {
    expect(snapLoad([20, 24], 18, 4)).toBe(20); // |20-22| == |24-22|
    expect(snapLoad([20, 24], 20, 4)).toBe(24); // current itself is not a candidate
  });

  it('minStep is null with fewer than two loads', () => {
    expect(minStep([20])).toBeNull();
    expect(minStep([])).toBeNull();
  });
});

describe('loadingFor (med-niix.6)', () => {
  const BAR = {
    kind: 'plated', name: 'Ohio bar', bar_kg: 20, sides: 2, pair: false,
    plates: [{ kg: 20, count: 2 }, { kg: 1.25, count: 2 }],
  };

  it('decomposes 62.5 on a 20kg bar into 20 + 1.25 per side', () => {
    expect(loadingFor(BAR, 62.5)).toEqual({ bar_kg: 20, per_side: [20, 1.25] });
  });

  it('returns null when the kg is not achievable, and for fixed gear', () => {
    expect(loadingFor(BAR, 61)).toBeNull();
    expect(loadingFor(BAR, 10)).toBeNull(); // below the bar
    expect(loadingFor(BAR, 0)).toBeNull();
    expect(loadingFor({ kind: 'fixed', name: 'Hex DBs', loads_kg: [10, 12] }, 12)).toBeNull();
    expect(loadingFor(null, 20)).toBeNull();
  });

  it('a bar-only target builds empty per_side; split rows still pair up', () => {
    expect(loadingFor({
      kind: 'plated', name: 'Bar', bar_kg: 20, sides: 2,
      plates: [{ kg: 5, count: 2 }],
    }, 20)).toEqual({ bar_kg: 20, per_side: [] });
    expect(loadingFor({
      kind: 'plated', name: 'Bar', bar_kg: 20, sides: 2,
      plates: [{ kg: 5, count: 1 }, { kg: 5, count: 1 }],
    }, 30)).toEqual({ bar_kg: 20, per_side: [5] });
  });

  it('falls back to the knapsack witness when greedy misses', () => {
    // Per side: one 1kg plate or two 0.75kg plates build 1.5kg; greedy takes
    // the 1kg first and strands 0.5kg, the witness finds 0.75 + 0.75.
    const exotic = {
      kind: 'plated', name: 'Exotic', bar_kg: 20, sides: 2,
      plates: [{ kg: 1, count: 2 }, { kg: 0.75, count: 4 }],
    };
    expect(achievableLoads(exotic)).toContain(23);
    expect(loadingFor(exotic, 23)).toEqual({ bar_kg: 20, per_side: [0.75, 0.75] });
  });

  it('returns null past the knapsack span ceiling, like achievableLoads', () => {
    const big = {
      kind: 'plated', name: 'Stacked bar', bar_kg: 20, sides: 2,
      plates: [{ kg: 25, count: 40 }],
    };
    expect(achievableLoads(big)[achievableLoads(big).length - 1]).toBeLessThanOrEqual(501);
    expect(achievableLoads(big)).not.toContain(620);
    expect(loadingFor(big, 620)).toBeNull();
    expect(loadingFor(big, 1e7)).toBeNull();
    expect(loadingFor(big, 420)).toEqual({ bar_kg: 20, per_side: [25, 25, 25, 25, 25, 25, 25, 25] });
  });

  it('agrees with achievableLoads on randomized small inventories (seeded)', () => {
    let seed = 0xc0ffee;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const choices = [1.25, 2.5, 5, 10, 15, 20, 25];
    for (let round = 0; round < 25; round += 1) {
      const sides = rnd() < 0.7 ? 2 : 1;
      const pair = sides === 2 && rnd() < 0.3;
      const plates = choices
        .filter(() => rnd() < 0.5)
        .map((kg) => ({ kg, count: 1 + Math.floor(rnd() * 4) }));
      const eq = { kind: 'plated', name: 'Rand', bar_kg: 20, sides, pair, plates };
      const loads = new Set(achievableLoads(eq).map((l) => Math.round(l * 100) / 100));
      const probes = new Set([...loads]);
      for (const l of loads) {
        probes.add(Math.round((l + 0.5) * 100) / 100);
        probes.add(Math.round((l - 0.5) * 100) / 100);
      }
      for (const kg of probes) {
        if (!(kg > 0)) continue;
        const ld = loadingFor(eq, kg);
        const achievable = loads.has(Math.round(kg * 100) / 100);
        expect({ kg, got: ld !== null }).toEqual({ kg, got: achievable });
        if (ld) {
          const rebuilt = Math.round(
            (ld.bar_kg + (sides * ld.per_side.reduce((a, b) => a + b, 0))) * 100,
          ) / 100;
          expect(rebuilt).toBeCloseTo(kg, 9);
        }
      }
    }
  });
});

describe('equipment CRUD', () => {
  it('create/list/get round-trips fixed gear with computed loads/step/max', async () => {
    const eq = domain();
    const created = await eq.createEquipment({
      kind: 'fixed', name: 'Hex DBs', loads_kg: [12, 10, 14, 12],
    });
    expect(created.id).toBeGreaterThan(0);
    expect(created.loads_kg).toEqual([10, 12, 14]);
    expect(created.min_step_kg).toBe(2);
    expect(created.max_kg).toBe(14);

    const list = await eq.listEquipment();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Hex DBs');

    const got = await eq.getEquipment(created.id);
    expect(got.loads_kg).toEqual([10, 12, 14]);
    expect(await eq.getEquipment(999999)).toBeNull();
  });

  it('create computes plated loads and update/delete behave', async () => {
    const eq = domain();
    const created = await eq.createEquipment(BARBELL);
    expect(created.loads_kg).toContain(22.5);
    expect(created.min_step_kg).toBe(2.5);
    expect(created.plates).toHaveLength(5);

    await eq.updateEquipment(created.id, { ...BARBELL, name: 'Ohio bar 2' });
    expect((await eq.getEquipment(created.id)).name).toBe('Ohio bar 2');

    await eq.deleteEquipment(created.id);
    expect(await eq.listEquipment()).toHaveLength(0);
  });

  it('a kind change strips the other kind fields from the stored body', async () => {
    let t = 1_000_000;
    const records = memPort();
    const eq = createEquipmentDomain({ records, now: () => (t += 1000) });
    const created = await eq.createEquipment(BARBELL);
    await eq.updateEquipment(created.id, { kind: 'fixed', name: 'Ohio bar', loads_kg: [20] });
    // Assert on the stored body: the response omits plated keys for fixed
    // gear regardless, so only the body proves the strip loop ran.
    const [stored] = await records.list('equipment');
    expect(stored.kind).toBe('fixed');
    for (const k of ['bar_kg', 'sides', 'pair', 'plates']) expect(k in stored).toBe(false);
    expect((await eq.getEquipment(created.id)).loads_kg).toEqual([20]);
  });

  it('duplicate plate rows merge so split counts still load both sides', () => {
    expect(achievableLoads({
      kind: 'plated', name: 'Bar', bar_kg: 20, sides: 2,
      plates: [{ kg: 5, count: 1 }, { kg: 5, count: 1 }],
    })).toEqual([20, 30]);
  });

  it('an off-grid bar still reports its exact weight as the first rung', () => {
    const loads = achievableLoads({
      kind: 'plated', name: 'LB bar', bar_kg: 20.4, sides: 2,
      plates: [{ kg: 20.4, count: 2 }],
    });
    expect(loads[0]).toBe(20.4);
  });

  it('validation rejects bad payloads with invalid_request', async () => {
    const eq = domain();
    const bad = [
      { kind: 'fixed', loads_kg: [10] }, // no name
      { kind: 'bands', name: 'x' }, // bad kind
      { kind: 'fixed', name: 'x', loads_kg: [] }, // empty loads
      { kind: 'fixed', name: 'x', loads_kg: [-5] }, // negative load
      { kind: 'plated', name: 'x', bar_kg: 0, sides: 2 }, // bad bar
      { kind: 'plated', name: 'x', bar_kg: 20, sides: 3 }, // bad sides
      { kind: 'plated', name: 'x', bar_kg: 20, sides: 2, plates: [{ kg: 5, count: 0 }] }, // bad count
      { kind: 'plated', name: 'x', bar_kg: 20, sides: 2, plates: [{ kg: 5, count: 1.5 }] }, // non-integer count
    ];
    for (const input of bad) {
      await expect(eq.createEquipment(input)).rejects.toMatchObject({ code: 'invalid_request' });
    }
    await expect(eq.createEquipment({
      kind: 'fixed', name: 'x', loads_kg: Array.from({ length: 201 }, (_, i) => i + 1),
    })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(eq.createEquipment({
      kind: 'plated', name: 'x', bar_kg: 20, sides: 2,
      plates: Array.from({ length: 21 }, () => ({ kg: 1, count: 2 })),
    })).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('equipment vault round-trip', () => {
  const NOW = Date.parse('2026-07-08T12:00:00Z');
  const GEAR = [
    {
      id: 7, user_id: 1, name: 'Ohio bar', kind: 'plated',
      bar_kg: 20, sides: 2, pair: false,
      plates: [{ kg: 5, count: 2 }],
      created_at: '2026-07-01T08:00:00Z', updated_at: '2026-07-01T08:00:00Z',
    },
    {
      id: 8, user_id: 1, name: 'Hex DBs', kind: 'fixed', loads_kg: [10, 12],
      created_at: '2026-07-01T08:00:00Z', updated_at: '2026-07-01T08:00:00Z',
    },
  ];

  it('equipment survives export/import on deterministic recordIds', () => {
    const vault = { format: 'medtracker-vault', version: 1, data: { workouts: { equipment: GEAR } } };
    const records = vaultToRecords(vault, { now: NOW });
    const gear = records.filter((r) => r.recordType === 'equipment');
    expect(gear.map((r) => r.recordId).sort()).toEqual(['equipment-7', 'equipment-8']);
    const back = recordsToVault(records, { now: NOW });
    expect(back.data.workouts.equipment).toEqual(GEAR);
  });

  it('a vault without gear exports an empty equipment array', () => {
    const vault = { format: 'medtracker-vault', version: 1, data: { workouts: {} } };
    const back = recordsToVault(vaultToRecords(vault, { now: NOW }), { now: NOW });
    expect(back.data.workouts.equipment).toEqual([]);
  });

  it('equipment is a vault-managed record type', () => {
    expect(VAULT_MANAGED_TYPES.has('equipment')).toBe(true);
  });
});
