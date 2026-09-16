// Runtime-agnostic exercise-tagging domain module. Pure logic over injected
// ports (aiClient, workoutDomain) — no window/document/fetch/IndexedDB. The
// browser aiClient (web/cloud/js/aiclient.js) does the provider HTTP call;
// this file validates the names going out, the body parts coming back, and
// writes the accepted tags into the exercise library.
//
// Why an LLM at all: the static catalog classifies by ENGLISH name match, so a
// custom or non-English exercise name ("Тяга блока") lands in the Balance
// view's "Uncategorized" bucket forever. Only the exercise NAMES leave the
// vault — never sets, weights or dates (privacy-manifest.js: trial-ai /
// byo-openai).

// Mirrors the FRIENDLY vocabulary in web/static/js/features/workout/
// exercise-catalog.js — the catalog's own body_part values.
export const BODY_PARTS = [
  'chest', 'back', 'shoulders', 'upper arms', 'lower arms',
  'upper legs', 'lower legs', 'waist', 'neck', 'cardio',
];

export const ExerciseTagSystemPrompt = `You are a strength coach. For each exercise name (any language, abbreviations allowed) pick the PRIMARY body part trained, using exactly one of these values:
${BODY_PARTS.map((bp) => `- ${bp}`).join('\n')}

"waist" means core/abs, "upper legs" means quads/hamstrings/glutes, "lower legs" means calves, "cardio" means running/cycling/rowing/swimming and similar.
Return every input name unchanged, in the same order. If a name is not an exercise, return body_part "unknown" for it.`;

export const exerciseTagSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          body_part: { type: 'string', enum: [...BODY_PARTS, 'unknown'] },
        },
        required: ['name', 'body_part'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

// ponytail: one provider call per request; cap keeps the prompt small.
const MAX_NAMES = 100;

function invalid(message) {
  const err = new Error(message);
  err.code = 'invalid_request';
  return err;
}

const norm = (s) => String(s || '').trim().toLowerCase();

export function createExerciseTagDomain({ aiClient, workoutDomain }) {
  // tagExercises(names) → { tagged: [{ name, body_part }], skipped: [name] }.
  // Writes a tag only for names the model resolved to a known body part; the
  // rest are reported back so the UI can say "tag these by hand".
  async function tagExercises(names) {
    const clean = [...new Set((Array.isArray(names) ? names : [])
      .map((n) => String(n || '').trim()).filter(Boolean))];
    if (clean.length === 0) throw invalid('names is required');
    if (clean.length > MAX_NAMES) throw invalid(`at most ${MAX_NAMES} names per request`);

    const parsed = await aiClient.classifyExercises(clean);
    const byName = new Map();
    for (const item of (parsed && Array.isArray(parsed.items) ? parsed.items : [])) {
      const bp = norm(item && item.body_part);
      if (BODY_PARTS.includes(bp)) byName.set(norm(item.name), bp);
    }

    const tagged = [];
    const skipped = [];
    for (const name of clean) {
      const bp = byName.get(norm(name));
      if (!bp) { skipped.push(name); continue; }
      await workoutDomain.setLibraryBodyPart(name, bp);
      tagged.push({ name, body_part: bp });
    }
    return { tagged, skipped };
  }

  return { tagExercises };
}
