package server

import (
	"encoding/json"
	"net/http"
	"sort"
	"time"
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

type HealthOverviewResponse struct {
	AverageHeartRate7d  int `json:"average_heart_rate_7d"`
	AverageHeartRate30d int `json:"average_heart_rate_30d"`

	AverageSpO27d  int `json:"average_spo2_7d"`
	AverageSpO230d int `json:"average_spo2_30d"`

	AverageStress7d  int `json:"average_stress_7d"`
	AverageStress30d int `json:"average_stress_30d"`

	AverageSleepHours7d  float64 `json:"average_sleep_hours_7d"`
	AverageSleepHours30d float64 `json:"average_sleep_hours_30d"`

	SleepStats7d []DailySleepStat `json:"sleep_stats_7d"`
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

	// Fetch Heart Rate (30d fetch covers 7d)
	hrLogs, _ := s.store.GetVitalsHeart(ctx, userId, start30d, now)
	var hr7d, hr30d []int
	for _, l := range hrLogs {
		hr30d = append(hr30d, l.Value)
		if l.DateTime.After(start7d) {
			hr7d = append(hr7d, l.Value)
		}
	}
	resp.AverageHeartRate7d = calcAvg(hr7d)
	resp.AverageHeartRate30d = calcAvg(hr30d)

	// Fetch SpO2
	spo2Logs, _ := s.store.GetVitalsSpO2(ctx, userId, start30d, now)
	var spo27d, spo230d []int
	for _, l := range spo2Logs {
		spo230d = append(spo230d, l.Value)
		if l.DateTime.After(start7d) {
			spo27d = append(spo27d, l.Value)
		}
	}
	resp.AverageSpO27d = calcAvg(spo27d)
	resp.AverageSpO230d = calcAvg(spo230d)

	// Fetch Stress
	stressLogs, _ := s.store.GetVitalsStress(ctx, userId, start30d, now)
	var stress7d, stress30d []int
	for _, l := range stressLogs {
		stress30d = append(stress30d, l.Value)
		if l.DateTime.After(start7d) {
			stress7d = append(stress7d, l.Value)
		}
	}
	resp.AverageStress7d = calcAvg(stress7d)
	resp.AverageStress30d = calcAvg(stress30d)

	// Fetch Sleep Logs
	sleepLogs, _ := s.store.GetSleepLogs(ctx, userId, start30d)
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

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
