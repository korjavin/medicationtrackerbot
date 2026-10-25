package cloudserver

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

// failingTokenResealStore makes the token conversion write fail, standing in
// for a legacy row that has not been converted yet.
type failingTokenResealStore struct{ *cloudstore.Repo }

func (failingTokenResealStore) ResealMCPRemoteToken(context.Context, string, string, []byte, []byte) (bool, error) {
	return false, errors.New("injected reseal failure")
}

// mcpAuthStatus runs one request through the hosted endpoint's token check for
// accountID and returns the status. 404 is the uniform reject; anything else
// means the token was accepted and the request reached the MCP handler.
func mcpAuthStatus(api *MCPRemoteAPI, accountID, token string) int {
	req := httptest.NewRequest(http.MethodGet, "/mcp/"+token, nil)
	req = req.WithContext(withAccount(req.Context(), &cloudstore.Account{ID: accountID}))
	rec := httptest.NewRecorder()
	api.Endpoint().ServeHTTP(rec, req)
	return rec.Code
}

func restoredAPI(t *testing.T, store mcpRemoteStore, repo *cloudstore.Repo) *MCPRemoteAPI {
	t.Helper()
	api := NewMCPRemoteAPI(store, NewMCPRelayAPI(repo, mcpTestSecret), mcpTestSecret)
	api.Restore(context.Background())
	t.Cleanup(func() {
		api.mu.RLock()
		defer api.mu.RUnlock()
		for _, e := range api.byAcc {
			e.client.CloseNow()
		}
	})
	return api
}

// insertLegacyTokenRow writes a pre-037 row: plaintext token, no token_ct.
func insertLegacyTokenRow(t *testing.T, d *storedb.DB, accountID, token string) {
	t.Helper()
	ct, nonce, err := sealMCPPairingKey(mcpTestSecret, bytes.Repeat([]byte{0x09}, 32))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.ExecContext(context.Background(),
		`INSERT INTO mcp_remote (account_id, token, relay_url, pairing_id, pairing_key, pairing_key_ct, pairing_key_nonce, created_at_unix) VALUES (?,?,?,?,?,?,?,?)`,
		accountID, token, "wss://"+accountID+".localhost", "pid-"+accountID, []byte{}, ct, nonce, time.Now().Unix()); err != nil {
		t.Fatalf("insert legacy token row: %v", err)
	}
}

func assertTokenSealed(t *testing.T, repo *cloudstore.Repo, accountID, token string) {
	t.Helper()
	row := mcpRemoteRow(t, repo, accountID)
	if !cloudstore.IsSealedTokenPlaceholder(row.Token) || strings.Contains(row.Token, strings.ReplaceAll(token, "-", "")) {
		t.Fatalf("token column = %q, want a sealed placeholder with no clear token", row.Token)
	}
	got, err := openMCPRemoteToken(mcpTestSecret, row.TokenCT, row.TokenNonce)
	if err != nil || got != token {
		t.Fatalf("sealed token opens to %q (err %v), want %q", got, err, token)
	}
}

// TestMCPRemoteToken_NewConnectorStoresNoClearToken: a fresh enable persists
// only the sealed token, and the restored registry authenticates from it.
func TestMCPRemoteToken_NewConnectorStoresNoClearToken(t *testing.T) {
	repo, _ := setupStoreWithDB(t)
	ctx := context.Background()
	const token = "abc-def"
	tokCT, tokNonce, err := sealMCPRemoteToken(mcpTestSecret, token)
	if err != nil {
		t.Fatal(err)
	}
	keyCT, keyNonce, err := sealMCPPairingKey(mcpTestSecret, bytes.Repeat([]byte{0x01}, 32))
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.UpsertMCPRemote(ctx, "acc-new", "wss://acc-new.localhost", "pid-new", tokCT, tokNonce, keyCT, keyNonce, time.Now()); err != nil {
		t.Fatalf("UpsertMCPRemote: %v", err)
	}
	assertTokenSealed(t, repo, "acc-new", token)

	api := restoredAPI(t, repo, repo)
	if got := mcpAuthStatus(api, "acc-new", "ABC-DEF"); got == http.StatusNotFound {
		t.Fatal("sealed row: correct token rejected")
	}
	for _, wrong := range []string{"abc-deg", "", "-", mcpRemoteRow(t, repo, "acc-new").Token} {
		if got := mcpAuthStatus(api, "acc-new", wrong); got != http.StatusNotFound {
			t.Fatalf("sealed row: token %q accepted (status %d)", wrong, got)
		}
	}
}

// TestMCPRemoteToken_LegacyRowConversion: a pre-037 plaintext row
// authenticates while unconverted, is converted on boot, authenticates from
// the sealed columns afterwards, and re-running the conversion changes nothing.
func TestMCPRemoteToken_LegacyRowConversion(t *testing.T) {
	repo, d := setupStoreWithDB(t)
	const token = "xyz-123"
	insertLegacyTokenRow(t, d, "acc-old", token)

	// Unconverted (the conversion write fails): still authenticates from plaintext.
	api := restoredAPI(t, failingTokenResealStore{repo}, repo)
	if got := mcpAuthStatus(api, "acc-old", token); got == http.StatusNotFound {
		t.Fatal("unconverted legacy row: correct token rejected")
	}
	if got := mcpAuthStatus(api, "acc-old", "xyz-124"); got != http.StatusNotFound {
		t.Fatalf("unconverted legacy row: wrong token accepted (status %d)", got)
	}
	if row := mcpRemoteRow(t, repo, "acc-old"); row.Token != token || len(row.TokenCT) != 0 {
		t.Fatalf("failed conversion modified the row: %+v", row)
	}

	// Converting boot: authenticates, and the clear token is gone.
	api = restoredAPI(t, repo, repo)
	if got := mcpAuthStatus(api, "acc-old", token); got == http.StatusNotFound {
		t.Fatal("converting boot: correct token rejected")
	}
	assertTokenSealed(t, repo, "acc-old", token)
	converted := mcpRemoteRow(t, repo, "acc-old")

	// Idempotent: another boot, and a replayed conversion write for the old
	// plaintext (crash-and-retry), leave the sealed row as it was.
	api = restoredAPI(t, repo, repo)
	ct, nonce, err := sealMCPRemoteToken(mcpTestSecret, token)
	if err != nil {
		t.Fatal(err)
	}
	if changed, err := repo.ResealMCPRemoteToken(context.Background(), "acc-old", token, ct, nonce); err != nil || changed {
		t.Fatalf("replayed conversion: changed=%v err=%v, want a no-op", changed, err)
	}
	if again := mcpRemoteRow(t, repo, "acc-old"); again.Token != converted.Token || !bytes.Equal(again.TokenCT, converted.TokenCT) {
		t.Fatal("re-running the conversion rewrote an already-sealed row")
	}
	if got := mcpAuthStatus(api, "acc-old", token); got == http.StatusNotFound {
		t.Fatal("converted row: correct token rejected")
	}
	if got := mcpAuthStatus(api, "acc-old", "xyz-124"); got != http.StatusNotFound {
		t.Fatalf("converted row: wrong token accepted (status %d)", got)
	}
}

// TestMCPRemoteToken_RollbackReEnableWins: after a rollback, an older binary's
// re-enable writes a plaintext token and leaves the previous token_ct behind.
// The plaintext is the token the user holds, so it must win and be resealed.
func TestMCPRemoteToken_RollbackReEnableWins(t *testing.T) {
	repo, d := setupStoreWithDB(t)
	insertLegacyTokenRow(t, d, "acc-rb", "old-old")
	restoredAPI(t, repo, repo) // converts old-old
	if _, err := d.ExecContext(context.Background(), `UPDATE mcp_remote SET token = ? WHERE account_id = ?`, "new-new", "acc-rb"); err != nil {
		t.Fatal(err)
	}
	api := restoredAPI(t, repo, repo)
	if got := mcpAuthStatus(api, "acc-rb", "new-new"); got == http.StatusNotFound {
		t.Fatal("token re-enabled by an older binary rejected")
	}
	if got := mcpAuthStatus(api, "acc-rb", "old-old"); got != http.StatusNotFound {
		t.Fatal("stale sealed token still authenticates")
	}
	assertTokenSealed(t, repo, "acc-rb", "new-new")
}

// TestMCPRemoteToken_ConversionScrubsDBFiles is the file-backed guard: after
// the startup conversion, neither cloud.db nor cloud.db-wal still holds the
// legacy plaintext token or pairing key, even when the legacy row had already
// been checkpointed into the main file. In-memory DBs can't see this.
func TestMCPRemoteToken_ConversionScrubsDBFiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cloud.db")
	d, err := storedb.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	repo, err := cloudstore.New(d)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	const token = "q7z-k9w"
	pairingKey := []byte("PAIRINGKEY-plaintext-32-bytes-xx")
	if _, err := d.ExecContext(ctx,
		`INSERT INTO mcp_remote (account_id, token, relay_url, pairing_id, pairing_key, created_at_unix) VALUES (?,?,?,?,?,?)`,
		"acc-file", token, "wss://acc-file.localhost", "pid-file", pairingKey, time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	if err := repo.CheckpointTruncate(ctx); err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(path); !bytes.Contains(raw, []byte(token)) {
		t.Fatal("fixture: legacy token not in cloud.db before conversion")
	}

	api := restoredAPI(t, repo, repo)
	if got := mcpAuthStatus(api, "acc-file", token); got == http.StatusNotFound {
		t.Fatal("converted row: correct token rejected")
	}
	for _, f := range []string{path, path + "-wal"} {
		raw, err := os.ReadFile(f)
		if err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
		if bytes.Contains(raw, []byte(token)) {
			t.Fatalf("%s still contains the clear token after conversion", filepath.Base(f))
		}
		if bytes.Contains(raw, pairingKey) {
			t.Fatalf("%s still contains the clear pairing key after conversion", filepath.Base(f))
		}
	}
}

// TestMCPRemoteToken_EmptyTokenRowNeverStarts: a row with neither a real nor a
// sealed token is skipped, so "/mcp/" can never match an empty token.
func TestMCPRemoteToken_EmptyTokenRowNeverStarts(t *testing.T) {
	repo, d := setupStoreWithDB(t)
	insertLegacyTokenRow(t, d, "acc-empty", "")
	api := restoredAPI(t, repo, repo)
	if got := mcpAuthStatus(api, "acc-empty", ""); got != http.StatusNotFound {
		t.Fatalf("empty-token row accepted an empty token (status %d)", got)
	}
}
