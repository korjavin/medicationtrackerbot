1. Add `BatchGetIntakesBySchedule(schedules []MedicationSchedule)` to `Store` and `MedicationStore`.
2. Do a 2-pass over medications in `Check`:
   - Pass 1: Build a list of schedules to check. Iterate over `meds`.
     - For plan steps, collect all steps where `!now.Before(step.ScheduledAt)`.
     - For normal schedule, calculate targets and collect valid targets.
   - Batch execute: `batchMap, err := c.store.BatchGetIntakesBySchedule(schedulesToCheck)`
   - Pass 2: Re-iterate over `meds`.
     - For plan steps, use `batchMap` instead of `GetIntakeBySchedule`. Same logic as before.
     - For normal schedule, use `batchMap` instead of `GetIntakeBySchedule`.
3. The benchmark we added `BenchmarkMedicationScheduler` will be used to show the performance improvement (mock will track `getInTokesBySchedCalls` going to 0, replaced by 1 `BatchGetIntakesBySchedule` call).
4. For `BatchGetIntakesBySchedule` implementation, I will generate a query chunking 500 combinations using `(medication_id, scheduled_at) IN ((?, ?), (?, ?))`. SQLite supports this `IN` operator with tuples.
5. Add `pre-commit` steps.

This fully removes the N+1 problem by batching queries and correctly handles the `triggered` behavior.
