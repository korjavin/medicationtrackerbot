// Deterministic eval-vault seed. Writes go through the dispatcher (mode write)
// like any agent write, so the seed exercises the same write path it later
// judges. Timestamps are absolute against the fixed eval clock
// (2026-07-06T12:00:00Z); judges derive ground truth live, so no seed knob is
// needed.
//
// The BP set is deliberately small: cloud mode has no mcp_execute, so the E1
// agent must average the listed readings itself — five readings keep that
// feasible while still testing windowed reads. Systolics average exactly 122.

export async function seedVault(write) {
  // Five readings inside the 30d window (avg systolic = 122, count = 5).
  const bp = [
    ['2026-06-08T08:00:00.000Z', 118, 76],
    ['2026-06-15T08:00:00.000Z', 122, 78],
    ['2026-06-22T08:00:00.000Z', 120, 77],
    ['2026-06-29T08:00:00.000Z', 126, 82],
    ['2026-07-05T08:00:00.000Z', 124, 80],
  ];
  for (const [measured_at, systolic, diastolic] of bp) {
    await write('health.bp.create', { measured_at, systolic, diastolic });
  }

  await write('health.weight.create', { measured_at: '2026-07-01T07:00:00.000Z', weight: 79.1 });
  await write('health.weight.create', { measured_at: '2026-07-05T07:00:00.000Z', weight: 78.4 });

  const med1 = await write('medications.create', {
    name: 'Lisinopril', dosage: '10mg', schedule: JSON.stringify({ type: 'daily', times: ['09:00'] }),
  });
  const med2 = await write('medications.create', {
    name: 'Atorvastatin', dosage: '20mg', schedule: JSON.stringify({ type: 'daily', times: ['21:00'] }),
  });

  await write('food.log.create', {
    name: 'oatmeal', eaten_at: '2026-07-06T08:30:00.000Z', weight: 100, calories: 370, carbs: 60, protein: 13, fat: 7,
  });

  const group = await write('workouts.groups.create', { name: 'Strength', description: 'Barbell rotation' });
  const variant = await write('workouts.variants.create', {
    group_id: group.id, name: 'Push Day', description: 'chest and triceps', rotation_order: 1,
  });
  const bench = await write('workouts.exercises.create', {
    variant_id: variant.id, exercise_name: 'Bench Press',
    target_sets: 4, target_reps_min: 6, target_reps_max: 8, target_weight_kg: 60, order_index: 0,
  });
  await write('workouts.exercises.create', {
    variant_id: variant.id, exercise_name: 'Overhead Press',
    target_sets: 3, target_reps_min: 8, target_reps_max: 10, order_index: 1,
  });
  const session = await write('workouts.sessions.schedule', {
    scheduled_date: '2026-07-07', scheduled_time: '18:00',
    exercises: [{ exercise_name: 'Bench Press', target_sets: 4, target_reps_min: 6 }],
  });
  await write('workouts.sessions.logs.create', {
    session_id: session.session.id, exercise_id: bench.exercise_library_id, exercise_name: 'Bench Press',
    target_sets: 4, target_reps_min: 6, target_reps_max: 8, target_weight_kg: 60, status: 'completed',
  });

  return {
    medIDs: [med1.id, med2.id],
    groupID: group.id,
    variantID: variant.id,
    sessionID: session.session.id,
  };
}
