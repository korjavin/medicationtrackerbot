package gojaspike

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store/bp"
	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	"github.com/korjavin/medicationtrackerbot/internal/store/migrations"
)

// bpUserID is the single account both sides seed under.
const bpUserID int64 = 1

// fixedTZLookup satisfies bp.TimezoneLookup with a constant zone, so the Go
// store's GetDailyWeightedStats uses the same tz as the injected JS timeZone.
type fixedTZLookup struct{ tz string }

func (f fixedTZLookup) GetCurrent() (string, error) { return f.tz, nil }

// bpFixture is one reading, used to seed BOTH the JS domain (via a JSON object
// literal fed to domain.create) and the Go store (via CreateReading) from a
// single source of truth.
type bpFixture struct {
	measuredAt string // RFC3339, UTC
	sys, dia   int
	pulse      *int
	site       string
	position   string
	notes      string
	tag        string
	ignoreCalc bool
}

func iptr(v int) *int { return &v }

// jsInput mirrors createBPDomain's create(input) contract: optional fields are
// omitted when empty exactly as a real caller would send them, so the JS
// toResponse omit-when-falsy branches are exercised the same way the Go
// nullable-column reads are.
func (f bpFixture) jsInput() map[string]interface{} {
	m := map[string]interface{}{
		"measured_at": f.measuredAt,
		"systolic":    f.sys,
		"diastolic":   f.dia,
		"ignore_calc": f.ignoreCalc,
	}
	if f.pulse != nil {
		m["pulse"] = *f.pulse
	}
	if f.site != "" {
		m["site"] = f.site
	}
	if f.position != "" {
		m["position"] = f.position
	}
	if f.notes != "" {
		m["notes"] = f.notes
	}
	if f.tag != "" {
		m["tag"] = f.tag
	}
	return m
}

// newBPHarness builds a goja VM with the unmodified web/domain/bp.js loaded and
// createBPDomain constructed over the SQLite records port.
func newBPHarness(t *testing.T) *vmHarness {
	t.Helper()
	db := openTestDB(t)
	h, err := newVM(db, "../../web/domain/bp.js", "createBPDomain", fixedNowMs, fixedTZ)
	if err != nil {
		t.Fatalf("newVM(bp.js): %v", err)
	}
	return h
}

// newBPGoRepo opens a migrated in-memory store and pins the clock/tz to the
// same fixed values the JS side sees.
func newBPGoRepo(t *testing.T) (*bp.Repo, context.Context) {
	t.Helper()
	d, err := storedb.Open(":memory:")
	if err != nil {
		t.Fatalf("open store db: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := d.Migrate(migrations.FS, "."); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	r := bp.New(d, fixedTZLookup{tz: fixedTZ})
	r.SetClock(func() time.Time { return time.UnixMilli(fixedNowMs).UTC() })
	return r, context.Background()
}

// jsCreate drives the JS domain create for one fixture and asserts the promise
// fulfilled (never Pending/Rejected).
func jsCreate(t *testing.T, h *vmHarness, f bpFixture) {
	t.Helper()
	b, err := json.Marshal(f.jsInput())
	if err != nil {
		t.Fatalf("marshal js input: %v", err)
	}
	if _, err := h.awaitCall(fmt.Sprintf("domain.create(%s)", b)); err != nil {
		t.Fatalf("js create(%s): %v", b, err)
	}
}

// goCreate inserts the same fixture through the native store.
func goCreate(t *testing.T, r *bp.Repo, ctx context.Context, f bpFixture) {
	t.Helper()
	measured, err := time.Parse(time.RFC3339, f.measuredAt)
	if err != nil {
		t.Fatalf("parse measured_at %q: %v", f.measuredAt, err)
	}
	rec := &bp.BloodPressure{
		UserID:     bpUserID,
		MeasuredAt: measured,
		Systolic:   f.sys,
		Diastolic:  f.dia,
		Pulse:      f.pulse,
		Site:       f.site,
		Position:   f.position,
		Notes:      f.notes,
		Tag:        f.tag,
		IgnoreCalc: f.ignoreCalc,
	}
	if _, err := r.CreateReading(ctx, rec); err != nil {
		t.Fatalf("go CreateReading: %v", err)
	}
}

// asInt normalizes a goja-exported number (int64 or float64) to int.
func asInt(t *testing.T, v interface{}) int {
	t.Helper()
	switch n := v.(type) {
	case int64:
		return int(n)
	case float64:
		return int(n)
	case int:
		return n
	default:
		t.Fatalf("value %v (%T) is not a number", v, v)
		return 0
	}
}

// TestBPCategoryParity: the unmodified JS calculateBPCategory (reached through
// domain.create → resolveCategory) must return the SAME bucket as the native
// bp.CalculateBPCategory for every fixture, across all buckets and boundaries.
func TestBPCategoryParity(t *testing.T) {
	h := newBPHarness(t)

	fixtures := []struct{ sys, dia int }{
		{110, 70},  // Normal
		{119, 79},  // Normal (upper edge)
		{120, 70},  // Elevated (sys 120-129, dia < 80)
		{125, 75},  // Elevated
		{129, 79},  // Elevated (upper edge)
		{130, 79},  // High BP Stage 1 (sys >= 130)
		{120, 80},  // High BP Stage 1 (dia >= 80, sys in elevated band)
		{135, 85},  // High BP Stage 1
		{140, 85},  // High BP Stage 2 (sys >= 140)
		{130, 90},  // High BP Stage 2 (dia >= 90)
		{150, 100}, // High BP Stage 2
		{180, 100}, // High BP Stage 2 (sys == 180, NOT crisis: guards the > boundary)
		{150, 120}, // High BP Stage 2 (dia == 120, NOT crisis: guards the > boundary)
		{181, 100}, // Hypertensive Crisis (sys > 180)
		{150, 121}, // Hypertensive Crisis (dia > 120)
		{200, 130}, // Hypertensive Crisis
	}

	for _, f := range fixtures {
		want := bp.CalculateBPCategory(f.sys, f.dia)
		v, err := h.awaitCall(fmt.Sprintf(
			`domain.create({ measured_at: '2026-05-20T10:00:00Z', systolic: %d, diastolic: %d })`,
			f.sys, f.dia))
		if err != nil {
			t.Fatalf("js create(%d/%d): %v", f.sys, f.dia, err)
		}
		resp, ok := v.Export().(map[string]interface{})
		if !ok {
			t.Fatalf("js create(%d/%d) result not an object: %T", f.sys, f.dia, v.Export())
		}
		got, _ := resp["category"].(string) // absent -> "" (never happens: all buckets non-empty)
		if got != want {
			t.Errorf("category(%d/%d) = %q via JS, want %q from Go", f.sys, f.dia, got, want)
		}
	}
}

// TestBPCreateListParity: an identical reading sequence through the JS domain
// (create then list) and the Go store (CreateReading then ListReadings) must
// yield field-by-field-equal readings in the same DESC-by-measured_at order.
func TestBPCreateListParity(t *testing.T) {
	h := newBPHarness(t)
	r, ctx := newBPGoRepo(t)

	// Distinct timestamps (no ordering ties), all within the JS list default
	// 30-day window of the fixed now (2026-06-21), with a mix of optional
	// fields incl. an ignore_calc row (category must stay empty on both sides).
	// The first row is the only one carrying site+tag, so it MUST fall inside
	// the window or those fields go uncompared.
	fixtures := []bpFixture{
		{measuredAt: "2026-06-08T08:00:00Z", sys: 120, dia: 80, pulse: iptr(72), site: "left arm", position: "sitting", notes: "morning", tag: "home"},
		{measuredAt: "2026-06-11T09:30:00Z", sys: 145, dia: 92},
		{measuredAt: "2026-06-15T18:00:00Z", sys: 118, dia: 76, pulse: iptr(65), position: "standing"},
		{measuredAt: "2026-06-18T07:15:00Z", sys: 135, dia: 88, notes: "raw", ignoreCalc: true},
	}
	for _, f := range fixtures {
		jsCreate(t, h, f)
		goCreate(t, r, ctx, f)
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
	goReadings, err := r.ListReadings(ctx, bpUserID, since)
	if err != nil {
		t.Fatalf("go ListReadings: %v", err)
	}

	if len(jsArr) != len(goReadings) {
		t.Fatalf("length mismatch: JS %d vs Go %d", len(jsArr), len(goReadings))
	}

	for i := range goReadings {
		js, ok := jsArr[i].(map[string]interface{})
		if !ok {
			t.Fatalf("js reading[%d] not an object: %T", i, jsArr[i])
		}
		g := goReadings[i]

		if got := asInt(t, js["systolic"]); got != g.Systolic {
			t.Errorf("reading[%d] systolic: JS %d vs Go %d", i, got, g.Systolic)
		}
		if got := asInt(t, js["diastolic"]); got != g.Diastolic {
			t.Errorf("reading[%d] diastolic: JS %d vs Go %d", i, got, g.Diastolic)
		}

		jsMeasured, ok := js["measured_at"].(string)
		if !ok {
			t.Fatalf("reading[%d] measured_at not a string: %T", i, js["measured_at"])
		}
		jsT, err := time.Parse(time.RFC3339, jsMeasured)
		if err != nil {
			t.Fatalf("reading[%d] parse JS measured_at %q: %v", i, jsMeasured, err)
		}
		if !jsT.Equal(g.MeasuredAt) {
			t.Errorf("reading[%d] measured_at: JS %s vs Go %s", i, jsT, g.MeasuredAt)
		}

		// pulse: JS omits when null; Go leaves *int nil.
		jp, hasJP := js["pulse"]
		if g.Pulse == nil {
			if hasJP {
				t.Errorf("reading[%d] pulse: JS has %v, Go nil", i, jp)
			}
		} else {
			if !hasJP {
				t.Errorf("reading[%d] pulse: JS missing, Go %d", i, *g.Pulse)
			} else if got := asInt(t, jp); got != *g.Pulse {
				t.Errorf("reading[%d] pulse: JS %d vs Go %d", i, got, *g.Pulse)
			}
		}

		// string fields: JS omits when empty; Go stores "".
		for _, tc := range []struct {
			name string
			js   string
			go_  string
		}{
			{"category", strOf(js, "category"), g.Category},
			{"site", strOf(js, "site"), g.Site},
			{"position", strOf(js, "position"), g.Position},
			{"notes", strOf(js, "notes"), g.Notes},
			{"tag", strOf(js, "tag"), g.Tag},
		} {
			if tc.js != tc.go_ {
				t.Errorf("reading[%d] %s: JS %q vs Go %q", i, tc.name, tc.js, tc.go_)
			}
		}

		jsIgnore, _ := js["ignore_calc"].(bool)
		if jsIgnore != g.IgnoreCalc {
			t.Errorf("reading[%d] ignore_calc: JS %v vs Go %v", i, jsIgnore, g.IgnoreCalc)
		}
	}
}

// strOf returns js[key] as a string, or "" when absent (matching JS omit-when-
// falsy against the Go store's empty-string columns).
func strOf(m map[string]interface{}, key string) string {
	s, _ := m[key].(string)
	return s
}

// TestBPStatsParity: a multi-day, multi-reading fixture driven through JS
// getStats and Go GetDailyWeightedStats must produce identical daily-weighted
// aggregates for every period (14/30/60). This exercises the Intl-backed
// day-boundary math and the two-stage time-weighted average on both sides.
func TestBPStatsParity(t *testing.T) {
	h := newBPHarness(t)
	r, ctx := newBPGoRepo(t)

	// All timestamps sit well inside their local (America/New_York, EDT)
	// calendar day — no midnight/DST edge. Relative to the fixed now
	// (2026-06-21), readings are spread so the three periods produce GENUINELY
	// DIFFERENT day sets on both sides: three days inside 14d (after ~06-06),
	// one more day inside 30d (~05-25, after ~05-21), one more inside 60d
	// (~05-05, after ~04-21). This forces each buildPeriod(14/30/60) boundary
	// to be exercised independently — a period-window bug can no longer hide
	// behind identical day sets. The ignore_calc row shares a day with a
	// counted reading and must be dropped from stats on both sides (JS filter
	// vs Go `ignore_calc = 0`).
	fixtures := []bpFixture{
		{measuredAt: "2026-05-05T16:00:00Z", sys: 100, dia: 62}, // inside 60d only
		{measuredAt: "2026-05-25T16:00:00Z", sys: 140, dia: 90}, // inside 30d + 60d
		{measuredAt: "2026-06-15T12:00:00Z", sys: 120, dia: 80}, // inside all three
		{measuredAt: "2026-06-15T22:00:00Z", sys: 160, dia: 100},
		{measuredAt: "2026-06-18T13:00:00Z", sys: 110, dia: 70},
		{measuredAt: "2026-06-18T13:30:00Z", sys: 150, dia: 95},
		{measuredAt: "2026-06-18T21:00:00Z", sys: 120, dia: 80},
		{measuredAt: "2026-06-19T11:00:00Z", sys: 130, dia: 85},
		{measuredAt: "2026-06-19T15:00:00Z", sys: 200, dia: 120, ignoreCalc: true}, // excluded from stats
	}
	for _, f := range fixtures {
		jsCreate(t, h, f)
		goCreate(t, r, ctx, f)
	}

	v, err := h.awaitCall(`domain.getStats()`)
	if err != nil {
		t.Fatalf("js getStats: %v", err)
	}
	jsStats, ok := v.Export().(map[string]interface{})
	if !ok {
		t.Fatalf("js getStats result not an object: %T", v.Export())
	}

	goStats, err := r.GetDailyWeightedStats(ctx, bpUserID)
	if err != nil {
		t.Fatalf("go GetDailyWeightedStats: %v", err)
	}

	cmpPeriod(t, "stats_14", jsStats["stats_14"], goStats.Stats14)
	cmpPeriod(t, "stats_30", jsStats["stats_30"], goStats.Stats30)
	cmpPeriod(t, "stats_60", jsStats["stats_60"], goStats.Stats60)

	// Guard: the fixtures are chosen so each wider period includes strictly more
	// days. Assert that here so a future fixture edit can't silently collapse
	// the three windows into one day set (which would let a period-boundary bug
	// pass unnoticed — the parity compare alone can't catch that).
	if goStats.Stats14 == nil || goStats.Stats30 == nil || goStats.Stats60 == nil {
		t.Fatalf("all three periods must be populated; got 14=%v 30=%v 60=%v",
			goStats.Stats14, goStats.Stats30, goStats.Stats60)
	}
	if goStats.Stats14.Days >= goStats.Stats30.Days || goStats.Stats30.Days >= goStats.Stats60.Days {
		t.Fatalf("periods must strictly widen (14<30<60 days); got %d/%d/%d",
			goStats.Stats14.Days, goStats.Stats30.Days, goStats.Stats60.Days)
	}
}

// cmpPeriod asserts a JS period object equals the Go BPPeriodStats, handling
// the nil/absent case (JS omits an empty period; Go leaves a nil pointer).
func cmpPeriod(t *testing.T, name string, jsVal interface{}, goVal *bp.BPPeriodStats) {
	t.Helper()
	if goVal == nil {
		if jsVal != nil {
			t.Errorf("%s: Go nil but JS present: %v", name, jsVal)
		}
		return
	}
	if jsVal == nil {
		t.Fatalf("%s: Go present (%+v) but JS absent", name, goVal)
	}
	m, ok := jsVal.(map[string]interface{})
	if !ok {
		t.Fatalf("%s: JS value not an object: %T", name, jsVal)
	}
	if got := asInt(t, m["systolic"]); got != goVal.Systolic {
		t.Errorf("%s systolic: JS %d vs Go %d", name, got, goVal.Systolic)
	}
	if got := asInt(t, m["diastolic"]); got != goVal.Diastolic {
		t.Errorf("%s diastolic: JS %d vs Go %d", name, got, goVal.Diastolic)
	}
	if got := asInt(t, m["days"]); got != goVal.Days {
		t.Errorf("%s days: JS %d vs Go %d", name, got, goVal.Days)
	}
	if got := asInt(t, m["readings"]); got != goVal.Readings {
		t.Errorf("%s readings: JS %d vs Go %d", name, got, goVal.Readings)
	}
}
