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
)

func TestHandleElevenLabsSignedURL_NotConfigured(t *testing.T) {
	srv, db := createHealthTestServer(t)
	defer db.Close()

	// Leaving ElevenLabsConfig zero-valued must surface as Service Unavailable.
	srv.SetElevenLabsConfig(ElevenLabsConfig{})

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

	srv.SetElevenLabsConfig(ElevenLabsConfig{APIKey: "test-key", AgentID: "agent_test"})

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

	srv.SetElevenLabsConfig(ElevenLabsConfig{})

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

	srv.SetElevenLabsConfig(ElevenLabsConfig{APIKey: "test-key"})

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

	srv.SetElevenLabsConfig(ElevenLabsConfig{APIKey: "test-key"})

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

	srv.SetElevenLabsConfig(ElevenLabsConfig{APIKey: "test-key"})

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

	srv.SetElevenLabsConfig(ElevenLabsConfig{APIKey: "test-key"})

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

	srv.SetElevenLabsConfig(ElevenLabsConfig{APIKey: "test-key"})

	req := newUploadRequest(t, "conv_xyz", "image/jpeg", []byte("fake-bytes"))
	w := httptest.NewRecorder()
	srv.handleElevenLabsUploadFile(w, req)

	if w.Code != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d", w.Code)
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

	srv.SetElevenLabsConfig(ElevenLabsConfig{APIKey: "test-key", AgentID: "agent_test"})

	req := httptest.NewRequest("GET", "/api/elevenlabs/signed-url", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleElevenLabsSignedURL(w, req)

	if w.Code != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d", w.Code)
	}
}
