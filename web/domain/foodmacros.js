// Macro sanity flags for per-100 g values (med-5jq.8). Pure: flags, never
// blocks — negatives are already rejected by the write guards. Computed on read
// (product/log responses, AI preview), so no stored record shape changes; the
// manual add sheet can import the same function to check typed values (.9).
//
//   impossible     — energy > 900 kcal, carbs+protein+fat > 100 g, or any value < 0
//   inconsistent   — energy > 0 and |kcal − (4C+4P+9F)| > 30% of the larger
//   suspicious-low — energy < 5 kcal while any macro is ≥ 1 g
//
// ponytail: no per-food-class ranges (no food class exists), so a value that is
// self-consistent but wrong for the food (red wine at 10 kcal / 2.6 g carbs —
// the missing kcal is alcohol) is not flagged. Add class ranges once a class exists.
export function macroWarnings(per100) {
  const n = (v) => Number(v) || 0;
  const kcal = n(per100 && per100.energy_kcal_100g);
  const c = n(per100 && per100.carbs_100g);
  const p = n(per100 && per100.protein_100g);
  const f = n(per100 && per100.fat_100g);
  const out = [];
  if (kcal > 900 || c + p + f > 100 || [kcal, c, p, f].some((v) => v < 0)) out.push('impossible');
  const computed = 4 * c + 4 * p + 9 * f;
  if (kcal > 0 && Math.abs(kcal - computed) > 0.3 * Math.max(kcal, computed)) out.push('inconsistent');
  if (kcal < 5 && (c >= 1 || p >= 1 || f >= 1)) out.push('suspicious-low');
  return out;
}

// withMacroWarnings sets `warnings` on resp only when there are any, so clean
// responses keep their exact previous shape.
export function withMacroWarnings(resp, per100) {
  const warnings = macroWarnings(per100);
  if (warnings.length) resp.warnings = warnings;
  return resp;
}
