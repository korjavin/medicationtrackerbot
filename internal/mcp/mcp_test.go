package mcp

import (
	"strings"
	"testing"

	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestLoadConfigFromEnv_AdminPort(t *testing.T) {
	required := map[string]string{
		"ALLOWED_USER_ID":     "1",
		"MCP_DATABASE_PATH":   "/tmp/x.db",
		"POCKET_ID_URL":       "https://auth.example.com",
		"MCP_SERVER_URL":      "https://mcp.example.com",
		"MCP_ALLOWED_SUBJECT": "test-user",
	}
	for k, v := range required {
		t.Setenv(k, v)
	}

	cases := []struct {
		raw     string
		want    int
		wantErr bool
	}{
		{"", 8082, false},     // default
		{"0", 0, false},       // explicit disable
		{"9999", 9999, false}, // explicit value
		{"abc", 0, true},      // not an integer
		{"-1", 0, true},       // out of range
		{"70000", 0, true},    // out of range
	}
	for _, tc := range cases {
		t.Run("MCP_ADMIN_PORT="+tc.raw, func(t *testing.T) {
			t.Setenv("MCP_ADMIN_PORT", tc.raw)
			cfg, err := LoadConfigFromEnv()
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got cfg=%+v", cfg)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if cfg.AdminPort != tc.want {
				t.Errorf("AdminPort = %d, want %d", cfg.AdminPort, tc.want)
			}
		})
	}
}

func TestLoadConfigFromEnv_AdminPortEqualsMainPort(t *testing.T) {
	required := map[string]string{
		"ALLOWED_USER_ID":     "1",
		"MCP_DATABASE_PATH":   "/tmp/x.db",
		"POCKET_ID_URL":       "https://auth.example.com",
		"MCP_SERVER_URL":      "https://mcp.example.com",
		"MCP_ALLOWED_SUBJECT": "test-user",
	}
	for k, v := range required {
		t.Setenv(k, v)
	}

	// Setting MCP_PORT == MCP_ADMIN_PORT should fail validation rather than
	// be discovered later as a confusing bind failure.
	t.Setenv("MCP_PORT", "8082")
	t.Setenv("MCP_ADMIN_PORT", "8082")
	cfg, err := LoadConfigFromEnv()
	if err == nil {
		t.Fatalf("expected error for AdminPort == Port, got cfg=%+v", cfg)
	}
	if !strings.Contains(err.Error(), "MCP_ADMIN_PORT") {
		t.Errorf("error should mention MCP_ADMIN_PORT, got: %v", err)
	}

	// AdminPort == 0 (disabled) must not collide even when Port also == 0
	// (which the loader normalizes to its default 8081 — different from 0).
	t.Setenv("MCP_PORT", "")
	t.Setenv("MCP_ADMIN_PORT", "0")
	if _, err := LoadConfigFromEnv(); err != nil {
		t.Errorf("disabled admin port should not collide: %v", err)
	}
}

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
