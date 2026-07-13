package cloudserver

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

const mcpTestSecret = "test-session-secret-at-least-32-bytes-long"

// setupStoreWithDB is setupStore but also hands back the raw *storedb.DB, so a
// test can insert a legacy plaintext mcp_remote row (which UpsertMCPRemote no
// longer writes) to exercise the startup reseal path.
func setupStoreWithDB(t *testing.T) (*cloudstore.Repo, *storedb.DB) {
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
	return r, d
}

// TestMCPPairingKeySealRoundtrip guards the at-rest encryption end to end: a
// sealed pairing key opens back to the original, the ciphertext never contains
// the plaintext, and a different SESSION_SECRET cannot open it.
func TestMCPPairingKeySealRoundtrip(t *testing.T) {
	key := bytes.Repeat([]byte{0xAB}, 32)

	ct, nonce, err := sealMCPPairingKey(mcpTestSecret, key)
	if err != nil {
		t.Fatalf("sealMCPPairingKey: %v", err)
	}
	if bytes.Contains(ct, key) {
		t.Fatal("ciphertext contains plaintext pairing key")
	}

	got, err := openMCPPairingKey(mcpTestSecret, ct, nonce)
	if err != nil {
		t.Fatalf("openMCPPairingKey: %v", err)
	}
	if !bytes.Equal(got, key) {
		t.Fatalf("roundtrip mismatch: got %x want %x", got, key)
	}

	if _, err := openMCPPairingKey("a-completely-different-session-secret-x", ct, nonce); err == nil {
		t.Fatal("expected decrypt failure under a different secret")
	}

	// Distinct HKDF domain from tg_bots: the tg-derived key must not open an
	// mcp-sealed blob even under the same SESSION_SECRET.
	tgCT, tgNonce, err := sealTGToken(mcpTestSecret, string(key))
	if err != nil {
		t.Fatalf("sealTGToken: %v", err)
	}
	if _, err := openMCPPairingKey(mcpTestSecret, tgCT, tgNonce); err == nil {
		t.Fatal("mcp open accepted a tg-sealed blob — domain separation broken")
	}
}

// TestMCPRemoteRestoreResealsLegacyPlaintext is the regression guard the bead
// calls out: a pre-migration mcp_remote row with a raw plaintext pairing_key
// must survive a deploy. Restore has to (1) still start the hosted shim from
// that plaintext key, (2) seal it in place and clear the plaintext, and (3) let
// a second boot start the shim from the sealed columns alone.
func TestMCPRemoteRestoreResealsLegacyPlaintext(t *testing.T) {
	repo, d := setupStoreWithDB(t)
	ctx := context.Background()

	pairingKey := bytes.Repeat([]byte{0x07}, 32)
	if _, err := d.ExecContext(ctx,
		`INSERT INTO mcp_remote (account_id, token, relay_url, pairing_id, pairing_key, created_at_unix) VALUES (?,?,?,?,?,?)`,
		"acc-legacy", "tok-legacy", "wss://acc-legacy.localhost", "pid-legacy", pairingKey, time.Now().Unix()); err != nil {
		t.Fatalf("insert legacy plaintext row: %v", err)
	}

	relay := NewMCPRelayAPI(repo, mcpTestSecret)
	api := NewMCPRemoteAPI(repo, relay, mcpTestSecret)
	api.Restore(ctx)

	api.mu.RLock()
	_, ok := api.byAcc["acc-legacy"]
	api.mu.RUnlock()
	if !ok {
		t.Fatal("legacy row was not restored into the registry — a paired remote would break on deploy")
	}

	row := mcpRemoteRow(t, repo, "acc-legacy")
	if len(row.PairingKey) != 0 {
		t.Fatalf("legacy plaintext pairing_key not cleared after reseal: %x", row.PairingKey)
	}
	if len(row.PairingKeyCT) == 0 || len(row.PairingKeyNonce) == 0 {
		t.Fatal("pairing key not sealed after restore")
	}
	sealed, err := openMCPPairingKey(mcpTestSecret, row.PairingKeyCT, row.PairingKeyNonce)
	if err != nil || !bytes.Equal(sealed, pairingKey) {
		t.Fatalf("sealed pairing key does not open to the original: err=%v got=%x", err, sealed)
	}

	// Second boot: a fresh API against the resealed row must start from the
	// sealed columns (no plaintext left to fall back on).
	relay2 := NewMCPRelayAPI(repo, mcpTestSecret)
	api2 := NewMCPRemoteAPI(repo, relay2, mcpTestSecret)
	api2.Restore(ctx)
	api2.mu.RLock()
	_, ok2 := api2.byAcc["acc-legacy"]
	api2.mu.RUnlock()
	if !ok2 {
		t.Fatal("sealed row was not restored on the second boot")
	}
}

func mcpRemoteRow(t *testing.T, repo *cloudstore.Repo, accountID string) cloudstore.MCPRemote {
	t.Helper()
	rows, err := repo.ListMCPRemote(context.Background())
	if err != nil {
		t.Fatalf("ListMCPRemote: %v", err)
	}
	for _, r := range rows {
		if r.AccountID == accountID {
			return r
		}
	}
	t.Fatalf("no mcp_remote row for %q", accountID)
	return cloudstore.MCPRemote{}
}
