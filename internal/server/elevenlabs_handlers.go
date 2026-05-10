package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// elevenLabsSignedURLBase is overridable in tests.
var elevenLabsSignedURLBase = "https://api.elevenlabs.io/v1/convai/conversation/get_signed_url"

// elevenLabsConversationsBase is overridable in tests. Real value is the
// ElevenLabs Conversational AI conversations endpoint; the per-conversation
// file upload is mounted at "{base}/{conversation_id}/files".
var elevenLabsConversationsBase = "https://api.elevenlabs.io/v1/convai/conversations"

// Cap upload size at 10 MiB. The browser-side Conversational AI agent only
// accepts images, and the SDK doesn't surface a documented per-file limit;
// 10 MiB is large enough for camera-quality JPEGs while keeping memory usage
// bounded. Anything larger is almost certainly a bug or accidental upload.
const elevenLabsMaxUploadBytes = 10 << 20

// handleElevenLabsSignedURL proxies a signed-URL request to ElevenLabs so the
// API key never reaches the browser. The frontend hands the returned URL to
// the <elevenlabs-convai> widget.
func (s *Server) handleElevenLabsSignedURL(w http.ResponseWriter, r *http.Request) {
	apiKey := os.Getenv("ELEVENLABS_API_KEY")
	agentID := os.Getenv("ELEVENLABS_AGENT_ID")
	if apiKey == "" || agentID == "" {
		http.Error(w, "ElevenLabs agent is not configured", http.StatusServiceUnavailable)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	q := url.Values{}
	q.Set("agent_id", agentID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, elevenLabsSignedURLBase+"?"+q.Encode(), nil)
	if err != nil {
		slog.Error("elevenlabs: build request", "error", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}
	req.Header.Set("xi-api-key", apiKey)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		slog.Error("elevenlabs: request failed", "error", err)
		http.Error(w, "Failed to reach ElevenLabs API", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<14))
		slog.Error("elevenlabs: non-200 response", "status", resp.StatusCode, "body", string(body))
		http.Error(w, "ElevenLabs API request failed", http.StatusBadGateway)
		return
	}

	var payload struct {
		SignedURL string `json:"signed_url"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&payload); err != nil {
		slog.Error("elevenlabs: decode response", "error", err)
		http.Error(w, "Invalid ElevenLabs response", http.StatusBadGateway)
		return
	}
	if payload.SignedURL == "" {
		slog.Error("elevenlabs: empty signed_url in response")
		http.Error(w, "Invalid ElevenLabs response", http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if err := json.NewEncoder(w).Encode(map[string]string{"signed_url": payload.SignedURL}); err != nil {
		slog.Error("encode response", "error", err)
	}
}

// handleElevenLabsUploadFile proxies a multipart file upload to ElevenLabs'
// per-conversation files endpoint so the API key never reaches the browser.
//
// The @elevenlabs/client SDK's `conversation.uploadFile()` posts directly to
// `https://api.elevenlabs.io/v1/convai/conversations/{conversation_id}/files`
// and requires `xi-api-key`, which we never expose to the browser. Instead
// the browser POSTs the multipart body here with `?conversation_id=...`,
// and we forward it upstream with the API key attached. The response shape
// (`{file_id: ...}`) is returned verbatim so the browser can hand the id to
// `conversation.sendMultimodalMessage({ fileId })`.
func (s *Server) handleElevenLabsUploadFile(w http.ResponseWriter, r *http.Request) {
	apiKey := os.Getenv("ELEVENLABS_API_KEY")
	if apiKey == "" {
		http.Error(w, "ElevenLabs agent is not configured", http.StatusServiceUnavailable)
		return
	}

	conversationID := r.URL.Query().Get("conversation_id")
	if conversationID == "" {
		http.Error(w, "conversation_id is required", http.StatusBadRequest)
		return
	}
	// ElevenLabs conversation IDs are opaque tokens; reject anything that
	// could break URL path semantics so we can't be tricked into hitting an
	// arbitrary upstream path.
	if strings.ContainsAny(conversationID, "/?#") {
		http.Error(w, "invalid conversation_id", http.StatusBadRequest)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, elevenLabsMaxUploadBytes)
	if err := r.ParseMultipartForm(elevenLabsMaxUploadBytes); err != nil {
		http.Error(w, "invalid multipart body", http.StatusBadRequest)
		return
	}
	defer func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}()

	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "file field is required", http.StatusBadRequest)
		return
	}
	defer file.Close()

	contentType := header.Header.Get("Content-Type")
	if !strings.HasPrefix(contentType, "image/") {
		http.Error(w, "only image uploads are supported", http.StatusBadRequest)
		return
	}

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	part, err := mw.CreatePart(header.Header)
	if err != nil {
		slog.Error("elevenlabs upload: create multipart part", "error", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}
	if _, err := io.Copy(part, file); err != nil {
		slog.Error("elevenlabs upload: copy file", "error", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}
	if err := mw.Close(); err != nil {
		slog.Error("elevenlabs upload: close multipart", "error", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	upstream := elevenLabsConversationsBase + "/" + url.PathEscape(conversationID) + "/files"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, upstream, &body)
	if err != nil {
		slog.Error("elevenlabs upload: build request", "error", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}
	req.Header.Set("xi-api-key", apiKey)
	req.Header.Set("Content-Type", mw.FormDataContentType())

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		slog.Error("elevenlabs upload: request failed", "error", err)
		http.Error(w, "Failed to reach ElevenLabs API", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<14))
		slog.Error("elevenlabs upload: non-2xx response", "status", resp.StatusCode, "body", string(respBody))
		http.Error(w, "ElevenLabs API request failed", http.StatusBadGateway)
		return
	}

	var payload struct {
		FileID string `json:"file_id"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&payload); err != nil {
		slog.Error("elevenlabs upload: decode response", "error", err)
		http.Error(w, "Invalid ElevenLabs response", http.StatusBadGateway)
		return
	}
	if payload.FileID == "" {
		slog.Error("elevenlabs upload: empty file_id in response")
		http.Error(w, "Invalid ElevenLabs response", http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if err := json.NewEncoder(w).Encode(map[string]string{"file_id": payload.FileID}); err != nil {
		slog.Error("encode response", "error", err)
	}
}
