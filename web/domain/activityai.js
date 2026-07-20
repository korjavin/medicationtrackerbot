// Runtime-agnostic activity-AI domain module. Pure logic over an injected
// aiClient port — no window/document/fetch/IndexedDB — so it can later run
// inside the Go server via goja (C6). The browser aiClient
// (web/cloud/js/aiclient.js) does the actual provider HTTP calls; this file
// only validates the parsed shape and sums the activity duration + distance.
// Prompt/schema originate from internal/ai/openai.go but DELIBERATELY DIVERGE
// (cloud > bot): the bot schema has no distance field, so bot /activity always
// stores distance_m=0. Cloud extracts a per-exercise distance_m and sums it, so
// "/activity 2k bicycle" records distance_m=2000. Do NOT sync this back to the
// bot Go (med-eas.73) — the bot is legacy. convertParsedActivity otherwise
// mirrors internal/domain/activity_ai.go + internal/bot/activity_commands.go.

// Based on internal/ai/openai.go's ParseActivityFromDescription systemPrompt,
// plus the cloud-only distance_m instruction (see file header).
export const ActivitySystemPrompt = `You are a fitness expert. Parse a free-text workout description and extract:
- A short descriptive name for the overall session
- A list of exercises performed

For each exercise include:
- name: exercise name
- sets: number of sets (null if not applicable, e.g. cardio)
- reps: reps per set (null if not applicable)
- weight_kg: weight used in kg (null if bodyweight or not applicable)
- duration_minutes: duration in minutes (null if not applicable, e.g. strength exercises)
- distance_m: distance covered in METERS (null if none stated). Convert any stated distance to meters: "2km" -> 2000, "5 mi" -> 8047, "800m" -> 800, "1.5 miles" -> 2414.
- notes: any additional notes (empty string if none)

For cardio/swimming/etc: use duration_minutes, leave sets/reps/weight_kg as null.
For strength: use sets/reps and optionally weight_kg, leave duration_minutes as null.
Respond ONLY with the requested JSON schema.`;

// Based on internal/ai/openai.go's activitySchema, extended with the cloud-only
// distance_m field (see file header — deliberate divergence from the bot).
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
          weight_kg: { type: ['number', 'null'] },
          duration_minutes: { type: ['number', 'null'] },
          distance_m: { type: ['number', 'null'] },
          notes: { type: 'string' },
        },
        required: ['name', 'sets', 'reps', 'weight_kg', 'duration_minutes', 'distance_m', 'notes'],
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

function invalid(message, code) {
  const err = new Error(message);
  err.code = code || 'invalid_request';
  return err;
}

// convertParsedActivity mirrors internal/domain/activity_ai.go: reject a nil /
// nameless parse, reject an empty exercises list (Go's len(Exercises)==0 error),
// then sum duration_minutes into durationSec (activity_commands.go) and
// distance_m into distanceM (cloud-only, see file header). A manual miband row
// carries name + total duration + total distance, so the per-exercise breakdown
// is validated (must be non-empty) but otherwise reduced.
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
    (sum, ex) => sum + (ex.distance_m || 0),
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
