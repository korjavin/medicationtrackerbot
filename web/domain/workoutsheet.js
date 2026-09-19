// Runtime-agnostic printed-sheet scan-back domain module. Pure logic over
// injected ports (aiClient, workoutDomain) — no window/document/fetch/
// IndexedDB. The browser aiClient (web/cloud/js/aiclient.js) does the
// provider HTTP call; this file validates the handwritten numbers coming
// back and writes the accepted sets into a workout session.
//
// Why an LLM and not on-device OCR: the sheet cells hold free handwriting,
// which Tesseract-style OCR reads unreliably. The vision call follows the
// food-photo precedent (web/domain/foodai.js + aiclient.js
// parseMealFromImage): in cloud mode the photo goes straight from the
// browser to the user's own vision provider, never through /api — and with
// no key it falls back to the operator-proxied trial path behind the same
// explicit `ai` consent scope food photos use. Only the parsed numbers land
// in the vault, via the same createAdHocSession/createLog/setSessionStatus
// writes the session modal already makes.
//
// Cloud only (bd med-qj4.9): there is no legacy-bot path here by design.

export const SHEET_QR_VERSION = 1;

// Compact enough for a small printed QR: `workout-plan:1:<groupId>`.
export function buildSheetQrText(groupId) {
  const id = Math.trunc(Number(groupId));
  if (!Number.isFinite(id) || id <= 0) throw invalid('groupId is required');
  return `workout-plan:${SHEET_QR_VERSION}:${id}`;
}

// parseSheetQrText(text) → { groupId } or null. Null, never a throw: a gym
// photo may crop or smudge the code, and that must degrade to "type the
// numbers" rather than fail the whole scan.
export function parseSheetQrText(text) {
  const m = /^workout-plan:(\d+):(\d+)$/.exec(String(text || '').trim());
  if (!m) return null;
  if (Number(m[1]) !== SHEET_QR_VERSION) return null;
  const groupId = Math.trunc(Number(m[2]));
  if (!Number.isFinite(groupId) || groupId <= 0) return null;
  return { groupId };
}

export const WorkoutSheetPhotoSystemPrompt = `You are a strength coach reading a photographed hand-filled workout sheet. The sheet lists exercises, each followed by numbered boxes where the athlete hand-wrote one performed set per box as reps, optionally with weight (e.g. "8", "10 @ 60", "12x60kg").

Rules:
- Return one item per handwritten set you can read, in sheet order.
- "exercise" must repeat the exercise name exactly as printed on the sheet.
- "set_index" is the 1-based box number within that exercise.
- "reps" is the performed rep count as a non-negative integer. A crossed-out or empty box means the set was not performed — omit it, do not guess.
- "weight" is the performed weight as written, or null when the box shows reps only (bodyweight). "unit" is "kg", "lb", or "" when no weight was written.
- Never invent sets for boxes you cannot read. If the photo shows no readable sets, return an empty items array.`;

export const workoutSheetSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          exercise: { type: 'string' },
          set_index: { type: 'number' },
          reps: { type: 'number' },
          weight: { type: 'number' },
          unit: { type: 'string' },
        },
        required: ['exercise', 'set_index', 'reps'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

// Same constant as web/static/js/core/utils.js KG_PER_LB (targets are stored
// in kg; a sheet printed in lb must convert back on the way in). Mirrored
// here so this module stays importable without the browser core bundle —
// same precedent as web/domain/brief.js's note about the duplicated constant.
const KG_PER_LB = 0.45359237;

const MAX_SETS_PER_SCAN = 200;
const MAX_REPS = 500;
const MAX_WEIGHT_KG = 2000;

function invalid(message, code) {
  const err = new Error(message);
  err.code = code || 'invalid_request';
  return err;
}

const normName = (s) => String(s || '').trim().toLowerCase();

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// planContext is assembled by the caller from the same reads the printed
// sheet used: { groupId, unit: 'kg'|'lb', days: [{ variant: {id,name},
// exercises: [{id, exercise_name, ...}] }] }.
export function convertParsedSheet(parsed, planContext) {
  const items = parsed && Array.isArray(parsed.items) ? parsed.items : null;
  if (!items) throw invalid('AI returned no sheet items', 'no_items');

  const byName = new Map();
  const days = (planContext && Array.isArray(planContext.days)) ? planContext.days : [];
  for (const day of days) {
    const variantId = day && day.variant && day.variant.id;
    for (const ex of ((day && day.exercises) || [])) {
      const key = normName(ex && ex.exercise_name);
      if (key && !byName.has(key)) {
        byName.set(key, { variantId, exerciseId: ex.id, exerciseName: ex.exercise_name });
      }
    }
  }

  const sets = [];
  const skipped = [];
  for (const item of items.slice(0, MAX_SETS_PER_SCAN)) {
    const match = byName.get(normName(item && item.exercise));
    if (!match) {
      const name = String((item && item.exercise) || '').trim();
      if (name && !skipped.includes(name)) skipped.push(name);
      continue;
    }
    const setIndex = Math.trunc(Number(item.set_index));
    const reps = Math.trunc(Number(item.reps));
    if (!Number.isFinite(setIndex) || setIndex < 1 || setIndex > 20) continue;
    if (!Number.isFinite(reps) || reps < 0 || reps > MAX_REPS) continue;
    let weightKg = numOrNull(item.weight);
    if (weightKg !== null) {
      const unit = String(item.unit || '').trim().toLowerCase();
      if (unit === 'lb') weightKg = weightKg * KG_PER_LB;
      else if (unit !== '' && unit !== 'kg') continue;
      if (weightKg < 0 || weightKg > MAX_WEIGHT_KG) continue;
      weightKg = Math.round(weightKg * 100) / 100;
    }
    sets.push({ ...match, setIndex, reps, weightKg });
  }
  return { sets, skipped };
}

export function createWorkoutSheetAIDomain({ aiClient, workoutDomain }) {
  // parseSheetFromPhoto(file, planContext) → { sets, skipped }. Validates but
  // never writes: the UI shows this in the review sheet first.
  async function parseSheetFromPhoto(file, planContext) {
    if (!planContext || !Array.isArray(planContext.days) || planContext.days.length === 0) {
      throw invalid('planContext with days is required');
    }
    const parsed = await aiClient.parseWorkoutSheetImage(file, planContext);
    return convertParsedSheet(parsed, planContext);
  }

  // logSheetAsSession({ planContext, sets, notes }) → { sessionId, logged,
  // failed }. Mirrors the session modal's own writes (logs/create with per-set
  // arrays, source defaulting to 'schedule') and food-AI's per-item
  // failure counting: one bad exercise never blocks the rest, and a re-scan
  // of an already-logged exercise reports failed instead of duplicating
  // (the domain's logs/create conflict guard).
  async function logSheetAsSession({ planContext, sets, notes } = {}) {
    const list = Array.isArray(sets) ? sets : [];
    if (list.length === 0) throw invalid('sets is required', 'no_items');
    const session = await workoutDomain.createAdHocSession({
      notes: notes || 'Scanned from printed sheet',
    });
    const sessionId = session && session.id;
    if (!sessionId) throw invalid('could not open a session', 'save_failed');

    const byExercise = new Map();
    for (const s of list) {
      const key = `${s.variantId}:${s.exerciseId}`;
      if (!byExercise.has(key)) {
        byExercise.set(key, {
          variantId: s.variantId,
          exerciseId: s.exerciseId,
          exerciseName: s.exerciseName,
          sets: [],
        });
      }
      byExercise.get(key).sets.push({
        set_index: s.setIndex,
        reps: s.reps,
        weight_kg: s.weightKg === null || s.weightKg === undefined ? 0 : s.weightKg,
        set_type: 'normal',
      });
    }

    let logged = 0;
    let failed = 0;
    for (const entry of byExercise.values()) {
      const perSet = entry.sets
        .slice()
        .sort((a, b) => a.set_index - b.set_index)
        .slice(0, 20);
      const maxReps = perSet.reduce((m, s) => Math.max(m, s.reps), 0);
      const maxWeight = perSet.reduce((m, s) => Math.max(m, s.weight_kg), 0);
      try {
        await workoutDomain.createLog({
          session_id: sessionId,
          exercise_id: entry.exerciseId,
          exercise_name: entry.exerciseName,
          target_sets: perSet.length,
          target_reps_min: maxReps,
          target_weight_kg: maxWeight,
          status: 'completed',
          notes: '',
          sets: perSet,
        });
        logged += 1;
      } catch {
        failed += 1;
      }
    }
    if (logged === 0) throw invalid('Failed to save any scanned sets', 'save_failed');
    await workoutDomain.setSessionStatus(sessionId, 'completed');
    return { sessionId, logged, failed };
  }

  return { parseSheetFromPhoto, logSheetAsSession };
}
