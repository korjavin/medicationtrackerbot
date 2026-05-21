package seeddemo

import (
	"context"
	"fmt"
	"math"
	"math/rand/v2"
	"sort"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// generateVitals produces blood pressure, weight, sleep, and continuous
// heart / SpO2 / stress samples across the synthetic window. It calls store
// methods directly because every row must be backdated; domain services here
// would refuse non-current timestamps.
//
// The continuous time-series generators run with a sub-rng derived from
// opts.Seed so they do not perturb the shared rng state seen by downstream
// generators (food, workouts, misc). That keeps existing determinism tests
// stable while adding three new streams.
func generateVitals(ctx context.Context, s *store.Store, opts Options, clk *clock, rng *rand.Rand, summary *Summary) error {
	if err := generateBP(ctx, s, opts, clk, rng, summary); err != nil {
		return fmt.Errorf("bp: %w", err)
	}
	if err := generateWeight(ctx, s, opts, clk, rng, summary); err != nil {
		return fmt.Errorf("weight: %w", err)
	}
	sleeps, err := generateSleep(ctx, s, opts, clk, rng, summary)
	if err != nil {
		return fmt.Errorf("sleep: %w", err)
	}

	vc := &vitalsContext{
		sleeps:   sleeps,
		workouts: computeWorkoutWindows(opts, clk),
	}
	tsRng := rand.New(rand.NewPCG(uint64(opts.Seed)^0xA5A5A5A5A5A5A5A5, uint64(opts.Seed)^0x5A5A5A5A5A5A5A5A))
	from := clk.start
	to := clk.anchor

	heart, err := generateHeartSamples(ctx, s, opts, vc, tsRng, from, to)
	if err != nil {
		return fmt.Errorf("heart samples: %w", err)
	}
	summary.HeartSamples += heart

	spo2, err := generateSpO2Samples(ctx, s, opts, vc, tsRng, from, to)
	if err != nil {
		return fmt.Errorf("spo2 samples: %w", err)
	}
	summary.SpO2Samples += spo2

	stress, err := generateStressSamples(ctx, s, opts, vc, tsRng, from, to)
	if err != nil {
		return fmt.Errorf("stress samples: %w", err)
	}
	summary.StressSamples += stress

	return nil
}

// bpRegimes splits the 90-day window into three blocks with distinct BP
// distributions so the demo trend chart shows visible improvement.
type bpRegime struct {
	sysMean, sysStd, diaMean, diaStd float64
}

func bpRegimeFor(daysFromAnchor, totalDays int) bpRegime {
	// First third (oldest): elevated. Middle third: normal. Last third: low-normal.
	third := totalDays / 3
	switch {
	case daysFromAnchor > totalDays-third:
		return bpRegime{sysMean: 135, sysStd: 8, diaMean: 88, diaStd: 5}
	case daysFromAnchor > third:
		return bpRegime{sysMean: 122, sysStd: 6, diaMean: 78, diaStd: 4}
	default:
		return bpRegime{sysMean: 118, sysStd: 5, diaMean: 75, diaStd: 4}
	}
}

var bpSites = []string{"left_arm", "right_arm", "wrist"}
var bpPositions = []string{"sitting", "sitting", "standing"}
var bpTags = []string{"", "morning", "evening", "after-coffee", "post-walk", ""}

func generateBP(ctx context.Context, s *store.Store, opts Options, clk *clock, rng *rand.Rand, summary *Summary) error {
	// Pick ~70 of opts.Days days deterministically.
	target := opts.Days * 70 / 90 // ≈70 when days=90
	if target > opts.Days {
		target = opts.Days
	}
	dayIdx := pickDays(rng, opts.Days, target)

	for _, off := range dayIdx {
		// off==0 means oldest day; off==opts.Days-1 is the day before anchor.
		daysFromAnchor := opts.Days - off
		regime := bpRegimeFor(daysFromAnchor, opts.Days)

		hour := 7 + rng.IntN(15) // 07..21
		minute := rng.IntN(60)
		measuredAt := clk.at(off, hour, minute)

		sys := int(gaussian(rng, regime.sysMean, regime.sysStd) + 0.5)
		dia := int(gaussian(rng, regime.diaMean, regime.diaStd) + 0.5)
		pulse := 65 + rng.IntN(18)

		bp := &store.BloodPressure{
			UserID:     opts.UserID,
			MeasuredAt: measuredAt,
			Systolic:   sys,
			Diastolic:  dia,
			Pulse:      &pulse,
			Site:       bpSites[rng.IntN(len(bpSites))],
			Position:   bpPositions[rng.IntN(len(bpPositions))],
			Tag:        bpTags[rng.IntN(len(bpTags))],
		}
		if _, err := s.BP.CreateReading(ctx, bp); err != nil {
			return fmt.Errorf("create bp at %s: %w", measuredAt, err)
		}
		summary.BPReadings++
	}
	return nil
}

func generateWeight(ctx context.Context, s *store.Store, opts Options, clk *clock, rng *rand.Rand, summary *Summary) error {
	if err := s.Weight.SetUnitPreference(ctx, "kg"); err != nil {
		return fmt.Errorf("set weight unit: %w", err)
	}

	startWeight := 84.0
	endWeight := 79.5
	// Roughly weekly entries: every 7 days.
	var trend *float64
	denom := opts.Days - 1
	if denom < 1 {
		denom = 1
	}
	for off := 0; off < opts.Days; off += 7 {
		// Linear glide from startWeight at off=0 to endWeight at off=days-1,
		// plus deterministic gaussian noise so the chart looks human.
		progress := float64(off) / float64(denom)
		base := startWeight + (endWeight-startWeight)*progress
		w := base + gaussian(rng, 0, 0.35)
		// Round to one decimal as the UI displays.
		w = float64(int(w*10+0.5)) / 10

		measuredAt := clk.at(off, 7, 25+rng.IntN(20))
		next := domain.CalculateWeightTrend(w, trend)
		trendCopy := next

		log := &store.WeightLog{
			UserID:      opts.UserID,
			MeasuredAt:  measuredAt,
			Weight:      w,
			WeightTrend: &trendCopy,
		}
		if _, err := s.Weight.CreateLog(ctx, log); err != nil {
			return fmt.Errorf("create weight at %s: %w", measuredAt, err)
		}
		summary.WeightLogs++
		trend = &next
	}
	return nil
}

func generateSleep(ctx context.Context, s *store.Store, opts Options, clk *clock, rng *rand.Rand, summary *Summary) ([]sleepWindow, error) {
	// Pick ~75 of opts.Days nights.
	target := opts.Days * 75 / 90
	if target > opts.Days {
		target = opts.Days
	}
	nightIdx := pickDays(rng, opts.Days, target)

	logs := make([]store.SleepLog, 0, len(nightIdx))
	windows := make([]sleepWindow, 0, len(nightIdx))
	for _, off := range nightIdx {
		// Each "night" is anchored to day `off`: bedtime falls on `off-1`
		// in the late evening and wake on `off` in the morning. Skip off==0
		// because we'd have nothing the night before to anchor to.
		if off == 0 {
			continue
		}
		bedHour := 22 + rng.IntN(2) // 22..23
		bedMinute := rng.IntN(60)
		start := clk.at(off-1, bedHour, bedMinute)

		// Weekend (Sat/Sun) → longer; weekday → shorter.
		weekday := clk.dayOffset(off).Weekday()
		baseMinutes := 6*60 + 30 // 6h30
		if weekday == time.Saturday || weekday == time.Sunday {
			baseMinutes = 7*60 + 45 // 7h45
		}
		jitter := rng.IntN(60) - 30 // ±30min
		totalMinutes := baseMinutes + jitter
		end := start.Add(time.Duration(totalMinutes) * time.Minute)

		// Phase split: rough breakdown so the UI's segmented bar has data.
		deep := totalMinutes / 5
		rem := totalMinutes / 4
		awake := 10 + rng.IntN(20)
		light := totalMinutes - deep - rem - awake
		if light < 0 {
			light = 0
		}

		quality := 1 + rng.IntN(5) // 1..5
		hr := 55 + rng.IntN(15)
		spo2 := 95 + rng.IntN(4)

		daysFromAnchor := opts.Days - off
		tzOffset := tzOffsetMinutesAtDay(daysFromAnchor)

		// `day` is the local calendar date the user wakes up on (start_time
		// is in UTC; convert via the offset). This mirrors how the JS
		// frontend submits sleep logs.
		local := start.Add(-time.Duration(tzOffset) * time.Minute)
		day := local.Format("2006-01-02")

		logs = append(logs, store.SleepLog{
			UserID:         opts.UserID,
			StartTime:      start,
			EndTime:        end,
			TimezoneOffset: tzOffset,
			Day:            day,
			LightMinutes:   &light,
			DeepMinutes:    &deep,
			REMMinutes:     &rem,
			AwakeMinutes:   &awake,
			TotalMinutes:   &totalMinutes,
			HeartRateAvg:   &hr,
			SpO2Avg:        &spo2,
			Notes:          fmt.Sprintf("quality:%d", quality),
		})
		windows = append(windows, sleepWindow{start: start, end: end})
	}
	if len(logs) == 0 {
		return windows, nil
	}
	imported, _, err := s.Vitals.ImportSleepLogs(ctx, opts.UserID, logs)
	if err != nil {
		return nil, fmt.Errorf("import sleep: %w", err)
	}
	summary.SleepLogs += imported
	return windows, nil
}

// pickDays returns `count` distinct day offsets in [0, totalDays) chosen
// deterministically via the supplied rng. The result is sorted ascending so
// downstream walks proceed in chronological order.
func pickDays(rng *rand.Rand, totalDays, count int) []int {
	if count >= totalDays {
		out := make([]int, totalDays)
		for i := range out {
			out[i] = i
		}
		return out
	}
	pool := make([]int, totalDays)
	for i := range pool {
		pool[i] = i
	}
	rng.Shuffle(len(pool), func(i, j int) { pool[i], pool[j] = pool[j], pool[i] })
	picked := pool[:count]
	sort.Ints(picked)
	return picked
}

// gaussian returns a sample from N(mean, std) using the Box-Muller transform
// so noise looks natural on charts. Determinism comes from the rng caller.
func gaussian(rng *rand.Rand, mean, std float64) float64 {
	u1 := rng.Float64()
	if u1 < 1e-12 {
		u1 = 1e-12
	}
	u2 := rng.Float64()
	z := math.Sqrt(-2*math.Log(u1)) * math.Cos(2*math.Pi*u2)
	return mean + std*z
}

// tzOffsetMinutesAtDay mirrors the timezone history that Task 6 will write:
// NY (UTC-5, JS-style offset 300) for the oldest stretch and the most recent
// 10 days; Berlin (UTC+1, JS-style offset -60) in the middle. Sign convention
// is "minutes west of UTC" to match what the JS frontend submits.
func tzOffsetMinutesAtDay(daysFromAnchor int) int {
	switch {
	case daysFromAnchor > 45:
		return 300
	case daysFromAnchor > 10:
		return -60
	default:
		return 300
	}
}
