package store

import (
	"testing"
)

func TestGetCurrentTimezone_EmptyTable(t *testing.T) {
	s, err := New(":memory:")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { s.Close() })

	tz, err := s.GetCurrentTimezone()
	if err != nil {
		t.Fatalf("GetCurrentTimezone: %v", err)
	}
	if tz != "" {
		t.Errorf("expected empty string on empty table, got %q", tz)
	}
}

func TestRecordTimezone_InsertAndRetrieve(t *testing.T) {
	s, err := New(":memory:")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { s.Close() })

	if err := s.RecordTimezone("Europe/Berlin"); err != nil {
		t.Fatalf("RecordTimezone: %v", err)
	}

	tz, err := s.GetCurrentTimezone()
	if err != nil {
		t.Fatalf("GetCurrentTimezone: %v", err)
	}
	if tz != "Europe/Berlin" {
		t.Errorf("expected Europe/Berlin, got %q", tz)
	}
}

func TestGetCurrentTimezone_MostRecentReturned(t *testing.T) {
	s, err := New(":memory:")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { s.Close() })

	if err := s.RecordTimezone("America/New_York"); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordTimezone("Asia/Tokyo"); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordTimezone("Europe/Berlin"); err != nil {
		t.Fatal(err)
	}

	tz, err := s.GetCurrentTimezone()
	if err != nil {
		t.Fatalf("GetCurrentTimezone: %v", err)
	}
	if tz != "Europe/Berlin" {
		t.Errorf("expected most recent Europe/Berlin, got %q", tz)
	}
}
