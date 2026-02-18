package mcp

import (
	"strings"
	"testing"

	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

func testServer(maxDays int) *Server {
	return &Server{
		config: &Config{
			MaxQueryDays: maxDays,
		},
	}
}

func TestParseDateRangeDefaults(t *testing.T) {
	s := testServer(90)

	start, end, warning, err := s.parseDateRange("", "")
	if err != nil {
		t.Fatalf("parseDateRange returned error: %v", err)
	}

	if !strings.Contains(warning, "start_date was omitted") {
		t.Fatalf("expected default-start warning, got: %q", warning)
	}
	if !strings.Contains(warning, "end_date was omitted") {
		t.Fatalf("expected default-end warning, got: %q", warning)
	}
	if !start.Equal(end.AddDate(0, 0, -90)) {
		t.Fatalf("expected start=end-90days, got start=%s end=%s", start, end)
	}
}

func TestParseDateRangeTruncatesLargeRange(t *testing.T) {
	s := testServer(90)

	start, end, warning, err := s.parseDateRange("2025-01-01", "2025-05-01")
	if err != nil {
		t.Fatalf("parseDateRange returned error: %v", err)
	}

	if !strings.Contains(warning, "exceeded maximum of 90 days") {
		t.Fatalf("expected truncation warning, got: %q", warning)
	}

	want := end.AddDate(0, 0, -90)
	if !start.Equal(want) {
		t.Fatalf("expected truncated start %s, got %s", want, start)
	}
}

func TestParseDateRangeRejectsStartAfterEnd(t *testing.T) {
	s := testServer(90)

	_, _, _, err := s.parseDateRange("2026-02-20", "2026-02-19")
	if err == nil {
		t.Fatal("expected error for start_date after end_date")
	}
	if !strings.Contains(err.Error(), "start_date") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestResolveDateRangeArgsAcceptsCamelCase(t *testing.T) {
	s := testServer(90)
	req := &sdkmcp.CallToolRequest{
		Params: &sdkmcp.CallToolParamsRaw{
			Name:      "get_sleep_logs",
			Arguments: []byte(`{"startDate":"2025-11-21","endDate":"2026-02-19"}`),
		},
	}

	start, end, warning, err := s.resolveDateRangeArgs(req, "", "")
	if err != nil {
		t.Fatalf("resolveDateRangeArgs returned error: %v", err)
	}
	if start != "2025-11-21" || end != "2026-02-19" {
		t.Fatalf("unexpected resolved range: start=%q end=%q", start, end)
	}
	if !strings.Contains(warning, "startDate") || !strings.Contains(warning, "endDate") {
		t.Fatalf("expected compatibility warning, got: %q", warning)
	}
}
