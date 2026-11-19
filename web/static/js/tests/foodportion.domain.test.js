// bd med-8npm.1 — the starting portion and three chips of a food search result
// (web/domain/foodportion.js, packSizeG in foodname.js, food.search()'s
// `portions`). Pure layer whose UI (.2) is not built yet, so this pure-unit
// suite owns it; the search annotation runs through food.search() over an
// in-memory records port. Hand-walked cases, exact numbers.
import { describe, expect, it } from 'vitest';
import { portionsFor, typicalServingG } from '../../../domain/foodportion.js';
import { packSizeG } from '../../../domain/foodname.js';
import { createFoodDomain } from '../../../domain/food.js';

const grams = (p) => p.chips.map((c) => c.g);

describe('portionsFor — sources in order', () => {
  it('history [175,160,175,200] (newest first): the 3 most used, the last one selected', () => {
    const p = portionsFor({ history: [175, 160, 175, 200] });
    expect(grams(p)).toEqual([160, 175, 200]);
    expect(p.start_g).toBe(175);
  });

  it('history [100,101,200,300]: 101 collapses with 100 on the grid, the next logged portion fills', () => {
    const p = portionsFor({ history: [100, 101, 200, 300] });
    expect(grams(p)).toEqual([100, 200, 300]);
    expect(p.start_g).toBe(100);
  });

  it('history [170]: ½× and 1.5× fill around the last, snapped to the 10 g grid', () => {
    const p = portionsFor({ history: [170] });
    expect(grams(p)).toEqual([90, 170, 260]);
    expect(p.start_g).toBe(170);
  });

  it('yogurt never logged with a 150 g pack: ½ · 1 pack · 2', () => {
    const name = 'Greek yogurt 2% - Milbona - 150 g';
    const p = portionsFor({ product: { energy_kcal_100g: 97 }, packG: packSizeG(name), typicalG: typicalServingG(name) });
    expect(p.chips).toEqual([{ g: 80 }, { g: 150, label: 'pack' }, { g: 300 }]);
    expect(p.start_g).toBe(150);
  });

  it('red caviar with a 95 g pack: pack wins over the 15 g typical serving (per spec, not a bug)', () => {
    const name = 'Red caviar - Brand - 95 g';
    const p = portionsFor({ packG: packSizeG(name), typicalG: typicalServingG(name) });
    expect(p.chips).toEqual([{ g: 50 }, { g: 95, label: 'pack' }, { g: 190 }]);
    expect(p.start_g).toBe(95);
  });

  it('a 1 kg pack is not a serving: it falls to the typical serving', () => {
    const name = 'Basmati rice - Brand - 1 kg';
    expect(portionsFor({ product: { energy_kcal_100g: 350 }, packG: packSizeG(name), typicalG: 40 }).start_g).toBe(40);
  });

  it('caviar with no pack: the typical serving, 15 g', () => {
    const p = portionsFor({ typicalG: typicalServingG('Caviar, red (salmon roe)') });
    expect(grams(p)).toEqual([10, 15, 30]);
    expect(p.start_g).toBe(15);
  });

  it('hummus at 166 kcal with nothing else: grams of 100 · 200 · 300 kcal', () => {
    const p = portionsFor({ product: { energy_kcal_100g: 166 } });
    expect(grams(p)).toEqual([60, 120, 180]);
    expect(p.start_g).toBe(120);
  });

  it('cucumber at 15 kcal: all three clamp to 400, the next candidates fill below', () => {
    const p = portionsFor({ product: { energy_kcal_100g: 15 } });
    expect(new Set(grams(p)).size).toBe(3);
    expect(grams(p).every((g) => g <= 400 && g >= 20)).toBe(true);
    expect(grams(p)).toEqual([100, 200, 400]);
    expect(p.start_g).toBe(400);
  });

  it('no kcal data: 50 · 100 · 200', () => {
    const p = portionsFor({ product: {} });
    expect(grams(p)).toEqual([50, 100, 200]);
    expect(p.start_g).toBe(100);
  });

  it('a 350 g meal last logged at 175: whole selected, ½ collapses with the last, the next candidate fills', () => {
    const p = portionsFor({ product: { is_meal: true, total_weight_g: 350 }, history: [175] });
    expect(grams(p)).toEqual([175, 350, 525]);
    expect(p.start_g).toBe(350);
  });
});

describe('typicalServingG', () => {
  it.each([
    ['Cooked pasta', 250], ['Peanut butter - Brand - 350 g', 20], ['Butter', 10],
    ['Chocolate milk', 250], ['Milk chocolate', 30], ['Broccoli', null], ['Pasta', null],
  ])('%s → %s', (name, g) => {
    expect(typicalServingG(name)).toBe(g);
  });

  it('no row is under 5 g or over 400 g', () => {
    for (const n of ['sugar', 'soup', 'caviar', 'milk']) {
      const g = typicalServingG(n);
      expect(g >= 5 && g <= 400).toBe(true);
    }
  });
});

describe('packSizeG — the quantity segment of a food-DB name', () => {
  it.each([
    ['Hazelnut Spread - MAXI NUTRITION - 400 g', 400],
    ['Yogurt - Brand - 4 x 125 g', 125],
    ['Cola - Brand - 330 ml', 330],
    ['Rice - Brand - 1 kg', 1000],
    ['Water - Brand - 1 l', 1000],
    ['Peanuts - Brand - 16 oz', 454],
    ['Flour - Brand - 2 lb', 907],
    ['Milk 3,5% - Brand - 0,5 l', 500],
    ['Broccoli', null],
  ])('%s → %s', (name, g) => {
    expect(packSizeG(name)).toBe(g);
  });
});

describe('food.search() annotates every result', () => {
  function memoryRecords(seed) {
    const rows = seed.map((r) => ({ ...r }));
    return {
      async list(type) { return rows.filter((r) => r.type === type).map((r) => ({ ...r })); },
      async put() { throw new Error('search must not write'); },
      async del() { throw new Error('search must not write'); },
    };
  }

  it('a Mine product with two logs and a remote hit in one call', async () => {
    const product = (id, name, extra = {}) => ({
      type: 'foodproduct', recordId: id, name, usage_count: 2, energy_kcal_100g: 165, carbs_100g: 0, protein_100g: 31, fat_100g: 4, ...extra,
    });
    const log = (id, productId, weight, at) => ({ type: 'foodlog', recordId: id, product_id: productId, weight, eaten_at: at });
    const records = memoryRecords([
      product('p-chicken', 'Chicken breast'),
      log('l1', 'p-chicken', 180, '2026-11-18T12:00:00Z'),
      log('l2', 'p-chicken', 220, '2026-11-19T12:00:00Z'),
      { ...log('l3', 'p-chicken', 999, '2026-11-19T13:00:00Z'), deleted: true },
    ]);
    const foodDb = {
      async search() {
        return [{ name: 'Chicken nuggets - Brand - 250 g', barcode: '4000000000001', energy_kcal_100g: 250, carbs_100g: 15, protein_100g: 15, fat_100g: 15 }];
      },
    };
    const food = createFoodDomain({ records, now: () => Date.parse('2026-11-19T14:00:00Z'), timeZone: 'UTC', foodDb });

    const results = await food.search('chicken', { remote: true });
    expect(results.map((r) => [r.name, r.portions])).toEqual([
      // Two logged values: the last selected, the other kept, ½× fills.
      ['Chicken breast', { start_g: 220, chips: [{ g: 110 }, { g: 180 }, { g: 220 }] }],
      ['Chicken nuggets - Brand - 250 g', { start_g: 250, chips: [{ g: 130 }, { g: 250, label: 'pack' }, { g: 500 }] }],
    ]);
  });
});
