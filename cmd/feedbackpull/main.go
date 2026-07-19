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
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"filippo.io/age"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
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

// run drains up to limit oldest items from the queue, decrypting and rendering
// each. Fail-open: a decrypt/parse/save error for one item is logged to stderr
// and skipped (never deleted, so it stays in the queue for investigation) — one
// bad row must not abort the whole drain. When del is set, only successfully
// processed items are acked. w receives the human render (or, with jsonOut, one
// JSON line per item).
func run(store *cloudstore.Repo, ids []age.Identity, outDir string, limit int, del, jsonOut bool, w io.Writer) error {
	ctx := context.Background()
	items, err := store.ListFeedback(ctx, limit)
	if err != nil {
		return fmt.Errorf("list feedback: %w", err)
	}
	for _, item := range items {
		doc, err := decodeItem(item, ids)
		if err != nil {
			fmt.Fprintf(os.Stderr, "skip item %d: %v\n", item.ID, err)
			continue
		}
		paths, err := saveAttachments(doc, item, outDir)
		if err != nil {
			fmt.Fprintf(os.Stderr, "skip item %d: %v\n", item.ID, err)
			continue
		}
		if jsonOut {
			line, err := json.Marshal(map[string]any{
				"id":          item.ID,
				"account_id":  item.AccountID,
				"client_id":   item.ClientID,
				"kind":        item.Kind,
				"app_version": item.AppVersion,
				"created_at":  item.CreatedAt.UTC().Format("2006-01-02T15:04:05Z07:00"),
				"text":        doc.Text,
				"attachments": paths,
			})
			if err != nil {
				fmt.Fprintf(os.Stderr, "skip item %d: %v\n", item.ID, err)
				continue
			}
			fmt.Fprintln(w, string(line))
		} else {
			fmt.Fprintf(w, "─── item %d ── account=%s client=%s kind=%s version=%s at=%s\n",
				item.ID, item.AccountID, item.ClientID, item.Kind, item.AppVersion,
				item.CreatedAt.UTC().Format("2006-01-02T15:04:05Z07:00"))
			for _, p := range paths {
				fmt.Fprintf(w, "  saved: %s\n", p)
			}
			fmt.Fprintf(w, "%s\n\n", doc.Text)
		}
		if del {
			if err := store.DeleteFeedback(ctx, item.ID); err != nil {
				fmt.Fprintf(os.Stderr, "ack item %d failed: %v\n", item.ID, err)
			}
		}
	}
	return nil
}

func main() {
	var (
		dbPath   = flag.String("db", "", "cloud sqlite path (required)")
		identity = flag.String("identity", os.Getenv("FEEDBACK_AGE_IDENTITY"), "age identity file (default $FEEDBACK_AGE_IDENTITY)")
		outDir   = flag.String("out", "./feedback", "attachment output dir")
		limit    = flag.Int("limit", 100, "max items to drain")
		del      = flag.Bool("delete", false, "ack (delete) items after a successful decrypt+save")
		jsonOut  = flag.Bool("json", false, "emit each item as a JSON line instead of the human render")
	)
	flag.Parse()

	fail := func(format string, a ...any) {
		fmt.Fprintf(os.Stderr, "feedbackpull: "+format+"\n", a...)
		os.Exit(1)
	}
	if *dbPath == "" {
		fail("-db is required")
	}
	if *identity == "" {
		fail("-identity (or $FEEDBACK_AGE_IDENTITY) is required")
	}
	idFile, err := os.Open(*identity)
	if err != nil {
		fail("open identity file: %v", err)
	}
	ids, err := age.ParseIdentities(idFile)
	idFile.Close()
	if err != nil {
		fail("parse identities: %v", err)
	}
	if len(ids) == 0 {
		fail("no identities in %s", *identity)
	}

	sharedDB, err := storedb.Open(*dbPath)
	if err != nil {
		fail("open database: %v", err)
	}
	defer sharedDB.Close()
	store, err := cloudstore.New(sharedDB)
	if err != nil {
		fail("init cloudstore: %v", err)
	}

	if err := run(store, ids, *outDir, *limit, *del, *jsonOut, os.Stdout); err != nil {
		fail("%v", err)
	}
}
