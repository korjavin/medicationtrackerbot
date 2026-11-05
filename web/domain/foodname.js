// foodname.js — the one shared food-name normalizer (bd med-5jq.1, epic
// med-5jq). Pure: no I/O, no ports, no network, no dictionary.
//
// foodKey(name)      → the MATCH key. Used only to compare names; it never
//                      replaces what the user typed (a canonical name comes
//                      from the matched product, not from the key).
// displayName(name)  → the user's words with annotation noise kept out.
// keyDistance(a, b)  → bounded Levenshtein between two keys (typo matching).
//
// Non-English names are not translated: "вареное яйцо" keys to itself; aliases
// and the AI path link them to English products.

// Whole tokens that annotate a food rather than name it (lowercase, NFKC).
const ANNOTATIONS = new Set([
  // quantity / portion
  'half', 'small', 'medium', 'large', 'portion', 'portions', 'serving', 'servings',
  // meal time
  'breakfast', 'lunch', 'dinner', 'night', 'snack',
  // place / context
  'airline', 'airplane', 'work', 'home', 'hotel',
]);

// Counts and weights: 2, x5, 2x, 300g, 250ml, 1.5kg (fractions split into digits).
const QUANTITY = /^(?:x\d+|\d+(?:x|g|gr|kg|mg|ml|l|oz|lb|pcs?)?)$/;

// ponytail: a short exception list instead of a stemmer; extend it when a real
// duplicate slips through.
const KEEP = new Set(['fries', 'hummus', 'couscous', 'asparagus', 'molasses', 'swiss']);
const IRREGULAR = new Map([
  ['cookies', 'cookie'], ['brownies', 'brownie'], ['smoothies', 'smoothie'],
  ['pies', 'pie'], ['veggies', 'veggie'], ['quiches', 'quiche'],
]);

function singular(t) {
  if (!/^[a-z]+$/.test(t) || KEEP.has(t)) return t; // English plurals only
  if (IRREGULAR.has(t)) return IRREGULAR.get(t);
  if (t.length > 4 && t.endsWith('ies')) return t.slice(0, -3) + 'y';
  if (t.length > 4 && t.endsWith('oes')) return t.slice(0, -2);
  if (/(?:ch|sh|x|ss|z)es$/.test(t)) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !/(?:ss|us)$/.test(t)) return t.slice(0, -1);
  return t;
}

// The lowercase sub-tokens of one word; apostrophes join ("McDonald's").
const subTokens = (word) =>
  word.normalize('NFKC').toLowerCase().replace(/['’`]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);

const isNoise = (t) => ANNOTATIONS.has(t) || QUANTITY.test(t);

// Whitespace words of the name with parenthesised asides removed and words
// made only of noise dropped; each word stays exactly as typed.
function keptWords(name) {
  return String(name ?? '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .split(/\s+/)
    .filter((w) => subTokens(w).some((t) => !isNoise(t)));
}

export function foodKey(name) {
  const tokens = keptWords(name).flatMap(subTokens).filter((t) => !isNoise(t)).map(singular);
  return ` ${tokens.join(' ')} `.replace(' hard boiled ', ' boiled ').trim();
}

export function displayName(name) {
  const raw = String(name ?? '').trim().replace(/\s+/g, ' ');
  const kept = keptWords(raw).join(' ').replace(/^[\s,;:+&/–—-]+|[\s,;:+&/–—-]+$/g, '');
  const out = kept || raw; // all annotation ("Breakfast"): keep what was typed
  return out.charAt(0).toUpperCase() + out.slice(1);
}

// Levenshtein over code points, capped: returns max + 1 as soon as the
// distance is known to exceed max. Callers pass keys and pick the cutoff.
export function keyDistance(a, b, max = 3) {
  const s = Array.from(String(a ?? ''));
  const t = Array.from(String(b ?? ''));
  if (Math.abs(s.length - t.length) > max) return max + 1;
  let prev = Array.from({ length: t.length + 1 }, (_, j) => j);
  for (let i = 1; i <= s.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= t.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return Math.min(prev[t.length], max + 1);
}
