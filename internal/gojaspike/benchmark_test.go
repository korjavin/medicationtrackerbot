package gojaspike

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/dop251/goja"
	"github.com/korjavin/medicationtrackerbot/internal/store/bp"
	"github.com/korjavin/medicationtrackerbot/internal/store/db"
	_ "modernc.org/sqlite"
)

func BenchmarkBP(b *testing.B) {
	d, err := db.Open(":memory:")
	if err != nil {
		b.Fatalf("failed to open db: %v", err)
	}
	defer d.Close()

	_, err = d.Exec(`
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
		CREATE TABLE records (
			type TEXT,
			id TEXT,
			data JSON,
			PRIMARY KEY (type, id)
		);
	`)
	if err != nil {
		b.Fatalf("failed to create tables: %v", err)
	}

	repo := bp.New(d, nil)

	b.Run("Go Native", func(b *testing.B) {
		ctx := context.Background()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			reading := &bp.BloodPressure{
				UserID:     1,
				MeasuredAt: time.Now(),
				Systolic:   120,
				Diastolic:  80,
			}
			_, err := repo.CreateReading(ctx, reading)
			if err != nil {
				b.Fatalf("create failed: %v", err)
			}
		}
	})

	bpJSBytes, err := os.ReadFile("../../web/domain/bp.js")
	if err != nil {
		b.Fatalf("failed to read bp.js: %v", err)
	}

	code := string(bpJSBytes)
	code = strings.ReplaceAll(code, "export function", "function")
	code = strings.ReplaceAll(code, "export const", "const")

	// Pre-create VM for reused benchmark
	vm := goja.New()
	_, err = vm.RunString(code)
	if err != nil {
		b.Fatalf("run js failed: %v", err)
	}

	rp := &RecordsPort{db: d.DB, vm: vm}

	records := vm.NewObject()
	records.Set("put", rp.put)
	records.Set("list", rp.list)
	records.Set("del", rp.del)

	injection := vm.NewObject()
	injection.Set("records", records)
	injection.Set("now", func() int64 {
		return time.Now().UnixMilli()
	})
	injection.Set("timeZone", "America/New_York")

	vm.Set("injectionArgs", injection)
	_, err = vm.RunString("const domain = createBPDomain(injectionArgs);")
	if err != nil {
		b.Fatalf("setup injection failed: %v", err)
	}

	b.Run("Goja Reused VM", func(b *testing.B) {
		inputObj := vm.NewObject()
		inputObj.Set("measured_at", time.Now().Format(time.RFC3339))
		inputObj.Set("systolic", 120)
		inputObj.Set("diastolic", 80)
		vm.Set("inputObj", inputObj)

		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, err := vm.RunString(`
				var done = false;
				domain.create(inputObj).then(() => { done = true; }).catch(e => { throw e; });
			`)
			if err != nil {
				b.Fatalf("create failed: %v", err)
			}
		}
	})

	b.Run("Goja Cold Start", func(b *testing.B) {
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			vm := goja.New()
			_, _ = vm.RunString(code)
			rp := &RecordsPort{db: d.DB, vm: vm}

			records := vm.NewObject()
			records.Set("put", rp.put)
			records.Set("list", rp.list)
			records.Set("del", rp.del)

			injection := vm.NewObject()
			injection.Set("records", records)
			injection.Set("now", func() int64 { return time.Now().UnixMilli() })
			injection.Set("timeZone", "America/New_York")

			vm.Set("injectionArgs", injection)
			_, _ = vm.RunString("const domain = createBPDomain(injectionArgs);")

			inputObj := vm.NewObject()
			inputObj.Set("measured_at", time.Now().Format(time.RFC3339))
			inputObj.Set("systolic", 120)
			inputObj.Set("diastolic", 80)
			vm.Set("inputObj", inputObj)

			_, err := vm.RunString(`domain.create(inputObj);`)
			if err != nil {
				b.Fatalf("create failed: %v", err)
			}
		}
	})
}
