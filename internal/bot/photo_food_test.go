package bot

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/korjavin/medicationtrackerbot/internal/domain"
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

// recordedRequest captures a single request the bot sent to the (mock)
// Telegram API. Tests use it to assert that the [Undo] expiry timer issues
// an editMessageReplyMarkup call after foodPhotoUndoWindow elapses. Body is
// the raw form-encoded payload; bodyDecoded is the URL-decoded view so tests
// can plain-string-match on the message text and callback_data.
type recordedRequest struct {
	path        string
	body        string
	bodyDecoded string
}

// newRecordingFoodBot builds a Bot wired against a recording httptest server.
// Every call to b.api.Send / b.api.Request lands in the returned []recordedRequest
// (in order), so tests can assert that summary messages, status deletes, and
// edit-reply-markup calls happen in the expected sequence.
//
// The mock server always returns message_id=999 so b.api.Send produces a Message
// with MessageID=999 — the undo-batch entry's messageID is therefore stamped
// with 999 after the summary is sent.
func newRecordingFoodBot(t *testing.T, food FoodStore, ai domain.FoodAIService) (*Bot, *[]recordedRequest) {
	t.Helper()
	var (
		mu       sync.Mutex
		recorded []recordedRequest
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		decoded, decErr := url.QueryUnescape(string(body))
		if decErr != nil {
			decoded = string(body)
		}
		mu.Lock()
		recorded = append(recorded, recordedRequest{path: r.URL.Path, body: string(body), bodyDecoded: decoded})
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true, "result": {"message_id": 999, "chat": {"id": 123}}}`))
	}))
	t.Cleanup(server.Close)

	api, _ := tgbotapi.NewBotAPIWithClient("123:TOKEN", tgbotapi.APIEndpoint, &http.Client{})
	if api == nil {
		api = &tgbotapi.BotAPI{Token: "123:TOKEN", Client: &http.Client{}, Buffer: 100}
	}
	api.SetAPIEndpoint(server.URL + "/bot%s/%s")

	b := &Bot{
		api:           api,
		food:          food,
		foodAI:        ai,
		allowedUserID: 123456,
		pendingPhotos: newPendingPhotoStore(),
		undoBatches:   newUndoBatchStore(),
	}
	return b, &recorded
}

// snapshot copies the recorded requests under the mutex so tests can read
// safely after concurrent timer callbacks may have appended entries.
func snapshot(recorded *[]recordedRequest) []recordedRequest {
	out := make([]recordedRequest, len(*recorded))
	copy(out, *recorded)
	return out
}

func containsPath(recorded []recordedRequest, suffix string) bool {
	for _, r := range recorded {
		if strings.HasSuffix(r.path, suffix) {
			return true
		}
	}
	return false
}

func bodiesForPath(recorded []recordedRequest, suffix string) []string {
	var out []string
	for _, r := range recorded {
		if strings.HasSuffix(r.path, suffix) {
			out = append(out, r.bodyDecoded)
		}
	}
	return out
}

func TestRespondWithFoodPhotoSummary_SuccessSingleItem(t *testing.T) {
	store := &mockFoodStore{enabled: true}
	ai := &mockFoodAI{logs: []domain.FoodLog{
		{Name: "Apple", Weight: 150, Carbs: 20, Protein: 1, Fat: 0, Calories: 80},
	}}
	b, recorded := newRecordingFoodBot(t, store, ai)

	eatenAt := time.Date(2026, 5, 11, 9, 0, 0, 0, time.UTC)
	b.respondWithFoodPhotoSummary(context.Background(), 123, eatenAt, minimalJPEG(), "image/jpeg")

	// The store should have received the single CreateFoodLog call.
	if len(store.logs) != 1 {
		t.Fatalf("expected 1 persisted log, got %d", len(store.logs))
	}
	if store.logs[0].Name != "Apple" {
		t.Errorf("expected Apple, got %s", store.logs[0].Name)
	}
	if !store.logs[0].EatenAt.Equal(eatenAt) {
		t.Errorf("expected eaten_at=%v, got %v", eatenAt, store.logs[0].EatenAt)
	}
	if store.logs[0].UserID != 123456 {
		t.Errorf("expected UserID=123456, got %d", store.logs[0].UserID)
	}

	// The undo batch should be stored with messageID set to the mock's 999.
	b.undoBatches.mu.Lock()
	defer b.undoBatches.mu.Unlock()
	if len(b.undoBatches.entries) != 1 {
		t.Fatalf("expected 1 undo batch entry, got %d", len(b.undoBatches.entries))
	}
	var (
		token string
		entry undoBatchEntry
	)
	for k, v := range b.undoBatches.entries {
		token = k
		entry = v
	}
	if len(token) != 32 {
		t.Errorf("expected 32-char hex token, got %q (len=%d)", token, len(token))
	}
	if entry.chatID != 123 {
		t.Errorf("entry.chatID: want 123, got %d", entry.chatID)
	}
	if entry.messageID != 999 {
		t.Errorf("entry.messageID: want 999 (from mock), got %d", entry.messageID)
	}
	if len(entry.foodLogIDs) != 1 || entry.foodLogIDs[0] != 1 {
		t.Errorf("entry.foodLogIDs: want [1], got %v", entry.foodLogIDs)
	}

	// The reply must contain item name + Undo button payload with the token.
	requests := snapshot(recorded)
	summaryBodies := bodiesForPath(requests, "/sendMessage")
	if len(summaryBodies) < 2 {
		t.Fatalf("expected at least 2 sendMessage calls (status + summary), got %d", len(summaryBodies))
	}
	summary := summaryBodies[len(summaryBodies)-1]
	if !strings.Contains(summary, "Apple") {
		t.Errorf("expected Apple in summary body, got: %s", summary)
	}
	if !strings.Contains(summary, foodPhotoUndoCallbackPrefix+token) {
		t.Errorf("expected callback_data with token in summary body, got: %s", summary)
	}
}

func TestRespondWithFoodPhotoSummary_ExpireUndoBatchStripsKeyboard(t *testing.T) {
	store := &mockFoodStore{enabled: true}
	ai := &mockFoodAI{logs: []domain.FoodLog{
		{Name: "Banana", Weight: 120, Carbs: 27, Protein: 1, Fat: 0, Calories: 105},
	}}
	b, recorded := newRecordingFoodBot(t, store, ai)

	b.respondWithFoodPhotoSummary(context.Background(), 456, time.Now(), minimalJPEG(), "image/jpeg")

	b.undoBatches.mu.Lock()
	var token string
	for k := range b.undoBatches.entries {
		token = k
	}
	b.undoBatches.mu.Unlock()

	if token == "" {
		t.Fatal("expected undo batch entry after respond")
	}

	// Drive the expiry helper directly — equivalent to the time.AfterFunc
	// firing — without sleeping for the real 5-second window.
	b.expireUndoBatch(token)

	requests := snapshot(recorded)
	if !containsPath(requests, "/editMessageReplyMarkup") {
		t.Errorf("expected editMessageReplyMarkup call after expireUndoBatch, got requests: %+v", requests)
	}

	b.undoBatches.mu.Lock()
	_, stillPresent := b.undoBatches.entries[token]
	b.undoBatches.mu.Unlock()
	if stillPresent {
		t.Error("expected undo batch entry to be consumed after expireUndoBatch (closes stale-click window)")
	}
}

func TestRespondWithFoodPhotoSummary_ZeroItems(t *testing.T) {
	store := &mockFoodStore{enabled: true}
	ai := &mockFoodAI{logs: []domain.FoodLog{}}
	b, recorded := newRecordingFoodBot(t, store, ai)

	b.respondWithFoodPhotoSummary(context.Background(), 789, time.Now(), minimalJPEG(), "image/jpeg")

	if len(store.logs) != 0 {
		t.Errorf("expected no persisted logs on zero items, got %d", len(store.logs))
	}
	b.undoBatches.mu.Lock()
	count := len(b.undoBatches.entries)
	b.undoBatches.mu.Unlock()
	if count != 0 {
		t.Errorf("expected no undo batch entries, got %d", count)
	}

	requests := snapshot(recorded)
	bodies := bodiesForPath(requests, "/sendMessage")
	joined := strings.Join(bodies, "\n")
	if !strings.Contains(joined, "No food detected") {
		t.Errorf("expected 'No food detected' user message, got: %s", joined)
	}
	if strings.Contains(joined, foodPhotoUndoCallbackPrefix) {
		t.Errorf("expected no undo button on zero-items reply, got: %s", joined)
	}
}

func TestRespondWithFoodPhotoSummary_PartialSaveFailure(t *testing.T) {
	store := &errFoodStore{
		mockFoodStore: mockFoodStore{enabled: true},
		failNames:     map[string]bool{"Broccoli": true},
	}
	ai := &mockFoodAI{logs: []domain.FoodLog{
		{Name: "Rice", Weight: 150, Carbs: 40, Protein: 4, Fat: 1, Calories: 185},
		{Name: "Broccoli", Weight: 100, Carbs: 7, Protein: 3, Fat: 0, Calories: 40},
	}}
	b, recorded := newRecordingFoodBot(t, store, ai)

	b.respondWithFoodPhotoSummary(context.Background(), 321, time.Now(), minimalJPEG(), "image/jpeg")

	if len(store.logs) != 1 {
		t.Fatalf("expected 1 persisted log (Rice only), got %d", len(store.logs))
	}
	if store.logs[0].Name != "Rice" {
		t.Errorf("expected only Rice to be persisted, got %s", store.logs[0].Name)
	}

	b.undoBatches.mu.Lock()
	var entry undoBatchEntry
	for _, v := range b.undoBatches.entries {
		entry = v
	}
	b.undoBatches.mu.Unlock()
	if len(entry.foodLogIDs) != 1 {
		t.Errorf("expected 1 ID in undo batch (only successful save), got %v", entry.foodLogIDs)
	}

	requests := snapshot(recorded)
	bodies := bodiesForPath(requests, "/sendMessage")
	if len(bodies) == 0 {
		t.Fatal("expected at least one sendMessage call")
	}
	summary := bodies[len(bodies)-1]
	if !strings.Contains(summary, "Logged 1 of 2 items") {
		t.Errorf("expected partial-success header in summary, got: %s", summary)
	}
	if !strings.Contains(summary, "1 failed") {
		t.Errorf("expected failure count in summary, got: %s", summary)
	}
}

func TestRespondWithFoodPhotoSummary_AIError(t *testing.T) {
	store := &mockFoodStore{enabled: true}
	ai := &mockFoodAI{err: errors.New("vision provider down")}
	b, recorded := newRecordingFoodBot(t, store, ai)

	b.respondWithFoodPhotoSummary(context.Background(), 12, time.Now(), minimalJPEG(), "image/jpeg")

	if len(store.logs) != 0 {
		t.Errorf("expected no persisted logs on AI error, got %d", len(store.logs))
	}
	b.undoBatches.mu.Lock()
	count := len(b.undoBatches.entries)
	b.undoBatches.mu.Unlock()
	if count != 0 {
		t.Errorf("expected no undo batch entries on AI error, got %d", count)
	}

	requests := snapshot(recorded)
	joined := strings.Join(bodiesForPath(requests, "/sendMessage"), "\n")
	if !strings.Contains(joined, "Failed to analyze photo") {
		t.Errorf("expected 'Failed to analyze photo' error reply, got: %s", joined)
	}
	if !strings.Contains(joined, "vision provider down") {
		t.Errorf("expected underlying error message, got: %s", joined)
	}
}

func TestRespondWithFoodPhotoSummary_AllSavesFail(t *testing.T) {
	store := &errFoodStore{
		mockFoodStore: mockFoodStore{enabled: true},
		failNames:     map[string]bool{"Rice": true, "Beans": true},
	}
	ai := &mockFoodAI{logs: []domain.FoodLog{
		{Name: "Rice", Weight: 150, Carbs: 40, Protein: 4, Fat: 1, Calories: 185},
		{Name: "Beans", Weight: 100, Carbs: 20, Protein: 8, Fat: 1, Calories: 120},
	}}
	b, recorded := newRecordingFoodBot(t, store, ai)

	b.respondWithFoodPhotoSummary(context.Background(), 7, time.Now(), minimalJPEG(), "image/jpeg")

	if len(store.logs) != 0 {
		t.Errorf("expected no persisted logs when every save fails, got %d", len(store.logs))
	}
	b.undoBatches.mu.Lock()
	count := len(b.undoBatches.entries)
	b.undoBatches.mu.Unlock()
	if count != 0 {
		t.Errorf("expected no undo batch entries when every save fails, got %d", count)
	}

	requests := snapshot(recorded)
	joined := strings.Join(bodiesForPath(requests, "/sendMessage"), "\n")
	if !strings.Contains(joined, "Error saving food log") {
		t.Errorf("expected 'Error saving food log' reply, got: %s", joined)
	}
}

// recentExifJPEG returns a minimal JPEG-EXIF blob whose DateTimeOriginal is
// set to (now - age) in UTC. With no OffsetTimeOriginal, parseExifDateTimeOriginal
// treats the date as UTC, so time.Since(parsed) ≈ age in real wall-clock time.
func recentExifJPEG(t *testing.T, age time.Duration) []byte {
	t.Helper()
	target := time.Now().UTC().Add(-age)
	return buildJPEGWithExif(t, target.Format("2006:01:02 15:04:05"), "", false)
}

func TestHandlePhotoMessage_NoEXIF_DirectSave(t *testing.T) {
	store := &mockFoodStore{enabled: true}
	ai := &mockFoodAI{logs: []domain.FoodLog{
		{Name: "Pizza", Weight: 200, Carbs: 30, Protein: 12, Fat: 10, Calories: 280},
	}}
	b, _ := newRecordingFoodBot(t, store, ai)

	var downloadCalls int
	b.photoDownloader = func(ctx context.Context, fileID string) ([]byte, string, error) {
		downloadCalls++
		if fileID != "large" {
			t.Errorf("expected to download largest photo, got fileID=%s", fileID)
		}
		return minimalJPEG(), "image/jpeg", nil
	}

	before := time.Now()
	msg := &tgbotapi.Message{
		Chat: &tgbotapi.Chat{ID: 555},
		Photo: []tgbotapi.PhotoSize{
			{FileID: "small", Width: 100, Height: 100},
			{FileID: "medium", Width: 320, Height: 240},
			{FileID: "large", Width: 1280, Height: 720},
		},
	}
	b.handlePhotoMessage(msg)
	after := time.Now()

	if downloadCalls != 1 {
		t.Fatalf("expected 1 download call, got %d", downloadCalls)
	}
	if len(store.logs) != 1 {
		t.Fatalf("expected 1 persisted log, got %d", len(store.logs))
	}
	eatenAt := store.logs[0].EatenAt
	if eatenAt.Before(before) || eatenAt.After(after) {
		t.Errorf("EatenAt %v not within [%v, %v]", eatenAt, before, after)
	}
	b.pendingPhotos.mu.Lock()
	pending := len(b.pendingPhotos.entries)
	b.pendingPhotos.mu.Unlock()
	if pending != 0 {
		t.Errorf("expected no pending photos on direct save, got %d", pending)
	}
}

func TestHandlePhotoMessage_RecentEXIF_DirectSave(t *testing.T) {
	store := &mockFoodStore{enabled: true}
	ai := &mockFoodAI{logs: []domain.FoodLog{
		{Name: "Salad", Weight: 250, Carbs: 12, Protein: 5, Fat: 8, Calories: 130},
	}}
	b, _ := newRecordingFoodBot(t, store, ai)

	// EXIF is only ~5 minutes old → within 1h threshold → direct save path.
	photoBytes := recentExifJPEG(t, 5*time.Minute)
	b.photoDownloader = func(ctx context.Context, fileID string) ([]byte, string, error) {
		return photoBytes, "image/jpeg", nil
	}

	before := time.Now()
	msg := &tgbotapi.Message{
		Chat:  &tgbotapi.Chat{ID: 777},
		Photo: []tgbotapi.PhotoSize{{FileID: "only", Width: 800, Height: 600}},
	}
	b.handlePhotoMessage(msg)
	after := time.Now()

	if len(store.logs) != 1 {
		t.Fatalf("expected 1 persisted log on recent-EXIF path, got %d", len(store.logs))
	}
	eatenAt := store.logs[0].EatenAt
	if eatenAt.Before(before) || eatenAt.After(after) {
		t.Errorf("EatenAt %v not within wall-clock [%v, %v] (should be ~now, not the EXIF time)", eatenAt, before, after)
	}
	b.pendingPhotos.mu.Lock()
	pending := len(b.pendingPhotos.entries)
	b.pendingPhotos.mu.Unlock()
	if pending != 0 {
		t.Errorf("expected no pending photos when EXIF is fresh, got %d", pending)
	}
}

func TestHandlePhotoMessage_OldEXIF_PromptsForTime(t *testing.T) {
	store := &mockFoodStore{enabled: true}
	ai := &mockFoodAI{logs: []domain.FoodLog{
		{Name: "ShouldNotSave", Weight: 100, Carbs: 1, Protein: 1, Fat: 1, Calories: 10},
	}}
	b, recorded := newRecordingFoodBot(t, store, ai)

	// EXIF is 3 hours old → > 1h threshold → prompt path; no save until user picks.
	photoBytes := recentExifJPEG(t, 3*time.Hour)
	b.photoDownloader = func(ctx context.Context, fileID string) ([]byte, string, error) {
		return photoBytes, "image/jpeg", nil
	}

	msg := &tgbotapi.Message{
		Chat:  &tgbotapi.Chat{ID: 888},
		Photo: []tgbotapi.PhotoSize{{FileID: "only", Width: 800, Height: 600}},
	}
	b.handlePhotoMessage(msg)

	if len(store.logs) != 0 {
		t.Errorf("expected no saves on old-EXIF prompt path, got %d", len(store.logs))
	}

	b.pendingPhotos.mu.Lock()
	if len(b.pendingPhotos.entries) != 1 {
		b.pendingPhotos.mu.Unlock()
		t.Fatalf("expected 1 pending photo entry, got %d", len(b.pendingPhotos.entries))
	}
	var (
		token string
		entry pendingPhotoEntry
	)
	for k, v := range b.pendingPhotos.entries {
		token = k
		entry = v
	}
	b.pendingPhotos.mu.Unlock()

	if entry.chatID != 888 {
		t.Errorf("entry.chatID: want 888, got %d", entry.chatID)
	}
	if entry.mimeType != "image/jpeg" {
		t.Errorf("entry.mimeType: want image/jpeg, got %s", entry.mimeType)
	}
	if len(entry.imageBytes) != len(photoBytes) {
		t.Errorf("entry.imageBytes length mismatch: got %d, want %d", len(entry.imageBytes), len(photoBytes))
	}

	// Verify the bot sent a single prompt message with both inline buttons
	// carrying the same token.
	requests := snapshot(recorded)
	bodies := bodiesForPath(requests, "/sendMessage")
	if len(bodies) != 1 {
		t.Fatalf("expected exactly 1 sendMessage call (the prompt), got %d", len(bodies))
	}
	body := bodies[0]
	if !strings.Contains(body, foodPhotoTimeCallbackPrefix+"exif:"+token) {
		t.Errorf("expected exif callback_data with token in prompt body, got: %s", body)
	}
	if !strings.Contains(body, foodPhotoTimeCallbackPrefix+"now:"+token) {
		t.Errorf("expected now callback_data with token in prompt body, got: %s", body)
	}
	if !strings.Contains(body, "Use the photo's time") {
		t.Errorf("expected prompt text to ask which time to use, got: %s", body)
	}
}

func TestHandlePhotoMessage_FoodIntakeDisabled(t *testing.T) {
	store := &mockFoodStore{enabled: false}
	ai := &mockFoodAI{}
	b, recorded := newRecordingFoodBot(t, store, ai)

	var downloadCalls int
	b.photoDownloader = func(ctx context.Context, fileID string) ([]byte, string, error) {
		downloadCalls++
		return nil, "", nil
	}

	msg := &tgbotapi.Message{
		Chat:  &tgbotapi.Chat{ID: 1},
		Photo: []tgbotapi.PhotoSize{{FileID: "only"}},
	}
	b.handlePhotoMessage(msg)

	if downloadCalls != 0 {
		t.Errorf("expected no download attempts when food intake disabled, got %d", downloadCalls)
	}
	requests := snapshot(recorded)
	joined := strings.Join(bodiesForPath(requests, "/sendMessage"), "\n")
	if !strings.Contains(joined, "disabled in settings") {
		t.Errorf("expected disabled-in-settings reply, got: %s", joined)
	}
}

func TestHandlePhotoMessage_NilFoodAI(t *testing.T) {
	store := &mockFoodStore{enabled: true}
	b, recorded := newRecordingFoodBot(t, store, nil)

	var downloadCalls int
	b.photoDownloader = func(ctx context.Context, fileID string) ([]byte, string, error) {
		downloadCalls++
		return nil, "", nil
	}

	msg := &tgbotapi.Message{
		Chat:  &tgbotapi.Chat{ID: 2},
		Photo: []tgbotapi.PhotoSize{{FileID: "only"}},
	}
	b.handlePhotoMessage(msg)

	if downloadCalls != 0 {
		t.Errorf("expected no download attempts when foodAI is nil, got %d", downloadCalls)
	}
	requests := snapshot(recorded)
	joined := strings.Join(bodiesForPath(requests, "/sendMessage"), "\n")
	if !strings.Contains(joined, "AI food logging is not configured") {
		t.Errorf("expected not-configured reply, got: %s", joined)
	}
}

func TestHandlePhotoMessage_DownloadError(t *testing.T) {
	store := &mockFoodStore{enabled: true}
	ai := &mockFoodAI{}
	b, recorded := newRecordingFoodBot(t, store, ai)

	b.photoDownloader = func(ctx context.Context, fileID string) ([]byte, string, error) {
		return nil, "", errors.New("network down")
	}

	msg := &tgbotapi.Message{
		Chat:  &tgbotapi.Chat{ID: 3},
		Photo: []tgbotapi.PhotoSize{{FileID: "only"}},
	}
	b.handlePhotoMessage(msg)

	if len(store.logs) != 0 {
		t.Errorf("expected no saves on download error, got %d", len(store.logs))
	}
	requests := snapshot(recorded)
	joined := strings.Join(bodiesForPath(requests, "/sendMessage"), "\n")
	if !strings.Contains(joined, "Could not download photo") {
		t.Errorf("expected download-error reply, got: %s", joined)
	}
	if !strings.Contains(joined, "network down") {
		t.Errorf("expected underlying error in reply, got: %s", joined)
	}
}

func TestExpireUndoBatch_NoOpOnUnknownToken(t *testing.T) {
	store := &mockFoodStore{enabled: true}
	ai := &mockFoodAI{}
	b, recorded := newRecordingFoodBot(t, store, ai)

	// Should not panic and should not issue any API request.
	b.expireUndoBatch("token-that-was-never-stored")

	if len(*recorded) != 0 {
		t.Errorf("expected no API calls for unknown token, got %d", len(*recorded))
	}
}

// timePickerCallback builds a CallbackQuery as Telegram would deliver it for
// the EXIF time-picker prompt: the originating bot message has MessageID 42
// and the user pressed the "Photo time" or "Now" button identified by
// callbackData.
func timePickerCallback(chatID int64, callbackData string) *tgbotapi.CallbackQuery {
	return &tgbotapi.CallbackQuery{
		ID:   "cbq",
		Data: callbackData,
		From: &tgbotapi.User{ID: chatID},
		Message: &tgbotapi.Message{
			MessageID: 42,
			Chat:      &tgbotapi.Chat{ID: chatID},
			Text:      "📸 Use the photo's time (12:34 on 2026-05-11) or use now?",
		},
	}
}

func TestHandleFoodPhotoTimeCallback_ExifBranch(t *testing.T) {
	store := &mockFoodStore{enabled: true}
	ai := &mockFoodAI{logs: []domain.FoodLog{
		{Name: "Soup", Weight: 300, Carbs: 25, Protein: 8, Fat: 5, Calories: 175},
	}}
	b, recorded := newRecordingFoodBot(t, store, ai)

	exifTime := time.Date(2026, 5, 11, 8, 30, 0, 0, time.UTC)
	token, err := b.pendingPhotos.put(pendingPhotoEntry{
		chatID:     321,
		imageBytes: minimalJPEG(),
		mimeType:   "image/jpeg",
		exifTime:   exifTime,
	})
	if err != nil {
		t.Fatalf("seed pending photo: %v", err)
	}

	cb := timePickerCallback(321, foodPhotoTimeCallbackPrefix+"exif:"+token)
	b.handleFoodPhotoTimeCallback(cb)

	b.pendingPhotos.mu.Lock()
	pendingCount := len(b.pendingPhotos.entries)
	b.pendingPhotos.mu.Unlock()
	if pendingCount != 0 {
		t.Errorf("expected pendingPhotos consumed, got %d remaining", pendingCount)
	}

	if len(store.logs) != 1 {
		t.Fatalf("expected 1 saved log, got %d", len(store.logs))
	}
	if !store.logs[0].EatenAt.Equal(exifTime) {
		t.Errorf("EatenAt: want %v, got %v", exifTime, store.logs[0].EatenAt)
	}

	requests := snapshot(recorded)
	if !containsPath(requests, "/editMessageText") {
		t.Errorf("expected editMessageText after selection, got %+v", requests)
	}
	editBodies := bodiesForPath(requests, "/editMessageText")
	if len(editBodies) == 0 || !strings.Contains(editBodies[0], "Using") {
		t.Errorf("expected confirm 'Using <time>' in edit body, got: %v", editBodies)
	}
}

func TestHandleFoodPhotoTimeCallback_NowBranch(t *testing.T) {
	store := &mockFoodStore{enabled: true}
	ai := &mockFoodAI{logs: []domain.FoodLog{
		{Name: "Toast", Weight: 60, Carbs: 30, Protein: 4, Fat: 2, Calories: 160},
	}}
	b, _ := newRecordingFoodBot(t, store, ai)

	exifTime := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	token, err := b.pendingPhotos.put(pendingPhotoEntry{
		chatID:     654,
		imageBytes: minimalJPEG(),
		mimeType:   "image/jpeg",
		exifTime:   exifTime,
	})
	if err != nil {
		t.Fatalf("seed pending photo: %v", err)
	}

	before := time.Now()
	cb := timePickerCallback(654, foodPhotoTimeCallbackPrefix+"now:"+token)
	b.handleFoodPhotoTimeCallback(cb)
	after := time.Now()

	if len(store.logs) != 1 {
		t.Fatalf("expected 1 saved log, got %d", len(store.logs))
	}
	eatenAt := store.logs[0].EatenAt
	if eatenAt.Before(before) || eatenAt.After(after) {
		t.Errorf("EatenAt %v not within [%v, %v] (now branch)", eatenAt, before, after)
	}
	if eatenAt.Equal(exifTime) {
		t.Errorf("EatenAt should not equal EXIF time on 'now' branch")
	}
}

func TestHandleFoodPhotoTimeCallback_UnknownToken(t *testing.T) {
	store := &mockFoodStore{enabled: true}
	ai := &mockFoodAI{}
	b, recorded := newRecordingFoodBot(t, store, ai)

	cb := timePickerCallback(111, foodPhotoTimeCallbackPrefix+"exif:does-not-exist")
	b.handleFoodPhotoTimeCallback(cb)

	if len(store.logs) != 0 {
		t.Errorf("expected no save on unknown token, got %d", len(store.logs))
	}

	requests := snapshot(recorded)
	editBodies := bodiesForPath(requests, "/editMessageText")
	if len(editBodies) == 0 {
		t.Fatalf("expected editMessageText with expired notice, got requests: %+v", requests)
	}
	joined := strings.Join(editBodies, "\n")
	if !strings.Contains(joined, "expired") {
		t.Errorf("expected 'expired' in edit body, got: %s", joined)
	}
}

func TestHandleFoodPhotoTimeCallback_MalformedData(t *testing.T) {
	store := &mockFoodStore{enabled: true}
	ai := &mockFoodAI{}
	b, recorded := newRecordingFoodBot(t, store, ai)

	cb := timePickerCallback(222, foodPhotoTimeCallbackPrefix+"banana:tok")
	b.handleFoodPhotoTimeCallback(cb)

	if len(store.logs) != 0 {
		t.Errorf("expected no save on malformed callback, got %d", len(store.logs))
	}
	requests := snapshot(recorded)
	joined := strings.Join(bodiesForPath(requests, "/sendMessage"), "\n")
	if !strings.Contains(joined, "Invalid time selection") {
		t.Errorf("expected invalid-selection reply, got: %s", joined)
	}
}

// undoCallback builds a CallbackQuery as Telegram would deliver it for the
// [Undo] button. The originating message has MessageID 77 and Text matching
// what the summary renderer would have produced.
func undoCallback(chatID int64, callbackData string) *tgbotapi.CallbackQuery {
	return &tgbotapi.CallbackQuery{
		ID:   "cbq",
		Data: callbackData,
		From: &tgbotapi.User{ID: chatID},
		Message: &tgbotapi.Message{
			MessageID: 77,
			Chat:      &tgbotapi.Chat{ID: chatID},
			Text:      "Logged 2 items: Apple, Banana",
		},
	}
}

func TestHandleFoodPhotoUndoCallback_Success(t *testing.T) {
	store := &mockFoodStore{enabled: true}
	b, recorded := newRecordingFoodBot(t, store, nil)
	b.allowedUserID = 123456

	token, err := b.undoBatches.put(undoBatchEntry{
		chatID:     500,
		messageID:  77,
		foodLogIDs: []int64{10, 11, 12},
	})
	if err != nil {
		t.Fatalf("seed undo batch: %v", err)
	}

	cb := undoCallback(500, foodPhotoUndoCallbackPrefix+token)
	b.handleFoodPhotoUndoCallback(cb)

	if len(store.deleted) != 3 {
		t.Fatalf("expected 3 DeleteFoodLog calls, got %d", len(store.deleted))
	}
	for i, d := range store.deleted {
		if d.UserID != 123456 {
			t.Errorf("delete[%d].UserID = %d, want 123456", i, d.UserID)
		}
	}

	b.undoBatches.mu.Lock()
	count := len(b.undoBatches.entries)
	b.undoBatches.mu.Unlock()
	if count != 0 {
		t.Errorf("expected undoBatches consumed, got %d remaining", count)
	}

	requests := snapshot(recorded)
	editBodies := bodiesForPath(requests, "/editMessageText")
	if len(editBodies) == 0 {
		t.Fatalf("expected editMessageText after undo, got requests: %+v", requests)
	}
	joined := strings.Join(editBodies, "\n")
	if !strings.Contains(joined, "Undone (3 items removed)") {
		t.Errorf("expected 'Undone (3 items removed)' in edit body, got: %s", joined)
	}
	if !strings.Contains(joined, "Logged 2 items") {
		t.Errorf("expected original summary text preserved, got: %s", joined)
	}
}

func TestHandleFoodPhotoUndoCallback_Expired(t *testing.T) {
	store := &mockFoodStore{enabled: true}
	b, recorded := newRecordingFoodBot(t, store, nil)

	cb := undoCallback(600, foodPhotoUndoCallbackPrefix+"unknown-token")
	b.handleFoodPhotoUndoCallback(cb)

	if len(store.deleted) != 0 {
		t.Errorf("expected no deletes on expired token, got %d", len(store.deleted))
	}

	requests := snapshot(recorded)
	joined := strings.Join(bodiesForPath(requests, "/sendMessage"), "\n")
	if !strings.Contains(joined, "Undo window expired") {
		t.Errorf("expected expired notice, got: %s", joined)
	}
	if containsPath(requests, "/editMessageText") {
		t.Errorf("expected no edit on expired token")
	}
}

func TestHandleFoodPhotoUndoCallback_PartialFailure(t *testing.T) {
	store := &mockFoodStore{
		enabled:   true,
		deleteErr: map[int64]error{11: fmt.Errorf("boom")},
	}
	b, recorded := newRecordingFoodBot(t, store, nil)
	b.allowedUserID = 123456

	token, err := b.undoBatches.put(undoBatchEntry{
		chatID:     700,
		messageID:  77,
		foodLogIDs: []int64{10, 11, 12},
	})
	if err != nil {
		t.Fatalf("seed undo batch: %v", err)
	}

	cb := undoCallback(700, foodPhotoUndoCallbackPrefix+token)
	b.handleFoodPhotoUndoCallback(cb)

	if len(store.deleted) != 2 {
		t.Fatalf("expected 2 successful deletes (10, 12), got %d", len(store.deleted))
	}

	requests := snapshot(recorded)
	joined := strings.Join(bodiesForPath(requests, "/editMessageText"), "\n")
	if !strings.Contains(joined, "Undone 2 items, 1 failed") {
		t.Errorf("expected partial-undo status, got: %s", joined)
	}
}

func TestHandleFoodPhotoUndoCallback_AllFail(t *testing.T) {
	store := &mockFoodStore{
		enabled: true,
		deleteErr: map[int64]error{
			10: fmt.Errorf("boom"),
			11: fmt.Errorf("boom"),
		},
	}
	b, recorded := newRecordingFoodBot(t, store, nil)

	token, err := b.undoBatches.put(undoBatchEntry{
		chatID:     800,
		messageID:  77,
		foodLogIDs: []int64{10, 11},
	})
	if err != nil {
		t.Fatalf("seed undo batch: %v", err)
	}

	cb := undoCallback(800, foodPhotoUndoCallbackPrefix+token)
	b.handleFoodPhotoUndoCallback(cb)

	if len(store.deleted) != 0 {
		t.Errorf("expected zero successful deletes, got %d", len(store.deleted))
	}

	requests := snapshot(recorded)
	joined := strings.Join(bodiesForPath(requests, "/editMessageText"), "\n")
	if !strings.Contains(joined, "Undo failed for all 2 items") {
		t.Errorf("expected all-failed status, got: %s", joined)
	}
}
