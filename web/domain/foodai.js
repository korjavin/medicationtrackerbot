// Runtime-agnostic food-AI domain module. Pure logic over injected ports
// (aiClient, foodDomain, now) — no window/document/fetch/IndexedDB — so it
// can later run inside the Go server via goja (C6). The browser aiClient
// (web/cloud/js/aiclient.js) does the actual provider HTTP calls; this file
// only validates the parsed shape and turns items into food log records.
// Prompts/schema pinned verbatim from internal/ai/openai.go; convertParsedMeal
// mirrors internal/domain/food_ai.go's convertParsedMeal.

import { calculateMacros } from './food.js';

// Copied verbatim from internal/ai/openai.go's MealSystemPrompt.
export const MealSystemPrompt = `You are a nutrition expert. Parse a free-text meal description and split it into an ordered list of atomic food items.

Rules:
- Return every dish name in English, regardless of the input language. Translate non-English names.
- Use common, generic names (e.g. "chicken breast", not "grilled marinated chicken breast with lemon"; "rice", not "steamed jasmine rice").
- Split complex meals into atomic items: one item per distinct food or ingredient listed. Do not combine unrelated foods into a single row.
- Do not over-split composed dishes that the user named as a single unit. A sandwich stays one item ("ham and cheese sandwich"); do not break it into bread + cheese + ham. Soup or stew stays one item.
- For each item return: name, weight_grams (estimated total eaten), and macronutrients PER 100 GRAMS (carbs_100g, protein_100g, fat_100g).
- Preserve the order the user mentioned the items in.
- The "items" array must contain at least one entry.
Respond ONLY with the requested JSON schema.`;

// Copied verbatim from internal/ai/openai.go's MealPhotoSystemPrompt.
export const MealPhotoSystemPrompt = MealSystemPrompt + `

You are looking at a single photograph of a meal. Identify each visible food
item, estimate its eaten weight in grams from the apparent portion size, and
report typical macronutrients per 100 grams for that food. If multiple distinct
foods share a plate, list each as its own item. If the photo does not show
food, return an empty items array.`;

// Copied verbatim (JSON-Schema shape) from internal/ai/openai.go's mealSchema.
export const mealSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          weight_grams: { type: 'number' },
          carbs_100g: { type: 'number' },
          protein_100g: { type: 'number' },
          fat_100g: { type: 'number' },
        },
        required: ['name', 'weight_grams', 'carbs_100g', 'protein_100g', 'fat_100g'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

// mirrors maxFoodDescriptionLength (food_handlers.go) — same 4 KiB cap on the
// free-text description sent to the provider.
const MAX_DESCRIPTION_BYTES = 4096;

function invalid(message, code) {
  const err = new Error(message);
  err.code = code || 'invalid_request';
  return err;
}

// convertParsedMeal mirrors internal/domain/food_ai.go's convertParsedMeal:
// all-or-nothing validation (name non-empty, weight_grams>0, macros>=0),
// then CalculateMacros for the frozen totals. Throws on the first bad item,
// same as the Go version returning an error before anything is saved.
export function convertParsedMeal(parsed) {
  if (!parsed || !Array.isArray(parsed.items) || parsed.items.length === 0) {
    throw invalid('AI returned no meal items', 'no_items');
  }
  return parsed.items.map((item, i) => {
    if (!item.name) throw invalid(`item ${i} missing name`, 'invalid_item');
    if (!(item.weight_grams > 0)) {
      throw invalid(`item ${i} (${JSON.stringify(item.name)}) has non-positive weight_grams`, 'invalid_item');
    }
    // Missing macro keys default to 0 to mirror Go's float64 zero-value: the
    // schema marks all three required, but the response_format-rejection
    // fallback sends an unconstrained request where a provider may omit one.
    // Without the default, undefined would pass the `< 0` check and then
    // propagate NaN through calculateMacros, collapsing the whole item to 0 kcal.
    const c100 = item.carbs_100g || 0, p100 = item.protein_100g || 0, f100 = item.fat_100g || 0;
    if (c100 < 0 || p100 < 0 || f100 < 0) {
      throw invalid(`item ${i} (${JSON.stringify(item.name)}) has negative macros`, 'invalid_item');
    }
    const { carbs, protein, fat, calories } = calculateMacros(c100, p100, f100, item.weight_grams);
    return { name: item.name, weight: Math.trunc(item.weight_grams), carbs, protein, fat, calories };
  });
}

// createFoodAIDomain builds the food-AI API over the injected ports:
//   aiClient    — { parseMealFromDescription(text), parseMealFromImage(file) },
//                 both resolving to a ParsedMeal ({items:[...]}); throws with
//                 .code 'no_api_key' when no provider key is configured (the
//                 replacement for the server's food_intake_enabled gate) —
//                 no HTTP call is attempted in that case.
//   foodDomain  — the food domain instance (web/domain/food.js) logs land in
//   now()       — current time in ms epoch, used as eaten_at when unset
export function createFoodAIDomain({ aiClient, foodDomain, now }) {
  // saveParsedItems mirrors the handlers' post-parse loop: every validated
  // item is attempted as a log create, per-item failures are counted (not
  // thrown), and only a fully-empty result is an error — same
  // {status:"created", items, failed} contract as the server.
  // recordIdFor(index) → a stable recordId for item `index`, so a caller that
  // needs idempotent re-creates (e.g. a re-drained Telegram /food) overwrites its
  // own rows. Absent → the food domain generates ids, unchanged for the UI path.
  async function saveParsedItems(parsedMeal, eatenAt, recordIdFor) {
    const items = convertParsedMeal(parsedMeal);
    const saved = [];
    let failed = 0;
    for (let i = 0; i < items.length; i++) {
      try {
        saved.push(await foodDomain.create(
          { ...items[i], eaten_at: eatenAt },
          { skipProductUpsert: true, recordId: recordIdFor ? recordIdFor(i) : undefined },
        ));
      } catch {
        failed++;
      }
    }
    if (saved.length === 0) throw invalid('Failed to save any food items', 'save_failed');
    return { status: 'created', items: saved, failed };
  }

  async function parseMealFromDescription(description, { eatenAt, recordIdFor } = {}) {
    const trimmed = (description || '').trim();
    if (!trimmed) throw invalid('Description is required');
    if (new TextEncoder().encode(trimmed).length > MAX_DESCRIPTION_BYTES) {
      throw invalid(`Description too long (max ${MAX_DESCRIPTION_BYTES} bytes)`);
    }
    const parsed = await aiClient.parseMealFromDescription(trimmed);
    return saveParsedItems(parsed, eatenAt ?? now(), recordIdFor);
  }

  async function parseMealFromPhoto(file, { eatenAt, recordIdFor } = {}) {
    const parsed = await aiClient.parseMealFromImage(file);
    return saveParsedItems(parsed, eatenAt ?? now(), recordIdFor);
  }

  return { parseMealFromDescription, parseMealFromPhoto };
}
