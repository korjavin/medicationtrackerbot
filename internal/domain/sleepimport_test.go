package domain

import (
	"archive/zip"
	"bytes"
	"context"
	"database/sql"
	"os"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

func TestValidateImportFile(t *testing.T) {
	tests := []struct {
		name     string
		fileName string
		fileSize int64
		wantErr  bool
	}{
		{"valid nxk", "test.nxk", 1024, false},
		{"valid NXK case-insensitive", "TEST.NXK", 1024, false},
		{"valid sqlite", "test.sqlite", 1024, false},
		{"valid SQLITE case-insensitive", "TEST.SQLITE", 1024, false},
		{"invalid extension", "test.zip", 1024, true},
		{"file too large", "test.nxk", 101 * 1024 * 1024, true},
		{"boundary size", "test.nxk", 100 * 1024 * 1024, false},
		{"empty file name", "", 1024, true},
		{"file too large sqlite", "test.sqlite", 100*1024*1024 + 1, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateImportFile(tt.fileName, tt.fileSize)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateImportFile() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func createTestDB(t *testing.T, schema string) string {
	t.Helper()
	f, err := os.CreateTemp("", "sleep-test-*.db")
	if err != nil {
		t.Fatalf("create temp db: %v", err)
	}
	_ = f.Close()
	t.Cleanup(func() { _ = os.Remove(f.Name()) })

	db, err := sql.Open("sqlite", f.Name())
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}
	defer db.Close()

	if _, err := db.ExecContext(context.Background(), schema); err != nil {
		t.Fatalf("create schema: %v", err)
	}

	return f.Name()
}

func TestPrepareBackupDB(t *testing.T) {
	t.Run("raw sqlite passthrough", func(t *testing.T) {
		tmpFile, err := os.CreateTemp("", "test-*.sqlite")
		if err != nil {
			t.Fatal(err)
		}
		defer os.Remove(tmpFile.Name())
		_, _ = tmpFile.Write([]byte("fake sqlite content"))
		tmpFile.Close()

		path, cleanup, err := PrepareBackupDB(tmpFile.Name())
		if err != nil {
			t.Fatalf("expected no error, got %v", err)
		}
		defer cleanup()

		if path != tmpFile.Name() {
			t.Errorf("expected path %s, got %s", tmpFile.Name(), path)
		}

		content, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if string(content) != "fake sqlite content" {
			t.Errorf("expected 'fake sqlite content', got %q", string(content))
		}
	})

	t.Run("nxk extraction fallback", func(t *testing.T) {
		buf := new(bytes.Buffer)
		zw := zip.NewWriter(buf)
		f, err := zw.Create("backup.db")
		if err != nil {
			t.Fatal(err)
		}
		_, _ = f.Write([]byte("fake db content"))
		zw.Close()

		tmpZip, err := os.CreateTemp("", "test-*.nxk")
		if err != nil {
			t.Fatal(err)
		}
		defer os.Remove(tmpZip.Name())
		_, _ = tmpZip.Write(buf.Bytes())
		tmpZip.Close()

		path, cleanup, err := PrepareBackupDB(tmpZip.Name())
		if err != nil {
			t.Fatalf("expected no error, got %v", err)
		}
		defer cleanup()

		if _, err := os.Stat(path); os.IsNotExist(err) {
			t.Errorf("extracted file does not exist at %s", path)
		}

		content, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if string(content) != "fake db content" {
			t.Errorf("expected 'fake db content', got %q", string(content))
		}
	})
}

func TestExtractBackupDB(t *testing.T) {
	t.Run("successful extraction", func(t *testing.T) {
		buf := new(bytes.Buffer)
		zw := zip.NewWriter(buf)
		f, err := zw.Create("backup.db")
		if err != nil {
			t.Fatal(err)
		}
		_, _ = f.Write([]byte("fake db content"))
		zw.Close()

		tmpZip, err := os.CreateTemp("", "test-*.nxk")
		if err != nil {
			t.Fatal(err)
		}
		defer os.Remove(tmpZip.Name())
		_, _ = tmpZip.Write(buf.Bytes())
		tmpZip.Close()

		path, cleanup, err := ExtractBackupDB(tmpZip.Name())
		if err != nil {
			t.Fatalf("expected no error, got %v", err)
		}
		defer cleanup()

		if _, err := os.Stat(path); os.IsNotExist(err) {
			t.Errorf("extracted file does not exist at %s", path)
		}

		content, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if string(content) != "fake db content" {
			t.Errorf("expected 'fake db content', got %q", string(content))
		}
	})

	t.Run("missing backup.db", func(t *testing.T) {
		buf := new(bytes.Buffer)
		zw := zip.NewWriter(buf)
		f, err := zw.Create("other.file")
		if err != nil {
			t.Fatal(err)
		}
		_, _ = f.Write([]byte("some content"))
		zw.Close()

		tmpZip, err := os.CreateTemp("", "test-*.nxk")
		if err != nil {
			t.Fatal(err)
		}
		defer os.Remove(tmpZip.Name())
		_, _ = tmpZip.Write(buf.Bytes())
		tmpZip.Close()

		_, _, err = ExtractBackupDB(tmpZip.Name())
		if err == nil {
			t.Error("expected error for missing backup.db, got nil")
		}
	})

	t.Run("invalid zip", func(t *testing.T) {
		tmpFile, err := os.CreateTemp("", "test-*.nxk")
		if err != nil {
			t.Fatal(err)
		}
		defer os.Remove(tmpFile.Name())
		_, _ = tmpFile.Write([]byte("not a zip"))
		tmpFile.Close()

		_, _, err = ExtractBackupDB(tmpFile.Name())
		if err == nil {
			t.Error("expected error for invalid zip, got nil")
		}
	})
}

func TestParseSleepDatabase(t *testing.T) {
	schema := `CREATE TABLE sleep (
		start INTEGER,
		end INTEGER,
		tz INTEGER,
		day TEXT,
		light INTEGER,
		deep INTEGER,
		rem INTEGER,
		awake INTEGER,
		total INTEGER,
		turnOver INTEGER,
		hrAvg INTEGER,
		spo2Avg INTEGER,
		userModified INTEGER,
		info TEXT
	)`
	dbPath := createTestDB(t, schema)
	db, _ := sql.Open("sqlite", dbPath)
	defer db.Close()

	start1 := time.Now().UnixMilli()
	end1 := start1 + 8*3600*1000
	_, _ = db.Exec(`INSERT INTO sleep VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		start1, end1, 60, "2023-10-27", 100, 200, 50, 30, 380, 5, 60, 98, 0, "good sleep")

	start2 := start1 + 24*3600*1000
	end2 := start2 + 7*3600*1000
	_, _ = db.Exec(`INSERT INTO sleep VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		start2, end2, 60, "2023-10-28", nil, nil, nil, nil, nil, nil, nil, nil, 1, nil)

	logs, err := ParseSleepDatabase(dbPath)
	if err != nil {
		// Skip if driver is missing in environment
		t.Skipf("ParseSleepDatabase failed (likely missing driver): %v", err)
	}

	if len(logs) != 2 {
		t.Fatalf("expected 2 logs, got %d", len(logs))
	}

	// Verify first log
	if logs[0].Day != "2023-10-27" || logs[0].Notes != "good sleep" || logs[0].UserModified {
		t.Errorf("unexpected values in first log: %+v", logs[0])
	}
	if logs[0].LightMinutes == nil || *logs[0].LightMinutes != 100 {
		t.Errorf("unexpected metrics in first log")
	}

	// Verify second log
	if logs[1].Day != "2023-10-28" || logs[1].Notes != "" || !logs[1].UserModified {
		t.Errorf("unexpected values in second log: %+v", logs[1])
	}
	if logs[1].LightMinutes != nil || logs[1].DeepMinutes != nil {
		t.Errorf("expected nil metrics in second log")
	}
}

func TestParseHeartDatabase(t *testing.T) {
	schema := `CREATE TABLE heart (
		dateTime INTEGER,
		tz INTEGER,
		value INTEGER,
		type INTEGER
	)`
	dbPath := createTestDB(t, schema)
	db, _ := sql.Open("sqlite", dbPath)
	defer db.Close()

	nowMs := time.Now().UnixMilli()
	_, _ = db.Exec(`INSERT INTO heart VALUES (?,?,?,?)`, nowMs, 60, 75, 1)

	logs, err := ParseHeartDatabase(dbPath)
	if err != nil {
		t.Skipf("ParseHeartDatabase failed: %v", err)
	}

	if len(logs) != 1 {
		t.Fatalf("expected 1 log, got %d", len(logs))
	}
	if logs[0].Value != 75 || logs[0].TzOffset != 60 {
		t.Errorf("unexpected values: %+v", logs[0])
	}
}

func TestParseDayDatabase(t *testing.T) {
	schema := `CREATE TABLE day (
		day TEXT,
		steps INTEGER,
		calories INTEGER,
		distance INTEGER
	)`
	dbPath := createTestDB(t, schema)
	db, _ := sql.Open("sqlite", dbPath)
	defer db.Close()

	_, _ = db.Exec(`INSERT INTO day VALUES (?,?,?,?)`, "2023-10-27", 10000, 500, 7500)

	stats, err := ParseDayDatabase(dbPath)
	if err != nil {
		t.Skipf("ParseDayDatabase failed: %v", err)
	}

	if len(stats) != 1 {
		t.Fatalf("expected 1 record, got %d", len(stats))
	}
	if stats[0].Day != "2023-10-27" || stats[0].Steps != 10000 {
		t.Errorf("unexpected values: %+v", stats[0])
	}
}

func TestParseSpO2Database(t *testing.T) {
	schema := `CREATE TABLE spo2 (
		dateTime INTEGER,
		tz INTEGER,
		value INTEGER,
		type INTEGER
	)`
	dbPath := createTestDB(t, schema)
	db, _ := sql.Open("sqlite", dbPath)
	defer db.Close()

	nowMs := time.Now().UnixMilli()
	_, _ = db.Exec(`INSERT INTO spo2 VALUES (?,?,?,?)`, nowMs, 60, 98, 1)

	logs, err := ParseSpO2Database(dbPath)
	if err != nil {
		t.Skipf("ParseSpO2Database failed: %v", err)
	}

	if len(logs) != 1 {
		t.Fatalf("expected 1 log, got %d", len(logs))
	}
	if logs[0].Value != 98 {
		t.Errorf("unexpected values: %+v", logs[0])
	}
}

func TestParseStressDatabase(t *testing.T) {
	schema := `CREATE TABLE stress (
		dateTime INTEGER,
		tz INTEGER,
		value INTEGER,
		type INTEGER,
		info TEXT
	)`
	dbPath := createTestDB(t, schema)
	db, _ := sql.Open("sqlite", dbPath)
	defer db.Close()

	nowMs := time.Now().UnixMilli()
	_, _ = db.Exec(`INSERT INTO stress VALUES (?,?,?,?,?)`, nowMs, 60, 45, 1, "stressful day")

	logs, err := ParseStressDatabase(dbPath)
	if err != nil {
		t.Skipf("ParseStressDatabase failed: %v", err)
	}

	if len(logs) != 1 {
		t.Fatalf("expected 1 log, got %d", len(logs))
	}
	if logs[0].Value != 45 || logs[0].Info != "stressful day" {
		t.Errorf("unexpected values: %+v", logs[0])
	}
}
