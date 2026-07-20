// Runtime-agnostic activity-AI domain module. Pure logic over an injected
// aiClient port — no window/document/fetch/IndexedDB — so it can later run
// inside the Go server via goja (C6). The browser aiClient
// (web/cloud/js/aiclient.js) does the actual provider HTTP calls; this file
// only validates the parsed shape and sums the activity duration.
// Prompt/schema pinned verbatim from internal/ai/openai.go; convertParsedActivity
// mirrors internal/domain/activity_ai.go + internal/bot/activity_commands.go.

// Copied verbatim from internal/ai/openai.go's ParseActivityFromDescription systemPrompt.
export const ActivitySystemPrompt = `You are a fitness expert. Parse a free-text workout description and extract:
- A short descriptive name for the overall session
- A list of exercises performed

For each exercise include:
- name: exercise name
- sets: number of sets (null if not applicable, e.g. cardio)
- reps: reps per set (null if not applicable)
- weight_kg: weight used in kg (null if bodyweight or not applicable)
- duration_minutes: duration in minutes (null if not applicable, e.g. strength exercises)
- notes: any additional notes (empty string if none)

For cardio/swimming/etc: use duration_minutes, leave sets/reps/weight_kg as null.
For strength: use sets/reps and optionally weight_kg, leave duration_minutes as null.
Respond ONLY with the requested JSON schema.`;

// Copied verbatim (JSON-Schema shape) from internal/ai/openai.go's activitySchema.
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
          notes: { type: 'string' },
        },
        required: ['name', 'sets', 'reps', 'weight_kg', 'duration_minutes', 'notes'],
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
// then sum duration_minutes into durationSec (activity_commands.go). The
// per-exercise breakdown is carried through for parity but a manual miband row
// only uses name + total duration.
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
  return { name: parsed.name, exercises: parsed.exercises, durationSec };
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
