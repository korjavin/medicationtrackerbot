package server

import "time"

// Canonical vault format v1 — the no-lock-in full-user backup shape shared by
// GET /api/export (vault_export.go) and POST /api/import (vault_import.go).
//
// The contract is documented in docs/vault-format.md and pinned against the
// golden fixture tests/fixtures/vault-v1.json. Field names and value formats
// match each domain's existing /api wire shape (which the cloud record bodies
// also follow), so this is the only Go dialect and it mirrors web/domain/vault.js.
//
// Nullable/optional scalars use pointers WITHOUT omitempty so an explicit null
// round-trips (matching the fixture); fields the round-trip contract treats as
// "absent == null == empty" (info, med_name, total_steps, approved_at,
// med_reminder_pref) use omitempty. Derived fields (bp category, weight_trend,
// miband start/end, IDs on leaf records) are never emitted — see the skip list.

const (
	vaultFormat  = "medtracker-vault"
	vaultVersion = 1

	// vaultIOTimeout replaces the http.Server Read/WriteTimeout on the two vault
	// handlers, which move a whole user's history in one request and legitimately
	// take minutes on a large dataset. Bounded, not cleared: a stuck transfer
	// still dies rather than pinning a goroutine + an import transaction forever.
	vaultIOTimeout = 10 * time.Minute

	// maxVaultUploadBytes caps the raw POST /api/import body. The UI gzips it, so
	// this is 64MB of *compressed* vault — roughly a gigabyte of JSON.
	maxVaultUploadBytes = 64 << 20
	// maxVaultInflatedBytes caps what that gzip may expand to, so a small
	// malicious body can't inflate into an OOM.
	maxVaultInflatedBytes = 1 << 30
)

// Vault is the top-level envelope.
type Vault struct {
	Format     string    `json:"format"`
	Version    int       `json:"version"`
	ExportedAt string    `json:"exported_at"`
	Data       VaultData `json:"data"`
}

// VaultData holds one key per domain.
//
// APITokens is a pointer-slice, not a plain slice: it is the only block (with
// Settings.Integrations) whose import is NOT replace-semantics. Absent means
// "the export was taken with include_secrets=0 — leave the target's tokens
// alone"; a present (even empty) array replaces them. nil vs []{} must survive
// the JSON boundary, which a plain `omitempty` slice cannot express.
type VaultData struct {
	Medications  VaultMedications  `json:"medications"`
	BP           VaultBP           `json:"bp"`
	Weight       VaultWeight       `json:"weight"`
	Food         VaultFood         `json:"food"`
	Workouts     VaultWorkouts     `json:"workouts"`
	Vitals       VaultVitals       `json:"vitals"`
	Diary        VaultDiary        `json:"diary"`
	TZ           VaultTZ           `json:"tz"`
	Settings     VaultSettings     `json:"settings"`
	Gamification VaultGamification `json:"gamification"`
	APITokens    *[]VaultAPIToken  `json:"api_tokens,omitempty"`
}

// --- medications ---

type VaultMedications struct {
	Items    []VaultMedication `json:"items"`
	Intakes  []VaultIntake     `json:"intakes"`
	Restocks []VaultRestock    `json:"restocks"`
}

type VaultMedication struct {
	ID             int64      `json:"id"`
	Name           string     `json:"name"`
	Dosage         string     `json:"dosage"`
	Schedule       string     `json:"schedule"`
	Archived       bool       `json:"archived"`
	Supplement     bool       `json:"supplement"`
	StartDate      *time.Time `json:"start_date"`
	EndDate        *time.Time `json:"end_date"`
	RxCUI          string     `json:"rxcui"`
	NormalizedName string     `json:"normalized_name"`
	InventoryCount *int       `json:"inventory_count"`
	TZShiftPolicy  string     `json:"tz_shift_policy"`
	CreatedAt      time.Time  `json:"created_at"`
}

type VaultIntake struct {
	MedicationID int64      `json:"medication_id"`
	ScheduledAt  time.Time  `json:"scheduled_at"`
	TakenAt      *time.Time `json:"taken_at"`
	Status       string     `json:"status"`
	SnoozedUntil *time.Time `json:"snoozed_until"`
	Source       string     `json:"source"`
	// source='tz_step' doses are only visible to the medication repo when they
	// still point at their plan (the APPROVED/COMPLETED gate in
	// medication/repo.go). Carry the FK — tz_transition_plans.id is preserved
	// verbatim on import — or a restore permanently hides them.
	TZPlanID     *int64 `json:"tz_plan_id,omitempty"`
	TZStepNumber *int64 `json:"tz_step_number,omitempty"`
}

type VaultRestock struct {
	MedicationID int64     `json:"medication_id"`
	Quantity     int       `json:"quantity"`
	Note         string    `json:"note"`
	RestockedAt  time.Time `json:"restocked_at"`
}

// --- bp ---

type VaultBP struct {
	Readings []VaultBPReading `json:"readings"`
	Goal     *VaultBPGoal     `json:"goal"`
}

type VaultBPReading struct {
	MeasuredAt time.Time `json:"measured_at"`
	Systolic   int       `json:"systolic"`
	Diastolic  int       `json:"diastolic"`
	Pulse      *int      `json:"pulse"`
	Site       string    `json:"site"`
	Position   string    `json:"position"`
	IgnoreCalc bool      `json:"ignore_calc"`
	Notes      string    `json:"notes"`
	Tag        string    `json:"tag"`
}

type VaultBPGoal struct {
	TargetSystolic  *int `json:"target_systolic"`
	TargetDiastolic *int `json:"target_diastolic"`
}

// --- weight ---

type VaultWeight struct {
	Logs []VaultWeightLog `json:"logs"`
	// Goals is the full append-only goal history, oldest first. Replace-import
	// restores every row; the legacy singleton settings.weight_goal{,_date}
	// columns are rebuilt from the newest one.
	Goals    []VaultWeightGoal `json:"goals"`
	UnitPref *string           `json:"unit_pref"`
}

type VaultWeightLog struct {
	MeasuredAt time.Time `json:"measured_at"`
	Weight     float64   `json:"weight"`
	BodyFat    *float64  `json:"body_fat"`
	MuscleMass *float64  `json:"muscle_mass"`
	Notes      string    `json:"notes"`
}

type VaultWeightGoal struct {
	TargetWeight float64   `json:"target_weight"`
	TargetDate   string    `json:"target_date"`
	SetAt        time.Time `json:"set_at"`
	StartWeight  *float64  `json:"start_weight"`
}

// --- food ---

type VaultFood struct {
	Logs     []VaultFoodLog     `json:"logs"`
	Products []VaultFoodProduct `json:"products"`
}

type VaultFoodLog struct {
	EatenAt   time.Time `json:"eaten_at"`
	Name      string    `json:"name"`
	Weight    int       `json:"weight"`
	Calories  int       `json:"calories"`
	Carbs     int       `json:"carbs"`
	Protein   int       `json:"protein"`
	Fat       int       `json:"fat"`
	IsMeal    bool      `json:"is_meal"`
	ProductID *int64    `json:"product_id"`
}

type VaultFoodProduct struct {
	ID             int64     `json:"id"`
	Name           string    `json:"name"`
	Barcode        *string   `json:"barcode"`
	Carbs100g      float64   `json:"carbs_100g"`
	Protein100g    float64   `json:"protein_100g"`
	Fat100g        float64   `json:"fat_100g"`
	EnergyKcal100g float64   `json:"energy_kcal_100g"`
	UsageCount     int       `json:"usage_count"`
	IsMeal         bool      `json:"is_meal"`
	TotalWeightG   int       `json:"total_weight_g"`
	CreatedAt      time.Time `json:"created_at"`
	LastUsedAt     time.Time `json:"last_used_at"`
}

// --- workouts ---

type VaultWorkouts struct {
	Groups       []VaultWorkoutGroup    `json:"groups"`
	Variants     []VaultWorkoutVariant  `json:"variants"`
	Exercises    []VaultWorkoutExercise `json:"exercises"`
	Library      []VaultLibraryEntry    `json:"library"`
	Rotations    []VaultRotation        `json:"rotations"`
	Sessions     []VaultSession         `json:"sessions"`
	ExerciseLogs []VaultExerciseLog     `json:"exercise_logs"`
	MiBand       []VaultMiBand          `json:"miband"`
}

type VaultWorkoutGroup struct {
	ID                         int64     `json:"id"`
	UserID                     int64     `json:"user_id"`
	Name                       string    `json:"name"`
	Description                string    `json:"description"`
	IsRotating                 bool      `json:"is_rotating"`
	DaysOfWeek                 string    `json:"days_of_week"`
	ScheduledTime              string    `json:"scheduled_time"`
	NotificationAdvanceMinutes int       `json:"notification_advance_minutes"`
	Active                     bool      `json:"active"`
	CreatedAt                  time.Time `json:"created_at"`
	UpdatedAt                  time.Time `json:"updated_at"`
}

type VaultWorkoutVariant struct {
	ID            int64     `json:"id"`
	GroupID       int64     `json:"group_id"`
	Name          string    `json:"name"`
	RotationOrder *int      `json:"rotation_order"`
	Description   string    `json:"description"`
	CreatedAt     time.Time `json:"created_at"`
}

type VaultWorkoutExercise struct {
	ID             int64    `json:"id"`
	VariantID      int64    `json:"variant_id"`
	ExerciseName   string   `json:"exercise_name"`
	TargetSets     int      `json:"target_sets"`
	TargetRepsMin  int      `json:"target_reps_min"`
	TargetRepsMax  *int     `json:"target_reps_max"`
	TargetWeightKg *float64 `json:"target_weight_kg"`
	OrderIndex     int      `json:"order_index"`
	// ExerciseLibraryID is the FK to the exercise_library row the name resolves
	// through (med-prk.2). Carried so a library rename keeps propagating to
	// imported plans; the cloud vault already round-trips it via stripMeta.
	ExerciseLibraryID *int64 `json:"exercise_library_id,omitempty"`
}

type VaultLibraryEntry struct {
	ID              int64     `json:"id"`
	UserID          int64     `json:"user_id"`
	Name            string    `json:"name"`
	DefaultSets     int       `json:"default_sets"`
	DefaultRepsMin  int       `json:"default_reps_min"`
	DefaultRepsMax  *int      `json:"default_reps_max"`
	DefaultWeightKg *float64  `json:"default_weight_kg"`
	Notes           string    `json:"notes"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

type VaultRotation struct {
	GroupID          int64      `json:"group_id"`
	CurrentVariantID int64      `json:"current_variant_id"`
	LastSessionDate  *time.Time `json:"last_session_date"`
	UpdatedAt        time.Time  `json:"updated_at"`
}

type VaultSession struct {
	ID                    int64      `json:"id"`
	UserID                int64      `json:"user_id"`
	GroupID               int64      `json:"group_id"`
	VariantID             int64      `json:"variant_id"`
	ScheduledDate         time.Time  `json:"scheduled_date"`
	ScheduledTime         string     `json:"scheduled_time"`
	Status                string     `json:"status"`
	StartedAt             *time.Time `json:"started_at"`
	CompletedAt           *time.Time `json:"completed_at"`
	SnoozedUntil          *time.Time `json:"snoozed_until"`
	SnoozeCount           int        `json:"snooze_count"`
	NotificationMessageID *int       `json:"notification_message_id"`
	Notes                 string     `json:"notes"`
}

type VaultExerciseLog struct {
	SessionID     int64     `json:"session_id"`
	ExerciseID    int64     `json:"exercise_id"`
	ExerciseName  string    `json:"exercise_name"`
	SetsCompleted *int      `json:"sets_completed"`
	RepsCompleted *int      `json:"reps_completed"`
	WeightKg      *float64  `json:"weight_kg"`
	Status        string    `json:"status"`
	Notes         string    `json:"notes"`
	LoggedAt      time.Time `json:"logged_at"`
	Source        string    `json:"source"`
}

type VaultMiBand struct {
	ActivityType  int             `json:"activity_type"`
	ActivityName  string          `json:"activity_name"`
	SourceStartMs int64           `json:"source_start_ms"`
	SourceEndMs   int64           `json:"source_end_ms"`
	TzOffset      int             `json:"tz_offset"`
	DurationSec   int             `json:"duration_sec"`
	DistanceM     float64         `json:"distance_m"`
	Steps         int             `json:"steps"`
	Calories      int             `json:"calories"`
	HeartRateAvg  int             `json:"heart_rate_avg"`
	SpO2Avg       int             `json:"spo2_avg"`
	PauseMs       int64           `json:"pause_ms"`
	Source        string          `json:"source"`
	GPS           []VaultGPSPoint `json:"gps"`
}

type VaultGPSPoint struct {
	PointIndex int     `json:"point_index"`
	TsMs       int64   `json:"ts_ms"`
	Latitude   float64 `json:"latitude"`
	Longitude  float64 `json:"longitude"`
	Altitude   float64 `json:"altitude"`
	IsPause    bool    `json:"is_pause"`
}

// --- vitals ---

type VaultVitals struct {
	Sleep    []VaultSleep   `json:"sleep"`
	DayStats []VaultDayStat `json:"day_stats"`
	Heart    []VaultSample  `json:"heart"`
	SpO2     []VaultSample  `json:"spo2"`
	Stress   []VaultSample  `json:"stress"`
}

type VaultSleep struct {
	StartTime      time.Time `json:"start_time"`
	EndTime        time.Time `json:"end_time"`
	TimezoneOffset int       `json:"timezone_offset"`
	Day            string    `json:"day"`
	LightMinutes   *int      `json:"light_minutes"`
	DeepMinutes    *int      `json:"deep_minutes"`
	REMMinutes     *int      `json:"rem_minutes"`
	AwakeMinutes   *int      `json:"awake_minutes"`
	TotalMinutes   *int      `json:"total_minutes"`
	TurnOverCount  *int      `json:"turn_over_count"`
	HeartRateAvg   *int      `json:"heart_rate_avg"`
	SpO2Avg        *int      `json:"spo2_avg"`
	UserModified   bool      `json:"user_modified"`
	Notes          string    `json:"notes"`
}

type VaultDayStat struct {
	Day      string `json:"day"`
	Steps    int    `json:"steps"`
	Calories int    `json:"calories"`
	Distance int    `json:"distance"`
}

// VaultSample is one heart/spo2/stress sample. Info only appears on stress.
type VaultSample struct {
	DateTime time.Time `json:"date_time"`
	TzOffset int       `json:"tz_offset"`
	Value    int       `json:"value"`
	// Type is the per-sample discriminator the /api/health/* reads and the
	// Mi Band importer both use. omitempty so the common 0 stays off the wire.
	Type int    `json:"type,omitempty"`
	Info string `json:"info,omitempty"`
}

// --- diary ---

type VaultDiary struct {
	Notes []VaultNote `json:"notes"`
}

type VaultNote struct {
	Content   string    `json:"content"`
	Tag       *string   `json:"tag"`
	CreatedAt time.Time `json:"created_at"`
}

// --- tz ---

type VaultTZ struct {
	Current *string         `json:"current"`
	History []VaultTZChange `json:"history"`
	// TransitionPlans is the full plan history, oldest first — past plans feed
	// history analysis and the wipe deletes every row, so exporting only the
	// active/pending one loses data on a replace-import.
	TransitionPlans []VaultTZPlan `json:"transition_plans"`
}

type VaultTZChange struct {
	Timezone  string    `json:"timezone"`
	ChangedAt time.Time `json:"changed_at"`
}

type VaultTZPlan struct {
	// ID is preserved verbatim on import so intake_log.tz_plan_id keeps
	// resolving. Absent (cloud-native vaults) means "assign a fresh id".
	ID         int64         `json:"id,omitempty"`
	OldTZ      string        `json:"old_tz"`
	NewTZ      string        `json:"new_tz"`
	Status     string        `json:"status"`
	CreatedAt  time.Time     `json:"created_at"`
	ApprovedAt *time.Time    `json:"approved_at,omitempty"`
	NotifiedAt *time.Time    `json:"notified_at,omitempty"`
	PlanHash   string        `json:"plan_hash"`
	InputsJSON string        `json:"inputs_json"`
	UserAction string        `json:"user_action,omitempty"`
	Steps      []VaultTZStep `json:"steps"`
}

type VaultTZStep struct {
	MedicationID int64     `json:"medication_id"`
	MedName      string    `json:"med_name,omitempty"`
	StepNumber   int       `json:"step_number"`
	TotalSteps   int       `json:"total_steps,omitempty"`
	ScheduledAt  time.Time `json:"scheduled_at"`
	Note         string    `json:"note"`
}

// --- settings ---

type VaultSettings struct {
	Timezone              string            `json:"timezone"`
	DismissedTZSuggestion string            `json:"dismissed_tz_suggestion"`
	Features              VaultFeatures     `json:"features"`
	TabOrder              []string          `json:"tab_order"`
	FoodTargets           *VaultFoodTargets `json:"food_targets"`
	// Integrations is a pointer: absent (include_secrets=0) means "leave the
	// target's provider keys alone", while a present block replaces them. An
	// empty-string-filled block is NOT the same thing — it clears them.
	Integrations    *VaultIntegrations    `json:"integrations,omitempty"`
	MedReminderPref *VaultMedReminderPref `json:"med_reminder_pref,omitempty"`
	// BPReminder / WeightReminder mirror med_reminder_pref for the two
	// scheduler-owned reminder-state rows. Only the user-set fields travel; the
	// transient scheduler/Telegram columns (last_notification_sent_at,
	// notification_message_id) stay behind.
	BPReminder     *VaultReminderState `json:"bp_reminder,omitempty"`
	WeightReminder *VaultReminderState `json:"weight_reminder,omitempty"`
}

type VaultReminderState struct {
	Enabled               bool       `json:"enabled"`
	PreferredReminderHour int        `json:"preferred_reminder_hour"`
	SnoozedUntil          *time.Time `json:"snoozed_until"`
	DontRemindUntil       *time.Time `json:"dont_remind_until"`
}

// VaultFeatures uses pointers so an absent flag (missing key, or a fresh
// cloud account whose export emits `features: {}`) stays nil and is left
// untouched on import — writing a zero-value false would silently disable the
// section. A real per-mode export always populates all eight.
type VaultFeatures struct {
	Food         *bool `json:"food"`
	BP           *bool `json:"bp"`
	Weight       *bool `json:"weight"`
	Medication   *bool `json:"medication"`
	Workout      *bool `json:"workout"`
	Health       *bool `json:"health"`
	Gamification *bool `json:"gamification"`
	WeeklyDigest *bool `json:"weekly_digest"`
}

type VaultFoodTargets struct {
	Calories int `json:"calories"`
	Carbs    int `json:"carbs"`
	Protein  int `json:"protein"`
	Fat      int `json:"fat"`
}

type VaultIntegrations struct {
	OpenAI     VaultOpenAI          `json:"openai"`
	Food       VaultFoodIntegration `json:"food"`
	ElevenLabs VaultElevenLabs      `json:"elevenlabs"`
}

type VaultOpenAI struct {
	APIKey       string `json:"api_key"`
	URL          string `json:"url"`
	Model        string `json:"model"`
	VisionAPIKey string `json:"vision_api_key"`
	VisionURL    string `json:"vision_url"`
	VisionModel  string `json:"vision_model"`
}

type VaultFoodIntegration struct {
	APIKey string `json:"api_key"`
	URL    string `json:"url"`
	Domain string `json:"domain"`
}

type VaultElevenLabs struct {
	APIKey  string `json:"api_key"`
	AgentID string `json:"agent_id"`
}

type VaultMedReminderPref struct {
	Enabled bool `json:"enabled"`
}

// --- gamification ---

// VaultGamification carries the HealthPoints engine's three tables. The ledger
// is technically recomputable, but only from health data that predates the
// user's install window, so a restore that drops it silently resets HP/level.
// Leaf ids are omitted (metric_key and the ledger's UNIQUE tuple are the
// natural keys).
type VaultGamification struct {
	Targets []VaultGamTarget      `json:"targets"`
	Ledger  []VaultGamLedgerEntry `json:"ledger"`
	State   *VaultGamState        `json:"state"`
}

type VaultGamTarget struct {
	MetricKey string    `json:"metric_key"`
	LowVal    *float64  `json:"low_val"`
	HighVal   *float64  `json:"high_val"`
	Falloff   *float64  `json:"falloff"`
	Mode      *string   `json:"mode"`
	UpdatedAt time.Time `json:"updated_at"`
}

type VaultGamLedgerEntry struct {
	// Day is the UTC-midnight instant of the scored day (stored as day_unix).
	Day          time.Time `json:"day"`
	Ring         string    `json:"ring"`
	SourceMetric string    `json:"source_metric"`
	Kind         string    `json:"kind"`
	HP           int       `json:"hp"`
	Detail       *string   `json:"detail"`
	CreatedAt    time.Time `json:"created_at"`
}

type VaultGamState struct {
	LifetimeHP    int        `json:"lifetime_hp"`
	Level         int        `json:"level"`
	CurrentStreak int        `json:"current_streak"`
	LongestStreak int        `json:"longest_streak"`
	Freezes       int        `json:"freezes"`
	InsightTier   int        `json:"insight_tier"`
	LastScoredDay *time.Time `json:"last_scored_day"`
	BackfilledAt  *time.Time `json:"backfilled_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

// --- api tokens ---

// VaultAPIToken carries the bcrypt-style token_hash, not the plaintext (which
// is unrecoverable). That is exactly what makes an already-minted MCP/API token
// keep authenticating after a server move.
type VaultAPIToken struct {
	Name       string     `json:"name"`
	TokenHash  string     `json:"token_hash"`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at"`
}
