package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
	"github.com/korjavin/medicationtrackerbot/internal/store/settings"
)

// TestVaultImportRoundTrip is the bot-side half of the cross-runtime contract
// (Task 7): import the shared golden fixture into a fresh migrated DB, then
// export, and require the export to equal the fixture modulo the documented
// normalizations (exported_at is per-run; med_reminder_pref is a cloud-only
// singleton the bot has no row for). Any field-name or storage-conversion
// drift in either handler fails here.
func TestVaultImportRoundTrip(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	srv := newServer(db, "tok", "sec", 123, OIDCConfig{}, "bot", "")
	t.Cleanup(func() { _ = srv.Shutdown(context.Background()) })

	// The fixture's workout rows carry user_id:1, so import as user 1 to keep
	// the exported user_id values identical.
	const userID = 1
	ctx := context.Background()

	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "fixtures", "vault-v1.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}

	var v Vault
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("unmarshal fixture: %v", err)
	}
	if err := srv.importVault(ctx, userID, &v); err != nil {
		t.Fatalf("importVault: %v", err)
	}

	exported, err := srv.buildVault(ctx, userID, true)
	if err != nil {
		t.Fatalf("buildVault: %v", err)
	}
	exportedJSON, err := json.Marshal(exported)
	if err != nil {
		t.Fatalf("marshal export: %v", err)
	}

	got := normalizeVault(t, exportedJSON)
	want := normalizeVault(t, raw)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("import→export is not identity with the fixture.\n got=%s\nwant=%s", exportedJSON, raw)
	}
}

// TestVaultImportEmptyFeaturesPreservesEnabled pins the fix for the cross-mode
// bug where a vault with an absent/empty `features` block (a fresh cloud
// account exports `features: {}`) would unconditionally disable every section.
// With nullable flags + COALESCE, absent flags leave the existing enabled
// state untouched.
func TestVaultImportEmptyFeaturesPreservesEnabled(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	srv := newServer(db, "tok", "sec", 123, OIDCConfig{}, "bot", "")
	t.Cleanup(func() { _ = srv.Shutdown(context.Background()) })
	ctx := context.Background()

	// BP defaults enabled on a fresh migrated DB.
	if on, err := db.Settings.GetBloodPressureEnabled(ctx); err != nil || !on {
		t.Fatalf("precondition: bp enabled=%v err=%v", on, err)
	}

	v := Vault{Format: vaultFormat, Version: vaultVersion}
	// Settings.Features left zero-valued (all nil pointers) == empty features.
	if err := srv.importVault(ctx, 1, &v); err != nil {
		t.Fatalf("importVault: %v", err)
	}

	if on, err := db.Settings.GetBloodPressureEnabled(ctx); err != nil || !on {
		t.Fatalf("bp should remain enabled after empty-features import; enabled=%v err=%v", on, err)
	}
}

// TestVaultDemoModeForbidden verifies the export/import endpoints refuse to run
// under DEMO_MODE, where auth is bypassed: export would leak the operator's raw
// integration API keys and import would let anyone wipe the shared demo data.
func TestVaultDemoModeForbidden(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	srv := newServer(db, "tok", "sec", 123, OIDCConfig{}, "bot", "")
	t.Cleanup(func() { _ = srv.Shutdown(context.Background()) })
	srv.SetDemoMode(true)

	rec := httptest.NewRecorder()
	srv.handleVaultExport(rec, httptest.NewRequest(http.MethodGet, "/api/export", nil))
	if rec.Code != http.StatusForbidden {
		t.Errorf("export in demo mode: got %d, want %d", rec.Code, http.StatusForbidden)
	}

	rec = httptest.NewRecorder()
	srv.handleVaultImport(rec, httptest.NewRequest(http.MethodPost, "/api/import", bytes.NewReader([]byte(`{}`))))
	if rec.Code != http.StatusForbidden {
		t.Errorf("import in demo mode: got %d, want %d", rec.Code, http.StatusForbidden)
	}
}

// normalizeVault decodes a vault and applies the normalizations the round-trip
// contract tolerates: drops the per-run exported_at and the cloud-only
// med_reminder_pref (bot mode has no such row), and sorts every array so
// per-domain list ordering (e.g. bp/weight/day_stats export DESC vs the
// fixture's ASC) doesn't count as drift.
func normalizeVault(t *testing.T, b []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("decode: %v", err)
	}
	delete(m, "exported_at")
	if data, ok := m["data"].(map[string]any); ok {
		if settings, ok := data["settings"].(map[string]any); ok {
			delete(settings, "med_reminder_pref")
		}
	}
	return sortArrays(m).(map[string]any)
}

// sortArrays recursively canonicalizes a decoded-JSON tree so array order is
// irrelevant: each []any is sorted by its elements' marshaled form.
func sortArrays(v any) any {
	switch x := v.(type) {
	case map[string]any:
		for k, val := range x {
			x[k] = sortArrays(val)
		}
		return x
	case []any:
		for i, el := range x {
			x[i] = sortArrays(el)
		}
		sort.Slice(x, func(i, j int) bool {
			bi, _ := json.Marshal(x[i])
			bj, _ := json.Marshal(x[j])
			return string(bi) < string(bj)
		})
		return x
	default:
		return v
	}
}

// TestVaultImportCloudNativeTimezone pins the cloud-native → bot direction:
// cloud stores the timezone on the settings singleton, so a cloud-origin vault
// carries tz.current with an empty tz.history. Bot GetCurrent() reads only from
// timezone_history, so importTZ must synthesize a history row or the timezone
// silently drops to "".
func TestVaultImportCloudNativeTimezone(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	srv := newServer(db, "tok", "sec", 123, OIDCConfig{}, "bot", "")
	t.Cleanup(func() { _ = srv.Shutdown(context.Background()) })

	const userID = 1
	tz := "Europe/Berlin"
	v := &Vault{
		Format:  vaultFormat,
		Version: vaultVersion,
		Data:    VaultData{TZ: VaultTZ{Current: &tz}},
	}
	if err := srv.importVault(context.Background(), userID, v); err != nil {
		t.Fatalf("importVault: %v", err)
	}
	got, err := db.TZ.GetCurrent()
	if err != nil {
		t.Fatalf("GetCurrent: %v", err)
	}
	if got != tz {
		t.Fatalf("timezone dropped on cloud-native import: want %q, got %q", tz, got)
	}
}

// TestVaultImportValidation rejects bad envelopes / modes with 400 and does NOT
// wipe: parse+validate runs before any DB write.
func TestVaultImportValidation(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	const userID = 123456
	// Seed one row so we can prove a rejected import leaves data intact.
	if _, err := db.Medication.Create("Aspirin", "100mg", `{"type":"daily","times":["08:00"]}`, nil, nil, "", "", "flexible"); err != nil {
		t.Fatalf("seed med: %v", err)
	}

	cases := []struct {
		name string
		body map[string]any
	}{
		{"bad format", map[string]any{"format": "nope", "version": 1, "mode": "replace"}},
		{"bad version", map[string]any{"format": vaultFormat, "version": 99, "mode": "replace"}},
		{"missing mode", map[string]any{"format": vaultFormat, "version": 1}},
		{"wrong mode", map[string]any{"format": vaultFormat, "version": 1, "mode": "merge"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw, _ := json.Marshal(tc.body)
			req := httptest.NewRequest("POST", "/api/import", bytes.NewReader(raw))
			req = withUser(req, userID)
			w := httptest.NewRecorder()
			srv.handleVaultImport(w, req)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("want 400, got %d: %s", w.Code, w.Body.String())
			}
		})
	}

	// The seeded medication must still be there (no wipe on a rejected import).
	meds, err := db.Medication.List(true)
	if err != nil {
		t.Fatalf("list meds: %v", err)
	}
	if len(meds) != 1 {
		t.Fatalf("rejected import must not wipe: want 1 med, got %d", len(meds))
	}
}

// TestVaultImportReplaceHandler drives the full HTTP path (with mode:replace)
// and confirms a subsequent export succeeds and carries the imported data.
func TestVaultImportReplaceHandler(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	srv := newServer(db, "tok", "sec", 123, OIDCConfig{}, "bot", "")
	t.Cleanup(func() { _ = srv.Shutdown(context.Background()) })

	const userID = 1
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "fixtures", "vault-v1.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	body["mode"] = "replace"
	reqBody, _ := json.Marshal(body)

	req := httptest.NewRequest("POST", "/api/import", bytes.NewReader(reqBody))
	req = withUser(req, userID)
	w := httptest.NewRecorder()
	srv.handleVaultImport(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", w.Code, w.Body.String())
	}

	v, err := srv.buildVault(context.Background(), userID, true)
	if err != nil {
		t.Fatalf("buildVault: %v", err)
	}
	if len(v.Data.Medications.Items) != 1 || v.Data.Medications.Items[0].Name != "Lisinopril" {
		t.Fatalf("imported medication missing: %+v", v.Data.Medications.Items)
	}
	if len(v.Data.Vitals.Heart) != 3 {
		t.Fatalf("want 3 heart samples, got %d", len(v.Data.Vitals.Heart))
	}
}

// TestVaultImportReminderStateGamificationAndTZPlans pins the blocks whose
// omission this plan fixes: reminder state (previously wiped, never restored),
// gamification (never wiped nor restored) and the *full* tz plan history (only
// the active plan used to be exported). Every list carries two rows in the
// fixture, so a dropped row shows up here.
func TestVaultImportReminderStateGamificationAndTZPlans(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	srv := newServer(db, "tok", "sec", 123, OIDCConfig{}, "bot", "")
	t.Cleanup(func() { _ = srv.Shutdown(context.Background()) })

	const userID = 1
	ctx := context.Background()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "fixtures", "vault-v1.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var v Vault
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("unmarshal fixture: %v", err)
	}
	if err := srv.importVault(ctx, userID, &v); err != nil {
		t.Fatalf("importVault: %v", err)
	}
	got, err := srv.buildVault(ctx, userID, true)
	if err != nil {
		t.Fatalf("buildVault: %v", err)
	}

	bp := got.Data.Settings.BPReminder
	if bp == nil || !bp.Enabled || bp.PreferredReminderHour != 20 || bp.SnoozedUntil == nil {
		t.Fatalf("bp_reminder not restored: %+v", bp)
	}
	if !bp.SnoozedUntil.Equal(*v.Data.Settings.BPReminder.SnoozedUntil) {
		t.Fatalf("bp snoozed_until drift: %v", bp.SnoozedUntil)
	}
	wt := got.Data.Settings.WeightReminder
	if wt == nil || wt.Enabled || wt.PreferredReminderHour != 7 || wt.SnoozedUntil != nil {
		t.Fatalf("weight_reminder not restored: %+v", wt)
	}

	g := got.Data.Gamification
	if len(g.Targets) != 2 || len(g.Ledger) != 2 {
		t.Fatalf("gamification lists lost rows: %d targets, %d ledger", len(g.Targets), len(g.Ledger))
	}
	if g.State == nil || g.State.LifetimeHP != 1355 || g.State.LongestStreak != 21 {
		t.Fatalf("gamification state not restored: %+v", g.State)
	}

	plans := got.Data.TZ.TransitionPlans
	if len(plans) != 2 {
		t.Fatalf("want 2 tz plans (history + pending), got %d", len(plans))
	}
	if plans[0].Status != "COMPLETED" || plans[0].UserAction != "APPROVED" ||
		plans[0].PlanHash == "" || plans[0].NotifiedAt == nil || len(plans[0].Steps) != 1 {
		t.Fatalf("oldest tz plan lost fields: %+v", plans[0])
	}
	if plans[1].Status != "PENDING_APPROVAL" || plans[1].ApprovedAt != nil || len(plans[1].Steps) != 2 {
		t.Fatalf("newest tz plan lost fields: %+v", plans[1])
	}
}

// TestVaultImportPreservesSecretsWhenAbsent pins the vault's only non-replace
// import path: a secrets-free vault (exported with include_secrets=0, so
// settings.integrations and api_tokens are absent) must leave the destination's
// provider keys and minted API tokens working, while a secrets-bearing vault
// replaces both.
func TestVaultImportPreservesSecretsWhenAbsent(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	srv := newServer(db, "tok", "sec", 123, OIDCConfig{}, "bot", "")
	t.Cleanup(func() { _ = srv.Shutdown(context.Background()) })
	ctx := context.Background()

	if err := db.Settings.SetIntegrationOpenAI(ctx, settings.IntegrationOpenAI{
		APIKey: "sk-existing", URL: "https://existing.example", Model: "gpt-x",
	}); err != nil {
		t.Fatalf("seed openai: %v", err)
	}
	if _, err := db.Auth.CreateToken(ctx, "existing", "hash-existing"); err != nil {
		t.Fatalf("seed token: %v", err)
	}

	// 1. Secrets-free vault: both blocks absent → both survive untouched.
	if err := srv.importVault(ctx, 1, &Vault{Format: vaultFormat, Version: vaultVersion}); err != nil {
		t.Fatalf("importVault (no secrets): %v", err)
	}
	oa, err := db.Settings.GetIntegrationOpenAI(ctx)
	if err != nil {
		t.Fatalf("get openai: %v", err)
	}
	if oa.APIKey != "sk-existing" || oa.URL != "https://existing.example" {
		t.Fatalf("secrets-free import clobbered provider keys: %+v", oa)
	}
	toks, err := db.Auth.ListTokens(ctx)
	if err != nil {
		t.Fatalf("list tokens: %v", err)
	}
	if len(toks) != 1 || toks[0].Name != "existing" {
		t.Fatalf("secrets-free import clobbered api tokens: %+v", toks)
	}

	// 2. Secrets-bearing vault: both blocks present → both replaced wholesale.
	last := time.Date(2026, 3, 1, 10, 0, 0, 0, time.UTC)
	v := Vault{Format: vaultFormat, Version: vaultVersion}
	v.Data.Settings.Integrations = &VaultIntegrations{
		OpenAI: VaultOpenAI{APIKey: "sk-imported", URL: "https://imported.example", Model: "gpt-y"},
	}
	v.Data.APITokens = &[]VaultAPIToken{
		{Name: "mcp", TokenHash: "hash-mcp", CreatedAt: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC), LastUsedAt: &last},
		{Name: "cli", TokenHash: "hash-cli", CreatedAt: time.Date(2026, 2, 2, 3, 4, 5, 0, time.UTC)},
	}
	if err := srv.importVault(ctx, 1, &v); err != nil {
		t.Fatalf("importVault (with secrets): %v", err)
	}
	if oa, err = db.Settings.GetIntegrationOpenAI(ctx); err != nil {
		t.Fatalf("get openai: %v", err)
	}
	if oa.APIKey != "sk-imported" || oa.URL != "https://imported.example" {
		t.Fatalf("secrets-bearing import did not replace provider keys: %+v", oa)
	}
	// The hash — not the plaintext — is what keeps a minted token authenticating.
	if tok, err := db.Auth.GetTokenByHash(ctx, "hash-mcp"); err != nil || tok == nil {
		t.Fatalf("imported token hash does not authenticate: tok=%v err=%v", tok, err)
	}
	if tok, err := db.Auth.GetTokenByHash(ctx, "hash-existing"); err != nil || tok != nil {
		t.Fatalf("pre-import token survived a secrets-bearing (replace) import: %v err=%v", tok, err)
	}
	got, err := srv.buildVault(ctx, 1, true)
	if err != nil {
		t.Fatalf("buildVault: %v", err)
	}
	if got.Data.APITokens == nil || len(*got.Data.APITokens) != 2 {
		t.Fatalf("api tokens did not round-trip: %+v", got.Data.APITokens)
	}
	if rt := (*got.Data.APITokens)[0]; rt.Name != "mcp" || rt.TokenHash != "hash-mcp" ||
		rt.LastUsedAt == nil || !rt.LastUsedAt.Equal(last) || !rt.CreatedAt.Equal((*v.Data.APITokens)[0].CreatedAt) {
		t.Fatalf("api token drift: %+v", rt)
	}
	if rt := (*got.Data.APITokens)[1]; rt.Name != "cli" || rt.LastUsedAt != nil {
		t.Fatalf("api token drift: %+v", rt)
	}
}
