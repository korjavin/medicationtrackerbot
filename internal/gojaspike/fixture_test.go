package gojaspike

import (
	"context"
	"testing"
	"time"

	"github.com/dop251/goja"
	"github.com/korjavin/medicationtrackerbot/internal/store/bp"
	"github.com/korjavin/medicationtrackerbot/internal/store/db"
)

func TestBPFixture(t *testing.T) {
	d, _ := db.Open(":memory:")
	defer d.Close()

	d.Exec(`
		CREATE TABLE records (
			type TEXT,
			id TEXT,
			data JSON,
			PRIMARY KEY (type, id)
		);
		CREATE TABLE blood_pressure_readings (
			id INTEGER PRIMARY KEY,
			user_id INTEGER,
			measured_at DATETIME,
			systolic INTEGER,
			diastolic INTEGER,
			pulse INTEGER,
			site TEXT,
			position TEXT,
			category TEXT,
			ignore_calc BOOLEAN,
			notes TEXT,
			tag TEXT
		);
	`)

	now := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	repo := bp.New(d, nil)

	// Go Native Setup
	reading := &bp.BloodPressure{
		UserID:     1,
		MeasuredAt: now,
		Systolic:   135,
		Diastolic:  85,
	}
	ctx := context.Background()
	_, err := repo.CreateReading(ctx, reading)
	if err != nil {
		t.Fatalf("go create err: %v", err)
	}

	goNativeReadings, _ := repo.ListReadings(ctx, 1, time.Time{})

	// Goja Setup
	code := loadJS(t, "../../web/domain/bp.js")
	vm := setupVM(t, code, d.DB)
	vm.Set("fixedNow", now.UnixMilli())
	vm.RunString(`
		injectionArgs.now = () => fixedNow;
	`)

	inputObj := vm.NewObject()
	inputObj.Set("measured_at", now.Format(time.RFC3339))
	inputObj.Set("systolic", 135)
	inputObj.Set("diastolic", 85)
	vm.Set("inputObj", inputObj)

	val, err := vm.RunString(`
        var listResult = null;
        var p = domain.create(inputObj).then(() => {
            return domain.list();
        }).then(l => {
            listResult = l;
        });

        listResult;
    `)

	if err != nil {
		t.Fatalf("js err: %v", err)
	}

	if val == nil || goja.IsNull(val) || goja.IsUndefined(val) {
        listVal, _ := vm.RunString(`listResult`)
        if listVal != nil && !goja.IsNull(listVal) {
             val = listVal
        } else {
             t.Fatalf("val is nil, microtasks did not execute synchronously")
        }
	}

	gojaReadings := val.Export().([]interface{})

	if len(goNativeReadings) != 1 {
		t.Fatalf("expected 1 reading, got %d", len(goNativeReadings))
	}
	if len(gojaReadings) != 1 {
		t.Fatalf("expected 1 goja reading, got %d", len(gojaReadings))
	}

	goCat := goNativeReadings[0].Category

	gojaObj := gojaReadings[0].(map[string]interface{})
	gojaCat := gojaObj["category"].(string)

	if goCat != gojaCat {
		t.Errorf("Category mismatch: Go=%s, Goja=%s", goCat, gojaCat)
	}
}
