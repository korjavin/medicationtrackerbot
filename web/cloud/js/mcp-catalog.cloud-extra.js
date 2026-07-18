// Cloud-only MCP operations that have no Go registry counterpart, merged into
// the responder's CATALOG at its import site (mcp-responder.js). Kept separate
// from mcp-catalog.generated.js — that file is generated from the Go registry
// and drift-guarded by internal/mcp/catalogjs/drift_test.go, so hand-editing it
// fails CI. Extras live here instead (docs/plans/20260717-cloud-analysis-pathb.md).
//
// These two composite analyses mirror bot mode's analyze_cardiovascular /
// analyze_fitness top-level MCP tools (internal/mcp/cardiovascular.go +
// fitness.go), but are computed in-tab over vault data by web/domain/analysis.js
// and served by two routes in apishim.js's createApiRouter. Same op-entry shape
// as the generated catalog: {id, topic, method, path, risk, description,
// response_summary, params_schema, response_example}.

const ANALYSIS_PARAMS = {
  type: 'object',
  properties: {
    start_date: {
      type: 'string',
      description: 'Start date in YYYY-MM-DD format. Defaults to 90 days before end_date if both start_date and days are omitted.',
    },
    end_date: {
      type: 'string',
      description: 'End date in YYYY-MM-DD format. Defaults to today if omitted.',
    },
    days: {
      type: 'integer',
      description: 'Number of days to look back from end_date. Alternative to start_date — e.g. days=30 means last 30 days. Ignored if start_date is provided.',
    },
    exclude_notes: {
      type: 'boolean',
      description: 'If true, omit diary notes from the response. Default false.',
    },
  },
};

export const CLOUD_EXTRA = [
  {
    id: 'health.analyze_cardiovascular',
    topic: 'health',
    method: 'GET',
    path: '/api/health/cardiovascular-analysis',
    risk: 'read',
    description: 'Comprehensive cardiovascular health analysis. Returns blood pressure readings with daily averages, active medications and adherence, sleep duration and quality, heart rate and SpO2 trends, and personal diary notes — all in one call. Maximum 90 days per query. Use this for any question about blood pressure, heart health, medication effects, or sleep quality. Computed client-side over your vault; a disabled/empty section is listed in the `warning` field rather than aborting.',
    response_summary: 'Object {period, blood_pressure?, medications?, sleep?, heart_rate?, spo2?, diary_notes?, warning?}. blood_pressure has avg_systolic/avg_diastolic (integer means) + days_measured; medications has adherence_rate (taken/resolved×100); sleep has avg_duration_minutes/avg_deep_minutes; heart_rate has avg/min/max/readings_count; spo2 has avg/min/readings_count. A section is omitted (and named in `warning`) when its feature is disabled or it has no data.',
    params_schema: ANALYSIS_PARAMS,
    response_example: {
      period: '2026-04-07 to 2026-07-06',
      blood_pressure: {
        readings: [{ measured_at: '2026-07-06T08:00:00Z', systolic: 122, diastolic: 79, pulse: 68 }],
        avg_systolic: 124,
        avg_diastolic: 80,
        days_measured: 12,
      },
      medications: {
        active: [{ name: 'Lisinopril', dosage: '10mg', schedule: '08:00' }],
        intake_log: [{ medication_name: 'Lisinopril', scheduled_at: '2026-07-06T08:00:00Z', status: 'TAKEN' }],
        adherence_rate: 92.5,
      },
      sleep: {
        logs: [{ day: '2026-07-06', total_minutes: 450, deep_minutes: 110 }],
        avg_duration_minutes: 438,
        avg_deep_minutes: 96,
      },
      heart_rate: { avg: 62, min: 48, max: 148, readings_count: 320 },
      spo2: { avg: 97, min: 93, readings_count: 96 },
    },
  },
  {
    id: 'health.analyze_fitness',
    topic: 'health',
    method: 'GET',
    path: '/api/health/fitness-analysis',
    risk: 'read',
    description: 'Comprehensive fitness and nutrition analysis. Returns workout sessions (gym and outdoor), daily step counts, daily calorie/protein/carb/fat totals (food names omitted for privacy), weight trend, and personal diary notes — all in one call. All weights are returned in kilograms (kg) — fields use the _kg suffix (current_kg, change_kg, weight_kg, trend_kg). The user\'s display unit preference does not affect this tool. Maximum 90 days per query. Use this for questions about training, nutrition balance, weight progress, or activity levels. Computed client-side over your vault; a disabled/empty section is listed in the `warning` field rather than aborting.',
    response_summary: 'Object {period, workouts?, steps?, nutrition?, weight?, diary_notes?, warning?}. workouts has total_sessions + completion_rate (completed/total×100, mi-band counted completed); steps has avg_daily_steps over days-with-data; nutrition has avg_daily_calories/avg_daily_protein over per-day macro sums (food names dropped); weight has current_kg/change_kg/trend_direction (gaining/losing/stable ±0.1 kg, or insufficient_data), kg only. A section is omitted (and named in `warning`) when its feature is disabled or it has no data.',
    params_schema: ANALYSIS_PARAMS,
    response_example: {
      period: '2026-04-07 to 2026-07-06',
      workouts: {
        sessions: [{
          type: 'miband', group_name: 'Outdoor Running', scheduled_date: '2026-07-06', status: 'completed', steps: 5400, calories: 320,
        }],
        total_sessions: 8,
        completion_rate: 87.5,
      },
      steps: {
        daily: [{
          date: '2026-07-06', steps: 8421, calories: 2100, distance: 6300,
        }],
        avg_daily_steps: 7800,
      },
      nutrition: {
        daily_totals: [{
          date: '2026-07-06', calories: 2100, protein_g: 120, carbs_g: 210, fat_g: 70,
        }],
        avg_daily_calories: 2050,
        avg_daily_protein: 118,
      },
      weight: {
        logs: [{ measured_at: '2026-07-06', weight_kg: 74.8, trend_kg: 75.1 }],
        current_kg: 74.8,
        change_kg: -1.2,
        trend_direction: 'losing',
      },
    },
  },
  {
    id: 'workouts.progression_preview',
    topic: 'workouts',
    method: 'GET',
    path: '/api/workout/progression-preview',
    risk: 'read',
    description: 'Dry-run the opt-in progression rules (Phase 4) without saving anything. For every scheduled exercise carrying a progression rule (linear or double), this finds its most recent completed log and computes the suggested next plan target — the same math applied automatically when a session is completed, but read-only. Use it to preview whether the next session will add weight or bump the rep target. Exercises with no rule (or rule "none", which just mirrors last performance) and exercises with no completed log yet are omitted. Computed client-side over your vault.',
    response_summary: 'Object {exercises: [...]}. Each entry has exercise_id, exercise_name, variant_id, rule {type, increment_kg, ...}, current {target_sets, target_reps_min, target_reps_max, target_weight_kg}, proposed (same shape, with the rule applied), and changed (boolean — whether proposed differs from current). An empty exercises array means no rule-carrying exercise has a completed log to project from.',
    params_schema: { type: 'object', properties: {} },
    response_example: {
      exercises: [{
        exercise_id: 12,
        exercise_name: 'Bench Press',
        variant_id: 3,
        rule: { type: 'linear', increment_kg: 2.5 },
        current: {
          target_sets: 4, target_reps_min: 6, target_reps_max: 6, target_weight_kg: 60,
        },
        proposed: {
          target_sets: 4, target_reps_min: 6, target_reps_max: 6, target_weight_kg: 62.5,
        },
        changed: true,
      }],
    },
  },
];
