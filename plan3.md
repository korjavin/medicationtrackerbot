Wait, if I fetch by time range, how large a range?
The existing code does:
`existing, err := c.store.GetIntakeBySchedule(med.ID, target)`
Target time could be from normal schedule (today), or from plan steps (which could technically be somewhat in the past or future).
Because plan steps could have any `ScheduledAt`, and normal schedule relies on `target` being today based on `userLoc`.

So the safest and most optimal solution that exactly preserves logic:
Create `BatchGetIntakesBySchedule(schedules []MedicationSchedule)`
But the loop does:
```go
if existing != nil {
    // skip or mark consumed
} else {
    // create group
}
```
If we do it 2-pass:
```go
// Pass 1: determine all required schedules
var required []store.MedicationSchedule
// We need to keep track of the context. For example, a struct:
type checkAction struct {
    Med      store.Medication
    Target   time.Time
    StepID   int64
    IsPlan   bool
}
actions := []checkAction{}

for _, med := range meds {
   // run the same logic
   // instead of `GetIntakeBySchedule` and branch, do:
   actions = append(actions, checkAction{Med: med, Target: target, ...})
}

// Batch query
results, err := c.store.BatchGetIntakesBySchedule(...)

// Pass 2: process actions
for _, action := range actions {
   existing := results[key(action.Med.ID, action.Target)]
   if action.IsPlan {
        if existing != nil {
            // mark consumed
            continue
        }
        if triggered { break } // WAIT! `triggered` is per medication in the first pass!
        // If we split into 2 passes, `triggered` logic depends on whether `existing != nil`.
   }
}
```
Ah! "Only trigger one new step per medication per tick".
This means for a given medication, if the first un-consumed step creates an intake, we `break` and don't create intakes for subsequent steps. But to know if it's un-consumed, we must check if `existing != nil`.
If we evaluate all of them in batch, we can just say:
Pass 1: gather ALL steps and normal targets.
Pass 2: `BatchGetIntakesBySchedule`
Pass 3: iterate meds. For plan steps, do the `existing` check using the batch map. If `!existing`, trigger, and break the inner loop.

Let's verify this logic.
