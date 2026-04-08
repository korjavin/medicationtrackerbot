package tzlookup

import "testing"

func TestLookupTimezone_Berlin(t *testing.T) {
	// Berlin coordinates
	tz, err := LookupTimezone(52.52, 13.40)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tz != "Europe/Berlin" {
		t.Errorf("expected Europe/Berlin, got %s", tz)
	}
}

func TestLookupTimezone_NewYork(t *testing.T) {
	// New York coordinates
	tz, err := LookupTimezone(40.71, -74.01)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tz != "America/New_York" {
		t.Errorf("expected America/New_York, got %s", tz)
	}
}

func TestLookupTimezone_Tokyo(t *testing.T) {
	tz, err := LookupTimezone(35.68, 139.69)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tz != "Asia/Tokyo" {
		t.Errorf("expected Asia/Tokyo, got %s", tz)
	}
}
