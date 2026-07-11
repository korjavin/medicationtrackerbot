package gojahost

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain"
	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	"github.com/korjavin/medicationtrackerbot/internal/store/diary"
	"github.com/korjavin/medicationtrackerbot/internal/store/migrations"
)

// notesUserID is the single account the Go side seeds under.
const notesUserID int64 = 1

// newNotesGo builds the native diary repo + domain NotesService (which owns tag
// normalization + content validation, the logic web/domain/notes.js mirrors),
// with the clock pinned to the shared fixed now so created_at is deterministic.
func newNotesGo(t *testing.T) (domain.NotesService, *diary.Repo, context.Context) {
	t.Helper()
	d, err := storedb.Open(":memory:")
	if err != nil {
		t.Fatalf("open store db: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := d.Migrate(migrations.FS, "."); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	repo := diary.New(d)
	repo.SetClock(func() time.Time { return time.UnixMilli(fixedNowMs).UTC() })
	return domain.NewNotesService(repo), repo, context.Background()
}

func sptr(s string) *string { return &s }

// TestNotesTagAndContentParity: for each (content, rawTag) fixture the JS
// notes.create (through a pooled VM) and the Go NotesService.CreateNote must
// agree on the normalized tag (invalid tags dropped to absent/nil) and the
// stored content + created_at. This proves web/domain/notes.js's normalizeTag
// and content handling match internal/domain/notes.go's NormalizeNoteTag.
//
// Ordering parity is deliberately NOT asserted: under a fixed clock the JS ids
// (nowMs*1000 + random) and the Go autoincrement ids order independently, so
// insertion order is the only stable key — we compare by content instead.
func TestNotesTagAndContentParity(t *testing.T) {
	h := newTestHost(t)
	svc, _, ctx := newNotesGo(t)

	fixtures := []struct {
		content string
		rawTag  *string
	}{
		{"slept 8 hours", sptr("sleep")},   // valid, lower-case → SLEEP
		{"resting hr low", sptr("  HR  ")}, // valid, padded → HR
		{"felt stressed", sptr("anxiety")}, // invalid → dropped
		{"plain note", nil},                // no tag
		{"spo2 reading", sptr("SPO2")},     // valid as-is
		{"weird tag", sptr("")},            // empty → dropped
	}

	for _, f := range fixtures {
		input := map[string]interface{}{"content": f.content}
		var rawForJS interface{}
		if f.rawTag != nil {
			input["tag"] = *f.rawTag
			rawForJS = *f.rawTag
		}
		b, err := json.Marshal(input)
		if err != nil {
			t.Fatalf("marshal js input: %v", err)
		}

		v, err := h.Call("notes", "create", string(b))
		if err != nil {
			t.Fatalf("js notes.create(%s): %v", b, err)
		}
		jsResp, ok := v.Export().(map[string]interface{})
		if !ok {
			t.Fatalf("js notes.create result not an object: %T", v.Export())
		}

		goNote, err := svc.CreateNote(ctx, notesUserID, f.content, f.rawTag)
		if err != nil {
			t.Fatalf("go CreateNote(%q): %v", f.content, err)
		}

		// content parity
		if got := strOf(jsResp, "content"); got != goNote.Content {
			t.Errorf("content: JS %q vs Go %q (raw tag %v)", got, goNote.Content, rawForJS)
		}

		// tag normalization parity
		jsTag := strOf(jsResp, "tag") // absent → ""
		goTag := ""
		if goNote.Tag != nil {
			goTag = *goNote.Tag
		}
		if jsTag != goTag {
			t.Errorf("tag(raw=%v): JS %q vs Go %q", rawForJS, jsTag, goTag)
		}

		// created_at parity (both on the fixed clock)
		jsCreated, ok := jsResp["created_at"].(string)
		if !ok {
			t.Fatalf("js created_at not a string: %T", jsResp["created_at"])
		}
		jsT, err := time.Parse(time.RFC3339, jsCreated)
		if err != nil {
			t.Fatalf("parse JS created_at %q: %v", jsCreated, err)
		}
		if !jsT.Equal(goNote.CreatedAt) {
			t.Errorf("created_at: JS %s vs Go %s", jsT, goNote.CreatedAt)
		}
	}
}

// TestNotesListParity: after seeding the same content set on both sides, the JS
// notes.list and the Go NotesService.ListNotes must return the SAME set of
// (content → tag) notes. Compared as a content-keyed map (see the ordering note
// above); count and membership must match exactly.
func TestNotesListParity(t *testing.T) {
	h := newTestHost(t)
	svc, _, ctx := newNotesGo(t)

	contents := []string{"note one", "note two", "note three", "note four"}
	tags := []*string{sptr("SLEEP"), nil, sptr("STEPS"), sptr("bogus")}

	for i, c := range contents {
		input := map[string]interface{}{"content": c}
		if tags[i] != nil {
			input["tag"] = *tags[i]
		}
		b, _ := json.Marshal(input)
		if _, err := h.Call("notes", "create", string(b)); err != nil {
			t.Fatalf("js notes.create(%q): %v", c, err)
		}
		if _, err := svc.CreateNote(ctx, notesUserID, c, tags[i]); err != nil {
			t.Fatalf("go CreateNote(%q): %v", c, err)
		}
	}

	v, err := h.Call("notes", "list", `{ limit: 50 }`)
	if err != nil {
		t.Fatalf("js notes.list: %v", err)
	}
	jsArr, ok := v.Export().([]interface{})
	if !ok {
		t.Fatalf("js list result not an array: %T", v.Export())
	}

	goNotes, err := svc.ListNotes(ctx, notesUserID, time.Time{}, time.Time{}, 50, 0)
	if err != nil {
		t.Fatalf("go ListNotes: %v", err)
	}

	if len(jsArr) != len(goNotes) {
		t.Fatalf("length mismatch: JS %d vs Go %d", len(jsArr), len(goNotes))
	}

	jsByContent := map[string]string{}
	for _, e := range jsArr {
		m, ok := e.(map[string]interface{})
		if !ok {
			t.Fatalf("js note not an object: %T", e)
		}
		jsByContent[strOf(m, "content")] = strOf(m, "tag")
	}
	for _, g := range goNotes {
		goTag := ""
		if g.Tag != nil {
			goTag = *g.Tag
		}
		jsTag, present := jsByContent[g.Content]
		if !present {
			t.Errorf("Go note %q missing from JS list", g.Content)
			continue
		}
		if jsTag != goTag {
			t.Errorf("note %q tag: JS %q vs Go %q", g.Content, jsTag, goTag)
		}
	}
}
