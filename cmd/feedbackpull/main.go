// Command feedbackpull is the developer/ops side of the cloud feedback channel
// (bd med-dni.4). It drains the blind feedback_queue from a cloud SQLite DB,
// age-decrypts each item with the developer's private key (the counterpart to
// the FEEDBACK_AGE_RECIPIENT pubkey clients encrypt to), prints the feedback
// text + metadata, saves any image/voice attachments to disk, and optionally
// acks (deletes) drained items.
//
// This is the only place the age private key exists and plaintext is recovered
// — never on the server. It is dev/ops tooling, not part of the shipped server
// or mobile binary; filippo.io/age is imported only here.
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"filippo.io/age"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

// feedbackDoc is the decrypted v1 plaintext document produced by the client
// (med-dni.3): a small JSON envelope with the feedback text and any inline
// base64 attachments.
type feedbackDoc struct {
	V           int    `json:"v"`
	CreatedAt   string `json:"created_at"`
	Text        string `json:"text"`
	Attachments []struct {
		Type    string `json:"type"`
		Mime    string `json:"mime"`
		DataB64 string `json:"data_b64"`
	} `json:"attachments"`
}

// decodeItem age-decrypts one queued item with the supplied identities and
// parses the v1 plaintext document. It returns an error (never panics) on a
// wrong key, corrupt ciphertext, malformed JSON, or an unsupported doc version.
func decodeItem(item cloudstore.FeedbackItem, ids []age.Identity) (feedbackDoc, error) {
	var doc feedbackDoc
	r, err := age.Decrypt(bytes.NewReader(item.Ciphertext), ids...)
	if err != nil {
		return doc, fmt.Errorf("decrypt item %d: %w", item.ID, err)
	}
	plaintext, err := io.ReadAll(r)
	if err != nil {
		return doc, fmt.Errorf("read plaintext for item %d: %w", item.ID, err)
	}
	if err := json.Unmarshal(plaintext, &doc); err != nil {
		return doc, fmt.Errorf("parse doc for item %d: %w", item.ID, err)
	}
	if doc.V != 1 {
		return doc, fmt.Errorf("unsupported feedback doc version %d for item %d", doc.V, item.ID)
	}
	return doc, nil
}

// mimeExt maps a declared attachment mime to a file extension, falling back to
// .bin for anything unexpected.
func mimeExt(mime string) string {
	switch mime {
	case "image/jpeg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "audio/webm":
		return ".webm"
	default:
		return ".bin"
	}
}

// saveAttachments base64-decodes each attachment and writes it to outDir named
// "<client_id>-<index><ext>", grouping a submission's files and keeping them
// collision-free across runs. It creates outDir if missing and returns the
// written paths.
func saveAttachments(doc feedbackDoc, item cloudstore.FeedbackItem, outDir string) ([]string, error) {
	if len(doc.Attachments) == 0 {
		return nil, nil
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return nil, fmt.Errorf("create out dir %q: %w", outDir, err)
	}
	var paths []string
	for i, att := range doc.Attachments {
		data, err := base64.StdEncoding.DecodeString(att.DataB64)
		if err != nil {
			return paths, fmt.Errorf("decode attachment %d of item %d: %w", i, item.ID, err)
		}
		name := fmt.Sprintf("%s-%d%s", item.ClientID, i, mimeExt(att.Mime))
		path := filepath.Join(outDir, name)
		if err := os.WriteFile(path, data, 0o644); err != nil {
			return paths, fmt.Errorf("write attachment %q: %w", path, err)
		}
		paths = append(paths, path)
	}
	return paths, nil
}

func main() {
	// Wired in Task 2 (flags, store drain, render, optional ack).
	fmt.Fprintln(os.Stderr, "feedbackpull: not yet wired (med-dni.4 Task 2)")
	os.Exit(1)
}
