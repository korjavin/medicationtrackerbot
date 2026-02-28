package server

import (
	"encoding/json"
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
	AverageHeartRate7d  int `json:"average_heart_rate_7d"`
	AverageHeartRate30d int `json:"average_heart_rate_30d"`

	AverageSpO27d  int `json:"average_spo2_7d"`
	AverageSpO230d int `json:"average_spo2_30d"`

	AverageStress7d  int `json:"average_stress_7d"`
	AverageStress30d int `json:"average_stress_30d"`

	AverageSleepHours7d  float64 `json:"average_sleep_hours_7d"`
	AverageSleepHours30d float64 `json:"average_sleep_hours_30d"`

	AverageSteps7d  int `json:"average_steps_7d"`
	AverageSteps30d int `json:"average_steps_30d"`

	SleepStats7d       []DailySleepStat `json:"sleep_stats_7d"`
	HeartRateHistory7d []VitalStat      `json:"heart_rate_history_7d"`
	SpO2History7d      []VitalStat      `json:"spo2_history_7d"`
	StressHistory7d    []VitalStat      `json:"stress_history_7d"`
	StepStats7d        []store.DayStat  `json:"step_stats_7d"`
}

func (s *Server) handleGetHealthOverview(w http.ResponseWriter, r *http.Request) {
	userId := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	ctx := r.Context()
	now := time.Now().UTC()
	start7d := now.AddDate(0, 0, -7)
	start30d := now.AddDate(0, 0, -30)

	resp := HealthOverviewResponse{}

	// Helper to calculate averages correctly
	calcAvg := func(values []int) int {
		if len(values) == 0 {
			return 0
		}
		sum := 0
		for _, v := range values {
			sum += v
		}
		return sum / len(values)
	}

	bucketVitals := func(logs []struct {
		DateTime time.Time
		Value    int
	}) []VitalStat {
		type acc struct {
			sum, count, min, max int
		}
		buckets := make(map[int64]*acc)

		for _, l := range logs {
			if l.DateTime.Before(start7d) {
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
	hrLogs, _ := s.health.GetVitalsHeart(ctx, userId, start30d, now)
	var hr7d, hr30d []int
	var hrBucketInput []struct {
		DateTime time.Time
		Value    int
	}

	for _, l := range hrLogs {
		hr30d = append(hr30d, l.Value)
		if l.DateTime.After(start7d) {
			hr7d = append(hr7d, l.Value)
			hrBucketInput = append(hrBucketInput, struct {
				DateTime time.Time
				Value    int
			}{l.DateTime, l.Value})
		}
	}
	resp.AverageHeartRate7d = calcAvg(hr7d)
	resp.AverageHeartRate30d = calcAvg(hr30d)
	resp.HeartRateHistory7d = bucketVitals(hrBucketInput)

	// Fetch SpO2
	spo2Logs, _ := s.health.GetVitalsSpO2(ctx, userId, start30d, now)
	var spo27d, spo230d []int
	var spo2BucketInput []struct {
		DateTime time.Time
		Value    int
	}
	for _, l := range spo2Logs {
		spo230d = append(spo230d, l.Value)
		if l.DateTime.After(start7d) {
			spo27d = append(spo27d, l.Value)
			spo2BucketInput = append(spo2BucketInput, struct {
				DateTime time.Time
				Value    int
			}{l.DateTime, l.Value})
		}
	}
	resp.AverageSpO27d = calcAvg(spo27d)
	resp.AverageSpO230d = calcAvg(spo230d)
	resp.SpO2History7d = bucketVitals(spo2BucketInput)

	// Fetch Stress
	stressLogs, _ := s.health.GetVitalsStress(ctx, userId, start30d, now)
	var stress7d, stress30d []int
	var stressBucketInput []struct {
		DateTime time.Time
		Value    int
	}
	for _, l := range stressLogs {
		stress30d = append(stress30d, l.Value)
		if l.DateTime.After(start7d) {
			stress7d = append(stress7d, l.Value)
			stressBucketInput = append(stressBucketInput, struct {
				DateTime time.Time
				Value    int
			}{l.DateTime, l.Value})
		}
	}
	resp.AverageStress7d = calcAvg(stress7d)
	resp.AverageStress30d = calcAvg(stress30d)
	resp.StressHistory7d = bucketVitals(stressBucketInput)

	// Fetch Sleep Logs
	sleepLogs, _ := s.health.GetSleepLogs(ctx, userId, start30d)
	var sleep7dMins, sleep30dMins []int
	dailyStatsMap := make(map[string]DailySleepStat)

	for _, l := range sleepLogs {
		if l.TotalMinutes != nil {
			sleep30dMins = append(sleep30dMins, *l.TotalMinutes)
			if l.StartTime.After(start7d) {
				sleep7dMins = append(sleep7dMins, *l.TotalMinutes)

				dayStr := l.Day
				if dayStr == "" {
					dayStr = l.StartTime.Format("2006-01-02")
				}

				stat := dailyStatsMap[dayStr]
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
					if stat.HeartRateAvg == 0 {
						stat.HeartRateAvg = *l.HeartRateAvg
					} else {
						stat.HeartRateAvg = (stat.HeartRateAvg + *l.HeartRateAvg) / 2
					}
				}
				dailyStatsMap[dayStr] = stat
			}
		}
	}

	var sleepStats7d []DailySleepStat
	for _, stat := range dailyStatsMap {
		sleepStats7d = append(sleepStats7d, stat)
	}
	sort.Slice(sleepStats7d, func(i, j int) bool {
		return sleepStats7d[i].Date < sleepStats7d[j].Date
	})
	resp.SleepStats7d = sleepStats7d

	avgMins7d := calcAvg(sleep7dMins)
	avgMins30d := calcAvg(sleep30dMins)

	resp.AverageSleepHours7d = float64(avgMins7d) / 60.0
	resp.AverageSleepHours30d = float64(avgMins30d) / 60.0

	// Fetch Day Stats for Steps
	dayStats, _ := s.health.GetDayStats(ctx, userId, start30d)
	var steps7d, steps30d []int
	var stepStats7d []store.DayStat

	for _, stat := range dayStats {
		steps30d = append(steps30d, stat.Steps)

		t, err := time.Parse("2006-01-02", stat.Day)
		if err == nil && t.After(start7d) {
			steps7d = append(steps7d, stat.Steps)
			stepStats7d = append(stepStats7d, stat)
		}
	}

	// Reverse to make it chronological because `GetDayStats` returns `ORDER BY day DESC`
	for i, j := 0, len(stepStats7d)-1; i < j; i, j = i+1, j-1 {
		stepStats7d[i], stepStats7d[j] = stepStats7d[j], stepStats7d[i]
	}

	resp.StepStats7d = stepStats7d
	resp.AverageSteps7d = calcAvg(steps7d)
	resp.AverageSteps30d = calcAvg(steps30d)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
