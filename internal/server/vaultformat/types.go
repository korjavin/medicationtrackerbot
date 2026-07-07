package vaultformat

import (
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store/bp"
	"github.com/korjavin/medicationtrackerbot/internal/store/diary"
	"github.com/korjavin/medicationtrackerbot/internal/store/food"
	"github.com/korjavin/medicationtrackerbot/internal/store/medication"
	"github.com/korjavin/medicationtrackerbot/internal/store/settings"
	storetz "github.com/korjavin/medicationtrackerbot/internal/store/tz"
	"github.com/korjavin/medicationtrackerbot/internal/store/vitals"
	"github.com/korjavin/medicationtrackerbot/internal/store/weight"
	"github.com/korjavin/medicationtrackerbot/internal/store/workout"
)

type VaultFile struct {
	Format     string     `json:"format"`
	Version    int        `json:"version"`
	ExportedAt time.Time  `json:"exported_at"`
	Data       *VaultData `json:"data"`
}

type VaultData struct {
	Medications *VaultMedications `json:"medications,omitempty"`
	BP          *VaultBP          `json:"bp,omitempty"`
	Weight      *VaultWeight      `json:"weight,omitempty"`
	Food        *VaultFood        `json:"food,omitempty"`
	Workouts    *VaultWorkouts    `json:"workouts,omitempty"`
	Vitals      *VaultVitals      `json:"vitals,omitempty"`
	Diary       *VaultDiary       `json:"diary,omitempty"`
	TZ          *VaultTZ          `json:"tz,omitempty"`
	Settings    *VaultSettings    `json:"settings,omitempty"`
}

type VaultMedications struct {
	Medications []medication.Medication `json:"medications,omitempty"`
	Intakes     []medication.IntakeLog  `json:"intakes,omitempty"`
	Restocks    []medication.Restock    `json:"restocks,omitempty"`
}

type VaultBP struct {
	Readings []bp.BloodPressure `json:"readings,omitempty"`
	Goal     *bp.BPGoal         `json:"goal,omitempty"`
}

type VaultWeight struct {
	Logs     []weight.WeightLog  `json:"logs,omitempty"`
	Goals    []weight.WeightGoal `json:"goals,omitempty"`
	UnitPref string              `json:"unit_pref,omitempty"`
}

type VaultFood struct {
	Logs     []food.FoodLog         `json:"logs,omitempty"`
	Products []food.FoodProduct     `json:"products,omitempty"`
	Targets  *food.FoodTargets      `json:"targets,omitempty"`
}

type VaultWorkouts struct {
	Groups       []workout.WorkoutGroup       `json:"groups,omitempty"`
	Variants     []workout.WorkoutVariant     `json:"variants,omitempty"`
	Exercises    []workout.WorkoutExercise    `json:"exercises,omitempty"`
	Library      []workout.ExerciseLibraryItem `json:"library,omitempty"`
	Rotations    []workout.WorkoutRotationState `json:"rotations,omitempty"`
	Sessions     []workout.WorkoutSession     `json:"sessions,omitempty"`
	ExerciseLogs []workout.WorkoutExerciseLog `json:"exercise_logs,omitempty"`
	MiBand       []workout.MiBandWorkout      `json:"miband,omitempty"`
}

type VaultVitals struct {
	Sleep    []vitals.SleepLog       `json:"sleep,omitempty"`
	DayStats []vitals.DayStat        `json:"day_stats,omitempty"`
	Heart    []vitals.VitalsHeartLog `json:"heart,omitempty"`
	SpO2     []vitals.VitalsSpO2Log  `json:"spo2,omitempty"`
	Stress   []vitals.VitalsStressLog `json:"stress,omitempty"`
}

type VaultDiary struct {
	Notes []diary.DiaryNote `json:"notes,omitempty"`
}

type VaultTZ struct {
	Current        string                    `json:"current,omitempty"`
	History        []storetz.TimezoneHistory `json:"history,omitempty"`
	TransitionPlan *storetz.TZTransitionPlan `json:"transition_plan,omitempty"`
}

type VaultSettings struct {
	Timezone          string                                 `json:"timezone,omitempty"`
	Features          map[string]bool                        `json:"features,omitempty"`
	TabOrder          string                                 `json:"tab_order,omitempty"`
	Integrations      *VaultIntegrations                     `json:"integrations,omitempty"`
	MedReminderPref   *medication.ScheduleConfig             `json:"med_reminder_pref,omitempty"`
	DismissedFlags    map[string]bool                        `json:"dismissed_flags,omitempty"`
}

type VaultIntegrations struct {
	OpenAI     settings.IntegrationOpenAI     `json:"openai,omitempty"`
	Food       settings.IntegrationFood       `json:"food,omitempty"`
	ElevenLabs settings.IntegrationElevenLabs `json:"elevenlabs,omitempty"`
}
