1. **Add `MedicationSchedule` struct to `internal/store/store.go`**
   ```go
   type MedicationSchedule struct {
       MedID       int64
       ScheduledAt time.Time
   }
   ```
2. **Add `BatchGetIntakesBySchedule` method to `internal/store/store.go`**
   ```go
   func (s *Store) BatchGetIntakesBySchedule(schedules []MedicationSchedule) (map[MedicationSchedule]*IntakeLog, error)
   ```
   Implementation:
   - Chunk `schedules` into batches of 500 to stay under SQLite variable limits.
   - For each batch, construct `WHERE (medication_id, scheduled_at) IN ((?, ?), (?, ?), ...)`
   - Execute query, parse rows into `IntakeLog` pointers, populate map.
3. **Add `BatchGetIntakesBySchedule` to `MedicationStore` interface in `internal/scheduler/medication.go`**
4. **Update `Check` loop in `internal/scheduler/medication.go`**
   - Accumulate a slice of `store.MedicationSchedule` containing all combinations of medication ID and target time to be checked.
   - For plan steps, collect those. For normal paths, collect those. Wait, the loop currently does things linearly and modifies state/creates groups right there.
   - So, we can do a 2-pass approach:
     - Pass 1: Iterate over meds as currently done, but instead of calling `c.store.GetIntakeBySchedule`, append to a `schedulesToCheck` slice.
     - Also need a way to store the rest of the logic or just re-run the loop!
     - Better: just build `schedulesToCheck` first. Wait, that means duplicating the scheduling logic.
     - Alternatively, we can construct the list of targets to check inside the loop, append to a slice, map them to some context, but it's simpler to do it in one pass if we query a time range.
     - Wait! What if we just fetch ALL intakes for all meds between `now - 24h` and `now + 48h` into a memory map at the start of the function?
     - `func (s *Store) GetIntakesInRange(start, end time.Time) ([]IntakeLog, error)`
     - This would be extremely fast, one single query! `SELECT ... FROM intake_log WHERE scheduled_at >= ? AND scheduled_at <= ?` or `WHERE scheduled_at BETWEEN ? AND ?`.
     - Let's check `internal/store/store.go` if something similar exists.
