package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"filippo.io/age"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

func setupStore(t *testing.T) *cloudstore.Repo {
	t.Helper()
	d, err := storedb.Open(":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	r, err := cloudstore.New(d)
	if err != nil {
		t.Fatalf("cloudstore.New: %v", err)
	}
	return r
}

// encryptDoc marshals doc to JSON and age-encrypts it to recipient, mirroring
// the wire format med-dni.3 produces client-side.
func encryptDoc(t *testing.T, doc feedbackDoc, recipient age.Recipient) []byte {
	t.Helper()
	plaintext, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("marshal doc: %v", err)
	}
	var buf bytes.Buffer
	w, err := age.Encrypt(&buf, recipient)
	if err != nil {
		t.Fatalf("age.Encrypt: %v", err)
	}
	if _, err := w.Write(plaintext); err != nil {
		t.Fatalf("write plaintext: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close age writer: %v", err)
	}
	return buf.Bytes()
}

func sampleDoc() feedbackDoc {
	doc := feedbackDoc{V: 1, CreatedAt: "2026-07-19T12:00:00Z", Text: "app crashes on save"}
	doc.Attachments = []struct {
		Type    string `json:"type"`
		Mime    string `json:"mime"`
		DataB64 string `json:"data_b64"`
	}{
		{Type: "image", Mime: "image/jpeg", DataB64: base64.StdEncoding.EncodeToString([]byte("\xff\xd8\xff-jpeg-bytes"))},
		{Type: "audio", Mime: "audio/webm", DataB64: base64.StdEncoding.EncodeToString([]byte("webm-bytes"))},
	}
	return doc
}

func TestDecodeItem(t *testing.T) {
	id, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatalf("GenerateX25519Identity: %v", err)
	}

	t.Run("round-trips text and attachments", func(t *testing.T) {
		item := cloudstore.FeedbackItem{ID: 1, ClientID: "cid-1", Ciphertext: encryptDoc(t, sampleDoc(), id.Recipient())}
		doc, err := decodeItem(item, []age.Identity{id})
		if err != nil {
			t.Fatalf("decodeItem: %v", err)
		}
		if doc.Text != "app crashes on save" {
			t.Errorf("text = %q", doc.Text)
		}
		if len(doc.Attachments) != 2 {
			t.Fatalf("attachments = %d, want 2", len(doc.Attachments))
		}
	})

	t.Run("wrong key errors, no panic", func(t *testing.T) {
		other, err := age.GenerateX25519Identity()
		if err != nil {
			t.Fatalf("GenerateX25519Identity: %v", err)
		}
		item := cloudstore.FeedbackItem{ID: 2, ClientID: "cid-2", Ciphertext: encryptDoc(t, sampleDoc(), other.Recipient())}
		if _, err := decodeItem(item, []age.Identity{id}); err == nil {
			t.Fatal("expected error for wrong-key item")
		}
	})

	t.Run("unsupported version errors", func(t *testing.T) {
		bad := sampleDoc()
		bad.V = 2
		item := cloudstore.FeedbackItem{ID: 3, ClientID: "cid-3", Ciphertext: encryptDoc(t, bad, id.Recipient())}
		if _, err := decodeItem(item, []age.Identity{id}); err == nil {
			t.Fatal("expected error for V != 1")
		}
	})
}

func TestSaveAttachments(t *testing.T) {
	item := cloudstore.FeedbackItem{ID: 1, ClientID: "cid-1"}
	doc := sampleDoc()
	outDir := filepath.Join(t.TempDir(), "inbox") // exercises MkdirAll

	paths, err := saveAttachments(doc, item, outDir)
	if err != nil {
		t.Fatalf("saveAttachments: %v", err)
	}
	want := []string{
		filepath.Join(outDir, "cid-1-0.jpg"),
		filepath.Join(outDir, "cid-1-1.webm"),
	}
	if len(paths) != len(want) {
		t.Fatalf("paths = %v, want %v", paths, want)
	}
	for i, p := range want {
		if paths[i] != p {
			t.Errorf("path[%d] = %q, want %q", i, paths[i], p)
		}
		got, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("read %q: %v", p, err)
		}
		exp, _ := base64.StdEncoding.DecodeString(doc.Attachments[i].DataB64)
		if !bytes.Equal(got, exp) {
			t.Errorf("bytes of %q mismatch", p)
		}
	}

	t.Run("no attachments is a clean no-op", func(t *testing.T) {
		paths, err := saveAttachments(feedbackDoc{V: 1}, item, filepath.Join(t.TempDir(), "empty"))
		if err != nil || paths != nil {
			t.Fatalf("got paths=%v err=%v, want nil,nil", paths, err)
		}
	})
}

func TestRun(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 19, 12, 0, 0, 0, time.UTC)
	id, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatalf("GenerateX25519Identity: %v", err)
	}
	other, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatalf("GenerateX25519Identity: %v", err)
	}

	// seed puts one good (our key) and one wrong-key item in the queue.
	seed := func(t *testing.T) *cloudstore.Repo {
		st := setupStore(t)
		good := encryptDoc(t, sampleDoc(), id.Recipient())
		bad := encryptDoc(t, sampleDoc(), other.Recipient())
		if err := st.AppendFeedback(ctx, "acc-1", "good", "bug", "1.0", good, now); err != nil {
			t.Fatalf("append good: %v", err)
		}
		if err := st.AppendFeedback(ctx, "acc-2", "bad", "bug", "1.0", bad, now.Add(time.Minute)); err != nil {
			t.Fatalf("append bad: %v", err)
		}
		return st
	}

	t.Run("renders good item, saves attachments, delete acks only the good one", func(t *testing.T) {
		st := seed(t)
		outDir := filepath.Join(t.TempDir(), "inbox")
		var buf bytes.Buffer
		if err := run(st, []age.Identity{id}, outDir, 100, true, false, &buf); err != nil {
			t.Fatalf("run: %v", err)
		}
		if !strings.Contains(buf.String(), "app crashes on save") {
			t.Errorf("output missing good text: %q", buf.String())
		}
		if _, err := os.Stat(filepath.Join(outDir, "good-0.jpg")); err != nil {
			t.Errorf("attachment not saved: %v", err)
		}
		remaining, err := st.ListFeedback(ctx, 100)
		if err != nil {
			t.Fatalf("ListFeedback: %v", err)
		}
		if len(remaining) != 1 || remaining[0].ClientID != "bad" {
			t.Errorf("expected only the bad item to remain, got %+v", remaining)
		}
	})

	t.Run("json emits parseable lines", func(t *testing.T) {
		st := seed(t)
		var buf bytes.Buffer
		if err := run(st, []age.Identity{id}, t.TempDir(), 100, false, true, &buf); err != nil {
			t.Fatalf("run: %v", err)
		}
		line := strings.TrimSpace(buf.String())
		if strings.Count(line, "\n") != 0 {
			t.Fatalf("expected exactly one JSON line, got: %q", buf.String())
		}
		var got map[string]any
		if err := json.Unmarshal([]byte(line), &got); err != nil {
			t.Fatalf("unmarshal json line: %v", err)
		}
		if got["text"] != "app crashes on save" || got["client_id"] != "good" {
			t.Errorf("unexpected json: %v", got)
		}
	})

	t.Run("empty queue is a clean no-op", func(t *testing.T) {
		st := setupStore(t)
		var buf bytes.Buffer
		if err := run(st, []age.Identity{id}, t.TempDir(), 100, true, false, &buf); err != nil {
			t.Fatalf("run: %v", err)
		}
		if buf.Len() != 0 {
			t.Errorf("expected no output, got %q", buf.String())
		}
	})
}
