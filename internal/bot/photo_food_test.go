package bot

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

// fakeTelegramFileFetcher returns a canned tgbotapi.File response for GetFile
// so tests can drive the local-mode and remote-mode branches of
// downloadTelegramPhoto without spinning up the Bot API itself.
type fakeTelegramFileFetcher struct {
	filePath string
	token    string
	err      error
	calls    int
}

func (f *fakeTelegramFileFetcher) GetFile(_ tgbotapi.FileConfig) (tgbotapi.File, error) {
	f.calls++
	if f.err != nil {
		return tgbotapi.File{}, f.err
	}
	return tgbotapi.File{FileID: "fid", FilePath: f.filePath}, nil
}

func (f *fakeTelegramFileFetcher) Token() string { return f.token }

// minimalJPEG returns the smallest byte sequence that http.DetectContentType
// classifies as "image/jpeg" — two SOI bytes plus enough to satisfy the
// sniffer.
func minimalJPEG() []byte {
	return []byte{0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 'J', 'F', 'I', 'F', 0x00, 0x01, 0x01, 0x00}
}

func TestDownloadTelegramPhoto_LocalMode(t *testing.T) {
	dir := t.TempDir()
	localPath := filepath.Join(dir, "photo.jpg")
	want := minimalJPEG()
	if err := os.WriteFile(localPath, want, 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	fetcher := &fakeTelegramFileFetcher{filePath: localPath, token: "irrelevant"}
	httpClient := &http.Client{Timeout: time.Second}

	got, mime, err := downloadTelegramPhotoWith(context.Background(), fetcher, httpClient, "fid")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(got) != string(want) {
		t.Fatalf("bytes mismatch: got %d bytes, want %d bytes", len(got), len(want))
	}
	if mime != "image/jpeg" {
		t.Fatalf("mime=%q, want image/jpeg", mime)
	}
	if fetcher.calls != 1 {
		t.Fatalf("expected exactly one GetFile call, got %d", fetcher.calls)
	}
}

func TestDownloadTelegramPhoto_RemoteMode(t *testing.T) {
	want := minimalJPEG()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/file/bot") {
			t.Errorf("unexpected request path: %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(want)
	}))
	defer server.Close()

	// fakeTelegramFileFetcher returns a relative FilePath. file.Link builds
	// "https://api.telegram.org/file/bot<token>/<FilePath>", and the
	// rewriteTransport below redirects every outgoing request to the
	// httptest server while preserving the path — so the handler sees the
	// original /file/botTESTTOKEN/photos/abc.jpg path.
	fetcher := &fakeTelegramFileFetcher{filePath: "photos/abc.jpg", token: "TESTTOKEN"}

	// Replace the HTTP client's Transport so requests to api.telegram.org are
	// transparently rerouted to our test server.
	httpClient := &http.Client{
		Transport: rewriteTransport{server: server.URL},
		Timeout:   2 * time.Second,
	}

	got, mime, err := downloadTelegramPhotoWith(context.Background(), fetcher, httpClient, "fid")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(got) != string(want) {
		t.Fatalf("bytes mismatch: got %d, want %d", len(got), len(want))
	}
	if mime != "image/jpeg" {
		t.Fatalf("mime=%q, want image/jpeg", mime)
	}
}

// rewriteTransport sends every request to the test server, preserving the
// request path so the handler can still inspect it.
type rewriteTransport struct {
	server string // e.g. "http://127.0.0.1:PORT"
}

func (t rewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	target, err := http.NewRequestWithContext(req.Context(), req.Method, t.server+req.URL.Path, req.Body)
	if err != nil {
		return nil, err
	}
	target.Header = req.Header
	return http.DefaultTransport.RoundTrip(target)
}

func TestDownloadTelegramPhoto_RejectsOversizeLocal(t *testing.T) {
	dir := t.TempDir()
	localPath := filepath.Join(dir, "huge.jpg")
	// One byte over the 8 MB cap.
	big := make([]byte, maxFoodPhotoBytes+1)
	for i := range big {
		big[i] = 0xAB
	}
	if err := os.WriteFile(localPath, big, 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	fetcher := &fakeTelegramFileFetcher{filePath: localPath, token: "x"}
	httpClient := &http.Client{Timeout: time.Second}

	_, _, err := downloadTelegramPhotoWith(context.Background(), fetcher, httpClient, "fid")
	if err == nil {
		t.Fatalf("expected error for oversize photo")
	}
	if !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("expected 'exceeds' in error, got %v", err)
	}
}

func TestDownloadTelegramPhoto_RejectsOversizeRemote(t *testing.T) {
	big := make([]byte, maxFoodPhotoBytes+1)
	for i := range big {
		big[i] = 0xCD
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(big)
	}))
	defer server.Close()

	fetcher := &fakeTelegramFileFetcher{filePath: "photos/huge.jpg", token: "TESTTOKEN"}
	httpClient := &http.Client{
		Transport: rewriteTransport{server: server.URL},
		Timeout:   5 * time.Second,
	}

	_, _, err := downloadTelegramPhotoWith(context.Background(), fetcher, httpClient, "fid")
	if err == nil {
		t.Fatalf("expected error for oversize remote photo")
	}
	if !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("expected 'exceeds' in error, got %v", err)
	}
}

func TestDownloadTelegramPhoto_RejectsNonImage(t *testing.T) {
	dir := t.TempDir()
	localPath := filepath.Join(dir, "doc.txt")
	if err := os.WriteFile(localPath, []byte("hello, this is plain text not an image"), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	fetcher := &fakeTelegramFileFetcher{filePath: localPath, token: "x"}
	httpClient := &http.Client{Timeout: time.Second}

	_, _, err := downloadTelegramPhotoWith(context.Background(), fetcher, httpClient, "fid")
	if err == nil {
		t.Fatalf("expected error for non-image content")
	}
	if !strings.Contains(err.Error(), "not an image") {
		t.Fatalf("expected 'not an image' in error, got %v", err)
	}
}

func TestDownloadTelegramPhoto_GetFileError(t *testing.T) {
	fetcher := &fakeTelegramFileFetcher{err: fmt.Errorf("network down")}
	httpClient := &http.Client{Timeout: time.Second}

	_, _, err := downloadTelegramPhotoWith(context.Background(), fetcher, httpClient, "fid")
	if err == nil {
		t.Fatalf("expected error when GetFile fails")
	}
	if !strings.Contains(err.Error(), "network down") {
		t.Fatalf("expected wrapped underlying error, got %v", err)
	}
}

func TestDownloadTelegramPhoto_RemoteHTTPError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer server.Close()

	fetcher := &fakeTelegramFileFetcher{filePath: "photos/x.jpg", token: "TESTTOKEN"}
	httpClient := &http.Client{
		Transport: rewriteTransport{server: server.URL},
		Timeout:   2 * time.Second,
	}

	_, _, err := downloadTelegramPhotoWith(context.Background(), fetcher, httpClient, "fid")
	if err == nil {
		t.Fatalf("expected error for HTTP 500")
	}
	if !strings.Contains(err.Error(), "500") {
		t.Fatalf("expected status code in error, got %v", err)
	}
}

func TestDownloadTelegramPhoto_EmptyDownload(t *testing.T) {
	dir := t.TempDir()
	localPath := filepath.Join(dir, "empty.jpg")
	if err := os.WriteFile(localPath, []byte{}, 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	fetcher := &fakeTelegramFileFetcher{filePath: localPath, token: "x"}
	httpClient := &http.Client{Timeout: time.Second}

	_, _, err := downloadTelegramPhotoWith(context.Background(), fetcher, httpClient, "fid")
	if err == nil {
		t.Fatalf("expected error for empty file")
	}
	if !strings.Contains(err.Error(), "empty") {
		t.Fatalf("expected 'empty' in error, got %v", err)
	}
}

// TestReadCapped_StreamsAtBoundary ensures we don't buffer arbitrarily large
// uploads: readCapped should stop reading at maxFoodPhotoBytes+1 bytes even if
// the underlying source has gigabytes more.
func TestReadCapped_StreamsAtBoundary(t *testing.T) {
	// Use io.MultiReader to glue together a too-large buffer plus a panicking
	// reader; if readCapped reads past the limit, the test would panic.
	first := make([]byte, maxFoodPhotoBytes+1)
	r := io.MultiReader(strings.NewReader(string(first)), panicReader{})

	_, err := readCapped(r)
	if err == nil {
		t.Fatalf("expected 'exceeds' error")
	}
	if !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("expected 'exceeds' in error, got %v", err)
	}
}

type panicReader struct{}

func (panicReader) Read([]byte) (int, error) {
	panic("readCapped read past the cap")
}
