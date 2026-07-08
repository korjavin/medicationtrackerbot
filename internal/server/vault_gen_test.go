package server

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// TestGenerateBotExportFixture is a throwaway generator: import the shared hand
// fixture, re-export through the real Go handler, and write the result to
// tests/fixtures/vault-v1-botexport.json (the cross-runtime full-loop pin in
// cloud.vault-roundtrip.test.js). Run explicitly:
//
//	GEN_BOTEXPORT=1 go test ./internal/server -run TestGenerateBotExportFixture
func TestGenerateBotExportFixture(t *testing.T) {
	if os.Getenv("GEN_BOTEXPORT") == "" {
		t.Skip("set GEN_BOTEXPORT=1 to regenerate the bot-export fixture")
	}
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	srv := newServer(db, "tok", "sec", 123, OIDCConfig{}, "bot", "")
	t.Cleanup(func() { _ = srv.Shutdown(context.Background()) })

	const userID = 1
	ctx := context.Background()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "fixtures", "vault-v1.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var v Vault
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("unmarshal fixture: %v", err)
	}
	if err := srv.importVault(ctx, userID, &v); err != nil {
		t.Fatalf("importVault: %v", err)
	}
	exported, err := srv.buildVault(ctx, userID, true)
	if err != nil {
		t.Fatalf("buildVault: %v", err)
	}
	out, err := json.MarshalIndent(exported, "", "  ")
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	dst := filepath.Join("..", "..", "tests", "fixtures", "vault-v1-botexport.json")
	if err := os.WriteFile(dst, append(out, '\n'), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	t.Logf("wrote %s", dst)
}
