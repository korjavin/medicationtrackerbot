// Focused integration tests for the extracted features/workout/stats.js
// sub-file. Covers the WorkoutStats public-API surface and the localStorage-
// persisted range selector.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { idle, signal } from './helpers/settle.js';
import * as WorkoutAnalysis from '../../../../web/domain/workout-analysis.js';

describe('features/workout/stats.js — split-file integration', () => {
  let env;
  let consoleErrorSpy;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    env = loadFrontendEnv({ withWorkout: true });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
    env.cleanup();
    env = null;
  });

  it('exposes the WorkoutStats public-API namespace', () => {
    const { window } = env;
    expect(window.WorkoutStats).toBeTypeOf('object');
    expect(window.WorkoutStats.load).toBeTypeOf('function');
    expect(window.WorkoutStats.getRange).toBeTypeOf('function');
    expect(window.WorkoutStats.setRange).toBeTypeOf('function');
  });

  it('getRange defaults to "all" when no value is stored', () => {
    const { window } = env;
    expect(window.WorkoutStats.getRange()).toBe('all');
  });

  it('setRange persists a valid value and getRange returns it', () => {
    const { window } = env;
    window.WorkoutStats.setRange('30d');
    expect(window.WorkoutStats.getRange()).toBe('30d');
    expect(window.localStorage.getItem('mt-workouts-stats-range')).toBe('30d');
  });

  it('setRange rejects invalid range values', () => {
    const { window } = env;
    window.WorkoutStats.setRange('7d');
    expect(window.WorkoutStats.getRange()).toBe('7d');

    window.WorkoutStats.setRange('nope');
    // Unchanged
    expect(window.WorkoutStats.getRange()).toBe('7d');
  });

  // med-s5m.3 — body-part split derived from the range's exercise totals
  // matched against the static catalog, client-side. med-zte moved the split
  // out of the Consistency view (the Balance view already owned it, so it was
  // rendering twice), hence every case here selects Balance first.
  describe('body-part split (med-s5m.3)', () => {
    const CATALOG = {
      exercises: [
        { name: 'Barbell Squat', body_part: 'upper legs' },
        { name: 'Bench Press', body_part: 'chest' },
      ],
    };

    // med-tc1.10 — `fetched` fires from inside the mock the moment the catalog
    // request is issued (the #716 pattern), so cases that need "the catalog
    // round-trip has started" get a fact instead of a `setTimeout(r, 0)` guess.
    function stubCatalog(window, response) {
      const fetched = signal();
      window.fetch = vi.fn(async (url) => {
        if (String(url).includes('/static/data/exercises-catalog.json')) {
          fetched.fire();
          return response;
        }
        return { ok: true, status: 200, json: async () => ({}) };
      });
      return fetched;
    }

    // The Balance view is the split's only home now; it folds on working SETS
    // (Hevy's per-muscle-group volume unit), so the fixtures carry `sets`.
    function renderBalance(window, document, exercise_totals) {
      window.WorkoutStats.setView('balance');
      const container = document.getElementById('workout-stats-display');
      window._renderWorkoutStats(container, { total_sessions: 6, exercise_totals });
      return container;
    }

    it('buckets logged exercises by catalog body_part, case-insensitively, with an uncategorized fallback', async () => {
      const { window, document } = env;
      stubCatalog(window, { ok: true, status: 200, json: async () => CATALOG });

      const container = renderBalance(window, document, [
        { exercise_name: 'barbell squat', session_count: 3, sets: 9, total_volume_kg: 1000 }, // lower-cased -> upper legs
        { exercise_name: 'Bench Press', session_count: 2, sets: 6, total_volume_kg: 800 },     // chest
        { exercise_name: 'Mystery Move', session_count: 1, sets: 2, total_volume_kg: 50 },     // no match -> uncategorized
      ]);

      await vi.waitFor(() => {
        expect(container.querySelector('.wg-workouts-stats__body-split')).toBeTruthy();
      });
      const labels = Array.from(
        container.querySelectorAll('.wg-workouts-stats__body-split .wg-workouts-stats__top-row-name')
      ).map((n) => n.textContent);
      expect(labels).toEqual(['Legs', 'Chest', 'Uncategorized']); // friendly labels, sorted by sets desc
    });

    it('renders no split section when the range holds no exercises (and does not fetch the catalog)', async () => {
      const { window, document } = env;
      stubCatalog(window, { ok: true, status: 200, json: async () => CATALOG });

      const container = renderBalance(window, document, []);

      // Nothing async is supposed to happen here at all, so there is no progress
      // point to latch onto — the barrier has to be pure WORK. Each idle round
      // drains the whole microtask queue, so a render that reached its
      // `await load()` (i.e. checked for an empty list too late) would have
      // issued the catalog fetch well before the assertions below.
      await idle();
      expect(container.querySelector('.wg-workouts-stats__body-split')).toBeNull();
      const catalogFetches = window.fetch.mock.calls.filter((c) => String(c[0]).includes('exercises-catalog.json'));
      expect(catalogFetches).toHaveLength(0);
    });

    it('buckets bare logged names via fuzzy token-overlap against verbose catalog entries', async () => {
      const { window, document } = env;
      // Only verbose forms exist as exact keys — bare logged names miss exact and
      // must resolve by whole-word token overlap (plurality body_part).
      const VERBOSE = {
        exercises: [
          { name: 'Barbell Bench Press', body_part: 'chest' },
          { name: 'Barbell Squat', body_part: 'upper legs' },
          { name: 'Barbell Deadlift', body_part: 'upper legs' },
          { name: 'Front Plank', body_part: 'waist' },
        ],
      };
      stubCatalog(window, { ok: true, status: 200, json: async () => VERBOSE });

      const container = renderBalance(window, document, [
        { exercise_name: 'bench press', session_count: 4, sets: 12, total_volume_kg: 900 }, // fuzzy -> chest
        { exercise_name: 'squat', session_count: 3, sets: 9, total_volume_kg: 800 },        // fuzzy -> upper legs
        { exercise_name: 'deadlift', session_count: 2, sets: 6, total_volume_kg: 700 },     // fuzzy -> upper legs
        { exercise_name: 'plank', session_count: 1, sets: 3, total_volume_kg: 10 },         // fuzzy -> waist
        { exercise_name: 'Mystery Move', session_count: 1, sets: 3, total_volume_kg: 5 },   // no overlap -> uncategorized
      ]);

      await vi.waitFor(() => {
        expect(container.querySelector('.wg-workouts-stats__body-split')).toBeTruthy();
      });
      const labels = Array.from(
        container.querySelectorAll('.wg-workouts-stats__body-split .wg-workouts-stats__top-row-name')
      ).map((n) => n.textContent);
      // squat + deadlift collapse into one Legs bucket (5 sessions); chest 4; core 1; unknown 1.
      expect(labels).toEqual(['Legs', 'Chest', 'Core', 'Uncategorized']);
    });

    it('a failed catalog fetch is silent — stats still render, no split section', async () => {
      const { window, document } = env;
      const fetched = stubCatalog(window, { ok: false, status: 500, json: async () => ({}) });

      const container = renderBalance(window, document, [
        { exercise_name: 'Bench Press', session_count: 1, sets: 3, total_volume_kg: 100 },
      ]);

      // `fetched` proves the catalog load ran (so the failure path is genuinely
      // exercised); `idle()` then lets the .catch → empty-Map → skip tail finish
      // — a split section that was going to render has rendered by then.
      await fetched.wait;
      await idle();
      expect(container.querySelector('.wg-workouts-stats')).toBeTruthy(); // base stats rendered
      expect(container.querySelector('.wg-workouts-stats__body-split')).toBeNull();
      expect(container.querySelector('.wg-workouts-stats__empty').textContent)
        .toMatch(/body-part catalog unavailable/i);
    });
  });

  // med-904.3 — Balance view v2: the movement-pattern ratios and the
  // own-baseline hard-set band, both appended below the body-part split.
  describe('balance view v2 (med-904.3)', () => {
    // One entry per pattern the ratios fold, plus a core move that has none.
    const PATTERN_CATALOG = {
      exercises: [
        { name: 'Barbell Row', body_part: 'back' },          // pull
        { name: 'Bench Press', body_part: 'chest' },         // push
        { name: 'Romanian Deadlift', body_part: 'upper legs' }, // hinge
        { name: 'Barbell Squat', body_part: 'upper legs' },  // squat
        { name: 'Front Plank', body_part: 'waist' },         // no pattern
      ],
    };

    function stubCatalog(window, exercises) {
      window.fetch = vi.fn(async (url) => {
        if (String(url).includes('/static/data/exercises-catalog.json')) {
          return { ok: true, status: 200, json: async () => ({ exercises }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      });
    }

    function renderBalanceV2(window, document, stats) {
      window.WorkoutStats.setView('balance');
      const container = document.getElementById('workout-stats-display');
      window._renderWorkoutStats(container, { total_sessions: 6, ...stats });
      return container;
    }

    function rowsIn(container, block) {
      return Array.from(container.querySelectorAll(`.wg-workouts-stats__${block} .wg-workouts-stats__top-row`))
        .map((r) => r.textContent);
    }

    it('folds working sets into Pull:Push and Hinge:Squat rows', async () => {
      const { window, document } = env;
      stubCatalog(window, PATTERN_CATALOG.exercises);

      const container = renderBalanceV2(window, document, {
        exercise_totals: [
          { exercise_name: 'Barbell Row', session_count: 4, sets: 12, total_volume_kg: 1200 },
          { exercise_name: 'Bench Press', session_count: 3, sets: 10, total_volume_kg: 1000 },
          { exercise_name: 'Barbell Squat', session_count: 3, sets: 9, total_volume_kg: 2000 },
          { exercise_name: 'Romanian Deadlift', session_count: 2, sets: 6, total_volume_kg: 1500 },
          { exercise_name: 'Front Plank', session_count: 2, sets: 4, total_volume_kg: 0 }, // no pattern
        ],
      });

      await vi.waitFor(() => {
        expect(container.querySelector('.wg-workouts-stats__movement-balance')).toBeTruthy();
      });
      const rows = rowsIn(container, 'movement-balance');
      expect(rows).toHaveLength(2);
      expect(rows[0]).toContain('Pull : Push');
      expect(rows[0]).toContain('12 : 10 sets · 1.2:1');
      expect(rows[1]).toContain('Hinge : Squat');
      expect(rows[1]).toContain('6 : 9 sets · 0.7:1');
    });

    it('reads as designed copy, not an error, when nothing maps to a pattern', async () => {
      const { window, document } = env;
      stubCatalog(window, PATTERN_CATALOG.exercises);

      const container = renderBalanceV2(window, document, {
        exercise_totals: [
          { exercise_name: 'Front Plank', session_count: 2, sets: 4, total_volume_kg: 0 },
        ],
      });

      await vi.waitFor(() => {
        expect(container.textContent).toContain('Movement Balance');
      });
      expect(container.querySelector('.wg-workouts-stats__movement-balance')).toBeNull();
      expect(container.textContent).toContain('Keep logging to unlock movement balance');
    });

    it('names the band verdict and the user\'s own range', async () => {
      const { window, document } = env;
      stubCatalog(window, PATTERN_CATALOG.exercises);

      const container = renderBalanceV2(window, document, {
        exercise_totals: [
          { exercise_name: 'Barbell Squat', session_count: 3, sets: 9, total_volume_kg: 2000 },
        ],
        hard_set_band: { current: 26, baseline: 25.3, low: 20, high: 30, status: 'in_range' },
      });

      await vi.waitFor(() => {
        expect(container.querySelector('.wg-workouts-stats__hard-set-band')).toBeTruthy();
      });
      const rows = rowsIn(container, 'hard-set-band');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toContain('In your usual range');
      expect(rows[0]).toContain('26 sets · usual 20–30');
      expect(container.textContent).toContain('Hard Sets · Last 7 Days');
    });

    it('says "below"/"above" off the domain-computed status', async () => {
      const { window, document } = env;
      stubCatalog(window, PATTERN_CATALOG.exercises);

      for (const [status, copy] of [['below', 'Below your usual'], ['above', 'Above your usual']]) {
        const container = renderBalanceV2(window, document, {
          exercise_totals: [
            { exercise_name: 'Barbell Squat', session_count: 3, sets: 9, total_volume_kg: 2000 },
          ],
          hard_set_band: { current: 4, baseline: 25.3, low: 20, high: 30, status },
        });
        await vi.waitFor(() => {
          expect(container.querySelector('.wg-workouts-stats__hard-set-band')).toBeTruthy();
        });
        expect(rowsIn(container, 'hard-set-band')[0]).toContain(copy);
      }
    });

    // The band is whole-history, range-independent and catalog-free, so an
    // unrelated failure on the body-part side must not take it down with it.
    it('still shows the band when the catalog fetch fails', async () => {
      const { window, document } = env;
      window.fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));

      const container = renderBalanceV2(window, document, {
        exercise_totals: [
          { exercise_name: 'Barbell Squat', session_count: 3, sets: 9, total_volume_kg: 2000 },
        ],
        hard_set_band: { current: 40, baseline: 25.3, low: 20, high: 30, status: 'above' },
      });

      await vi.waitFor(() => {
        expect(container.querySelector('.wg-workouts-stats__hard-set-band')).toBeTruthy();
      });
      // The body-part side still says why it skipped.
      expect(container.textContent).toContain('Body-part catalog unavailable');
      expect(rowsIn(container, 'hard-set-band')[0]).toContain('Above your usual');
    });

    it('invites more logging rather than erroring when there is no baseline yet', async () => {
      const { window, document } = env;
      stubCatalog(window, PATTERN_CATALOG.exercises);

      const container = renderBalanceV2(window, document, {
        exercise_totals: [
          { exercise_name: 'Barbell Squat', session_count: 3, sets: 9, total_volume_kg: 2000 },
        ],
        hard_set_band: null,
      });

      await vi.waitFor(() => {
        expect(container.textContent).toContain('Hard Sets · Last 7 Days');
      });
      expect(container.querySelector('.wg-workouts-stats__hard-set-band')).toBeNull();
      expect(container.textContent).toContain('Keep logging to unlock your usual range');
    });
  });

  // med-mj4 — shared catalog helper: single-flight fetch + medical→friendly
  // body-part translation reused by the Stats split and the session-card chip.
  describe('WorkoutExerciseCatalog', () => {
    it('friendlyBodyPart maps every medical value to its friendly name, null otherwise', () => {
      const { window } = env;
      const f = window.WorkoutExerciseCatalog.friendlyBodyPart;
      expect(f('upper legs')).toBe('Legs');
      expect(f('lower legs')).toBe('Calves');
      expect(f('waist')).toBe('Core');
      expect(f('upper arms')).toBe('Arms');
      expect(f('lower arms')).toBe('Forearms');
      expect(f('chest')).toBe('Chest');
      expect(f('back')).toBe('Back');
      expect(f('shoulders')).toBe('Shoulders');
      expect(f('neck')).toBe('Neck');
      expect(f('cardio')).toBe('Cardio');
      expect(f('uncategorized')).toBeNull();
      expect(f('nonsense')).toBeNull();
    });

    it('getBodyPart is case-insensitive and null for names absent from the catalog', async () => {
      const { window } = env;
      window.fetch = vi.fn(async () => ({
        ok: true, status: 200,
        json: async () => ({ exercises: [{ name: 'Barbell Squat', body_part: 'upper legs' }] }),
      }));
      expect(await window.WorkoutExerciseCatalog.getBodyPart('BARBELL squat')).toBe('upper legs');
      expect(await window.WorkoutExerciseCatalog.getBodyPart('Unknown Move')).toBeNull();
    });

    it('resolveBodyPart matches bare names via token overlap and returns null for noise/unknown', async () => {
      const { window } = env;
      window.fetch = vi.fn(async () => ({
        ok: true, status: 200,
        json: async () => ({ exercises: [
          { name: 'Barbell Bench Press', body_part: 'chest' },
          { name: 'Front Plank', body_part: 'waist' },
        ] }),
      }));
      await window.WorkoutExerciseCatalog.load();
      const resolve = window.WorkoutExerciseCatalog.resolveBodyPart;
      // Bare logged name resolves via the verbose catalog entry's shared tokens.
      expect(resolve('bench press')).toBe('chest');
      expect(await window.WorkoutExerciseCatalog.getBodyPart('plank')).toBe('waist');
      // Only-short-token / no-overlap queries do not spuriously match.
      expect(resolve('up ab')).toBeNull();      // 2-char tokens dropped -> no votes
      expect(resolve('Mystery Move')).toBeNull(); // real tokens, none in catalog
    });

    it('resolveBodyPart: a popular shared token does not outvote the identifying one', async () => {
      const { window } = env;
      // "press" is the head noun in many chest entries; "leg press" must still land
      // on the leg entry via subset match, not get pulled to chest by token frequency.
      window.fetch = vi.fn(async () => ({
        ok: true, status: 200,
        json: async () => ({ exercises: [
          { name: 'Barbell Bench Press', body_part: 'chest' },
          { name: 'Dumbbell Chest Press', body_part: 'chest' },
          { name: 'Machine Leg Press', body_part: 'upper legs' },
        ] }),
      }));
      await window.WorkoutExerciseCatalog.load();
      const resolve = window.WorkoutExerciseCatalog.resolveBodyPart;
      expect(resolve('leg press')).toBe('upper legs');
      expect(resolve('bench press')).toBe('chest');
    });

    it('resolveBodyPart: a strict cross-body-part vote tie resolves to null', async () => {
      const { window } = env;
      // "raise" is a subset of both entries, one vote each across different body
      // parts -> plurality tie -> uncategorized, not an arbitrary pick.
      window.fetch = vi.fn(async () => ({
        ok: true, status: 200,
        json: async () => ({ exercises: [
          { name: 'Lateral Raise', body_part: 'shoulders' },
          { name: 'Calf Raise', body_part: 'lower legs' },
        ] }),
      }));
      await window.WorkoutExerciseCatalog.load();
      expect(window.WorkoutExerciseCatalog.resolveBodyPart('raise')).toBeNull();
    });

    it('resolveBodyPart: a clear plurality wins even after an interim tie', async () => {
      const { window } = env;
      // "barbell" is a subset of all six entries. Tally in first-seen (Map) order is
      // chest=2, back=2, upper legs=3 — the max loop must flag the chest/back tie and
      // then reset it when upper legs (the true plurality, >=2 votes) is reached.
      window.fetch = vi.fn(async () => ({
        ok: true, status: 200,
        json: async () => ({ exercises: [
          { name: 'Barbell Bench Press', body_part: 'chest' },
          { name: 'Barbell Bent Row', body_part: 'back' },
          { name: 'Barbell Squat', body_part: 'upper legs' },
          { name: 'Barbell Incline Press', body_part: 'chest' },
          { name: 'Barbell Pendlay Row', body_part: 'back' },
          { name: 'Barbell Deadlift', body_part: 'upper legs' },
          { name: 'Barbell Lunge', body_part: 'upper legs' },
        ] }),
      }));
      await window.WorkoutExerciseCatalog.load();
      expect(window.WorkoutExerciseCatalog.resolveBodyPart('barbell')).toBe('upper legs');
    });

    // med-904.3 — the movement pattern is derived from the name, so the leg
    // rules have to win over the arm ones: "leg curl" is a hinge, not a pull,
    // and "leg press" is a squat, not a push. Body parts that have no pattern
    // at all (core, calves, cardio) resolve to null rather than to a guess.
    it('resolveMovementPattern derives push/pull/hinge/squat, legs before arms', async () => {
      const { window } = env;
      window.fetch = vi.fn(async () => ({
        ok: true, status: 200,
        json: async () => ({ exercises: [
          { name: 'Lying Leg Curl', body_part: 'upper legs' },
          { name: 'Machine Leg Press', body_part: 'upper legs' },
          { name: 'Barbell Biceps Curl', body_part: 'upper arms' },
          { name: 'Lat Pulldown', body_part: 'back' },
          { name: 'Overhead Press', body_part: 'shoulders' },
          { name: 'Glute-Ham Raise', body_part: 'upper legs' },
          { name: 'Sled Leg Wide Press', body_part: 'upper legs' },
          { name: 'Machine Chest Press', body_part: 'chest' },
          { name: 'Standing Calf Raise', body_part: 'lower legs' },
          { name: 'Front Plank', body_part: 'waist' },
        ] }),
      }));
      await window.WorkoutExerciseCatalog.load();
      const move = window.WorkoutExerciseCatalog.resolveMovementPattern;
      expect(move('Lying Leg Curl')).toEqual({ pattern: 'hinge', axis: null });
      expect(move('Machine Leg Press')).toEqual({ pattern: 'squat', axis: null });
      expect(move('Glute-Ham Raise')).toEqual({ pattern: 'hinge', axis: null });
      // A leg exercise no leg rule matches goes UNCOUNTED — falling through to
      // the generic upper-body rules would file this "press" as a push,
      // inflating Pull:Push with sets that belong to Hinge:Squat.
      expect(move('Sled Leg Wide Press')).toBeNull();
      // "maCHINe" must not read as a chin-up.
      expect(move('Machine Chest Press')).toEqual({ pattern: 'push', axis: 'horizontal' });
      expect(move('Barbell Biceps Curl')).toEqual({ pattern: 'pull', axis: null });
      expect(move('Lat Pulldown')).toEqual({ pattern: 'pull', axis: 'vertical' });
      expect(move('Overhead Press')).toEqual({ pattern: 'push', axis: 'vertical' });
      // No pattern: not every exercise is one of the four.
      expect(move('Standing Calf Raise')).toBeNull();
      expect(move('Front Plank')).toBeNull();
      expect(move('Unknown Move')).toBeNull();
    });

    it('fetches the catalog at most once across repeated getBodyPart/load calls', async () => {
      const { window } = env;
      window.fetch = vi.fn(async () => ({
        ok: true, status: 200,
        json: async () => ({ exercises: [{ name: 'Bench Press', body_part: 'chest' }] }),
      }));
      await window.WorkoutExerciseCatalog.load();
      await window.WorkoutExerciseCatalog.getBodyPart('bench press');
      await window.WorkoutExerciseCatalog.getBodyPart('missing');
      const catalogFetches = window.fetch.mock.calls.filter((c) => String(c[0]).includes('exercises-catalog.json'));
      expect(catalogFetches).toHaveLength(1);
    });
  });

  // Phase 3 (epic med-qj4) — per-exercise detail view + PR cue.
  describe('per-exercise detail view (Phase 3)', () => {
    it('exposes the WorkoutExerciseDetail public-API surface', () => {
      const { window } = env;
      expect(window.WorkoutExerciseDetail).toBeTypeOf('object');
      expect(window.WorkoutExerciseDetail.open).toBeTypeOf('function');
      expect(window.WorkoutExerciseDetail.renderDetail).toBeTypeOf('function');
      expect(window.WorkoutExerciseDetail.isPRLog).toBeTypeOf('function');
    });

    it('renderDetail paints the records summary + est-1RM/top-weight graphs', () => {
      const { window, document } = env;
      const root = document.createElement('div');
      const prs = {
        heaviest_weight: 100,
        best_est_1rm: 116.67,
        best_set_volume: 500,
        best_session_volume: 1500,
        most_reps: 8,
        set_records: {},
      };
      const series = [
        { date: '2026-01-01', est_1rm: 100, top_weight: 90, volume: 900 },
        { date: '2026-01-08', est_1rm: 116.67, top_weight: 100, volume: 1500 },
      ];
      window.WorkoutExerciseDetail.renderDetail(root, 'Bench Press', prs, series);

      // Records summary present with the folded values.
      const recordNames = Array.from(root.querySelectorAll('.wg-workouts-exercise-detail__record .wg-workouts-stats__top-row-name'))
        .map((n) => n.textContent);
      expect(recordNames).toContain('Heaviest weight');
      expect(recordNames).toContain('Best est. 1RM');
      expect(root.textContent).toContain('116.7 kg'); // _fmtWeight renders 1dp

      // Two progress graphs rendered (est-1RM + top-weight).
      expect(root.querySelectorAll('.wg-workouts-exercise-detail__chart').length).toBe(2);
      expect(root.querySelectorAll('.wg-workout-chart').length).toBe(2);
    });

    it('open() fetches history, folds via workout-analysis, and mounts the detail view', async () => {
      const { window, document } = env;
      window.WorkoutAnalysis = WorkoutAnalysis; // inject the real pure module
      const history = [
        { date: '2026-01-01', session_id: 1, sets: [{ set_index: 0, weight_kg: 80, reps: 5, set_type: 'normal' }] },
        { date: '2026-01-08', session_id: 2, sets: [{ set_index: 0, weight_kg: 100, reps: 5, set_type: 'normal' }] },
      ];
      window.apiCall = vi.fn(async (url) => {
        if (String(url).includes('/api/workout/exercises/history')) return history;
        return null;
      });

      await window.WorkoutExerciseDetail.open('Bench Press');

      const container = document.getElementById('workout-stats-display');
      expect(container.querySelector('.wg-workouts-exercise-detail')).toBeTruthy();
      expect(container.textContent).toContain('Bench Press');
      // Heaviest weight across history is 100 kg.
      expect(container.textContent).toContain('100 kg');
      expect(container.querySelectorAll('.wg-workout-chart').length).toBe(2);
    });

    it('isPRLog reports a record only when a set beats the prior baseline', () => {
      const { window } = env;
      const priorPRs = WorkoutAnalysis.exercisePRs([
        { sets: [{ weight_kg: 90, reps: 5, set_type: 'normal' }] },
      ]);
      const beats = { sets: [{ weight_kg: 100, reps: 5, set_type: 'normal' }] };
      const ties = { sets: [{ weight_kg: 90, reps: 5, set_type: 'normal' }] };
      expect(window.WorkoutExerciseDetail.isPRLog(beats, priorPRs, WorkoutAnalysis)).toBe(true);
      expect(window.WorkoutExerciseDetail.isPRLog(ties, priorPRs, WorkoutAnalysis)).toBe(false);
    });

    it('isPRLog ignores set-volume / most-reps / rep-max records — only heaviest + est-1RM count', () => {
      const { window } = env;
      // Prior best: a heavy low-rep set (100 kg × 5). New: lighter but higher-rep
      // (80 kg × 12) — a new best set volume (960 > 500), most reps (12 > 5), and a
      // fresh 12-rep record, but NOT heavier (80 < 100) and lower est-1RM
      // (112 < 116.67). These no longer earn a PR badge; they were the noise that
      // made the badge appear on almost every set.
      const priorPRs = WorkoutAnalysis.exercisePRs([
        { sets: [{ weight_kg: 100, reps: 5, set_type: 'normal' }] },
      ]);
      const volumeOnly = { sets: [{ weight_kg: 80, reps: 12, set_type: 'normal' }] };
      expect(window.WorkoutExerciseDetail.isPRLog(volumeOnly, priorPRs, WorkoutAnalysis)).toBe(false);
      // A genuinely stronger higher-rep set (85 kg × 12 → est-1RM 119 > 116.67) does.
      const est1rmPR = { sets: [{ weight_kg: 85, reps: 12, set_type: 'normal' }] };
      expect(window.WorkoutExerciseDetail.isPRLog(est1rmPR, priorPRs, WorkoutAnalysis)).toBe(true);
    });

    it('renderDetail surfaces per-rep-count set-records', () => {
      const { window, document } = env;
      const root = document.createElement('div');
      const prs = {
        heaviest_weight: 100,
        best_est_1rm: 116.67,
        best_set_volume: 960,
        best_session_volume: 1500,
        most_reps: 12,
        set_records: { 5: 100, 12: 80 },
      };
      window.WorkoutExerciseDetail.renderDetail(root, 'Bench Press', prs, []);
      expect(root.textContent).toContain('Rep-max records');
      const repNames = Array.from(root.querySelectorAll('.wg-workouts-exercise-detail__record .wg-workouts-stats__top-row-name'))
        .map((n) => n.textContent);
      expect(repNames).toContain('5 reps');
      expect(repNames).toContain('12 reps');
    });
  });

  // med-qj4.6.4 / .6.5 — the detail view's headline metric, graph order and
  // effort surfaces follow the exercise's effective training goal.
  describe('goal-driven emphasis + effort insight', () => {
    // One session, newest-first as listExerciseLogsByName returns it, with the
    // effective goal riding on each entry.
    function history(goal, sets) {
      return [{ date: '2026-01-08', session_id: 2, sets, training_goal: goal }];
    }

    async function openWith(logs) {
      const { window, document } = env;
      window.WorkoutAnalysis = WorkoutAnalysis;
      window.apiCall = vi.fn(async (url) => (String(url).includes('/api/workout/exercises/history') ? logs : null));
      await window.WorkoutExerciseDetail.open('Bench Press');
      return document.getElementById('workout-stats-display');
    }

    function chartMetrics(container) {
      return Array.from(container.querySelectorAll('svg.wg-workout-chart'))
        .map((svg) => svg.dataset.workoutMetric);
    }

    it('leads a strength exercise with est-1RM and graphs est-1RM first', async () => {
      const container = await openWith(history('strength', [
        { set_index: 0, weight_kg: 100, reps: 5, set_type: 'normal' },
      ]));
      const headline = container.querySelector('.wg-workouts-exercise-detail__headline');
      expect(headline).toBeTruthy();
      expect(headline.dataset.goal).toBe('strength');
      expect(headline.textContent).toContain('Best est. 1RM');
      expect(headline.textContent).toContain('116.7 kg');
      expect(chartMetrics(container)).toEqual(['est-1rm', 'top-weight']);
    });

    it('leads a hypertrophy exercise with volume load + weekly hard sets', async () => {
      const container = await openWith(history('hypertrophy', [
        { set_index: 0, weight_kg: 60, reps: 10, set_type: 'normal' },
        { set_index: 1, weight_kg: 60, reps: 10, set_type: 'normal' },
      ]));
      const headline = container.querySelector('.wg-workouts-exercise-detail__headline');
      expect(headline.textContent).toContain('Volume load');
      expect(headline.textContent).toContain('1200 kg');
      expect(headline.textContent).toContain('Hard sets · last 7 days: 2 sets');
      expect(chartMetrics(container)).toEqual(['volume', 'est-1rm']);
    });

    it('leads an endurance exercise with total reps', async () => {
      const container = await openWith(history('endurance', [
        { set_index: 0, weight_kg: 30, reps: 20, set_type: 'normal' },
        { set_index: 1, weight_kg: 30, reps: 18, set_type: 'normal' },
      ]));
      const headline = container.querySelector('.wg-workouts-exercise-detail__headline');
      expect(headline.textContent).toContain('Reps · last session');
      expect(headline.textContent).toContain('38 reps');
      expect(chartMetrics(container)).toEqual(['reps', 'volume']);
    });

    it('falls back to the hypertrophy emphasis when the history carries no goal', async () => {
      const container = await openWith([
        { date: '2026-01-08', session_id: 2, sets: [{ set_index: 0, weight_kg: 60, reps: 10, set_type: 'normal' }] },
      ]);
      expect(container.querySelector('.wg-workouts-exercise-detail__headline').dataset.goal).toBe('hypertrophy');
    });

    it('flags an est-1RM computed from a high-rep set, where the number is', async () => {
      const container = await openWith(history('strength', [
        { set_index: 0, weight_kg: 80, reps: 20, set_type: 'normal' },
      ]));
      const flags = container.querySelectorAll('.wg-workouts-exercise-detail__flag');
      // Once on the headline, once on the "Best est. 1RM" record row.
      expect(flags.length).toBe(2);
      expect(flags[0].textContent).toContain('from a 20-rep set');
      // A low-rep estimate carries no caveat.
      const clean = await openWith(history('strength', [
        { set_index: 0, weight_kg: 100, reps: 5, set_type: 'normal' },
      ]));
      expect(clean.querySelectorAll('.wg-workouts-exercise-detail__flag').length).toBe(0);
    });

    it('advises a hypertrophy exercise whose rated sets sit far from failure', async () => {
      const container = await openWith(history('hypertrophy', [
        { set_index: 0, weight_kg: 60, reps: 10, rpe: 5, set_type: 'normal' },
        { set_index: 1, weight_kg: 60, reps: 10, rpe: 5, set_type: 'normal' },
        { set_index: 2, weight_kg: 60, reps: 10, rpe: 6, set_type: 'normal' },
      ]));
      const advice = container.querySelector('.wg-workouts-exercise-detail__advice');
      expect(advice).toBeTruthy();
      expect(advice.textContent).toContain('push closer to failure or add load');
      // Per-set RIR is surfaced as a record row alongside it.
      expect(container.textContent).toContain('Recent effort · 3 rated sets');
    });

    it('never advises a strength goal, but still shows its effort summary', async () => {
      const container = await openWith(history('strength', [
        { set_index: 0, weight_kg: 100, reps: 5, rpe: 5, set_type: 'normal' },
        { set_index: 1, weight_kg: 100, reps: 5, rpe: 5, set_type: 'normal' },
        { set_index: 2, weight_kg: 100, reps: 5, rpe: 6, set_type: 'normal' },
      ]));
      expect(container.querySelector('.wg-workouts-exercise-detail__advice')).toBeNull();
      expect(container.textContent).toContain('Recent effort');
    });

    it('says nothing about effort when no RPE was logged', async () => {
      const container = await openWith(history('hypertrophy', [
        { set_index: 0, weight_kg: 60, reps: 10, set_type: 'normal' },
        { set_index: 1, weight_kg: 60, reps: 10, set_type: 'normal' },
      ]));
      expect(container.querySelector('.wg-workouts-exercise-detail__advice')).toBeNull();
      expect(container.textContent).not.toContain('Recent effort');
    });
  });

  // Phase 3 — PR badge on the session log card.
  describe('session log-card PR badge (Phase 3)', () => {
    it('appends a PR badge when a saved log beats the exercise history baseline', async () => {
      const { window, document } = env;
      window.WorkoutAnalysis = WorkoutAnalysis;
      window.WorkoutSessionsState.data = { id: 2 };
      window.WorkoutSessionsState.logs = [{
        id: 42,
        exercise_name: 'Bench Press',
        sets_completed: 1,
        reps_completed: 5,
        weight_kg: 100,
        sets: [{ set_index: 0, weight_kg: 100, reps: 5, set_type: 'normal' }],
      }];
      // History: an older session at 90 kg (baseline) + this session at 100 kg (PR).
      window.apiCall = vi.fn(async (url) => {
        if (String(url).includes('/api/workout/exercises/history')) {
          return [
            { date: '2026-01-01', session_id: 1, sets: [{ weight_kg: 90, reps: 5, set_type: 'normal' }] },
            { date: '2026-01-08', session_id: 2, sets: [{ weight_kg: 100, reps: 5, set_type: 'normal' }] },
          ];
        }
        return null;
      });

      const container = document.getElementById('workout-session-logs');
      window.WorkoutSessions.renderLogs(container);

      await vi.waitFor(() => {
        expect(container.querySelector('.wg-workouts-session-exercise__pr-badge')).toBeTruthy();
      });
    });

    it('does not badge a saved log that only ties the baseline', async () => {
      const { window, document } = env;
      window.WorkoutAnalysis = WorkoutAnalysis;
      window.WorkoutSessionsState.data = { id: 2 };
      window.WorkoutSessionsState.logs = [{
        id: 43,
        exercise_name: 'Squat',
        sets_completed: 1,
        reps_completed: 5,
        weight_kg: 90,
        sets: [{ set_index: 0, weight_kg: 90, reps: 5, set_type: 'normal' }],
      }];
      window.apiCall = vi.fn(async (url) => {
        if (String(url).includes('/api/workout/exercises/history')) {
          return [
            { date: '2026-01-01', session_id: 1, sets: [{ weight_kg: 90, reps: 5, set_type: 'normal' }] },
            { date: '2026-01-08', session_id: 2, sets: [{ weight_kg: 90, reps: 5, set_type: 'normal' }] },
          ];
        }
        return null;
      });

      const container = document.getElementById('workout-session-logs');
      window.WorkoutSessions.renderLogs(container);

      await new Promise((r) => setTimeout(r, 10));
      expect(container.querySelector('.wg-workouts-session-exercise__pr-badge')).toBeNull();
    });

    it('does not badge the first-ever log of an exercise (no prior history)', async () => {
      const { window, document } = env;
      window.WorkoutAnalysis = WorkoutAnalysis;
      window.WorkoutSessionsState.data = { id: 2 };
      window.WorkoutSessionsState.logs = [{
        id: 44,
        exercise_name: 'Overhead Press',
        sets_completed: 1,
        reps_completed: 5,
        weight_kg: 50,
        sets: [{ set_index: 0, weight_kg: 50, reps: 5, set_type: 'normal' }],
      }];
      // History contains only this in-progress session's own log — no prior
      // session to set a record against, so the first-ever log must not badge.
      window.apiCall = vi.fn(async (url) => {
        if (String(url).includes('/api/workout/exercises/history')) {
          return [
            { date: '2026-01-08', session_id: 2, sets: [{ weight_kg: 50, reps: 5, set_type: 'normal' }] },
          ];
        }
        return null;
      });

      const container = document.getElementById('workout-session-logs');
      window.WorkoutSessions.renderLogs(container);

      await new Promise((r) => setTimeout(r, 10));
      expect(container.querySelector('.wg-workouts-session-exercise__pr-badge')).toBeNull();
    });
  });
});
