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
	// DEMO_MODE and ships no OAuth env.
	t.Setenv("POCKET_ID_URL", "")
	t.Setenv("MCP_SERVER_URL", "")
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
