package settings

import (
	"context"
	"strings"
	"testing"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	"github.com/korjavin/medicationtrackerbot/internal/store/migrations"
)

func setupSettingsRepo(t *testing.T) *Repo {
	t.Helper()
	d, err := storedb.Open(":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := d.Migrate(migrations.FS, "."); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return New(d)
}

func TestFeatureFlags(t *testing.T) {
	r := setupSettingsRepo(t)
	ctx := context.Background()

	tests := []struct {
		name       string
		getter     func(context.Context) (bool, error)
		setter     func(context.Context, bool) error
		defaultVal bool
	}{
		{"FoodIntake", r.GetFoodIntakeEnabled, r.SetFoodIntakeEnabled, false},
		{"BloodPressure", r.GetBloodPressureEnabled, r.SetBloodPressureEnabled, true},
		{"Weight", r.GetWeightEnabled, r.SetWeightEnabled, true},
		{"Medication", r.GetMedicationEnabled, r.SetMedicationEnabled, true},
		{"Workout", r.GetWorkoutEnabled, r.SetWorkoutEnabled, true},
		{"Health", r.GetHealthEnabled, r.SetHealthEnabled, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Default value
			val, err := tt.getter(ctx)
			if err != nil {
				t.Fatalf("Get %s: %v", tt.name, err)
			}
			if val != tt.defaultVal {
				t.Errorf("Expected default %v for %s, got %v", tt.defaultVal, tt.name, val)
			}

			// Toggle to opposite
			if err := tt.setter(ctx, !tt.defaultVal); err != nil {
				t.Fatalf("Set %s to %v: %v", tt.name, !tt.defaultVal, err)
			}
			val, err = tt.getter(ctx)
			if err != nil {
				t.Fatalf("Get %s after toggle: %v", tt.name, err)
			}
			if val != !tt.defaultVal {
				t.Errorf("Expected %v for %s after toggle", !tt.defaultVal, tt.name)
			}

			// Toggle back
			if err := tt.setter(ctx, tt.defaultVal); err != nil {
				t.Fatalf("Set %s to %v: %v", tt.name, tt.defaultVal, err)
			}
			val, err = tt.getter(ctx)
			if err != nil {
				t.Fatalf("Get %s after toggle back: %v", tt.name, err)
			}
			if val != tt.defaultVal {
				t.Errorf("Expected %v for %s after toggle back", tt.defaultVal, tt.name)
			}
		})
	}
}

func TestGetBool_RejectsUnknownColumn(t *testing.T) {
	r := setupSettingsRepo(t)
	ctx := context.Background()

	if _, err := r.GetBool(ctx, "definitely_not_a_column"); err == nil {
		t.Fatalf("expected GetBool with unknown column to fail")
	}
	if err := r.SetBool(ctx, "definitely_not_a_column", true); err == nil {
		t.Fatalf("expected SetBool with unknown column to fail")
	}
}

// TestSettingsBoolValidation guards the SQL-injection allowlist on the
// generic GetBool/SetBool helpers. The private-helper version of this test
// lived in internal/store/store_validation_test.go before the per-domain
// split; carrying it here keeps the allowlist contract under test.
func TestSettingsBoolValidation(t *testing.T) {
	r := setupSettingsRepo(t)
	ctx := context.Background()

	// Test valid columns
	validColumns := []string{
		"food_intake_enabled",
		"blood_pressure_enabled",
		"weight_enabled",
		"medication_enabled",
		"workout_enabled",
		"health_enabled",
	}

	for _, col := range validColumns {
		err := r.SetBool(ctx, col, true)
		if err != nil {
			t.Errorf("Expected success for setting %s, got: %v", col, err)
		}

		val, err := r.GetBool(ctx, col)
		if err != nil {
			t.Errorf("Expected success for getting %s, got: %v", col, err)
		}
		if !val {
			t.Errorf("Expected %s to be true, got false", col)
		}
	}

	// Test invalid columns (SQL Injection attempts)
	invalidColumns := []string{
		"invalid_column",
		"1; DROP TABLE settings",
		"food_intake_enabled; SELECT 1",
		"",
	}

	for _, col := range invalidColumns {
		err := r.SetBool(ctx, col, true)
		if err == nil {
			t.Errorf("Expected error for setting invalid column %q, but got nil", col)
		} else if !strings.Contains(err.Error(), "unknown settings column") {
			t.Errorf("Expected 'unknown settings column' error, got: %v", err)
		}

		_, err = r.GetBool(ctx, col)
		if err == nil {
			t.Errorf("Expected error for getting invalid column %q, but got nil", col)
		} else if !strings.Contains(err.Error(), "unknown settings column") {
			t.Errorf("Expected 'unknown settings column' error, got: %v", err)
		}
	}
}

func TestLastDownload(t *testing.T) {
	r := setupSettingsRepo(t)

	// Set a download time
	now := time.Now().Truncate(time.Second)
	err := r.UpdateLastDownload(now)
	if err != nil {
		t.Fatalf("UpdateLastDownload: %v", err)
	}

	// Retrieve it
	last, err := r.GetLastDownload()
	if err != nil {
		t.Fatalf("GetLastDownload after update: %v", err)
	}
	diff := last.Sub(now)
	if diff < -time.Second || diff > time.Second {
		t.Errorf("Expected %v, got %v (diff: %v)", now, last, diff)
	}

	// Update again
	later := now.Add(time.Hour)
	err = r.UpdateLastDownload(later)
	if err != nil {
		t.Fatalf("UpdateLastDownload again: %v", err)
	}

	last, err = r.GetLastDownload()
	if err != nil {
		t.Fatalf("GetLastDownload after second update: %v", err)
	}
	diff = last.Sub(later)
	if diff < -time.Second || diff > time.Second {
		t.Errorf("Expected %v, got %v (diff: %v)", later, last, diff)
	}
}

func TestIntegrationOpenAI(t *testing.T) {
	r := setupSettingsRepo(t)
	ctx := context.Background()

	got, err := r.GetIntegrationOpenAI(ctx)
	if err != nil {
		t.Fatalf("GetIntegrationOpenAI initial: %v", err)
	}
	if got != (IntegrationOpenAI{}) {
		t.Errorf("expected zero IntegrationOpenAI on fresh DB, got %+v", got)
	}

	in := IntegrationOpenAI{
		APIKey:       "sk-text",
		URL:          "https://api.example.test/v1",
		Model:        "model-x",
		VisionAPIKey: "sk-vision",
		VisionURL:    "https://vision.example.test/v1",
		VisionModel:  "model-vision",
	}
	if err := r.SetIntegrationOpenAI(ctx, in); err != nil {
		t.Fatalf("SetIntegrationOpenAI: %v", err)
	}

	got, err = r.GetIntegrationOpenAI(ctx)
	if err != nil {
		t.Fatalf("GetIntegrationOpenAI after set: %v", err)
	}
	if got != in {
		t.Errorf("round-trip mismatch:\n got %+v\nwant %+v", got, in)
	}

	// Empty string clears (overrides previously-saved value).
	if err := r.SetIntegrationOpenAI(ctx, IntegrationOpenAI{}); err != nil {
		t.Fatalf("SetIntegrationOpenAI clear: %v", err)
	}
	got, err = r.GetIntegrationOpenAI(ctx)
	if err != nil {
		t.Fatalf("GetIntegrationOpenAI after clear: %v", err)
	}
	if got != (IntegrationOpenAI{}) {
		t.Errorf("expected zero after clear, got %+v", got)
	}
}

func TestIntegrationFood(t *testing.T) {
	r := setupSettingsRepo(t)
	ctx := context.Background()

	got, err := r.GetIntegrationFood(ctx)
	if err != nil {
		t.Fatalf("GetIntegrationFood initial: %v", err)
	}
	if got != (IntegrationFood{}) {
		t.Errorf("expected zero on fresh DB, got %+v", got)
	}

	in := IntegrationFood{
		APIKey: "food-key",
		URL:    "https://food.example.test/v1",
		Domain: "food.example.test",
	}
	if err := r.SetIntegrationFood(ctx, in); err != nil {
		t.Fatalf("SetIntegrationFood: %v", err)
	}
	got, err = r.GetIntegrationFood(ctx)
	if err != nil {
		t.Fatalf("GetIntegrationFood after set: %v", err)
	}
	if got != in {
		t.Errorf("round-trip mismatch:\n got %+v\nwant %+v", got, in)
	}
}

func TestIntegrationElevenLabs(t *testing.T) {
	r := setupSettingsRepo(t)
	ctx := context.Background()

	got, err := r.GetIntegrationElevenLabs(ctx)
	if err != nil {
		t.Fatalf("GetIntegrationElevenLabs initial: %v", err)
	}
	if got != (IntegrationElevenLabs{}) {
		t.Errorf("expected zero on fresh DB, got %+v", got)
	}

	in := IntegrationElevenLabs{APIKey: "el-key", AgentID: "el-agent"}
	if err := r.SetIntegrationElevenLabs(ctx, in); err != nil {
		t.Fatalf("SetIntegrationElevenLabs: %v", err)
	}
	got, err = r.GetIntegrationElevenLabs(ctx)
	if err != nil {
		t.Fatalf("GetIntegrationElevenLabs after set: %v", err)
	}
	if got != in {
		t.Errorf("round-trip mismatch:\n got %+v\nwant %+v", got, in)
	}
}

// strPtr is a tiny helper for the patch tests below.
func strPtr(s string) *string { return &s }

// TestPatchIntegrations_OnlyWritesSetFields exercises the core invariant of
// PatchIntegrations: a nil pointer means "leave the column untouched," a non-nil
// pointer (including one pointing at "") means "write this value." Without this
// guarantee the partial PATCH handler would have to read-modify-write, opening
// a race window where a stale read can resurrect a column another patch just
// cleared.
func TestPatchIntegrations_OnlyWritesSetFields(t *testing.T) {
	r := setupSettingsRepo(t)
	ctx := context.Background()

	seed := IntegrationOpenAI{
		APIKey: "sk-existing", URL: "https://api.openai.com/v1", Model: "gpt-5",
		VisionAPIKey: "vk-existing", VisionURL: "https://vision.example.com", VisionModel: "gpt-4o-vision",
	}
	if err := r.SetIntegrationOpenAI(ctx, seed); err != nil {
		t.Fatalf("seed openai: %v", err)
	}

	// Patch only the model field; everything else must be preserved.
	if err := r.PatchIntegrations(ctx, &IntegrationOpenAIPatch{Model: strPtr("gpt-5-new")}, nil, nil); err != nil {
		t.Fatalf("patch model: %v", err)
	}
	got, err := r.GetIntegrationOpenAI(ctx)
	if err != nil {
		t.Fatalf("read openai: %v", err)
	}
	want := seed
	want.Model = "gpt-5-new"
	if got != want {
		t.Errorf("after model-only patch:\n got %+v\nwant %+v", got, want)
	}

	// Patch an explicit empty string (clear) for the API key.
	if err := r.PatchIntegrations(ctx, &IntegrationOpenAIPatch{APIKey: strPtr("")}, nil, nil); err != nil {
		t.Fatalf("patch apikey clear: %v", err)
	}
	got, err = r.GetIntegrationOpenAI(ctx)
	if err != nil {
		t.Fatalf("read openai after clear: %v", err)
	}
	if got.APIKey != "" {
		t.Errorf("APIKey should be cleared, got %q", got.APIKey)
	}
	if got.URL != seed.URL || got.VisionAPIKey != "vk-existing" {
		t.Errorf("other fields should be preserved after apikey clear, got %+v", got)
	}

	// All-nil patch is a no-op.
	if err := r.PatchIntegrations(ctx, &IntegrationOpenAIPatch{}, nil, nil); err != nil {
		t.Fatalf("patch noop: %v", err)
	}
}

// TestPatchIntegrations_ConcurrentDisjointFieldsDoNotClobber is the regression
// test for the read-modify-write race the previous SetIntegrations
// implementation had: a concurrent patch that cleared APIKey could be reverted
// by a sibling patch that read the pre-clear value before the clear committed
// and then wrote the whole group back. PatchIntegrations sidesteps this by only
// writing the explicitly-set columns, so two partial patches to disjoint fields
// must both stick.
func TestPatchIntegrations_ConcurrentDisjointFieldsDoNotClobber(t *testing.T) {
	r := setupSettingsRepo(t)
	ctx := context.Background()

	if err := r.SetIntegrationOpenAI(ctx, IntegrationOpenAI{
		APIKey: "sk-existing", URL: "https://api.openai.com/v1", Model: "gpt-5",
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// Maximize the chance the two patches overlap by gating both goroutines on a
	// channel barrier.
	start := make(chan struct{})
	done := make(chan error, 2)

	go func() {
		<-start
		done <- r.PatchIntegrations(ctx, &IntegrationOpenAIPatch{APIKey: strPtr("")}, nil, nil)
	}()
	go func() {
		<-start
		done <- r.PatchIntegrations(ctx, &IntegrationOpenAIPatch{URL: strPtr("https://proxy.example.com/v1")}, nil, nil)
	}()
	close(start)
	for i := 0; i < 2; i++ {
		if err := <-done; err != nil {
			t.Fatalf("concurrent patch: %v", err)
		}
	}

	got, err := r.GetIntegrationOpenAI(ctx)
	if err != nil {
		t.Fatalf("read openai: %v", err)
	}
	if got.APIKey != "" {
		t.Errorf("APIKey clear must stick across concurrent patches, got %q", got.APIKey)
	}
	if got.URL != "https://proxy.example.com/v1" {
		t.Errorf("URL update must stick across concurrent patches, got %q", got.URL)
	}
	if got.Model != "gpt-5" {
		t.Errorf("Model must be untouched (no patch touched it), got %q", got.Model)
	}
}

func TestTabOrder(t *testing.T) {
	r := setupSettingsRepo(t)
	ctx := context.Background()

	// Initial value should be empty
	order, err := r.GetTabOrder(ctx)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if order != "" {
		t.Fatalf("expected empty string, got %s", order)
	}

	// Update the order
	err = r.SetTabOrder(ctx, `["tab1", "tab2"]`)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	// Verify the update
	order, err = r.GetTabOrder(ctx)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if order != `["tab1", "tab2"]` {
		t.Fatalf("expected '[\"tab1\", \"tab2\"]', got %s", order)
	}
}
