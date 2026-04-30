package server

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"sort"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

type DailySleepStat struct {
	Date         string `json:"date"`
	LightMins    int    `json:"light_mins"`
	DeepMins     int    `json:"deep_mins"`
	RemMins      int    `json:"rem_mins"`
	AwakeMins    int    `json:"awake_mins"`
	TotalMins    int    `json:"total_mins"`
	HeartRateAvg int    `json:"heart_rate_avg"`
}

type VitalStat struct {
	Timestamp int64 `json:"timestamp"`
	Min       int   `json:"min"`
	Max       int   `json:"max"`
	Avg       int   `json:"avg"`
}

type HealthOverviewResponse struct {
	AverageHeartRate7d  *int `json:"average_heart_rate_7d"`
	AverageHeartRate30d *int `json:"average_heart_rate_30d"`

	AverageSpO27d  *int `json:"average_spo2_7d"`
	AverageSpO230d *int `json:"average_spo2_30d"`

	AverageStress7d  *int `json:"average_stress_7d"`
	AverageStress30d *int `json:"average_stress_30d"`

	AverageSleepHours7d  *float64 `json:"average_sleep_hours_7d"`
	AverageSleepHours30d *float64 `json:"average_sleep_hours_30d"`

	AverageSteps7d  *int `json:"average_steps_7d"`
	AverageSteps30d *int `json:"average_steps_30d"`

	SleepStats7d        []DailySleepStat `json:"sleep_stats_7d"`
	SleepStats30d       []DailySleepStat `json:"sleep_stats_30d"`
	HeartRateHistory7d  []VitalStat      `json:"heart_rate_history_7d"`
	HeartRateHistory30d []VitalStat      `json:"heart_rate_history_30d"`
	SpO2History7d       []VitalStat      `json:"spo2_history_7d"`
	SpO2History30d      []VitalStat      `json:"spo2_history_30d"`
	StressHistory7d     []VitalStat      `json:"stress_history_7d"`
	StressHistory30d    []VitalStat      `json:"stress_history_30d"`
	StepStats7d         []store.DayStat  `json:"step_stats_7d"`
	StepStats30d        []store.DayStat  `json:"step_stats_30d"`
}

func (s *Server) handleGetHealthOverview(w http.ResponseWriter, r *http.Request) {
	userId := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	ctx := r.Context()
	clientLoc := parseClientLocation(r.URL.Query().Get("tz"), r.URL.Query().Get("tz_offset"))
	now := time.Now().In(clientLoc)
	todayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, clientLoc)
	start7d := todayStart.AddDate(0, 0, -6)
	start30d := todayStart.AddDate(0, 0, -29)
	start7dDay := start7d.Format("2006-01-02")
	start30dDay := start30d.Format("2006-01-02")

	resp := HealthOverviewResponse{}

	// Helper to calculate averages; returns nil when the input is empty so callers
	// can distinguish "no data" (null in JSON) from an actual zero average.
	calcAvg := func(values []int) *int {
		if len(values) == 0 {
			return nil
		}
		sum := 0
		for _, v := range values {
			sum += v
		}
		avg := sum / len(values)
		return &avg
	}

	bucketVitals := func(logs []struct {
		DateTime time.Time
		Value    int
	}, cutoff time.Time,
	) []VitalStat {
		type acc struct {
			sum, count, min, max int
		}
		buckets := make(map[int64]*acc)

		for _, l := range logs {
			if l.DateTime.Before(cutoff) {
				continue
			}
			// Truncate to hour block
			ts := l.DateTime.Truncate(time.Hour).UnixMilli()

			if b, exists := buckets[ts]; exists {
				b.sum += l.Value
				b.count++
				if l.Value < b.min {
					b.min = l.Value
				}
				if l.Value > b.max {
					b.max = l.Value
				}
			} else {
				buckets[ts] = &acc{sum: l.Value, count: 1, min: l.Value, max: l.Value}
			}
		}

		var stats []VitalStat
		for ts, b := range buckets {
			stats = append(stats, VitalStat{
				Timestamp: ts,
				Min:       b.min,
				Max:       b.max,
				Avg:       b.sum / b.count,
			})
		}

		sort.Slice(stats, func(i, j int) bool {
			return stats[i].Timestamp < stats[j].Timestamp
		})

		return stats
	}

	// Fetch Heart Rate (30d fetch covers 7d)
	hrLogs, err := s.health.GetVitalsHeart(ctx, userId, start30d, now)
	if err != nil {
		slog.Error("health overview: GetVitalsHeart", "error", err, "user", userId)
	}
	var hr7d, hr30d []int
	var hrBucketInput []struct {
		DateTime time.Time
		Value    int
	}

	for _, l := range hrLogs {
		hr30d = append(hr30d, l.Value)
		hrBucketInput = append(hrBucketInput, struct {
			DateTime time.Time
			Value    int
		}{l.DateTime, l.Value})
		if !l.DateTime.Before(start7d) {
			hr7d = append(hr7d, l.Value)
		}
	}
	resp.AverageHeartRate7d = calcAvg(hr7d)
	resp.AverageHeartRate30d = calcAvg(hr30d)
	resp.HeartRateHistory7d = bucketVitals(hrBucketInput, start7d)
	resp.HeartRateHistory30d = bucketVitals(hrBucketInput, start30d)

	// Fetch SpO2
	spo2Logs, err := s.health.GetVitalsSpO2(ctx, userId, start30d, now)
	if err != nil {
		slog.Error("health overview: GetVitalsSpO2", "error", err, "user", userId)
	}
	var spo27d, spo230d []int
	var spo2BucketInput []struct {
		DateTime time.Time
		Value    int
	}
	for _, l := range spo2Logs {
		spo230d = append(spo230d, l.Value)
		spo2BucketInput = append(spo2BucketInput, struct {
			DateTime time.Time
			Value    int
		}{l.DateTime, l.Value})
		if !l.DateTime.Before(start7d) {
			spo27d = append(spo27d, l.Value)
		}
	}
	resp.AverageSpO27d = calcAvg(spo27d)
	resp.AverageSpO230d = calcAvg(spo230d)
	resp.SpO2History7d = bucketVitals(spo2BucketInput, start7d)
	resp.SpO2History30d = bucketVitals(spo2BucketInput, start30d)

	// Fetch Stress
	stressLogs, err := s.health.GetVitalsStress(ctx, userId, start30d, now)
	if err != nil {
		slog.Error("health overview: GetVitalsStress", "error", err, "user", userId)
	}
	var stress7d, stress30d []int
	var stressBucketInput []struct {
		DateTime time.Time
		Value    int
	}
	for _, l := range stressLogs {
		stress30d = append(stress30d, l.Value)
		stressBucketInput = append(stressBucketInput, struct {
			DateTime time.Time
			Value    int
		}{l.DateTime, l.Value})
		if !l.DateTime.Before(start7d) {
			stress7d = append(stress7d, l.Value)
		}
	}
	resp.AverageStress7d = calcAvg(stress7d)
	resp.AverageStress30d = calcAvg(stress30d)
	resp.StressHistory7d = bucketVitals(stressBucketInput, start7d)
	resp.StressHistory30d = bucketVitals(stressBucketInput, start30d)

	// Fetch Sleep Logs — extend window by 1 day so sessions whose start_time falls
	// before UTC midnight on the boundary day (but whose local Day label is in range)
	// are not excluded by the start_time >= since SQL filter.
	sleepLogs, err := s.health.GetSleepLogs(ctx, userId, start30d.AddDate(0, 0, -1))
	if err != nil {
		slog.Error("health overview: GetSleepLogs", "error", err, "user", userId)
	}
	var sleep7dMins, sleep30dMins []int
	dailyStatsMap30d := make(map[string]DailySleepStat)
	type hrAcc struct{ weightedSum, totalMins int }
	dailyHRAcc := make(map[string]hrAcc)

	for _, l := range sleepLogs {
		if l.TotalMinutes != nil {
			dayStr := l.Day
			if dayStr == "" {
				dayStr = l.StartTime.Format("2006-01-02")
			}

			stat := dailyStatsMap30d[dayStr]
			stat.Date = dayStr
			stat.TotalMins += *l.TotalMinutes
			if l.LightMinutes != nil {
				stat.LightMins += *l.LightMinutes
			}
			if l.DeepMinutes != nil {
				stat.DeepMins += *l.DeepMinutes
			}
			if l.REMMinutes != nil {
				stat.RemMins += *l.REMMinutes
			}
			if l.AwakeMinutes != nil {
				stat.AwakeMins += *l.AwakeMinutes
			}
			if l.HeartRateAvg != nil && *l.HeartRateAvg > 0 {
				mins := *l.TotalMinutes
				if mins == 0 {
					mins = 1
				}
				acc := dailyHRAcc[dayStr]
				acc.weightedSum += *l.HeartRateAvg * mins
				acc.totalMins += mins
				dailyHRAcc[dayStr] = acc
			}
			dailyStatsMap30d[dayStr] = stat
		}
	}
	for dayStr, acc := range dailyHRAcc {
		if acc.totalMins > 0 {
			if stat, ok := dailyStatsMap30d[dayStr]; ok {
				stat.HeartRateAvg = acc.weightedSum / acc.totalMins
				dailyStatsMap30d[dayStr] = stat
			}
		}
	}

	var sleepStats7d, sleepStats30d []DailySleepStat
	for _, stat := range dailyStatsMap30d {
		if stat.Date < start30dDay {
			// Exclude the extra buffered day fetched to handle UTC boundary sessions.
			continue
		}
		sleepStats30d = append(sleepStats30d, stat)
		sleep30dMins = append(sleep30dMins, stat.TotalMins)
		if stat.Date >= start7dDay {
			sleepStats7d = append(sleepStats7d, stat)
			sleep7dMins = append(sleep7dMins, stat.TotalMins)
		}
	}
	sort.Slice(sleepStats7d, func(i, j int) bool {
		return sleepStats7d[i].Date < sleepStats7d[j].Date
	})
	sort.Slice(sleepStats30d, func(i, j int) bool {
		return sleepStats30d[i].Date < sleepStats30d[j].Date
	})
	resp.SleepStats7d = sleepStats7d
	resp.SleepStats30d = sleepStats30d

	avgMins7d := calcAvg(sleep7dMins)
	avgMins30d := calcAvg(sleep30dMins)

	if avgMins7d != nil {
		h := float64(*avgMins7d) / 60.0
		resp.AverageSleepHours7d = &h
	}
	if avgMins30d != nil {
		h := float64(*avgMins30d) / 60.0
		resp.AverageSleepHours30d = &h
	}

	// Fetch Day Stats for Steps
	dayStats, err := s.health.GetDayStats(ctx, userId, start30d)
	if err != nil {
		slog.Error("health overview: GetDayStats", "error", err, "user", userId)
	}
	var steps7d, steps30d []int
	var stepStats7d, stepStats30d []store.DayStat

	for _, stat := range dayStats {
		steps30d = append(steps30d, stat.Steps)
		stepStats30d = append(stepStats30d, stat)

		if stat.Day >= start7dDay {
			steps7d = append(steps7d, stat.Steps)
			stepStats7d = append(stepStats7d, stat)
		}
	}

	// Reverse to make it chronological because `GetDayStats` returns `ORDER BY day DESC`
	for i, j := 0, len(stepStats7d)-1; i < j; i, j = i+1, j-1 {
		stepStats7d[i], stepStats7d[j] = stepStats7d[j], stepStats7d[i]
	}
	for i, j := 0, len(stepStats30d)-1; i < j; i, j = i+1, j-1 {
		stepStats30d[i], stepStats30d[j] = stepStats30d[j], stepStats30d[i]
	}

	resp.StepStats7d = stepStats7d
	resp.StepStats30d = stepStats30d
	resp.AverageSteps7d = calcAvg(steps7d)
	resp.AverageSteps30d = calcAvg(steps30d)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
