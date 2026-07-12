package cloudserver

import (
	"fmt"
	"log/slog"
	"os"
	"sort"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain/nxk"
)

// Downsample cadences for the dense continuous streams, matching the app cadence
// used by internal/seeddemo/vitals_timeseries.go (alignUpToInterval). Buckets are
// anchored to 00:00 UTC so cloud-imported and seeded data land on the same grid,
// and the vitals graphs re-bucket hourly so there is no user-visible fidelity loss.
const (
	hrCadence     = 15 * time.Minute
	spo2Cadence   = 15 * time.Minute
	stressCadence = 30 * time.Minute
)

// downsampleSamples collapses a dense sample stream to one representative per
// 00:00-UTC-anchored bucket of width cadence. Sorting first, then keeping the
// first sample per bucket, is deterministic so re-importing the same backup
// yields an identical result. TzOffset/Type/Info of the kept sample are
// preserved. Output is sorted by instant.
func downsampleSamples(samples []vitalsSampleWire, cadence time.Duration) []vitalsSampleWire {
	if len(samples) == 0 || cadence <= 0 {
		return samples
	}
	sort.SliceStable(samples, func(i, j int) bool {
		return samples[i].DateTime.Before(samples[j].DateTime)
	})
	bucketSecs := int64(cadence.Seconds())
	out := make([]vitalsSampleWire, 0, len(samples))
	prevBucket := int64(-1)
	for _, s := range samples {
		bucket := s.DateTime.UTC().Unix() / bucketSecs
		if bucket == prevBucket {
			continue
		}
		prevBucket = bucket
		out = append(out, s)
	}
	return out
}

// inboxEventKindVitalsImport seals a whole Mi Band NXK import as ONE event.
// The relay parses the .nxk server-side (transient plaintext, same trust model
// as the Telegram inbound path), then seals the mapped vitals streams; the
// client drains and writes them into vault vitals records. GPS is never
// included (locked scope decision — docs/plans/20260711-cloud-miband-nxk-ingest.md).
const inboxEventKindVitalsImport = "vitals_import"

// vitalsImportEvent is the sealed payload for one NXK import. Every stream
// mirrors the field names of internal/store/vitals/repo.go +
// internal/store/workout/miband.go so the client writes them into vault records
// with no translation layer.
type vitalsImportEvent struct {
	Kind     string              `json:"kind"`
	AtUnix   int64               `json:"at_unix"`
	Sleep    []vitalsSleepWire   `json:"sleep,omitempty"`
	HR       []vitalsSampleWire  `json:"hr,omitempty"`
	SpO2     []vitalsSampleWire  `json:"spo2,omitempty"`
	Stress   []vitalsSampleWire  `json:"stress,omitempty"`
	DayStats []vitalsDayStatWire `json:"daystats,omitempty"`
	Workouts []vitalsWorkoutWire `json:"workouts,omitempty"`
}

// vitalsSleepWire mirrors store.SleepLog JSON tags (health_handlers.go read shape).
type vitalsSleepWire struct {
	StartTime      time.Time `json:"start_time"`
	EndTime        time.Time `json:"end_time"`
	TimezoneOffset int       `json:"timezone_offset"`
	Day            string    `json:"day"`
	LightMinutes   *int      `json:"light_minutes,omitempty"`
	DeepMinutes    *int      `json:"deep_minutes,omitempty"`
	REMMinutes     *int      `json:"rem_minutes,omitempty"`
	AwakeMinutes   *int      `json:"awake_minutes,omitempty"`
	TotalMinutes   *int      `json:"total_minutes,omitempty"`
	TurnOverCount  *int      `json:"turn_over_count,omitempty"`
	HeartRateAvg   *int      `json:"heart_rate_avg,omitempty"`
	SpO2Avg        *int      `json:"spo2_avg,omitempty"`
	UserModified   bool      `json:"user_modified"`
	Notes          string    `json:"notes,omitempty"`
}

// vitalsSampleWire mirrors store.Vitals{Heart,SpO2,Stress}Log (day-batched
// client sample shape {date_time, tz_offset, value[, info]}).
type vitalsSampleWire struct {
	DateTime time.Time `json:"date_time"`
	TzOffset int       `json:"tz_offset"`
	Value    int       `json:"value"`
	Type     int       `json:"type"`
	Info     string    `json:"info,omitempty"`
}

// vitalsDayStatWire mirrors store.DayStat.
type vitalsDayStatWire struct {
	Day      string `json:"day"`
	Steps    int    `json:"steps"`
	Calories int    `json:"calories"`
	Distance int    `json:"distance"`
}

// vitalsWorkoutWire mirrors store.MiBandWorkout minus GPS and server-side ids.
type vitalsWorkoutWire struct {
	SourceStartMs int64   `json:"source_start_ms"`
	SourceEndMs   int64   `json:"source_end_ms"`
	ActivityType  int     `json:"activity_type"`
	ActivityName  string  `json:"activity_name"`
	DurationSec   int     `json:"duration_sec"`
	DistanceM     float64 `json:"distance_m"`
	Steps         int     `json:"steps"`
	Calories      int     `json:"calories"`
	HeartRateAvg  int     `json:"heart_rate_avg"`
	SpO2Avg       int     `json:"spo2_avg"`
	PauseMs       int64   `json:"pause_ms"`
	TzOffset      int     `json:"tz_offset"`
}

// parseNXKToVitalsEvents parses a Mi Band .nxk (or raw .sqlite) backup and maps
// its vitals streams into sealed-event payloads, mirroring
// internal/bot/sleep_import.go:importSleepFile but writing to the vault wire
// shapes instead of the store. GPS is parsed and discarded.
//
// Returns one event per import (the whole backup sealed atomically). The caller
// stamps AtUnix with the server clock and SealAndQueue's each event.
//
// ponytail: one event per import even for a 90-day NXK, which seals as one big
// ct blob (~9k HR samples). Chunk per-stream only if a real inbox/envelope size
// limit is hit — a []event return keeps that door open without paying for it now.
func parseNXKToVitalsEvents(nxkPath string) ([]vitalsImportEvent, error) {
	info, err := os.Stat(nxkPath)
	if err != nil {
		return nil, fmt.Errorf("stat import file: %w", err)
	}
	if err := nxk.ValidateImportFile(nxkPath, info.Size()); err != nil {
		return nil, err
	}

	dbPath, cleanup, err := nxk.PrepareBackupDB(nxkPath)
	if err != nil {
		return nil, fmt.Errorf("prepare backup db: %w", err)
	}
	defer cleanup()

	ev := vitalsImportEvent{Kind: inboxEventKindVitalsImport}

	// Each stream is best-effort: a backup missing one table must not sink the
	// rest (mirrors importSleepFile, which warns-and-continues per stream).
	if sleepLogs, err := nxk.ParseSleepDatabase(dbPath); err != nil {
		slog.Warn("vitals import: parse sleep", "error", err)
	} else {
		for _, s := range sleepLogs {
			ev.Sleep = append(ev.Sleep, vitalsSleepWire{
				StartTime: s.StartTime, EndTime: s.EndTime,
				TimezoneOffset: s.TimezoneOffset, Day: s.Day,
				LightMinutes: s.LightMinutes, DeepMinutes: s.DeepMinutes,
				REMMinutes: s.REMMinutes, AwakeMinutes: s.AwakeMinutes,
				TotalMinutes: s.TotalMinutes, TurnOverCount: s.TurnOverCount,
				HeartRateAvg: s.HeartRateAvg, SpO2Avg: s.SpO2Avg,
				UserModified: s.UserModified, Notes: s.Notes,
			})
		}
	}

	if heart, err := nxk.ParseHeartDatabase(dbPath); err != nil {
		slog.Warn("vitals import: parse heart", "error", err)
	} else {
		for _, h := range heart {
			ev.HR = append(ev.HR, vitalsSampleWire{DateTime: h.DateTime, TzOffset: h.TzOffset, Value: h.Value, Type: h.Type})
		}
	}

	if spo2, err := nxk.ParseSpO2Database(dbPath); err != nil {
		slog.Warn("vitals import: parse spo2", "error", err)
	} else {
		for _, s := range spo2 {
			ev.SpO2 = append(ev.SpO2, vitalsSampleWire{DateTime: s.DateTime, TzOffset: s.TzOffset, Value: s.Value, Type: s.Type})
		}
	}

	if stress, err := nxk.ParseStressDatabase(dbPath); err != nil {
		slog.Warn("vitals import: parse stress", "error", err)
	} else {
		for _, s := range stress {
			ev.Stress = append(ev.Stress, vitalsSampleWire{DateTime: s.DateTime, TzOffset: s.TzOffset, Value: s.Value, Type: s.Type, Info: s.Info})
		}
	}

	if days, err := nxk.ParseDayDatabase(dbPath); err != nil {
		slog.Warn("vitals import: parse day", "error", err)
	} else {
		for _, d := range days {
			ev.DayStats = append(ev.DayStats, vitalsDayStatWire{Day: d.Day, Steps: d.Steps, Calories: d.Calories, Distance: d.Distance})
		}
	}

	// GPS is parsed by ParseOutdoorWorkouts but the second return is discarded
	// here and never mapped into the payload (locked scope: no GPS import).
	if workouts, _, err := nxk.ParseOutdoorWorkouts(dbPath); err != nil {
		slog.Warn("vitals import: parse workouts", "error", err)
	} else {
		for _, w := range workouts {
			ev.Workouts = append(ev.Workouts, vitalsWorkoutWire{
				SourceStartMs: w.SourceStartMs, SourceEndMs: w.SourceEndMs,
				ActivityType: w.ActivityType, ActivityName: w.ActivityName,
				DurationSec: w.DurationSec, DistanceM: w.DistanceM,
				Steps: w.Steps, Calories: w.Calories,
				HeartRateAvg: w.HeartRateAvg, SpO2Avg: w.SpO2Avg,
				PauseMs: w.PauseMs, TzOffset: w.TzOffset,
			})
		}
	}

	// Downsample the dense continuous streams to the app cadence before sealing.
	// Sleep, daystats, and workouts are daily aggregates and pass through unchanged.
	ev.HR = downsampleSamples(ev.HR, hrCadence)
	ev.SpO2 = downsampleSamples(ev.SpO2, spo2Cadence)
	ev.Stress = downsampleSamples(ev.Stress, stressCadence)

	if len(ev.Sleep)+len(ev.HR)+len(ev.SpO2)+len(ev.Stress)+len(ev.DayStats)+len(ev.Workouts) == 0 {
		return nil, fmt.Errorf("no vitals data found in backup")
	}

	return []vitalsImportEvent{ev}, nil
}
