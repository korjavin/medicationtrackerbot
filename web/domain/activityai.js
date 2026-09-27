// Runtime-agnostic activity-AI domain module. Pure logic over an injected
// aiClient port — no window/document/fetch/IndexedDB — so it can later run
// inside the Go server via goja (C6). The browser aiClient
// (web/cloud/js/aiclient.js) does the actual provider HTTP calls; this file
// only validates the parsed shape and sums the activity duration + distance.
// Prompt/schema originate from internal/ai/openai.go but DELIBERATELY DIVERGE
// (cloud > bot): the bot schema has no distance field, so bot /activity always
// stores distance_m=0. Cloud asks for a raw distance + distance_unit per
// exercise and converts in convertParsedActivity (med-l8bj), so "/activity 2k
// bicycle" records distance_m=2000 without the model doing arithmetic. Legacy
// distance_m / weight_kg exercise fields are still accepted (old providers,
// cached responses). Do NOT sync this back to the bot Go (med-eas.73) — the
// bot is legacy. convertParsedActivity otherwise mirrors
// internal/domain/activity_ai.go + internal/bot/activity_commands.go.

// Based on internal/ai/openai.go's ParseActivityFromDescription systemPrompt,
// plus the cloud-only raw distance/weight instructions (see file header): the
// model echoes numbers and units as stated, code owns the conversion.
export const ActivitySystemPrompt = `You are a fitness expert. Parse a free-text workout description and extract:
- A short descriptive name for the overall session
- A list of exercises performed

For each exercise include:
- name: exercise name
- sets: number of sets (null if not applicable, e.g. cardio)
- reps: reps per set (null if not applicable)
- weight: weight used, exactly as stated (null if bodyweight or not applicable)
- weight_unit: "kg", "lb", or "" when weight is null. Never convert — return the number and unit as stated ("135lb" -> weight 135, weight_unit "lb").
- duration_minutes: duration in minutes (null if not applicable, e.g. strength exercises)
- distance: distance covered, exactly as stated (null if none stated)
- distance_unit: "m", "km", "mi", or "" when distance is null. Never convert — return the number and unit as stated ("2km" -> distance 2, distance_unit "km"; "5 mi" -> distance 5, distance_unit "mi").
- notes: any additional notes (empty string if none)

For cardio/swimming/etc: use duration_minutes, leave sets/reps/weight as null.
For strength: use sets/reps and optionally weight, leave duration_minutes as null.`;

// Based on internal/ai/openai.go's activitySchema, with the cloud-only
// distance + distance_unit and weight + weight_unit fields in place of the
// bot's weight_kg (see file header — deliberate divergence from the bot).
export const activitySchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    exercises: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          sets: { type: ['number', 'null'] },
          reps: { type: ['number', 'null'] },
          weight: { type: ['number', 'null'] },
          weight_unit: { type: 'string' },
          duration_minutes: { type: ['number', 'null'] },
          distance: { type: ['number', 'null'] },
          distance_unit: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['name', 'sets', 'reps', 'weight', 'weight_unit', 'duration_minutes', 'distance', 'distance_unit', 'notes'],
        additionalProperties: false,
      },
    },
  },
  required: ['name', 'exercises'],
  additionalProperties: false,
};

// mirrors maxFoodDescriptionLength (food_handlers.go) — same 4 KiB cap on the
// free-text description sent to the provider.
const MAX_DESCRIPTION_BYTES = 4096;

// Meters per distance_unit: metric (m/km, plus the colloquial "k") and US
// customary (mi/yd/ft). The
// prompt names m/km/mi/"" as the vocabulary and the schema types the unit as
// a plain string (workoutsheet.js precedent), so spelled-out and customary
// forms normalize here — the fenced-prompt fallback path has no schema
// enforcement at all. Code owns unit interpretation; the model just echoes
// what was stated. Unit "" is the stated-nothing marker; a bare number with
// "" reads as meters, the same way workoutsheet.js reads a bare weight as kg.
// Null-prototype map (mcp-responder.js precedent): a provider-echoed unit like
// "constructor" must resolve to undefined, not an inherited property.
const DISTANCE_TO_M = Object.assign(Object.create(null), {
  '': 1,
  m: 1, meter: 1, meters: 1,
  km: 1000, k: 1000, kilometer: 1000, kilometers: 1000,
  mi: 1609.344, mile: 1609.344, miles: 1609.344,
  yd: 0.9144, yard: 0.9144, yards: 0.9144,
  ft: 0.3048, foot: 0.3048, feet: 0.3048,
});

function invalid(message, code) {
  const err = new Error(message);
  err.code = code || 'invalid_request';
  return err;
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// exerciseDistanceM converts one exercise's stated distance to whole meters.
// The new shape (distance + distance_unit) wins when present; otherwise the
// legacy distance_m field passes through untouched so providers or cached
// responses that still return it keep working. An unrecognised unit falls
// back to legacy too — the number's scale is unknown, so it must not be
// summed raw.
function exerciseDistanceM(ex) {
  const stated = numOrNull(ex && ex.distance);
  if (stated !== null) {
    const factor = DISTANCE_TO_M[String((ex && ex.distance_unit) || '').trim().toLowerCase()];
    if (factor !== undefined) return Math.round(stated * factor);
  }
  const legacy = numOrNull(ex && ex.distance_m);
  return legacy === null ? 0 : legacy;
}

// convertParsedActivity mirrors internal/domain/activity_ai.go: reject a nil /
// nameless parse, reject an empty exercises list (Go's len(Exercises)==0 error),
// then sum duration_minutes into durationSec (activity_commands.go) and the
// stated distance into distanceM via exerciseDistanceM (cloud-only, see file
// header). A manual miband row carries name + total duration + total distance,
// so the per-exercise breakdown is validated (must be non-empty) but otherwise
// reduced; weight fields (new or legacy) are accepted and ignored, as before —
// the win is the model no longer does lb→kg arithmetic to produce them.
export function convertParsedActivity(parsed) {
  if (!parsed || !parsed.name) {
    throw invalid('AI returned no activity', 'no_activity');
  }
  if (!Array.isArray(parsed.exercises) || parsed.exercises.length === 0) {
    throw invalid('AI returned no exercises', 'no_exercises');
  }
  const durationSec = parsed.exercises.reduce(
    (sum, ex) => sum + (ex.duration_minutes || 0) * 60,
    0,
  );
  const distanceM = parsed.exercises.reduce(
    (sum, ex) => sum + exerciseDistanceM(ex),
    0,
  );
  return { name: parsed.name, durationSec, distanceM };
}

// createActivityAIDomain builds the activity-AI API over the injected aiClient:
//   aiClient — { parseActivityFromDescription(text) } resolving to a parsed
//              ActivityData ({name, exercises:[...]}); throws with .code
//              'no_api_key' / 'trial_consent_required' when no provider key is
//              usable — no HTTP call is attempted in that case.
export function createActivityAIDomain({ aiClient }) {
  async function parseActivityFromDescription(description) {
    const trimmed = (description || '').trim();
    if (!trimmed) throw invalid('Description is required');
    if (new TextEncoder().encode(trimmed).length > MAX_DESCRIPTION_BYTES) {
      throw invalid(`Description too long (max ${MAX_DESCRIPTION_BYTES} bytes)`);
    }
    const parsed = await aiClient.parseActivityFromDescription(trimmed);
    return convertParsedActivity(parsed);
  }

  return { parseActivityFromDescription };
}
