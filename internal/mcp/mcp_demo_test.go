package mcp

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestLoadConfigFromEnv_DemoMode(t *testing.T) {
	required := map[string]string{
		"ALLOWED_USER_ID":   "1",
		"MCP_DATABASE_PATH": "/tmp/x.db",
	}
	for k, v := range required {
		t.Setenv(k, v)
	}
	// Deliberately leave POCKET_ID_URL and MCP_SERVER_URL unset — in demo
	// mode the loader must accept that, because the operator only flips
	// DEMO_MODE and ships no OAuth env. Also clear MCP_EXECUTOR_BRIDGE_URL
	// so a developer/CI environment that exports it doesn't trip the demo-
	// mode executor guard (see TestLoadConfigFromEnv_DemoMode_RejectsExecutor).
	t.Setenv("POCKET_ID_URL", "")
	t.Setenv("MCP_SERVER_URL", "")
	t.Setenv("MCP_EXECUTOR_BRIDGE_URL", "")
	t.Setenv("DEMO_MODE", "1")

	cfg, err := LoadConfigFromEnv()
	if err != nil {
		t.Fatalf("LoadConfigFromEnv with DEMO_MODE=1 returned error: %v", err)
	}
	if !cfg.DemoMode {
		t.Fatalf("DemoMode = false, want true")
	}
	if cfg.PocketIDURL != "" || cfg.MCPServerURL != "" {
		t.Errorf("expected empty Pocket-ID config, got PocketIDURL=%q MCPServerURL=%q",
			cfg.PocketIDURL, cfg.MCPServerURL)
	}
}

func TestLoadConfigFromEnv_DemoMode_AllowsExecutorWithCaps(t *testing.T) {
	// In demo mode /mcp accepts all callers, so we used to refuse to wire the
	// Python executor. The metered posture replaces that fail-fast with a
	// warn + per-IP rate limit + shrunk per-script caps; the loader must now
	// succeed even when MCP_EXECUTOR_BRIDGE_URL is set, and surface the demo
	// caps on the returned *Config.
	required := map[string]string{
		"ALLOWED_USER_ID":   "1",
		"MCP_DATABASE_PATH": "/tmp/x.db",
	}
	for k, v := range required {
		t.Setenv(k, v)
	}
	t.Setenv("POCKET_ID_URL", "")
	t.Setenv("MCP_SERVER_URL", "")
	t.Setenv("DEMO_MODE", "1")
	t.Setenv("MCP_EXECUTOR_BRIDGE_URL", "http://medtracker:8080/internal/mcp/bridge")

	cfg, err := LoadConfigFromEnv()
	if err != nil {
		t.Fatalf("LoadConfigFromEnv with DEMO_MODE=1 + bridge URL returned error: %v", err)
	}
	if !cfg.DemoMode {
		t.Fatalf("DemoMode = false, want true")
	}
	if cfg.ExecutorBridgeURL == "" {
		t.Errorf("ExecutorBridgeURL was cleared by loader; want preserved")
	}
	if cfg.DemoExecuteCallsPerHour != 5 {
		t.Errorf("DemoExecuteCallsPerHour = %d, want default 5", cfg.DemoExecuteCallsPerHour)
	}
	if cfg.DemoExecutorMaxAPICalls != 10 {
		t.Errorf("DemoExecutorMaxAPICalls = %d, want default 10", cfg.DemoExecutorMaxAPICalls)
	}
	if cfg.DemoExecutorMaxTimeoutMS != 10000 {
		t.Errorf("DemoExecutorMaxTimeoutMS = %d, want default 10000", cfg.DemoExecutorMaxTimeoutMS)
	}
}

func TestLoadConfigFromEnv_DemoMode_CapsOverridable(t *testing.T) {
	required := map[string]string{
		"ALLOWED_USER_ID":   "1",
		"MCP_DATABASE_PATH": "/tmp/x.db",
	}
	for k, v := range required {
		t.Setenv(k, v)
	}
	t.Setenv("POCKET_ID_URL", "")
	t.Setenv("MCP_SERVER_URL", "")
	t.Setenv("MCP_EXECUTOR_BRIDGE_URL", "")
	t.Setenv("DEMO_MODE", "1")
	t.Setenv("DEMO_MCP_EXECUTE_PER_HOUR", "12")
	t.Setenv("DEMO_MCP_EXECUTOR_MAX_API_CALLS", "25")
	t.Setenv("DEMO_MCP_EXECUTOR_MAX_TIMEOUT_MS", "20000")

	cfg, err := LoadConfigFromEnv()
	if err != nil {
		t.Fatalf("LoadConfigFromEnv returned error: %v", err)
	}
	if cfg.DemoExecuteCallsPerHour != 12 {
		t.Errorf("DemoExecuteCallsPerHour = %d, want 12", cfg.DemoExecuteCallsPerHour)
	}
	if cfg.DemoExecutorMaxAPICalls != 25 {
		t.Errorf("DemoExecutorMaxAPICalls = %d, want 25", cfg.DemoExecutorMaxAPICalls)
	}
	if cfg.DemoExecutorMaxTimeoutMS != 20000 {
		t.Errorf("DemoExecutorMaxTimeoutMS = %d, want 20000", cfg.DemoExecutorMaxTimeoutMS)
	}
}

func TestLoadConfigFromEnv_DemoMode_MalformedCapsFallBack(t *testing.T) {
	required := map[string]string{
		"ALLOWED_USER_ID":   "1",
		"MCP_DATABASE_PATH": "/tmp/x.db",
	}
	for k, v := range required {
		t.Setenv(k, v)
	}
	t.Setenv("POCKET_ID_URL", "")
	t.Setenv("MCP_SERVER_URL", "")
	t.Setenv("MCP_EXECUTOR_BRIDGE_URL", "")
	t.Setenv("DEMO_MODE", "1")
	t.Setenv("DEMO_MCP_EXECUTE_PER_HOUR", "not-an-int")
	t.Setenv("DEMO_MCP_EXECUTOR_MAX_API_CALLS", "0")
	t.Setenv("DEMO_MCP_EXECUTOR_MAX_TIMEOUT_MS", "-1")

	cfg, err := LoadConfigFromEnv()
	if err != nil {
		t.Fatalf("LoadConfigFromEnv returned error: %v", err)
	}
	if cfg.DemoExecuteCallsPerHour != 5 {
		t.Errorf("DemoExecuteCallsPerHour = %d, want default 5", cfg.DemoExecuteCallsPerHour)
	}
	if cfg.DemoExecutorMaxAPICalls != 10 {
		t.Errorf("DemoExecutorMaxAPICalls = %d, want default 10", cfg.DemoExecutorMaxAPICalls)
	}
	if cfg.DemoExecutorMaxTimeoutMS != 10000 {
		t.Errorf("DemoExecutorMaxTimeoutMS = %d, want default 10000", cfg.DemoExecutorMaxTimeoutMS)
	}
}

func TestApplyDemoExecutorCaps_DemoOn(t *testing.T) {
	cfg := &Config{
		DemoMode:                 true,
		MaxExecutorAPICalls:      200,
		MaxExecutorTimeoutMS:     45_000,
		DemoExecutorMaxAPICalls:  10,
		DemoExecutorMaxTimeoutMS: 8_000,
	}
	ApplyDemoExecutorCaps(cfg)
	if cfg.MaxExecutorAPICalls != 10 {
		t.Errorf("MaxExecutorAPICalls = %d, want 10 (overridden by demo)", cfg.MaxExecutorAPICalls)
	}
	if cfg.MaxExecutorTimeoutMS != 8_000 {
		t.Errorf("MaxExecutorTimeoutMS = %d, want 8000 (overridden by demo)", cfg.MaxExecutorTimeoutMS)
	}
}

func TestApplyDemoExecutorCaps_DemoOff(t *testing.T) {
	cfg := &Config{
		DemoMode:                 false,
		MaxExecutorAPICalls:      200,
		MaxExecutorTimeoutMS:     45_000,
		DemoExecutorMaxAPICalls:  10,
		DemoExecutorMaxTimeoutMS: 8_000,
	}
	ApplyDemoExecutorCaps(cfg)
	if cfg.MaxExecutorAPICalls != 200 {
		t.Errorf("MaxExecutorAPICalls = %d, want 200 unchanged (demo off)", cfg.MaxExecutorAPICalls)
	}
	if cfg.MaxExecutorTimeoutMS != 45_000 {
		t.Errorf("MaxExecutorTimeoutMS = %d, want 45000 unchanged (demo off)", cfg.MaxExecutorTimeoutMS)
	}
}

func TestLoadConfigFromEnv_NonDemoStillRequiresPocketID(t *testing.T) {
	required := map[string]string{
		"ALLOWED_USER_ID":   "1",
		"MCP_DATABASE_PATH": "/tmp/x.db",
	}
	for k, v := range required {
		t.Setenv(k, v)
	}
	t.Setenv("POCKET_ID_URL", "")
	t.Setenv("MCP_SERVER_URL", "")
	t.Setenv("DEMO_MODE", "")

	if _, err := LoadConfigFromEnv(); err == nil {
		t.Fatal("expected error when POCKET_ID_URL is unset and DEMO_MODE is off, got nil")
	}
}

// newDemoTestServer builds a *Server with the same demo-mode shape as
// production but without touching a real store: no admin, no data, OAuth nil.
// All we need is the mcpServer for /mcp and the empty s.oauth so the handler
// chain skips auth.
func newDemoTestServer(t *testing.T, demo bool) *Server {
	t.Helper()
	s := &Server{
		config: &Config{
			MaxQueryDays: 90,
			UserID:       1,
			DemoMode:     demo,
		},
	}
	s.mcpServer = sdkmcp.NewServer(&sdkmcp.Implementation{Name: "test", Version: "v0"}, nil)
	if !demo {
		// Mirror NewServer's non-demo branch. tokens=nil keeps the handler
		// from touching any DB; the auth header check happens before any
		// token lookup, so a missing-header request still rejects with 401.
		s.oauth = NewOAuthHandler(s.config, nil)
	}
	return s
}

func TestRun_DemoMode_MCPAcceptsUnauthenticated(t *testing.T) {
	s := newDemoTestServer(t, true)
	if s.oauth != nil {
		t.Fatal("demo mode: expected s.oauth to be nil")
	}

	srv := httptest.NewServer(s.buildPublicMux())
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/mcp", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("POST /mcp: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		t.Errorf("demo mode: /mcp returned 401, expected anything but 401")
	}
}

func TestRun_NonDemoMode_MCPRejectsUnauthenticated(t *testing.T) {
	s := newDemoTestServer(t, false)
	if s.oauth == nil {
		t.Fatal("non-demo mode: expected s.oauth to be wired")
	}

	srv := httptest.NewServer(s.buildPublicMux())
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/mcp", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("POST /mcp: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("non-demo: /mcp returned status=%d, want 401", resp.StatusCode)
	}
}

func TestRun_DemoMode_SkipsOAuthDiscovery(t *testing.T) {
	s := newDemoTestServer(t, true)
	srv := httptest.NewServer(s.buildPublicMux())
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/.well-known/oauth-protected-resource")
	if err != nil {
		t.Fatalf("GET /.well-known/oauth-protected-resource: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("demo mode: /.well-known/oauth-protected-resource returned status=%d, want 404",
			resp.StatusCode)
	}
}

func TestRun_NonDemoMode_AdvertisesOAuthDiscovery(t *testing.T) {
	s := newDemoTestServer(t, false)
	// HandleProtectedResourceMetadata reads MCPServerURL — give it a value
	// so the JSON payload renders cleanly even though we don't validate it.
	s.config.MCPServerURL = "https://mcp.example.com"
	srv := httptest.NewServer(s.buildPublicMux())
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/.well-known/oauth-protected-resource")
	if err != nil {
		t.Fatalf("GET /.well-known/oauth-protected-resource: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		t.Errorf("non-demo: /.well-known/oauth-protected-resource returned 404, want a metadata response")
	}
}
