package server

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store/auth"
)

func TestHandleElevenLabsSignedURL_NotConfigured(t *testing.T) {
	srv, db := createHealthTestServer(t)
	defer db.Close()

	t.Setenv("ELEVENLABS_API_KEY", "")
	t.Setenv("ELEVENLABS_AGENT_ID", "")

	req := httptest.NewRequest("GET", "/api/elevenlabs/signed-url", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleElevenLabsSignedURL(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d. Body: %s", w.Code, w.Body.String())
	}
}

func TestHandleElevenLabsSignedURL_OK(t *testing.T) {
	srv, db := createHealthTestServer(t)
	defer db.Close()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("xi-api-key"); got != "test-key" {
			t.Errorf("expected xi-api-key=test-key, got %q", got)
		}
		if got := r.URL.Query().Get("agent_id"); got != "agent_test" {
			t.Errorf("expected agent_id=agent_test, got %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"signed_url": "wss://example.test/sig?token=abc"})
	}))
	defer upstream.Close()

	prev := elevenLabsSignedURLBase
	elevenLabsSignedURLBase = upstream.URL
	defer func() { elevenLabsSignedURLBase = prev }()

	t.Setenv("ELEVENLABS_API_KEY", "test-key")
	t.Setenv("ELEVENLABS_AGENT_ID", "agent_test")

	req := httptest.NewRequest("GET", "/api/elevenlabs/signed-url", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleElevenLabsSignedURL(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}
	var body map[string]string
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["signed_url"] != "wss://example.test/sig?token=abc" {
		t.Fatalf("unexpected signed_url: %q", body["signed_url"])
	}
	if cc := w.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("expected Cache-Control: no-store, got %q", cc)
	}
}

func newUploadRequest(t *testing.T, conversationID, contentType string, fileBytes []byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	header := make(map[string][]string)
	header["Content-Disposition"] = []string{`form-data; name="file"; filename="photo.jpg"`}
	if contentType != "" {
		header["Content-Type"] = []string{contentType}
	}
	part, err := mw.CreatePart(header)
	if err != nil {
		t.Fatalf("create part: %v", err)
	}
	if _, err := part.Write(fileBytes); err != nil {
		t.Fatalf("write part: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close mw: %v", err)
	}
	url := "/api/elevenlabs/upload-file"
	if conversationID != "" {
		url += "?conversation_id=" + conversationID
	}
	req := httptest.NewRequest("POST", url, &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	return withUser(req, 123456)
}

func TestHandleElevenLabsUploadFile_NotConfigured(t *testing.T) {
	srv, db := createHealthTestServer(t)
	defer db.Close()

	t.Setenv("ELEVENLABS_API_KEY", "")

	req := newUploadRequest(t, "conv_1", "image/jpeg", []byte("fake-bytes"))
	w := httptest.NewRecorder()
	srv.handleElevenLabsUploadFile(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d. Body: %s", w.Code, w.Body.String())
	}
}

func TestHandleElevenLabsUploadFile_MissingConversationID(t *testing.T) {
	srv, db := createHealthTestServer(t)
	defer db.Close()

	t.Setenv("ELEVENLABS_API_KEY", "test-key")

	req := newUploadRequest(t, "", "image/jpeg", []byte("fake-bytes"))
	w := httptest.NewRecorder()
	srv.handleElevenLabsUploadFile(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestHandleElevenLabsUploadFile_RejectsNonImage(t *testing.T) {
	srv, db := createHealthTestServer(t)
	defer db.Close()

	t.Setenv("ELEVENLABS_API_KEY", "test-key")

	req := newUploadRequest(t, "conv_1", "text/plain", []byte("hello"))
	w := httptest.NewRecorder()
	srv.handleElevenLabsUploadFile(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestHandleElevenLabsUploadFile_RejectsConversationIDWithSlash(t *testing.T) {
	srv, db := createHealthTestServer(t)
	defer db.Close()

	t.Setenv("ELEVENLABS_API_KEY", "test-key")

	// Path traversal attempt — conversation_id must not contain URL path
	// metacharacters or our forwarded URL could be redirected.
	req := newUploadRequest(t, "conv_1%2F..%2Fattack", "image/jpeg", []byte("fake-bytes"))
	w := httptest.NewRecorder()
	srv.handleElevenLabsUploadFile(w, req)
	// %2F is URL-decoded by net/url to "/", which our guard then rejects.
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestHandleElevenLabsUploadFile_OK(t *testing.T) {
	srv, db := createHealthTestServer(t)
	defer db.Close()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("xi-api-key"); got != "test-key" {
			t.Errorf("expected xi-api-key=test-key, got %q", got)
		}
		if !strings.HasSuffix(r.URL.Path, "/conv_xyz/files") {
			t.Errorf("expected path .../conv_xyz/files, got %q", r.URL.Path)
		}
		if !strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
			t.Errorf("expected multipart content-type, got %q", r.Header.Get("Content-Type"))
		}
		// Confirm the file part made it through with the original mime type.
		if err := r.ParseMultipartForm(10 << 20); err != nil {
			t.Errorf("parse multipart: %v", err)
		} else {
			f, h, err := r.FormFile("file")
			if err != nil {
				t.Errorf("missing file part: %v", err)
			} else {
				defer f.Close()
				if got := h.Header.Get("Content-Type"); got != "image/jpeg" {
					t.Errorf("expected forwarded Content-Type=image/jpeg, got %q", got)
				}
				body, _ := io.ReadAll(f)
				if string(body) != "fake-bytes" {
					t.Errorf("expected forwarded bytes 'fake-bytes', got %q", string(body))
				}
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"file_id": "file_abc123"})
	}))
	defer upstream.Close()

	prev := elevenLabsConversationsBase
	elevenLabsConversationsBase = upstream.URL
	defer func() { elevenLabsConversationsBase = prev }()

	t.Setenv("ELEVENLABS_API_KEY", "test-key")

	req := newUploadRequest(t, "conv_xyz", "image/jpeg", []byte("fake-bytes"))
	w := httptest.NewRecorder()
	srv.handleElevenLabsUploadFile(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}
	var body map[string]string
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["file_id"] != "file_abc123" {
		t.Fatalf("unexpected file_id: %q", body["file_id"])
	}
	if cc := w.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("expected Cache-Control: no-store, got %q", cc)
	}
}

func TestHandleElevenLabsUploadFile_UpstreamError(t *testing.T) {
	srv, db := createHealthTestServer(t)
	defer db.Close()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer upstream.Close()

	prev := elevenLabsConversationsBase
	elevenLabsConversationsBase = upstream.URL
	defer func() { elevenLabsConversationsBase = prev }()

	t.Setenv("ELEVENLABS_API_KEY", "test-key")

	req := newUploadRequest(t, "conv_xyz", "image/jpeg", []byte("fake-bytes"))
	w := httptest.NewRecorder()
	srv.handleElevenLabsUploadFile(w, req)

	if w.Code != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d", w.Code)
	}
}

func TestHandleElevenLabsMCPSessionToken_NotConfigured(t *testing.T) {
	cases := []struct {
		name      string
		apiKey    string
		agentID   string
		mcpURL    string
		wantCode  int
		wantInMsg string
	}{
		{name: "missing api key", apiKey: "", agentID: "agent_test", mcpURL: "https://mcp.example.com", wantCode: http.StatusServiceUnavailable, wantInMsg: "ElevenLabs"},
		{name: "missing agent id", apiKey: "test-key", agentID: "", mcpURL: "https://mcp.example.com", wantCode: http.StatusServiceUnavailable, wantInMsg: "ElevenLabs"},
		{name: "missing both eleven envs", apiKey: "", agentID: "", mcpURL: "https://mcp.example.com", wantCode: http.StatusServiceUnavailable, wantInMsg: "ElevenLabs"},
		{name: "missing mcp url", apiKey: "test-key", agentID: "agent_test", mcpURL: "", wantCode: http.StatusServiceUnavailable, wantInMsg: "MCP"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv, db := createHealthTestServer(t)
			defer db.Close()

			t.Setenv("ELEVENLABS_API_KEY", tc.apiKey)
			t.Setenv("ELEVENLABS_AGENT_ID", tc.agentID)
			t.Setenv("MCP_SERVER_URL", tc.mcpURL)

			req := httptest.NewRequest("POST", "/api/elevenlabs/mcp-session-token", nil)
			req = withUser(req, 123456)
			w := httptest.NewRecorder()
			srv.handleElevenLabsMCPSessionToken(w, req)

			if w.Code != tc.wantCode {
				t.Fatalf("expected %d, got %d. Body: %s", tc.wantCode, w.Code, w.Body.String())
			}
			if !strings.Contains(w.Body.String(), tc.wantInMsg) {
				t.Errorf("expected body to contain %q, got %q", tc.wantInMsg, w.Body.String())
			}
		})
	}
}

func TestHandleElevenLabsMCPSessionToken_Unauthenticated(t *testing.T) {
	srv, db := createHealthTestServer(t)
	defer db.Close()

	t.Setenv("ELEVENLABS_API_KEY", "test-key")
	t.Setenv("ELEVENLABS_AGENT_ID", "agent_test")
	t.Setenv("MCP_SERVER_URL", "https://mcp.example.com")

	// No withUser() — context has no UserCtxKey, mirroring the path a request
	// would take if AuthMiddleware fell through (defense in depth).
	req := httptest.NewRequest("POST", "/api/elevenlabs/mcp-session-token", nil)
	w := httptest.NewRecorder()
	srv.handleElevenLabsMCPSessionToken(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d. Body: %s", w.Code, w.Body.String())
	}
}

func TestHandleElevenLabsMCPSessionToken_OK(t *testing.T) {
	srv, db := createHealthTestServer(t)
	defer db.Close()

	t.Setenv("ELEVENLABS_API_KEY", "test-key")
	t.Setenv("ELEVENLABS_AGENT_ID", "agent_test")
	t.Setenv("MCP_SERVER_URL", "https://mcp.example.com/")

	before := time.Now().UTC()

	req := httptest.NewRequest("POST", "/api/elevenlabs/mcp-session-token", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleElevenLabsMCPSessionToken(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}
	if cc := w.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("expected Cache-Control: no-store, got %q", cc)
	}

	var body struct {
		Token        string `json:"token"`
		MCPServerURL string `json:"mcp_server_url"`
		ExpiresAt    int64  `json:"expires_at"`
	}
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !strings.HasPrefix(body.Token, "mcp_") {
		t.Errorf("expected token to start with mcp_, got %q", body.Token)
	}
	// "mcp_" + 64 hex chars
	if got := len(body.Token); got != 4+64 {
		t.Errorf("expected token length 68, got %d", got)
	}
	// Trailing slash on MCP_SERVER_URL must be trimmed so the frontend can
	// safely concatenate "/mcp".
	if body.MCPServerURL != "https://mcp.example.com" {
		t.Errorf("expected mcp_server_url trimmed of trailing slash, got %q", body.MCPServerURL)
	}

	// expires_at lands within ~16 minutes of the call (15 min TTL plus a
	// generous skew buffer for slow CI runners).
	wantMin := before.Add(14 * time.Minute).Unix()
	wantMax := before.Add(16 * time.Minute).Unix()
	if body.ExpiresAt < wantMin || body.ExpiresAt > wantMax {
		t.Errorf("expires_at %d outside [%d, %d]", body.ExpiresAt, wantMin, wantMax)
	}

	// DB row exists with the expected name + expiry, and its hash matches.
	tokens, err := db.Auth.ListTokens(req.Context())
	if err != nil {
		t.Fatalf("ListTokens: %v", err)
	}
	if len(tokens) != 1 {
		t.Fatalf("expected 1 token row, got %d", len(tokens))
	}
	tok := tokens[0]
	if tok.Name != "elevenlabs-voice-session" {
		t.Errorf("expected name=elevenlabs-voice-session, got %q", tok.Name)
	}
	if !tok.ExpiresAt.Valid {
		t.Fatal("expected ExpiresAt to be set, got NULL")
	}
	if tok.ExpiresAt.Int64 != body.ExpiresAt {
		t.Errorf("DB expires_at=%d, response=%d", tok.ExpiresAt.Int64, body.ExpiresAt)
	}

	// The stored hash must look up correctly through the same path the OAuth
	// middleware uses, proving the mint endpoint hashes consistently.
	got, err := db.Auth.GetTokenByHash(req.Context(), auth.HashToken(body.Token))
	if err != nil {
		t.Fatalf("GetTokenByHash: %v", err)
	}
	if got == nil || got.ID != tok.ID {
		t.Errorf("GetTokenByHash returned %+v, want id=%d", got, tok.ID)
	}
}

func TestHandleElevenLabsMCPSessionToken_DistinctTokensPerCall(t *testing.T) {
	srv, db := createHealthTestServer(t)
	defer db.Close()

	t.Setenv("ELEVENLABS_API_KEY", "test-key")
	t.Setenv("ELEVENLABS_AGENT_ID", "agent_test")
	t.Setenv("MCP_SERVER_URL", "https://mcp.example.com")

	mint := func() string {
		req := httptest.NewRequest("POST", "/api/elevenlabs/mcp-session-token", nil)
		req = withUser(req, 123456)
		w := httptest.NewRecorder()
		srv.handleElevenLabsMCPSessionToken(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d. Body: %s", w.Code, w.Body.String())
		}
		var body struct {
			Token string `json:"token"`
		}
		if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return body.Token
	}

	a, b := mint(), mint()
	if a == b {
		t.Fatalf("expected distinct tokens per call, got duplicates: %q", a)
	}
}

func TestHandleElevenLabsSignedURL_UpstreamError(t *testing.T) {
	srv, db := createHealthTestServer(t)
	defer db.Close()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer upstream.Close()

	prev := elevenLabsSignedURLBase
	elevenLabsSignedURLBase = upstream.URL
	defer func() { elevenLabsSignedURLBase = prev }()

	t.Setenv("ELEVENLABS_API_KEY", "test-key")
	t.Setenv("ELEVENLABS_AGENT_ID", "agent_test")

	req := httptest.NewRequest("GET", "/api/elevenlabs/signed-url", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleElevenLabsSignedURL(w, req)

	if w.Code != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d", w.Code)
	}
}
