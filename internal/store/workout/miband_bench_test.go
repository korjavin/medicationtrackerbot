package workout

import (
	"context"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	"github.com/korjavin/medicationtrackerbot/internal/store/migrations"
)

// setupBenchRepo mirrors setupTestDB but accepts testing.TB so it can be used
// from benchmarks.
func setupBenchRepo(tb testing.TB) *Repo {
	tb.Helper()
	d, err := storedb.Open(":memory:")
	if err != nil {
		tb.Fatalf("open db: %v", err)
	}
	tb.Cleanup(func() { _ = d.Close() })
	if err := d.Migrate(migrations.FS, "."); err != nil {
		tb.Fatalf("migrate: %v", err)
	}
	return New(d)
}

func BenchmarkImportMiBand(b *testing.B) {
	ctx := context.Background()
	db := setupBenchRepo(b)

	userID := int64(1)

	var workouts []MiBandWorkout
	gpsTracks := make(map[int64][]MiBandGPSPoint)

	// Create 10 workouts, each with 1000 GPS points
	for i := 0; i < 10; i++ {
		startMs := time.Now().UnixMilli() + int64(i*1000000)
		workouts = append(workouts, MiBandWorkout{
			UserID:        userID,
			SourceStartMs: startMs,
			SourceEndMs:   startMs + 600000,
			ActivityType:  1,
			ActivityName:  "Running",
			DurationSec:   600,
			Source:        "device",
		})

		var pts []MiBandGPSPoint
		for j := 0; j < 1000; j++ {
			pts = append(pts, MiBandGPSPoint{
				TsMs:      startMs + int64(j*1000),
				Latitude:  10.0 + float64(j)*0.0001,
				Longitude: 20.0 + float64(j)*0.0001,
				Altitude:  100.0,
				IsPause:   false,
			})
		}
		gpsTracks[startMs] = pts
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		// To avoid unique constraint violations, we modify start times in each iteration
		iterWorkouts := make([]MiBandWorkout, len(workouts))
		copy(iterWorkouts, workouts)
		iterGpsTracks := make(map[int64][]MiBandGPSPoint)

		for j := range iterWorkouts {
			iterWorkouts[j].SourceStartMs += int64(i+1) * 1000000000

			ptsCopy := make([]MiBandGPSPoint, len(gpsTracks[workouts[j].SourceStartMs]))
			copy(ptsCopy, gpsTracks[workouts[j].SourceStartMs])
			iterGpsTracks[iterWorkouts[j].SourceStartMs] = ptsCopy
		}

		imported, _, err := db.ImportMiBand(ctx, iterWorkouts, iterGpsTracks)
		if err != nil {
			b.Fatalf("failed to import: %v", err)
		}
		if imported != len(workouts) {
			b.Fatalf("expected to import %d workouts, got %d", len(workouts), imported)
		}
	}
}
