package gojaspike

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	"github.com/korjavin/medicationtrackerbot/internal/store/migrations"
	"github.com/korjavin/medicationtrackerbot/internal/store/weight"
)

// weightUserID is the single account both sides seed under.
const weightUserID int64 = 1

// weightFixture is one measurement, feeding BOTH the JS domain (domain.create)
// and the Go path (handler-equivalent trend calc + CreateLog) from one source.
type weightFixture struct {
	measuredAt string // RFC3339, UTC
	weight     float64
	bodyFat    *float64
	muscleMass *float64
	notes      string
}

func fptr(v float64) *float64 { return &v }

// jsInput mirrors createWeightDomain's create(input): optional fields are
// omitted when nil exactly as a real caller sends them, exercising the JS
// `?? null` / omit-when-falsy branches the same way the Go nullable reads run.
func (f weightFixture) jsInput() map[string]interface{} {
	m := map[string]interface{}{
		"measured_at": f.measuredAt,
		"weight":      f.weight,
	}
	if f.bodyFat != nil {
		m["body_fat"] = *f.bodyFat
	}
	if f.muscleMass != nil {
		m["muscle_mass"] = *f.muscleMass
	}
	if f.notes != "" {
		m["notes"] = f.notes
	}
	return m
}

// newWeightHarness builds a goja VM with the unmodified web/domain/weight.js
// loaded and createWeightDomain constructed over the SQLite records port.
func newWeightHarness(t *testing.T) *vmHarness {
	t.Helper()
	db := openTestDB(t)
	h, err := newVM(db, "../../web/domain/weight.js", "createWeightDomain", fixedNowMs, fixedTZ)
	if err != nil {
		t.Fatalf("newVM(weight.js): %v", err)
	}
	return h
}

// newWeightGoRepo opens a migrated in-memory store for the native side.
func newWeightGoRepo(t *testing.T) (*weight.Repo, context.Context) {
	t.Helper()
	d, err := storedb.Open(":memory:")
	if err != nil {
		t.Fatalf("open store db: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := d.Migrate(migrations.FS, "."); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return weight.New(d), context.Background()
}

// jsCreateWeight drives one JS create and returns its response map, asserting
// the promise fulfilled (never Pending/Rejected).
func jsCreateWeight(t *testing.T, h *vmHarness, f weightFixture) map[string]interface{} {
	t.Helper()
	b, err := json.Marshal(f.jsInput())
	if err != nil {
		t.Fatalf("marshal js input: %v", err)
	}
	v, err := h.awaitCall(fmt.Sprintf("domain.create(%s)", b))
	if err != nil {
		t.Fatalf("js create(%s): %v", b, err)
	}
	resp, ok := v.Export().(map[string]interface{})
	if !ok {
		t.Fatalf("js create(%s) result not an object: %T", b, v.Export())
	}
	return resp
}

// goCreateWeight replicates handleCreateWeight's trend seeding: read the last
// log's trend, EWMA it forward via CalculateWeightTrend (alpha=0.1), and
// CreateLog. Returns the computed trend so trend parity can assert against JS.
func goCreateWeight(t *testing.T, r *weight.Repo, ctx context.Context, f weightFixture) float64 {
	t.Helper()
	measured, err := time.Parse(time.RFC3339, f.measuredAt)
	if err != nil {
		t.Fatalf("parse measured_at %q: %v", f.measuredAt, err)
	}
	last, err := r.GetLastLog(ctx, weightUserID)
	if err != nil {
		t.Fatalf("go GetLastLog: %v", err)
	}
	var previousTrend *float64
	if last != nil && last.WeightTrend != nil {
		previousTrend = last.WeightTrend
	}
	trend := weight.CalculateWeightTrend(f.weight, previousTrend)
	rec := &weight.WeightLog{
		UserID:      weightUserID,
		MeasuredAt:  measured,
		Weight:      f.weight,
		WeightTrend: &trend,
		BodyFat:     f.bodyFat,
		MuscleMass:  f.muscleMass,
		Notes:       f.notes,
	}
	if _, err := r.CreateLog(ctx, rec); err != nil {
		t.Fatalf("go CreateLog: %v", err)
	}
	return trend
}

// asFloat normalizes a goja-exported number (int64 or float64) to float64.
func asFloat(t *testing.T, v interface{}) float64 {
	t.Helper()
	switch n := v.(type) {
	case float64:
		return n
	case int64:
		return float64(n)
	case int:
		return float64(n)
	default:
		t.Fatalf("value %v (%T) is not a number", v, v)
		return 0
	}
}

// weightSequence is the shared fixture: a monotonic-by-measured_at run so the
// "previous = latest by measured_at" selection is identical on both sides, with
// a mix of body-composition/notes fields (incl. an omitted-field row).
var weightSequence = []weightFixture{
	{measuredAt: "2026-05-20T08:00:00Z", weight: 80.0, bodyFat: fptr(22.5), muscleMass: fptr(35.0), notes: "start"},
	{measuredAt: "2026-05-22T08:00:00Z", weight: 79.4},
	{measuredAt: "2026-05-24T08:00:00Z", weight: 79.8, bodyFat: fptr(22.1), notes: "hydrated"},
	{measuredAt: "2026-05-27T08:00:00Z", weight: 78.6, muscleMass: fptr(35.4)},
	{measuredAt: "2026-05-30T08:00:00Z", weight: 78.9, bodyFat: fptr(21.8), muscleMass: fptr(35.6), notes: "morning"},
}

// TestWeightTrendParity: the unmodified JS calculateWeightTrend (reached via
// domain.create → weight_trend in the response) must equal the native
// weight.CalculateWeightTrend across the whole EWMA sequence, bit-for-bit
// (identical IEEE-754 op order on both sides).
func TestWeightTrendParity(t *testing.T) {
	h := newWeightHarness(t)
	r, ctx := newWeightGoRepo(t)

	for i, f := range weightSequence {
		resp := jsCreateWeight(t, h, f)
		goTrend := goCreateWeight(t, r, ctx, f)

		jsTrend, ok := resp["weight_trend"]
		if !ok {
			t.Fatalf("step %d: JS response missing weight_trend: %v", i, resp)
		}
		if got := asFloat(t, jsTrend); got != goTrend {
			t.Errorf("step %d weight_trend: JS %v vs Go %v", i, got, goTrend)
		}
	}
}

// TestWeightCreateListParity: an identical log sequence through the JS domain
// (create then list) and the Go store (handler-equivalent create then
// ListLogs) must yield field-by-field-equal logs in the same DESC-by-
// measured_at order.
func TestWeightCreateListParity(t *testing.T) {
	h := newWeightHarness(t)
	r, ctx := newWeightGoRepo(t)

	for _, f := range weightSequence {
		jsCreateWeight(t, h, f)
		goCreateWeight(t, r, ctx, f)
	}

	v, err := h.awaitCall(`domain.list({ days: 30, limit: 100 })`)
	if err != nil {
		t.Fatalf("js list: %v", err)
	}
	jsArr, ok := v.Export().([]interface{})
	if !ok {
		t.Fatalf("js list result not an array: %T", v.Export())
	}

	// JS list() filters measured_at >= now - 30*DAY_MS; mirror that exactly.
	since := time.UnixMilli(fixedNowMs - 30*24*60*60*1000).UTC()
	goLogs, err := r.ListLogs(ctx, weightUserID, since)
	if err != nil {
		t.Fatalf("go ListLogs: %v", err)
	}

	if len(jsArr) != len(goLogs) {
		t.Fatalf("length mismatch: JS %d vs Go %d", len(jsArr), len(goLogs))
	}

	for i := range goLogs {
		js, ok := jsArr[i].(map[string]interface{})
		if !ok {
			t.Fatalf("js log[%d] not an object: %T", i, jsArr[i])
		}
		g := goLogs[i]

		if got := asFloat(t, js["weight"]); got != g.Weight {
			t.Errorf("log[%d] weight: JS %v vs Go %v", i, got, g.Weight)
		}

		jsMeasured, ok := js["measured_at"].(string)
		if !ok {
			t.Fatalf("log[%d] measured_at not a string: %T", i, js["measured_at"])
		}
		jsT, err := time.Parse(time.RFC3339, jsMeasured)
		if err != nil {
			t.Fatalf("log[%d] parse JS measured_at %q: %v", i, jsMeasured, err)
		}
		if !jsT.Equal(g.MeasuredAt) {
			t.Errorf("log[%d] measured_at: JS %s vs Go %s", i, jsT, g.MeasuredAt)
		}

		// weight_trend / body_fat / muscle_mass: JS omits when null; Go leaves
		// the *float64 nil. Assert presence and value agree on both sides.
		cmpOptFloat(t, i, "weight_trend", js, g.WeightTrend)
		cmpOptFloat(t, i, "body_fat", js, g.BodyFat)
		cmpOptFloat(t, i, "muscle_mass", js, g.MuscleMass)

		if got := strOf(js, "notes"); got != g.Notes {
			t.Errorf("log[%d] notes: JS %q vs Go %q", i, got, g.Notes)
		}
	}
}

// cmpOptFloat asserts a JS-omitted-when-null numeric field agrees with the Go
// nullable *float64 (both absent, or both present and equal).
func cmpOptFloat(t *testing.T, i int, key string, js map[string]interface{}, goVal *float64) {
	t.Helper()
	jsv, has := js[key]
	if goVal == nil {
		if has {
			t.Errorf("log[%d] %s: JS has %v, Go nil", i, key, jsv)
		}
		return
	}
	if !has {
		t.Errorf("log[%d] %s: JS missing, Go %v", i, key, *goVal)
		return
	}
	if got := asFloat(t, jsv); got != *goVal {
		t.Errorf("log[%d] %s: JS %v vs Go %v", i, key, got, *goVal)
	}
}
