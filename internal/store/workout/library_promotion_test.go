package workout

import "testing"

// TestCreateExercise_PromotesIntoLibrary is the med-spp contract guard: creating
// a plan exercise must make it appear on the Workouts → Exercises tab (the
// exercise library), with defaults seeded from the plan targets. This mirrors
// the cloud shim assertion in cloud.shim-contract.workout-crud.test.js so both
// modes stay contract-identical.
func TestCreateExercise_PromotesIntoLibrary(t *testing.T) {
	store := setupTestDB(t)
	const userID = 1

	group, err := store.CreateGroup("Push/Pull", "", false, userID, "[]", "10:00", 15)
	if err != nil {
		t.Fatalf("create group: %v", err)
	}
	variant, err := store.CreateVariant(group.ID, "Day A", nil, "")
	if err != nil {
		t.Fatalf("create variant: %v", err)
	}

	weight := 60.0
	repsMax := 10
	if _, err := store.CreateExerciseInVariant(variant.ID, "Bench Press", 4, 8, &repsMax, &weight, 0); err != nil {
		t.Fatalf("create exercise: %v", err)
	}

	lib, err := store.ListExerciseLibrary(userID)
	if err != nil {
		t.Fatalf("list library: %v", err)
	}
	var found *ExerciseLibraryItem
	for i := range lib {
		if lib[i].Name == "Bench Press" {
			found = &lib[i]
			break
		}
	}
	if found == nil {
		t.Fatalf("plan exercise %q was not promoted into the library; got %d entries", "Bench Press", len(lib))
	}
	if found.DefaultSets != 4 || found.DefaultRepsMin != 8 {
		t.Errorf("library defaults not seeded from targets: sets=%d repsMin=%d", found.DefaultSets, found.DefaultRepsMin)
	}
	if found.DefaultRepsMax == nil || *found.DefaultRepsMax != 10 {
		t.Errorf("library default_reps_max not seeded: %v", found.DefaultRepsMax)
	}
	if found.DefaultWeightKg == nil || *found.DefaultWeightKg != 60.0 {
		t.Errorf("library default_weight_kg not seeded: %v", found.DefaultWeightKg)
	}
}

// TestCreateExercise_LibraryDedupeByName verifies two plan exercises with the
// same name (same user) yield exactly one library entry — the (user_id, name)
// unique index + ON CONFLICT DO NOTHING dedupe.
func TestCreateExercise_LibraryDedupeByName(t *testing.T) {
	store := setupTestDB(t)
	const userID = 1

	group, _ := store.CreateGroup("Full Body", "", false, userID, "[]", "10:00", 15)
	varA, _ := store.CreateVariant(group.ID, "Day A", nil, "")
	varB, _ := store.CreateVariant(group.ID, "Day B", nil, "")

	if _, err := store.CreateExerciseInVariant(varA.ID, "Squat", 3, 5, nil, nil, 0); err != nil {
		t.Fatalf("create exercise A: %v", err)
	}
	if _, err := store.CreateExerciseInVariant(varB.ID, "Squat", 5, 3, nil, nil, 0); err != nil {
		t.Fatalf("create exercise B: %v", err)
	}

	lib, err := store.ListExerciseLibrary(userID)
	if err != nil {
		t.Fatalf("list library: %v", err)
	}
	count := 0
	for _, item := range lib {
		if item.Name == "Squat" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("expected exactly one library entry for %q, got %d", "Squat", count)
	}
}
