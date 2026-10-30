// workout-suggest.test.js
//
// Pure-unit net for web/domain/workout-suggest.js (med-okwf.4): the "Up next"
// ranking behind the add sheet (kit WA3) and the Next › step (WA5/WA6).

import { describe, it, expect } from 'vitest';
import { rankNextExercises } from '../../../domain/workout-suggest.js';

const S = (id, date) => ({ id, scheduled_date: date, scheduled_time: '09:00' });
let nextId = 1;
const L = (session_id, exercise_name, status = 'completed') => ({ id: nextId++, session_id, exercise_name, status });
const names = (rows) => rows.map((r) => r.name);

describe('rankNextExercises', () => {
  it('ranks what usually follows the current exercise first, most often then most recent', () => {
    const sessions = [S(1, '2026-01-01'), S(2, '2026-01-03'), S(3, '2026-01-05'), S(9, '2026-01-07')];
    const logs = [
      L(1, 'Bench'), L(1, 'Fly'),
      L(2, 'Bench'), L(2, 'Dip'),
      L(3, 'Bench'), L(3, 'Dip'), L(3, 'Curl'),
      L(9, 'Bench'),
    ];
    const out = rankNextExercises({ sessions, logs, sessionId: 9, after: 'bench' });
    // Dip twice, Fly once; then recency fills the rest (Curl newest).
    expect(names(out)).toEqual(['Dip', 'Fly', 'Curl']);
  });

  it('then one library row per body part the session has not hit, then recent', () => {
    const sessions = [S(1, '2026-01-01'), S(9, '2026-01-07')];
    const logs = [L(1, 'Lunge'), L(9, 'Bench')];
    const library = [
      { id: 1, name: 'Bench', body_part: 'chest' },
      { id: 2, name: 'Fly', body_part: 'chest' },
      { id: 3, name: 'Row', body_part: 'back' },
      { id: 4, name: 'Pulldown', body_part: 'back' },
      { id: 5, name: 'Plank', body_part: 'core' },
    ];
    const out = rankNextExercises({ sessions, logs, library, sessionId: 9, after: 'Bench' });
    // Chest is hit; one back (library order) and one core, then recent Lunge.
    expect(out).toEqual([library[2], library[4], { name: 'Lunge' }]);
  });

  it('within a body part, an exercise the user has logged beats one never logged', () => {
    const sessions = [S(1, '2026-01-01'), S(9, '2026-01-07')];
    const library = [{ id: 3, name: 'Row', body_part: 'back' }, { id: 4, name: 'Pulldown', body_part: 'back' }];
    const out = rankNextExercises({ sessions, logs: [L(1, 'Pulldown')], library, sessionId: 9 });
    expect(names(out)).toEqual(['Pulldown']);
  });

  it('never offers anything already in the session, whatever its status', () => {
    const sessions = [S(1, '2026-01-01'), S(9, '2026-01-07')];
    const logs = [L(1, 'Bench'), L(1, 'Dip'), L(1, 'Row'), L(9, 'Bench'), L(9, 'dip ', '')];
    const out = rankNextExercises({ sessions, logs, sessionId: 9, after: 'Bench' });
    expect(names(out)).toEqual(['Row']);
  });

  it('excludes a library row the session logged under its old name (rename), not a plan row with the same id', () => {
    const sessions = [S(1, '2026-01-01'), S(9, '2026-01-07')];
    const library = [{ id: 12, name: 'Cable row', body_part: 'back' }, { id: 13, name: 'Plank', body_part: 'core' }];
    const logs = [
      { ...L(9, 'Row'), source: 'library', exercise_id: 12 },
      // A plan log's exercise_id lives in the schedule id space: 13 is not the library's Plank.
      { ...L(9, 'Squat'), source: 'schedule', exercise_id: 13 },
    ];
    expect(names(rankNextExercises({ sessions, logs, library, sessionId: 9 }))).toEqual(['Plank']);
  });

  it('treats an alias as its library row: offers the row, and an alias already in the session excludes it (med-l5yr.1)', () => {
    const sessions = [S(1, '2026-01-01'), S(2, '2026-01-03'), S(9, '2026-01-07')];
    const library = [
      { id: 20, name: 'Kettlebell Swings', body_part: 'upper legs', aliases: ['Swings'] },
      { id: 21, name: 'Goblet Squat', body_part: 'upper legs', aliases: ['Goblet squat', 'Goblet Squats'] },
    ];
    const logs = [L(1, 'Swings'), L(1, 'Goblet Squats'), L(2, 'Lunge'), L(9, 'Lunge')];
    // History only knows the old spellings; the canonical rows come back.
    expect(names(rankNextExercises({ sessions, logs, library, sessionId: 9, after: 'swings' })))
      .toEqual(['Goblet Squat', 'Kettlebell Swings']);
    // Logging "goblet squat" in this session takes the Goblet Squat row out.
    const inSession = [...logs, L(9, 'goblet  squat')];
    expect(names(rankNextExercises({ sessions, logs: inSession, library, sessionId: 9 })))
      .toEqual(['Kettlebell Swings']);
  });

  it('ignores skipped/placeholder history and caps at the limit', () => {
    const sessions = [S(1, '2026-01-01'), S(9, '2026-01-07')];
    const logs = [L(1, 'A'), L(1, 'B', 'skipped'), L(1, 'C'), L(1, 'D'), L(1, 'E')];
    expect(names(rankNextExercises({ sessions, logs, sessionId: 9 }))).toEqual(['A', 'C', 'D']);
  });

  it('is empty with no history and no library (search only)', () => {
    expect(rankNextExercises({ sessionId: 9, after: 'Bench' })).toEqual([]);
  });
});
