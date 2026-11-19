// foodportion.js — the starting portion and three portion chips of a food
// search result (bd med-8npm.1, epic med-8npm; spec screens-food-portion.html
// PS1–PS6, INDEX changelog 2026-11-19). Pure: no I/O, no ports, no network.
// food.search() annotates every result with portionsFor(); the add sheet only
// renders the payload.
//
// Sources, first that exists wins: the meal's own weight → your history of the
// food → its pack size → a typical serving → a kcal guess.
//
// Rounding (Archie ruling B, 29480): a real number (a logged weight, the pack
// size, a meal's weight, a table serving) shows exact to 1 g; a derived one
// (½×, 1.5×, 2×, a kcal guess) snaps to 5 g below 50, 10 g up to 300, 25 g
// above. Two chips that land on the same grid value are duplicates.

import { foodKey, offDisplayName } from './foodname.js';

const exact = (g) => Math.max(1, Math.round(g));
export function roundPortion(g) {
  const step = g < 50 ? 5 : g <= 300 ? 10 : 25;
  return Math.max(step, Math.round(g / step) * step);
}
const clamp = (g) => Math.min(400, Math.max(20, g));

// Typical single servings in grams, English match keys. A key matches a run of
// whole words in foodKey(offDisplayName(name)); the longest matching key wins.
// Bare "pasta"/"rice" are left out on purpose: dry and cooked differ 3×, and
// the kcal guess tells them apart by energy density.
// ponytail: English-only keys, extend on misses; no import, no AI.
const TYPICAL = [
  ['caviar', 15], ['roe', 15],
  ['cooked pasta', 250], ['cooked spaghetti', 250], ['cooked rice', 250], ['boiled rice', 250], ['cooked noodle', 250],
  ['dry pasta', 80], ['dry rice', 80], ['uncooked rice', 80], ['uncooked pasta', 80],
  ['bread', 35], ['toast', 35], ['bun', 60], ['bagel', 90], ['croissant', 60],
  ['butter', 10], ['oil', 10], ['mayonnaise', 10], ['mayo', 10], ['margarine', 10],
  ['spread', 20], ['jam', 20], ['honey', 20], ['nutella', 20], ['peanut butter', 20],
  ['cheese', 30], ['cottage cheese', 150],
  ['nut', 30], ['almond', 30], ['peanut', 30], ['walnut', 30], ['seed', 30],
  ['chocolate', 30], ['cookie', 30], ['biscuit', 30], ['crisp', 30], ['cracker', 30],
  ['cereal', 40], ['granola', 40], ['oat', 40], ['muesli', 40], ['cornflake', 40],
  ['yogurt', 150], ['yoghurt', 150], ['kefir', 150], ['skyr', 150], ['quark', 150],
  ['milk', 250], ['juice', 250], ['soda', 250], ['cola', 250], ['lemonade', 250], ['chocolate milk', 250],
  ['egg', 60],
  ['meat', 150], ['chicken', 150], ['beef', 150], ['pork', 150], ['turkey', 150], ['poultry', 150], ['steak', 150],
  ['fish', 150], ['salmon', 150], ['tuna', 150], ['sausage', 100],
  ['vegetable', 150], ['salad', 150], ['potato', 200],
  ['fruit', 150], ['apple', 180], ['banana', 120], ['orange', 150],
  ['berry', 100], ['strawberry', 100], ['blueberry', 100], ['raspberry', 100],
  ['sauce', 30], ['ketchup', 30], ['dressing', 30], ['pesto', 30],
  ['hummus', 60], ['dip', 60], ['guacamole', 60],
  ['soup', 300],
  ['sugar', 5], ['sweetener', 5],
].map(([k, g]) => [foodKey(k), g]);

export function typicalServingG(name) {
  const key = ` ${foodKey(offDisplayName(name))} `;
  let best = null;
  for (const [k, g] of TYPICAL) {
    if (k && key.includes(` ${k} `) && (!best || k.length > best[0].length)) best = [k, g];
  }
  return best ? best[1] : null;
}

// portionsFor → { start_g, chips: [{ g, label? }] }: exactly three distinct
// chips, ascending; start_g is one of them. history: the food's logged weights,
// newest first. A duplicate after rounding collapses and the next candidate
// fills.
export function portionsFor({ product = {}, history = [], packG = null, typicalG = null } = {}) {
  const kcal100 = Number(product.energy_kcal_100g) || 0;
  const meal = product.is_meal && Number(product.total_weight_g) > 0;
  const weights = history.map(Number).filter((w) => w > 0).map(exact);
  let start;
  let candidates;
  let label;
  let fit = (g) => g;
  if (meal) {
    start = exact(product.total_weight_g);
    // The real last portion before the derived ½, so it survives a collapse.
    candidates = [...weights.slice(0, 1), roundPortion(start / 2)];
  } else if (weights.length) {
    start = weights[0];
    // Most used first, ties to the newer (Map keeps first-seen order).
    const counts = new Map();
    for (const w of weights) counts.set(w, (counts.get(w) || 0) + 1);
    const used = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
    candidates = used.length >= 3
      ? used.filter((w) => w !== start).slice(0, 2)
      : [...used, roundPortion(start / 2), roundPortion(start * 1.5)];
  } else if (packG >= 5 && packG <= 400) {
    // A pack is a serving only within the typical table's bounds: a 1 kg bag
    // of rice is not a start (never absurd); it falls to the next source.
    start = exact(packG);
    label = 'pack';
    candidates = [roundPortion(start / 2), roundPortion(start * 2)];
  } else if (typicalG) {
    start = exact(typicalG);
    candidates = [roundPortion(start / 2), roundPortion(start * 2)];
  } else if (kcal100 > 0) {
    fit = clamp;
    const gramsOf = (kcal) => clamp(roundPortion((kcal * 100) / kcal100));
    start = gramsOf(200);
    candidates = [gramsOf(100), gramsOf(300)];
  } else {
    start = 100;
    candidates = [50, 200];
  }
  // Fillers when duplicates collapsed; a kcal guess keeps its 20–400 g bounds.
  const filler = [0.5, 1.5, 2, 0.25, 3, 4, 0.125].map((m) => fit(roundPortion(start * m)));
  const chips = [label ? { g: start, label } : { g: start }];
  for (const g of [...candidates, ...filler]) {
    if (chips.length === 3) break;
    // Compared on the grid: a meal's exact last 175 and its derived ½ (180)
    // are one chip.
    if (!chips.some((c) => roundPortion(c.g) === roundPortion(g))) chips.push({ g });
  }
  return { start_g: start, chips: chips.sort((a, b) => a.g - b.g) };
}
