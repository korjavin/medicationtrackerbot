// med-niix.1 — equipment inventory domain (web/domain/equipment.js): pure
// load math (achievableLoads / minStep / snapLoad) plus the CRUD surface over
// an in-memory records port. No UI entry point yet (that is med-niix.3), so a
// pure-unit suite is the owning suite for this layer.
import { describe, it, expect } from 'vitest';
import {
  createEquipmentDomain, achievableLoads, loadingFor, minStep, snapLoad,
  nearestLoads, equipmentIdForExercise, pickNearestLoad,
  implementForExerciseName, autoEquipmentForExercise, equipmentForExercise, implementOf,
  inventoryAt,
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

function domain(records = memPort()) {
  let t = 1_000_000;
  return createEquipmentDomain({ records, now: () => (t += 1000) });
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
      { kind: 'fixed', name: 'x', loads_kg: [10], implement: 'rack' }, // bad implement
      { kind: 'plated', name: 'x', bar_kg: 20, sides: 2, implement: 'rack' }, // bad implement
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

describe('equipment implement label (med-v75c.1)', () => {
  it('a fixed write with implement round-trips through list/get', async () => {
    const eq = domain();
    const created = await eq.createEquipment({
      kind: 'fixed', name: 'KB', loads_kg: [8], implement: 'kettlebell',
    });
    expect(created.implement).toBe('kettlebell');
    expect((await eq.listEquipment())[0].implement).toBe('kettlebell');
    expect((await eq.getEquipment(created.id)).implement).toBe('kettlebell');
  });

  it('a fixed write without implement stores no label and reads back without it', async () => {
    let t = 1_000_000;
    const records = memPort();
    const eq = createEquipmentDomain({ records, now: () => (t += 1000) });
    const created = await eq.createEquipment({ kind: 'fixed', name: 'DBs', loads_kg: [10] });
    expect('implement' in created).toBe(false);
    const [stored] = await records.list('equipment');
    expect('implement' in stored).toBe(false);
  });

  it('a plated write without implement defaults from sides/pair and stores it', async () => {
    let t = 1_000_000;
    const records = memPort();
    const eq = createEquipmentDomain({ records, now: () => (t += 1000) });
    const bell = await eq.createEquipment({
      kind: 'plated', name: 'Bell', bar_kg: 8, sides: 1, plates: [],
    });
    expect(bell.implement).toBe('kettlebell');
    const dbs = await eq.createEquipment({
      kind: 'plated', name: 'DBs', bar_kg: 2, sides: 2, pair: true, plates: [],
    });
    expect(dbs.implement).toBe('dumbbell');
    const bar = await eq.createEquipment({
      kind: 'plated', name: 'Bar', bar_kg: 20, sides: 2, plates: [],
    });
    expect(bar.implement).toBe('barbell');
    // Assert on the stored bodies: the responses would show the same values
    // via derive-on-read, so only the bodies prove the write persisted them.
    const stored = await records.list('equipment');
    expect(stored.map((r) => r.implement).sort()).toEqual(['barbell', 'dumbbell', 'kettlebell']);
  });

  it('a legacy plated record without implement derives it on read without writing', async () => {
    let t = 1_000_000;
    const inner = memPort();
    let puts = 0;
    const records = {
      ...inner,
      put: async (...args) => { puts += 1; return inner.put(...args); },
    };
    const eq = createEquipmentDomain({ records, now: () => (t += 1000) });
    // Seeded straight into the port: a pre-implement stored body.
    await records.put('equipment', {
      recordId: 'equipment-9', id: 9, user_id: 1, name: 'Legacy bar',
      kind: 'plated', bar_kg: 20, sides: 2, pair: true, plates: [],
      created_at: '2026-07-01T08:00:00Z', updated_at: '2026-07-01T08:00:00Z',
    });
    puts = 0;
    expect((await eq.listEquipment())[0].implement).toBe('dumbbell');
    expect((await eq.getEquipment(9)).implement).toBe('dumbbell');
    expect(puts).toBe(0);
    const [stored] = await records.list('equipment');
    expect('implement' in stored).toBe(false);
  });

  it('an update omitting implement keeps the stored label; an explicit one overwrites', async () => {
    const eq = domain();
    const created = await eq.createEquipment({
      kind: 'fixed', name: 'KB', loads_kg: [8], implement: 'kettlebell',
    });
    await eq.updateEquipment(created.id, { kind: 'fixed', name: 'KB', loads_kg: [8] });
    expect((await eq.getEquipment(created.id)).implement).toBe('kettlebell');
    await eq.updateEquipment(created.id, {
      kind: 'fixed', name: 'KB', loads_kg: [8], implement: 'dumbbell',
    });
    expect((await eq.getEquipment(created.id)).implement).toBe('dumbbell');
  });
});

describe('sleeve capacity: max_plates_per_side', () => {
  // 20 kg bar, five 20s per side available — but the sleeve fits only four.
  const PILE = {
    kind: 'plated', name: 'Short sleeve', bar_kg: 20, sides: 2, pair: false,
    plates: [{ kg: 20, count: 10 }, { kg: 10, count: 2 }, { kg: 5, count: 2 }],
  };
  const CAPPED = { ...PILE, max_plates_per_side: 4 };

  it('drops loads needing more plates per side than the sleeve holds', () => {
    expect(achievableLoads(PILE)).toContain(220); // 5 x 20 per side
    const capped = achievableLoads(CAPPED);
    expect(capped).not.toContain(220);
    expect(capped).not.toContain(190); // 4 x 20 + 5 = 5 plates
    expect(capped).toContain(180); // 4 x 20
    expect(capped).toContain(160); // 3 x 20 + 10
    expect(capped).not.toContain(170); // 3 x 20 + 10 + 5 = 5 plates
    expect(capped[capped.length - 1]).toBe(180);
  });

  it('loadingFor refuses an over-capacity build and never returns more plates than fit', () => {
    expect(loadingFor(PILE, 220)).toEqual({ bar_kg: 20, per_side: [20, 20, 20, 20, 20] });
    expect(loadingFor(CAPPED, 220)).toBeNull();
    expect(loadingFor(CAPPED, 180)).toEqual({ bar_kg: 20, per_side: [20, 20, 20, 20] });
  });

  it('an over-capacity greedy build falls back to the fewest-plates witness', () => {
    // sides:1, target 10 kg on the sleeve: greedy takes 6 + 1 + 1 + 1 + 1
    // (five plates), the two-plate sleeve only fits 5 + 5.
    const kb = {
      kind: 'plated', name: 'Loadable KB', bar_kg: 20, sides: 1, pair: false,
      plates: [{ kg: 6, count: 1 }, { kg: 5, count: 2 }, { kg: 1, count: 4 }],
      max_plates_per_side: 2,
    };
    expect(achievableLoads(kb)).toContain(30);
    expect(loadingFor(kb, 30)).toEqual({ bar_kg: 20, per_side: [5, 5] });
  });

  it('agrees with achievableLoads under random capacities (seeded)', () => {
    let seed = 0xbeef;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const choices = [1, 1.25, 2.5, 5, 6, 10, 15, 20, 25];
    for (let round = 0; round < 25; round += 1) {
      const sides = rnd() < 0.7 ? 2 : 1;
      const pair = sides === 2 && rnd() < 0.3;
      const plates = choices
        .filter(() => rnd() < 0.5)
        .map((kg) => ({ kg, count: 1 + Math.floor(rnd() * 8) }));
      const cap = 1 + Math.floor(rnd() * 4);
      const eq = { kind: 'plated', name: 'Rand', bar_kg: 20, sides, pair, plates, max_plates_per_side: cap };
      const loads = new Set(achievableLoads(eq));
      for (const kg of achievableLoads({ ...eq, max_plates_per_side: undefined })) {
        const ld = loadingFor(eq, kg);
        expect({ kg, got: ld !== null }).toEqual({ kg, got: loads.has(kg) });
        if (ld) expect(ld.per_side.length).toBeLessThanOrEqual(cap);
      }
    }
  });

  it('a garbage capacity (vault body that bypassed validation) reads as unlimited', () => {
    expect(achievableLoads({ ...PILE, max_plates_per_side: 'x' })).toEqual(achievableLoads(PILE));
    expect(achievableLoads({ ...PILE, max_plates_per_side: 0 })).toEqual(achievableLoads(PILE));
  });

  it('create stores it, the response carries it and caps loads_kg / max_kg', async () => {
    const eq = domain();
    const created = await eq.createEquipment(CAPPED);
    expect(created.max_plates_per_side).toBe(4);
    expect(created.max_kg).toBe(180);
    const uncapped = await eq.createEquipment({ ...PILE, max_plates_per_side: null });
    expect('max_plates_per_side' in uncapped).toBe(false);
    expect(uncapped.max_kg).toBe(250);
  });

  it('update: omitted preserves, null clears, a kind change strips it', async () => {
    let t = 1_000_000;
    const records = memPort();
    const eq = createEquipmentDomain({ records, now: () => (t += 1000) });
    const created = await eq.createEquipment(CAPPED);
    await eq.updateEquipment(created.id, { ...PILE, name: 'Renamed' });
    expect((await eq.getEquipment(created.id)).max_plates_per_side).toBe(4);
    await eq.updateEquipment(created.id, { ...PILE, max_plates_per_side: 3 });
    expect((await eq.getEquipment(created.id)).max_kg).toBe(140);
    await eq.updateEquipment(created.id, { ...PILE, max_plates_per_side: null });
    const [cleared] = await records.list('equipment');
    expect('max_plates_per_side' in cleared).toBe(false);
    await eq.updateEquipment(created.id, CAPPED);
    await eq.updateEquipment(created.id, { kind: 'fixed', name: 'Now fixed', loads_kg: [20] });
    const [fixed] = await records.list('equipment');
    expect('max_plates_per_side' in fixed).toBe(false);
  });

  it('validation rejects a non-integer or out-of-range capacity', async () => {
    const eq = domain();
    for (const bad of [0, -1, 2.5, 101, 'four']) {
      await expect(eq.createEquipment({ ...PILE, max_plates_per_side: bad }))
        .rejects.toMatchObject({ code: 'invalid_request' });
    }
  });
});

describe('equipment vault round-trip', () => {
  const NOW = Date.parse('2026-07-08T12:00:00Z');
  const GEAR = [
    {
      id: 7, user_id: 1, name: 'Ohio bar', kind: 'plated', implement: 'barbell',
      bar_kg: 20, sides: 2, pair: false,
      plates: [{ kg: 5, count: 2 }],
      created_at: '2026-07-01T08:00:00Z', updated_at: '2026-07-01T08:00:00Z',
    },
    {
      id: 8, user_id: 1, name: 'Hex DBs', kind: 'fixed', implement: 'dumbbell', loads_kg: [10, 12],
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

// med-v75c.2 - nearestLoads brackets a working weight within an equipment
// item's achievable loads so the session card can fall back to the nearest
// buildable rung (tie -> below at the call site) with its delta.
describe('nearestLoads (med-v75c.2)', () => {
  it('returns the rung twice on an exact hit', () => {
    expect(nearestLoads([20, 22.5, 25], 22.5)).toEqual({ below: 22.5, above: 22.5 });
    expect(nearestLoads([8, 16, 24], 8)).toEqual({ below: 8, above: 8 });
  });

  it('brackets a between-rungs target', () => {
    expect(nearestLoads([20, 25], 22)).toEqual({ below: 20, above: 25 });
  });

  it('returns null past the ends', () => {
    expect(nearestLoads([20, 25], 10)).toEqual({ below: null, above: 20 });
    expect(nearestLoads([20, 25], 30)).toEqual({ below: 25, above: null });
  });

  it('returns nulls for an empty list', () => {
    expect(nearestLoads([], 20)).toEqual({ below: null, above: null });
    expect(nearestLoads(null, 20)).toEqual({ below: null, above: null });
  });

  it('brackets an off-grid input without snapping it', () => {
    // 20kg bar + one 20 and one 1.25 per side: rungs 20, 22.5, 60, 62.5.
    const loads = achievableLoads({
      kind: 'plated', name: 'Ohio bar', bar_kg: 20, sides: 2, pair: false,
      plates: [{ kg: 20, count: 2 }, { kg: 1.25, count: 2 }],
    });
    expect(loads).toEqual([20, 22.5, 60, 62.5]);
    expect(nearestLoads(loads, 61.3)).toEqual({ below: 60, above: 62.5 });
  });

  it('brackets within a plate-loaded kettlebell (sides:1) inventory', () => {
    const kb = {
      kind: 'plated', name: 'Loadable KB', bar_kg: 4, sides: 1,
      plates: [{ kg: 2, count: 3 }, { kg: 1, count: 2 }],
    };
    const loads = achievableLoads(kb);
    expect(loads).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(nearestLoads(loads, 9)).toEqual({ below: 9, above: 9 });
    expect(nearestLoads(loads, 9.5)).toEqual({ below: 9, above: 10 });
    expect(loadingFor(kb, 9)).toEqual({ bar_kg: 4, per_side: [2, 2, 1] });
  });

  it('an lb-ish plate set still builds its snapped rungs', () => {
    // Plates bought as 45/25/10 lb, stored as kg like every record (there is
    // no unit field): the 0.25-kg grid snaps them, and the snapped rungs
    // must still decompose.
    const eq = {
      kind: 'plated', name: 'LB plates', bar_kg: 8, sides: 2, pair: false,
      plates: [{ kg: 20.4, count: 2 }, { kg: 11.3, count: 2 }, { kg: 4.5, count: 2 }],
    };
    const loads = achievableLoads(eq);
    expect(loads).toContain(49); // 8 + 2 x 20.5 (snapped 20.4)
    expect(loadingFor(eq, 49)).toEqual({ bar_kg: 8, per_side: [20.4] });
    expect(nearestLoads(loads, 49)).toEqual({ below: 49, above: 49 });
    for (const rung of loads) {
      expect(loadingFor(eq, rung)).not.toBeNull();
    }
  });
});

describe('equipmentIdForExercise + pickNearestLoad (med-3gln)', () => {
  it('the row override wins over the library binding', () => {
    expect(equipmentIdForExercise({ equipment_id: 5 }, { equipment_id: 6 })).toBe(5);
  });

  it('an unset row falls back to the library binding', () => {
    expect(equipmentIdForExercise({}, { equipment_id: 6 })).toBe(6);
    expect(equipmentIdForExercise({ equipment_id: null }, { equipment_id: 6 })).toBe(6);
    expect(equipmentIdForExercise(null, { equipment_id: 6 })).toBe(6);
  });

  it('a row without a library link still resolves its override', () => {
    expect(equipmentIdForExercise({ equipment_id: 5 }, null)).toBe(5);
    expect(equipmentIdForExercise({ equipment_id: 5 }, {})).toBe(5);
  });

  it('unbound on both sides reads as null', () => {
    expect(equipmentIdForExercise({}, {})).toBeNull();
    expect(equipmentIdForExercise(null, null)).toBeNull();
    expect(equipmentIdForExercise({ equipment_id: null }, { equipment_id: null })).toBeNull();
  });

  it('picks the closer rung, ties going below', () => {
    expect(pickNearestLoad(72, 74.5, 73)).toBe(72);
    expect(pickNearestLoad(60, 62.5, 62)).toBe(62.5);
    expect(pickNearestLoad(70, 74, 72)).toBe(70); // exact tie → below
    expect(pickNearestLoad(72, 72, 72)).toBe(72); // exact hit brackets twice
  });

  it('picks the surviving end past the bracket ends', () => {
    expect(pickNearestLoad(null, 20, 10)).toBe(20);
    expect(pickNearestLoad(25, null, 30)).toBe(25);
    expect(pickNearestLoad(null, null, 20)).toBeNull();
  });
});

// med-x295 — auto-match: with no explicit binding, the inventory item whose
// implement matches the exercise name's implement word and best fits the
// weight is picked on read.
describe('equipment auto-match (med-x295)', () => {
  const fixedBar = (id, loads, step, over) => ({
    id, name: `Bar ${id}`, kind: 'fixed', implement: 'barbell', loads_kg: loads, min_step_kg: step, ...over,
  });

  it('derives the implement from EN and RU name keywords', () => {
    expect(implementForExerciseName('barbell bench press')).toBe('barbell');
    expect(implementForExerciseName('Жим штанги лёжа')).toBe('barbell');
    expect(implementForExerciseName('dumbbell fly')).toBe('dumbbell');
    expect(implementForExerciseName('гантели на бицепс')).toBe('dumbbell');
    expect(implementForExerciseName('kettlebell swing')).toBe('kettlebell');
    expect(implementForExerciseName('махи гирей')).toBe('kettlebell');
    expect(implementForExerciseName('ez bar curl')).toBe('barbell');
    expect(implementForExerciseName('EZ-bar curl')).toBe('barbell');
    expect(implementForExerciseName('trap bar deadlift')).toBe('barbell');
    expect(implementForExerciseName('landmine press')).toBe('barbell');
    expect(implementForExerciseName('push up')).toBeNull();
    expect(implementForExerciseName('Pezbar row')).toBeNull();
    expect(implementForExerciseName(null)).toBeNull();
  });

  it('implementOf applies the plated read-side default and leaves unlabelled fixed items unknown', () => {
    expect(implementOf({ kind: 'plated', sides: 2, pair: false })).toBe('barbell');
    expect(implementOf({ kind: 'plated', sides: 2, pair: true })).toBe('dumbbell');
    expect(implementOf({ kind: 'plated', sides: 1 })).toBe('kettlebell');
    expect(implementOf({ kind: 'fixed', loads_kg: [10] })).toBeNull();
    expect(implementOf({ kind: 'fixed', implement: 'dumbbell' })).toBe('dumbbell');
  });

  it('an item achieving the weight exactly beats one that does not', () => {
    const inv = [fixedBar(1, [55, 65], 10), fixedBar(2, [50, 60, 70], 10)];
    expect(autoEquipmentForExercise('barbell squat', inv, 60).id).toBe(2);
  });

  it('both exact → smaller min_step, then lower id', () => {
    const inv = [fixedBar(3, [40, 60], 20), fixedBar(2, [55, 60], 5), fixedBar(1, [50, 60], 10)];
    expect(autoEquipmentForExercise('barbell squat', inv, 60).id).toBe(2);
    const same = [fixedBar(7, [50, 60], 10), fixedBar(4, [40, 50, 60], 10)];
    expect(autoEquipmentForExercise('barbell squat', same, 60).id).toBe(4);
  });

  it('none exact → the item whose nearest rung is closest wins', () => {
    const inv = [fixedBar(1, [55, 65], 10), fixedBar(2, [58, 70], 12)];
    expect(autoEquipmentForExercise('barbell squat', inv, 60).id).toBe(2);
  });

  it('a plated barbell with no implement label matches by its read-side default', () => {
    const rec = {
      id: 9, name: 'Ohio bar', kind: 'plated', bar_kg: 20, sides: 2, pair: false,
      plates: [{ kg: 20, count: 2 }],
    };
    const loads = achievableLoads(rec);
    const inv = [{ ...rec, loads_kg: loads, min_step_kg: minStep(loads) }];
    expect(autoEquipmentForExercise('Жим штанги', inv, 60).id).toBe(9);
  });

  it('other/absent implement, empty loads, empty inventory, no name implement → null', () => {
    expect(autoEquipmentForExercise('barbell squat', [fixedBar(1, [60], null, { implement: 'other' })], 60)).toBeNull();
    expect(autoEquipmentForExercise('barbell squat', [fixedBar(1, [60], null, { implement: undefined })], 60)).toBeNull();
    expect(autoEquipmentForExercise('barbell squat', [fixedBar(1, [], null)], 60)).toBeNull();
    expect(autoEquipmentForExercise('barbell squat', [], 60)).toBeNull();
    expect(autoEquipmentForExercise('push up', [fixedBar(1, [60], null)], 60)).toBeNull();
    expect(autoEquipmentForExercise('dumbbell fly', [fixedBar(1, [60], null)], 60)).toBeNull();
  });

  it('with no kg → min_step then id', () => {
    const inv = [fixedBar(3, [40, 60], 20), fixedBar(2, [55, 60], 5), fixedBar(1, [50, 55], 5)];
    expect(autoEquipmentForExercise('barbell squat', inv, null).id).toBe(1);
    expect(autoEquipmentForExercise('barbell squat', inv, 0).id).toBe(1);
    expect(autoEquipmentForExercise('barbell squat', inv, NaN).id).toBe(1);
  });

  it('equipmentForExercise: explicit row beats library beats auto; dangling explicit stays unbound', () => {
    const inv = [fixedBar(1, [60], null), fixedBar(5, [60], null), fixedBar(6, [60], null)];
    const row = { exercise_name: 'barbell squat', equipment_id: 5 };
    const lib = { name: 'barbell squat', equipment_id: 6 };
    expect(equipmentForExercise(row, lib, inv, 60)).toEqual({ item: inv[1], auto: false });
    expect(equipmentForExercise({ exercise_name: 'barbell squat' }, lib, inv, 60)).toEqual({ item: inv[2], auto: false });
    expect(equipmentForExercise({ exercise_name: 'barbell squat' }, null, inv, 60))
      .toEqual({ item: inv[0], auto: true });
    // The library name is canonical over the row's cached copy.
    expect(equipmentForExercise({ exercise_name: 'push up' }, { name: 'barbell squat' }, inv, 60))
      .toEqual({ item: inv[0], auto: true });
    expect(equipmentForExercise({ exercise_name: 'barbell squat' }, { name: 'push up' }, inv, 60)).toBeNull();
    // No row: the library name drives the auto-match.
    expect(equipmentForExercise(null, { name: 'barbell squat' }, inv, 60)).toEqual({ item: inv[0], auto: true });
    // A deleted binding must not silently switch gear.
    expect(equipmentForExercise({ exercise_name: 'barbell squat', equipment_id: 99 }, lib, inv, 60)).toBeNull();
    expect(equipmentForExercise({ exercise_name: 'barbell squat' }, { name: 'barbell squat', equipment_id: 99 }, inv, 60)).toBeNull();
    expect(equipmentForExercise({ exercise_name: 'push up' }, null, inv, 60)).toBeNull();
  });
});

// med-8j5w.1 — workout locations (gyms): inventoryAt is the one location
// filter; equipmentForExercise scopes explicit bindings and auto-match by it.
describe('workout locations (med-8j5w.1)', () => {
  const A = 1;
  const B = 2;
  const LIVE = [A, B];
  const BAR_A = { id: 10, name: 'A bar', implement: 'barbell', loads_kg: [20, 22.5, 25], min_step_kg: 2.5, location_id: A };
  const BAR_B = { id: 11, name: 'B bar', implement: 'barbell', loads_kg: [20, 60, 100], min_step_kg: 40, location_id: B };
  const DBS = { id: 12, name: 'Travel DBs', implement: 'dumbbell', loads_kg: [10, 12], min_step_kg: 2 };
  const GONE = { id: 13, name: 'Old gym bar', implement: 'barbell', loads_kg: [20, 40], min_step_kg: 20, location_id: 99 };
  const INV = [BAR_A, BAR_B, DBS, GONE];
  const names = (items) => items.map((e) => e.name).sort();

  it('inventoryAt: the location plus portable and dangling-location gear', () => {
    expect(names(inventoryAt(INV, A, LIVE))).toEqual(['A bar', 'Old gym bar', 'Travel DBs']);
    expect(names(inventoryAt(INV, B, LIVE))).toEqual(['B bar', 'Old gym bar', 'Travel DBs']);
  });

  it('inventoryAt: no location, or a deleted one, is the whole inventory', () => {
    expect(inventoryAt(INV, null, LIVE)).toBe(INV);
    expect(inventoryAt(INV, 99, LIVE)).toBe(INV);
    expect(inventoryAt(INV, A, [])).toBe(INV);
  });

  it('portable gear is visible at every location', () => {
    for (const loc of [A, B, null]) expect(inventoryAt(INV, loc, LIVE)).toContain(DBS);
  });

  it('an explicit binding to gear at another location falls through to auto within the location', () => {
    const ex = { exercise_name: 'Barbell squat', equipment_id: BAR_A.id };
    expect(equipmentForExercise(ex, null, INV, 60, { locationId: A, liveLocationIds: LIVE }))
      .toEqual({ item: BAR_A, auto: false });
    expect(equipmentForExercise(ex, null, INV, 60, { locationId: B, liveLocationIds: LIVE }))
      .toEqual({ item: BAR_B, auto: true });
    // Without a location context the binding resolves exactly as before.
    expect(equipmentForExercise(ex, null, INV, 60)).toEqual({ item: BAR_A, auto: false });
  });

  it('a deleted explicit binding stays unbound (no auto) at any location', () => {
    const ex = { exercise_name: 'Barbell squat', equipment_id: 777 };
    expect(equipmentForExercise(ex, null, INV, 60, { locationId: B, liveLocationIds: LIVE })).toBeNull();
  });

  it('location CRUD validates the name and lists by name', async () => {
    const d = domain();
    await expect(d.createLocation({ name: '   ' })).rejects.toThrow(/Name is required/);
    await expect(d.createLocation({ name: 'x'.repeat(101) })).rejects.toThrow(/may not exceed/);
    const z = await d.createLocation({ name: '  Zeta  ' });
    await d.createLocation({ name: 'Alpha' });
    expect(z.name).toBe('Zeta');
    expect((await d.listLocations()).map((l) => l.name)).toEqual(['Alpha', 'Zeta']);
    await d.updateLocation(z.id, { name: 'Home' });
    expect((await d.getLocation(z.id)).name).toBe('Home');
  });

  it('equipment location_id: must exist on write; absent preserves, null clears', async () => {
    const d = domain();
    const gym = await d.createLocation({ name: 'Gym' });
    await expect(d.createEquipment({ kind: 'fixed', name: 'KB', loads_kg: [16], location_id: 999 }))
      .rejects.toThrow(/location_id/);
    const kb = await d.createEquipment({ kind: 'fixed', name: 'KB', loads_kg: [16], location_id: gym.id });
    expect(kb.location_id).toBe(gym.id);
    await d.updateEquipment(kb.id, { kind: 'fixed', name: 'KB', loads_kg: [16, 24] });
    expect((await d.getEquipment(kb.id)).location_id).toBe(gym.id);
    await d.updateEquipment(kb.id, { kind: 'fixed', name: 'KB', loads_kg: [16], location_id: null });
    expect('location_id' in (await d.getEquipment(kb.id))).toBe(false);
  });

  it('deleting a location writes nothing to equipment; its gear keeps the dangling id', async () => {
    const records = memPort();
    const writes = [];
    const put = records.put.bind(records);
    records.put = async (type, rec) => { writes.push(type); return put(type, rec); };
    const d = domain(records);
    const gym = await d.createLocation({ name: 'Gym' });
    const kb = await d.createEquipment({ kind: 'fixed', name: 'KB', loads_kg: [16], location_id: gym.id });
    await d.setActiveLocation(gym.id);
    writes.length = 0;
    await d.deleteLocation(gym.id);
    expect(writes).toEqual([]);
    expect((await d.getEquipment(kb.id)).location_id).toBe(gym.id);
    // The active pointer at a deleted gym reads as null, with no cleanup write.
    expect(await d.getActiveLocation()).toEqual({ location_id: null, location: null });
    // Re-saving the item keeps the dangling id verbatim (no existence check).
    await d.updateEquipment(kb.id, { kind: 'fixed', name: 'KB', loads_kg: [16], location_id: gym.id });
    expect((await d.getEquipment(kb.id)).location_id).toBe(gym.id);
  });

  it('the active gym is its own singleton: null by default, live ids only', async () => {
    const d = domain();
    expect(await d.getActiveLocation()).toEqual({ location_id: null, location: null });
    const gym = await d.createLocation({ name: 'Gym' });
    expect((await d.setActiveLocation(gym.id)).location).toMatchObject({ id: gym.id, name: 'Gym' });
    await expect(d.setActiveLocation(12345)).rejects.toThrow(/location_id/);
    expect((await d.setActiveLocation(null)).location_id).toBe(null);
  });

  it('locations and the active gym are vault-managed', () => {
    expect(VAULT_MANAGED_TYPES.has('location')).toBe(true);
    expect(VAULT_MANAGED_TYPES.has('activelocation')).toBe(true);
  });
});
