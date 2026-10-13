// Runtime-agnostic food-AI domain module. Pure logic over injected ports
// (aiClient, foodDomain, now) — no window/document/fetch/IndexedDB — so it
// can later run inside the Go server via goja (C6). The browser aiClient
// (web/cloud/js/aiclient.js) does the actual provider HTTP calls; this file
// only validates the parsed shape and turns items into food log records.
// Prompts/schema started from internal/ai/openai.go; convertParsedMeal
// mirrors internal/domain/food_ai.go's convertParsedMeal.

import { calculateMacros } from './food.js';

// Started as internal/ai/openai.go's MealSystemPrompt; the `uncertain` rule
// (med-xso6.17) feeds the review step's warn chip. The unit is the DISH, not
// the ingredient (med-x7bk): "bread with butter and fish" is one row.
export const MealSystemPrompt = `You are a nutrition expert. Parse a free-text meal description into an ordered list of the dishes and foods that were eaten.

Rules:
- Return every dish name in English, regardless of the input language. Translate non-English names.
- One item per separately eaten dish or food. Separators between dishes ("and", commas, "+", new lines) mean separate items: "soup and fries" is two items; "2 eggs, toast, orange juice" is three.
- Ingredients, fillings or toppings that describe one dish belong to that dish and stay ONE item: "X with Y and Z", "X: a, b, c", a dish name followed by its ingredients ("sandwich, bread with butter and fish"), or ingredients that together make one dish ("bread with butter and fish"). Soup, stew, salad, sandwich or burger is one item. "Oatmeal with banana and coffee" is two items: oatmeal with banana, and coffee.
- Name a composed dish by its main components ("fish and butter sandwich", "oatmeal with banana"). Name a single plain food generically ("chicken breast", not "grilled marinated chicken breast with lemon"; "rice", not "steamed jasmine rice").
- For each item return: name, weight_grams (estimated total eaten; for a composed dish, the whole dish), and macronutrients PER 100 GRAMS (carbs_100g, protein_100g, fat_100g), estimated from the listed composition.
- Preserve the order the user mentioned the items in.
- Set uncertain to true when you had to guess what the food is or how much was eaten (hidden ingredients, no quantity given, an unclear photo); otherwise false.
- If the text describes no food, return an empty items array.`;

// Started as internal/ai/openai.go's MealPhotoSystemPrompt.
export const MealPhotoSystemPrompt = MealSystemPrompt + `

You are looking at a single photograph of a meal. Identify each visible dish,
estimate its eaten weight in grams from the apparent portion size, and report
typical macronutrients per 100 grams for that dish. A sandwich, burger or
composed salad stays one item; only distinct dishes (e.g. a main and a side,
a drink) are separate items. If the photo shows no food, return an empty
items array.`;

// Started as internal/ai/openai.go's mealSchema (JSON-Schema shape), plus
// `uncertain`. Strict mode needs every property required; a provider on the
// unconstrained fallback may still omit it, which reads as false.
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
          uncertain: { type: 'boolean' },
        },
        required: ['name', 'weight_grams', 'carbs_100g', 'protein_100g', 'fat_100g', 'uncertain'],
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

// previewParsedMeal is the parse-only (dry run) shape the review step edits:
// convertParsedMeal's totals plus the per-100g values (so a gram change can
// recompute) and the model's `uncertain` flag. Same validation, nothing saved.
export function previewParsedMeal(parsed) {
  const totals = convertParsedMeal(parsed);
  return totals.map((t, i) => {
    const item = parsed.items[i];
    return {
      ...t,
      carbs_100g: item.carbs_100g || 0,
      protein_100g: item.protein_100g || 0,
      fat_100g: item.fat_100g || 0,
      uncertain: item.uncertain === true,
    };
  });
}

// createFoodAIDomain builds the food-AI API over the injected ports:
//   aiClient    — { parseMealFromDescription(text), parseMealFromImage(file, caption) },
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

  async function parseMealFromDescription(description, { eatenAt, recordIdFor, dryRun = false } = {}) {
    const trimmed = (description || '').trim();
    if (!trimmed) throw invalid('Description is required');
    if (new TextEncoder().encode(trimmed).length > MAX_DESCRIPTION_BYTES) {
      throw invalid(`Description too long (max ${MAX_DESCRIPTION_BYTES} bytes)`);
    }
    const parsed = await aiClient.parseMealFromDescription(trimmed);
    if (dryRun) return { status: 'parsed', items: previewParsedMeal(parsed) };
    return saveParsedItems(parsed, eatenAt ?? now(), recordIdFor);
  }

  // caption — what the user wrote alongside the photo (a Telegram caption).
  // Passed to the model as a hint, never as a substitute for the image: it is
  // what makes "300g" beat guessing the portion from pixels.
  async function parseMealFromPhoto(file, { eatenAt, recordIdFor, caption, dryRun = false } = {}) {
    const parsed = await aiClient.parseMealFromImage(file, (caption || '').trim());
    if (dryRun) return { status: 'parsed', items: previewParsedMeal(parsed) };
    return saveParsedItems(parsed, eatenAt ?? now(), recordIdFor);
  }

  // logParsedItems commits a reviewed dry-run list ({name, weight, *_100g})
  // through the same write path as a direct parse: re-validated, macros
  // recomputed from per-100g, no product upsert.
  async function logParsedItems(items, { eatenAt } = {}) {
    const parsed = {
      items: (Array.isArray(items) ? items : []).map((it) => ({
        name: it && it.name,
        weight_grams: Number(it && it.weight),
        carbs_100g: Number(it && it.carbs_100g) || 0,
        protein_100g: Number(it && it.protein_100g) || 0,
        fat_100g: Number(it && it.fat_100g) || 0,
      })),
    };
    return saveParsedItems(parsed, eatenAt ?? now());
  }

  return { parseMealFromDescription, parseMealFromPhoto, logParsedItems };
}
