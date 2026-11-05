// bd med-5jq.1 — the shared food-name normalizer (web/domain/foodname.js).
// Pure layer with no caller yet (wiring is .3/.4/.6), so this pure-unit suite
// owns it. Fixtures are the epic med-5jq duplicate table, verbatim.
import { describe, expect, it } from 'vitest';
import { foodKey, displayName, keyDistance, offDisplayName } from '../../../domain/foodname.js';

describe('foodKey — one key per food', () => {
  it.each([
    [['Boiled eggs', 'boiled egg', 'hard-boiled eggs', '2 boiled eggs', 'boiled eggs breakfast', 'Boiled eggs (airline)'], 'boiled egg'],
    [['Night sandwiches', 'sandwich'], 'sandwich'],
    [['capuccino'], 'capuccino'],
    [['вареное яйцо', '  Вареное   яйцо '], 'вареное яйцо'],
    [['Weißwurst', 'WEISSWURST', 'WEIẞWURST', 'weisswurst'], 'weisswurst'],
  ])('%j → %s', (names, key) => {
    for (const n of names) expect(foodKey(n), n).toBe(key);
  });

  it('strips quantities, portions, meal-times and places', () => {
    expect(foodKey('x5 dumplings')).toBe('dumpling');
    expect(foodKey('2x Tomatoes 300g')).toBe('tomato');
    expect(foodKey('1/3 portion lasagna')).toBe('lasagna');
    expect(foodKey('half large pizza, lunch')).toBe('pizza');
    expect(foodKey('Berries (small) work snack')).toBe('berry');
    expect(foodKey('hotel home airplane dinner rice')).toBe('rice');
  });

  it('keeps a percentage as part of the name (med-5jq.3)', () => {
    expect(foodKey('Greek yogurt 2%')).toBe('greek yogurt 2%');
    expect(foodKey('Greek yogurt 0%')).not.toBe(foodKey('Greek yogurt 2%'));
    expect(foodKey('Milk 3.2%')).toBe('milk 3.2%');
    expect(foodKey('Milk 3,2%')).toBe('milk 3.2%');
    expect(foodKey('Milk 1.5%')).not.toBe(foodKey('Milk 3.2%'));
    expect(foodKey('milk')).not.toBe(foodKey('Milk 3.2%'));
    expect(foodKey('2x milk 300g')).toBe('milk');
  });

  it('folds English plurals with a short exception list', () => {
    expect(foodKey('fries')).toBe('fries');
    expect(foodKey('hummus')).toBe('hummus');
    expect(foodKey('cookies')).toBe(foodKey('cookie'));
    expect(foodKey('peaches')).toBe('peach');
    expect(foodKey('potatoes')).toBe('potato');
    expect(foodKey("McDonald's fries")).toBe('mcdonald fries');
  });

  it("returns '' when only annotations are left", () => {
    expect(foodKey('Breakfast')).toBe('');
    expect(foodKey(' (airline) 2x ')).toBe('');
    expect(foodKey(null)).toBe('');
  });

  it.each([
    ['boiled egg', 'fried egg'],
    ['rye bread', 'white bread'],
    ['dry spaghetti', 'cooked spaghetti'],
    ['coffee', 'coffee with milk'],
    ['banana', 'dried banana'],
  ])('does not merge %s vs %s', (a, b) => {
    expect(foodKey(a)).not.toBe(foodKey(b));
  });
});

describe('displayName — what the user typed, minus annotations', () => {
  it.each([
    ['  boiled   eggs ', 'Boiled eggs'],
    ['2 boiled eggs (airline)', 'Boiled eggs'],
    ['Night sandwiches', 'Sandwiches'],
    ['hard-boiled eggs, breakfast', 'Hard-boiled eggs'],
    ['eggs,breakfast', 'Eggs'],
    ['300g-eggs', 'Eggs'],
    ['boiled eggs 1/3', 'Boiled eggs'],
    ['вареное яйцо', 'Вареное яйцо'],
    ['capuccino', 'Capuccino'],
    ['Breakfast', 'Breakfast'],
    ['', ''],
  ])('%j → %j', (input, out) => {
    expect(displayName(input)).toBe(out);
  });
});

describe('offDisplayName — a clean name for a scanned food-DB row (med-5jq.6)', () => {
  it.each([
    ['Hazelnut Spread - MAXI NUTRITION - 400 g', 'Maxi Nutrition Hazelnut Spread'],
    ['Nutella Hazelnut Spread - Nutella, Ferrero - 750g', 'Nutella Hazelnut Spread'],
    ['Coca-Cola Zero - Coca-Cola - 6x33cl', 'Coca-Cola Zero'],
    ['Big Mac - KFC - 1 L', 'KFC Big Mac'],
    ['Broccoli - K-Classic - 500 g', 'Broccoli'],
    ['Milk - Gut & Günstig - 1 L', 'Milk'],
    ['Vollmilch - Gut & Günstig - 1 L', 'Gut & Günstig Vollmilch'],
    ['Chocolate chip cookies - Tesco - 200 g', 'Tesco Chocolate chip cookies'],
    ['Chocolate cookies - Tesco - 200 g', 'Tesco Chocolate cookies'],
    ['Protein bar - Lidl - 50 g', 'Lidl Protein bar'],
    ['Cookies - Tesco', 'Tesco Cookies'],
    ['Greek yogurt - Fage - 2% - 500 g', 'Fage Greek yogurt 2%'],
    ['ORANGE JUICE - 1.5 l', 'Orange Juice'],
    ['Snack bar', 'Snack bar'],
    ['Oats 500g', 'Oats'],
    ['', ''],
  ])('%j → %j', (input, out) => {
    expect(offDisplayName(input)).toBe(out);
  });
});

describe('keyDistance — bounded Levenshtein on keys', () => {
  it('counts edits', () => {
    expect(keyDistance('capuccino', 'cappuccino')).toBe(1);
    expect(keyDistance('yugurt', 'yogurt')).toBe(1);
    expect(keyDistance('swandwich', 'sandwich')).toBe(1);
    expect(keyDistance('egg', 'egg')).toBe(0);
    expect(keyDistance('', 'abc')).toBe(3);
    expect(keyDistance('харчо', 'харчо суп', 9)).toBe(4);
  });

  it('stops at max + 1', () => {
    expect(keyDistance('banana', 'chocolate', 2)).toBe(3);
    expect(keyDistance('a', 'abcdefgh', 3)).toBe(4);
    expect(keyDistance('kitten', 'sitting', 2)).toBe(3);
    expect(keyDistance('kitten', 'sitting')).toBe(3);
  });
});
