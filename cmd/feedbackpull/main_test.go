package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"filippo.io/age"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

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
