1. **Add `BatchGetIntakesBySchedule` method to `internal/store/store.go`**
   - Signature: `func (s *Store) BatchGetIntakesBySchedule(schedules []MedicationSchedule) (map[MedicationSchedule]*IntakeLog, error)`
   - Where `MedicationSchedule` is a new struct containing `MedID int64` and `ScheduledAt time.Time`.
   - The implementation will format the time into ISO8601 strings and do a batched query. For simplicity and driver compatibility, it will query all the `medication_id` and `scheduled_at` pairs in batches (e.g. `SELECT ... WHERE (medication_id, scheduled_at) IN ((?, ?), (?, ?))`). Actually, querying all intake logs for the list of medication IDs that are `>= min(scheduledAt)` and `<= max(scheduledAt)` and then filtering in memory might be faster and easier for SQLite. Wait, since SQLite supports `(a, b) IN ((?, ?), (?, ?))`, we can use that! Or just `SELECT ... WHERE medication_id IN (...) AND scheduled_at IN (...)` and filter.
   - Actually, simpler approach: query `SELECT ... FROM intake_log WHERE medication_id IN (...) AND scheduled_at IN (...)` and filter exactly in Go.

2. **Add `BatchGetIntakesBySchedule` to `MedicationStore` interface in `internal/scheduler/medication.go`**

3. **Update `schedulePendingSteps` and normal scheduling loops in `internal/scheduler/medication.go`**
   - Instead of querying the database one-by-one inside the loops, collect all combinations of `(MedID, TargetTime)` that we need to check.
   - Then, do a single `BatchGetIntakesBySchedule` query.
   - Finally, iterate through the combinations again (or use the returned map) to create intakes.

4. **Run Pre-Commit steps**
   - Ensure the new function works and doesn't break anything.

5. **Commit and create PR**
