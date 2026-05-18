package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func createNotesTestServer(t *testing.T) (*Server, *store.Store) {
	t.Helper()
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	srv := New(db, "test-token", "test-secret", 123456, OIDCConfig{}, "test-bot", "")
	t.Cleanup(func() { _ = srv.Shutdown(context.Background()) })
	return srv, db
}

func TestHandleCreateNote(t *testing.T) {
	srv, db := createNotesTestServer(t)
	defer db.Close()

	body, _ := json.Marshal(map[string]string{"content": "feeling great today"})
	req := httptest.NewRequest("POST", "/api/notes", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleCreateNote(w, req)

	if w.Code != http.StatusCreated {
		t.Errorf("Expected 201, got %d. Body: %s", w.Code, w.Body.String())
	}

	var resp store.DiaryNote
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("Decode response: %v", err)
	}
	if resp.Content != "feeling great today" {
		t.Errorf("Expected content 'feeling great today', got %q", resp.Content)
	}
	if resp.ID == 0 {
		t.Error("Expected non-zero ID")
	}
}

func TestHandleCreateNote_EmptyContent(t *testing.T) {
	srv, db := createNotesTestServer(t)
	defer db.Close()

	body, _ := json.Marshal(map[string]string{"content": ""})
	req := httptest.NewRequest("POST", "/api/notes", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleCreateNote(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("Expected 400, got %d", w.Code)
	}
}

func TestHandleCreateNote_InvalidJSON(t *testing.T) {
	srv, db := createNotesTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("POST", "/api/notes", bytes.NewReader([]byte("not json")))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleCreateNote(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("Expected 400, got %d", w.Code)
	}
}

func TestHandleListNotes(t *testing.T) {
	srv, db := createNotesTestServer(t)
	defer db.Close()

	ctx := ctxWithUser(123456)
	for i := 0; i < 3; i++ {
		_, err := db.Diary.Create(ctx, 123456, fmt.Sprintf("note %d", i), nil)
		if err != nil {
			t.Fatalf("CreateDiaryNote: %v", err)
		}
	}

	req := httptest.NewRequest("GET", "/api/notes", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleListNotes(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	var notes []store.DiaryNote
	if err := json.NewDecoder(w.Body).Decode(&notes); err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if len(notes) != 3 {
		t.Errorf("Expected 3 notes, got %d", len(notes))
	}
}

func TestHandleListNotes_LimitParam(t *testing.T) {
	srv, db := createNotesTestServer(t)
	defer db.Close()

	ctx := ctxWithUser(123456)
	for i := 0; i < 5; i++ {
		_, err := db.Diary.Create(ctx, 123456, fmt.Sprintf("note %d", i), nil)
		if err != nil {
			t.Fatalf("CreateDiaryNote: %v", err)
		}
	}

	req := httptest.NewRequest("GET", "/api/notes?limit=2", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleListNotes(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected 200, got %d", w.Code)
	}
	var notes []store.DiaryNote
	if err := json.NewDecoder(w.Body).Decode(&notes); err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if len(notes) != 2 {
		t.Errorf("Expected 2 notes, got %d", len(notes))
	}
}

func TestHandleListNotes_CursorPagination(t *testing.T) {
	srv, db := createNotesTestServer(t)
	defer db.Close()

	ctx := ctxWithUser(123456)
	var lastID int64
	for i := 0; i < 5; i++ {
		note, err := db.Diary.Create(ctx, 123456, fmt.Sprintf("note %d", i), nil)
		if err != nil {
			t.Fatalf("CreateDiaryNote: %v", err)
		}
		lastID = note.ID
		_ = lastID
	}

	// Page 1: 3 most recent notes.
	req := httptest.NewRequest("GET", "/api/notes?limit=3", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleListNotes(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("page1: expected 200, got %d", w.Code)
	}
	var page1 []store.DiaryNote
	if err := json.NewDecoder(w.Body).Decode(&page1); err != nil {
		t.Fatalf("decode page1: %v", err)
	}
	if len(page1) != 3 {
		t.Fatalf("expected 3 notes on page1, got %d", len(page1))
	}

	// Page 2: notes before the last note on page 1.
	cursor := page1[len(page1)-1].ID
	req2 := httptest.NewRequest("GET", fmt.Sprintf("/api/notes?limit=3&before_id=%d", cursor), nil)
	req2 = withUser(req2, 123456)
	w2 := httptest.NewRecorder()
	srv.handleListNotes(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("page2: expected 200, got %d", w2.Code)
	}
	var page2 []store.DiaryNote
	if err := json.NewDecoder(w2.Body).Decode(&page2); err != nil {
		t.Fatalf("decode page2: %v", err)
	}
	if len(page2) != 2 {
		t.Fatalf("expected 2 notes on page2, got %d", len(page2))
	}
	for _, n := range page2 {
		if n.ID >= cursor {
			t.Errorf("page2 note ID %d not < cursor %d", n.ID, cursor)
		}
	}
}

func TestHandleDeleteNote(t *testing.T) {
	srv, db := createNotesTestServer(t)
	defer db.Close()

	ctx := ctxWithUser(123456)
	note, err := db.Diary.Create(ctx, 123456, "to delete", nil)
	if err != nil {
		t.Fatalf("CreateDiaryNote: %v", err)
	}

	req := httptest.NewRequest("DELETE", fmt.Sprintf("/api/notes/%d", note.ID), nil)
	req.SetPathValue("id", fmt.Sprintf("%d", note.ID))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleDeleteNote(w, req)

	if w.Code != http.StatusNoContent {
		t.Errorf("Expected 204, got %d. Body: %s", w.Code, w.Body.String())
	}

	notes, err := db.Diary.List(ctx, 123456, time.Time{}, time.Time{}, 0, 0 /*beforeID*/)
	if err != nil {
		t.Fatalf("ListDiaryNotes: %v", err)
	}
	if len(notes) != 0 {
		t.Errorf("Expected 0 notes after delete, got %d", len(notes))
	}
}

func TestHandleDeleteNote_InvalidID(t *testing.T) {
	srv, db := createNotesTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("DELETE", "/api/notes/abc", nil)
	req.SetPathValue("id", "abc")
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleDeleteNote(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("Expected 400, got %d", w.Code)
	}
}

func TestHandleDeleteNote_NotFound(t *testing.T) {
	srv, db := createNotesTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("DELETE", "/api/notes/99999", nil)
	req.SetPathValue("id", "99999")
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleDeleteNote(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("Expected 404, got %d", w.Code)
	}
}

func TestHandleCreateNote_ContentTooLong(t *testing.T) {
	srv, db := createNotesTestServer(t)
	defer db.Close()

	body, _ := json.Marshal(map[string]string{"content": string(make([]byte, 10001))})
	req := httptest.NewRequest("POST", "/api/notes", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleCreateNote(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("Expected 400, got %d", w.Code)
	}
}

func TestHandleCreateNote_WithValidTag(t *testing.T) {
	srv, db := createNotesTestServer(t)
	defer db.Close()

	body, _ := json.Marshal(map[string]interface{}{"content": "slept 8h", "tag": "SLEEP"})
	req := httptest.NewRequest("POST", "/api/notes", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleCreateNote(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("Expected 201, got %d. Body: %s", w.Code, w.Body.String())
	}
	var resp store.DiaryNote
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if resp.Tag == nil || *resp.Tag != "SLEEP" {
		t.Errorf("Expected tag SLEEP, got %v", resp.Tag)
	}
}

func TestHandleCreateNote_LowercaseTagNormalized(t *testing.T) {
	srv, db := createNotesTestServer(t)
	defer db.Close()

	body, _ := json.Marshal(map[string]interface{}{"content": "x", "tag": "stress"})
	req := httptest.NewRequest("POST", "/api/notes", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleCreateNote(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("Expected 201, got %d", w.Code)
	}
	var resp store.DiaryNote
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if resp.Tag == nil || *resp.Tag != "STRESS" {
		t.Errorf("Expected normalized STRESS, got %v", resp.Tag)
	}
}

// Invalid tags are sanitized to NULL rather than rejected — the POST still succeeds with 201.
func TestHandleCreateNote_InvalidTagSanitizedToNull(t *testing.T) {
	srv, db := createNotesTestServer(t)
	defer db.Close()

	body, _ := json.Marshal(map[string]interface{}{"content": "x", "tag": "MOOD"})
	req := httptest.NewRequest("POST", "/api/notes", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleCreateNote(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("Expected 201 (sanitized), got %d. Body: %s", w.Code, w.Body.String())
	}
	var resp store.DiaryNote
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if resp.Tag != nil {
		t.Errorf("Expected nil tag after sanitization, got %v", *resp.Tag)
	}
}

func TestHandleCreateNote_NoTagField(t *testing.T) {
	srv, db := createNotesTestServer(t)
	defer db.Close()

	body, _ := json.Marshal(map[string]string{"content": "just text"})
	req := httptest.NewRequest("POST", "/api/notes", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleCreateNote(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("Expected 201, got %d", w.Code)
	}
	var resp store.DiaryNote
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if resp.Tag != nil {
		t.Errorf("Expected nil tag, got %v", *resp.Tag)
	}
}

func TestHandleListNotes_ReturnsTag(t *testing.T) {
	srv, db := createNotesTestServer(t)
	defer db.Close()

	ctx := ctxWithUser(123456)
	tag := "HR"
	if _, err := db.Diary.Create(ctx, 123456, "resting 58", &tag); err != nil {
		t.Fatalf("CreateDiaryNote: %v", err)
	}

	req := httptest.NewRequest("GET", "/api/notes", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleListNotes(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}
	var notes []store.DiaryNote
	if err := json.NewDecoder(w.Body).Decode(&notes); err != nil {
		t.Fatal(err)
	}
	if len(notes) != 1 {
		t.Fatalf("Expected 1 note, got %d", len(notes))
	}
	if notes[0].Tag == nil || *notes[0].Tag != "HR" {
		t.Errorf("Expected tag HR, got %v", notes[0].Tag)
	}
}
