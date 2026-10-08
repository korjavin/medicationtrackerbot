package cloudstore

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

// Snapshot compaction deletes the superseded oplog; PutSnapshot then runs
// incremental_vacuum so the freed pages leave the file instead of piling up
// in the freelist (bd med-tvfn: prod cloud.db was mostly free pages).
func TestPutSnapshot_ReturnsFreedPages(t *testing.T) {
	d, err := storedb.Open(filepath.Join(t.TempDir(), "cloud.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	r, err := New(d)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	now := time.Now().UTC()
	acc, err := r.CreateAccount(ctx, "acc-vac", "vac-otter-abc123", []byte("h"), now.Add(time.Hour), now, "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	ct := make([]byte, 1000)
	var last int64
	for b := 0; b < 30; b++ {
		ops := make([]OpInput, 100)
		for i := range ops {
			ops[i] = OpInput{DeviceCredentialID: []byte("dev"), RecordTypeTag: "bp:1", Nonce: []byte("n"), CT: ct}
		}
		seqs, err := r.AppendOps(ctx, acc.ID, ops, 0, now)
		if err != nil {
			t.Fatal(err)
		}
		last = seqs[len(seqs)-1]
	}
	if err := r.PutSnapshot(ctx, acc.ID, last, []byte("n"), []byte("snap"), now); err != nil {
		t.Fatal(err)
	}
	var free int64
	if err := d.QueryRow(`PRAGMA freelist_count`).Scan(&free); err != nil {
		t.Fatal(err)
	}
	if free != 0 {
		t.Fatalf("freelist_count after PutSnapshot = %d, want 0", free)
	}
}
