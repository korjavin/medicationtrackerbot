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
    response_summary: 'Object {period, blood_pressure?, medications?, sleep?, heart_rate?, spo2?, diary_notes?, warning?}. blood_pressure has avg_systolic/avg_diastolic (integer means) + days_measured; medications has adherence_rate (taken/resolved×100) computed over SCHEDULED medications only — an as-needed medication (or one whose schedule cannot be parsed) has no doses to miss, so its intake rows are excluded from the rate entirely, though they still appear in intake_log; sleep has avg_duration_minutes/avg_deep_minutes; heart_rate has avg/min/max/readings_count; spo2 has avg/min/readings_count. A section is omitted (and named in `warning`) when its feature is disabled or it has no data.',
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
    description: 'Dry-run the opt-in progression rules (Phase 4) without saving anything. For every scheduled exercise carrying a progression rule (linear or double), this finds its most recent completed log and computes the suggested next plan target — the same math applied automatically when a session is completed, but read-only. Use it to preview whether the next session will add weight or bump the rep target. Progression is goal-differentiated and RIR-gated: a load bump needs the rep target AND effort near enough to failure for the training goal (RIR = 10 − RPE at or below the goal target — strength 2, hypertrophy/endurance 1, general ungated); a log with no RPE is never gated. Exercises with no rule (or rule "none", which just mirrors last performance) and exercises with no completed log yet are omitted. Computed client-side over your vault.',
    response_summary: 'Object {exercises: [...]}. Each entry has exercise_id, exercise_name, variant_id, rule {type, increment_kg, ...}, training_goal (the effective goal: the exercise override, else its routine\'s), effort (the least-hard work set of the source log as "RPE 8 · 2 RIR", or null when no RPE was logged), current {target_sets, target_reps_min, target_reps_max, target_weight_kg}, proposed (same shape, with the rule applied), and changed (boolean — whether proposed differs from current). changed:false with a high-RIR effort means the RIR gate held the load, not that the reps were missed. An empty exercises array means no rule-carrying exercise has a completed log to project from.',
    params_schema: { type: 'object', properties: {} },
    response_example: {
      exercises: [{
        exercise_id: 12,
        exercise_name: 'Bench Press',
        variant_id: 3,
        rule: { type: 'linear', increment_kg: 2.5 },
        training_goal: 'strength',
        effort: 'RPE 9 · 1 RIR',
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
  // Doctor-visit brief (med-5k6t). Cloud-only for the same reason as the two
  // analyses above: /api/brief is served by apishim.js's createApiRouter over
  // web/domain/brief.js, and the legacy Go server has no handler for it. In the
  // shared registry this op would ride DefaultOperations into bot mode's
  // mcp_help and 404 on every call from the bridge.
  {
    id: 'health.brief',
    topic: 'health',
    method: 'GET',
    path: '/api/brief',
    risk: 'read',
    description: 'Assemble the doctor-visit brief: ONE read folding medications + adherence, blood pressure, weight, sleep/resting-HR vitals, diary notes, and optionally food and workouts over the last 30/90/180 days. Use this instead of chaining health.bp.list + health.weight.list + medications.history when the user asks for an appointment summary or "everything since my last visit". Computed client-side over your vault from the same folds the app screens show, so it can never disagree with them. A selected section with no data yields nulls/empty arrays rather than an error.',
    response_summary: 'Object with range{days,from,to,generated_at} plus one key per SELECTED section: medications[] (name, dosage, schedule_summary, started_at, adherence_pct, as_needed, times_taken) and overall_adherence_pct for meds — an as-needed medication (or one whose schedule cannot be parsed) has as_needed true, adherence_pct null and times_taken = number of doses logged in the window, and is excluded from overall_adherence_pct; adherence_pct/overall_adherence_pct are also null when nothing was scheduled in the window; bp{count, systolic/diastolic/pulse{avg,min,max} or null, goal, readings[] oldest-first}; weight{start,end,delta,unit:"kg",points[]}; vitals{avg_sleep_minutes,resting_hr}; notes[{date,text}] capped at 50. food{days_logged,avg_kcal,avg_protein,avg_carbs,avg_fat,targets} and workouts{session_count,per_week} appear ONLY when named in sections. An unselected section is absent from the response, not null.',
    params_schema: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          enum: [30, 90, 180],
          description: 'Window length in days (default 90). Any other value falls back to 90 rather than erroring.',
        },
        sections: {
          type: 'string',
          description: 'Comma-separated subset of meds,bp,weight,vitals,notes,food,workouts. Default: meds,bp,weight,vitals,notes — food and workouts are opt-in and cost a read only when named. Unknown names are ignored.',
        },
      },
    },
    // Captured from the real router (createApiRouter → /api/brief) against the
    // med-5k6t.1 test vault, default sections.
    response_example: {
      range: {
        days: 90, from: '2026-05-22T12:00:00.000Z', to: '2026-08-20T12:00:00.000Z', generated_at: '2026-08-20T12:00:00.000Z',
      },
      medications: [
        {
          name: 'Ibuprofen', dosage: '200mg', schedule_summary: 'as needed', started_at: '2026-03-01T00:00:00.000Z', adherence_pct: null, as_needed: true, times_taken: 2,
        },
        {
          name: 'Lisinopril', dosage: '10mg', schedule_summary: 'Mon, Thu at 09:00', started_at: '2026-02-01T00:00:00.000Z', adherence_pct: 50, as_needed: false, times_taken: 1,
        },
        {
          name: 'Metformin', dosage: '500mg', schedule_summary: 'daily at 08:00, 20:00', started_at: '2026-01-05T00:00:00.000Z', adherence_pct: 75, as_needed: false, times_taken: 3,
        },
      ],
      // 4 of 6 scheduled doses — the as-needed medication's rows are excluded
      // from the overall rate, not folded in at 100%.
      overall_adherence_pct: 66.7,
      bp: {
        count: 3,
        systolic: { avg: 130, min: 120, max: 140 },
        diastolic: { avg: 85, min: 80, max: 90 },
        pulse: { avg: 65, min: 60, max: 70 },
        goal: { target_systolic: 130, target_diastolic: 85 },
        readings: [
          {
            measured_at: '2026-08-18T09:00:00Z', systolic: 120, diastolic: 80, pulse: 60,
          },
          {
            measured_at: '2026-08-20T09:00:00Z', systolic: 130, diastolic: 85, pulse: null,
          },
        ],
      },
      weight: {
        start: 82,
        end: 80.5,
        delta: -1.5,
        unit: 'kg',
        points: [
          { measured_at: '2026-08-10T12:00:00.000Z', weight: 82 },
          { measured_at: '2026-08-19T12:00:00.000Z', weight: 80.5 },
        ],
      },
      vitals: { avg_sleep_minutes: 450, resting_hr: 60 },
      notes: [{ date: '2026-08-19', text: 'dizzy after the morning dose' }],
    },
  },
];

// CLOUD_EXTRA_PARAMS: params that exist ONLY in cloud mode, merged into the
// generated catalog's schemas at the responder's import site.
//
// `offset` is the paging channel for these lists (med-vgw). It is implemented
// in web/cloud/js/apishim.js's createApiRouter, which is a cloud-mode component
// — the legacy bot server's Go handlers for the same routes parse `limit` (and
// notes' before_id cursor) and ignore `offset` entirely. Declaring it in the
// shared Go registry would therefore advertise a param that silently returns
// page one forever in bot mode, which is worse for an agent than no paging at
// all: it looks like it is walking a history while re-reading the same rows.
// So it lives here, where only cloud consumers see it.
//
// food.products.list / .frequent are deliberately absent: handleGetFoodProducts
// (internal/server/food_handlers.go) really does parse offset, so those two keep
// it in the shared registry where it is true of both modes.
const OFFSET_PARAM = (noun, extra = '') => ({
  type: 'integer',
  minimum: 0,
  description: `${noun} to skip before this page (default 0). Walk the whole history by advancing it `
    + `one page size at a time until a short or empty page comes back.${extra}`,
});

export const CLOUD_EXTRA_PARAMS = {
  'health.bp.list': { offset: OFFSET_PARAM('Readings') },
  'health.weight.list': { offset: OFFSET_PARAM('Entries') },
  'health.notes.list': { offset: OFFSET_PARAM('Notes', ' Prefer before_id when notes may be written while you page.') },
  'health.sleep.list': { offset: OFFSET_PARAM('Sessions') },
  'health.weight.goal.history.list': { offset: OFFSET_PARAM('Goals') },
  'workouts.sessions.list': { offset: OFFSET_PARAM('Sessions') },
  'workouts.miband.list': { offset: OFFSET_PARAM('Workouts') },
};
