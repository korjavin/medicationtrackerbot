package cloudstore

import (
	"context"
	"sort"
	"testing"
	"time"
)

// discoverAccountKeyedTables returns every table whose schema mentions
// account_id, from the live database — the ground truth the delete must cover.
// 'accounts' matches too (it has created_by_account_id) but is the account row
// itself, deleted separately, so it is excluded here.
func discoverAccountKeyedTables(t *testing.T, r *Repo) []string {
	t.Helper()
	rows, err := r.db.QueryContext(context.Background(),
		`SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%account_id%' AND name != 'accounts' ORDER BY name`)
	if err != nil {
		t.Fatalf("introspect schema: %v", err)
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			t.Fatalf("scan: %v", err)
		}
		names = append(names, n)
	}
	return names
}

// seedAllAccountTables writes one row into every account-keyed table for
// accountID, so a delete that misses a table is caught by a non-zero count.
func seedAllAccountTables(t *testing.T, r *Repo, accountID string) {
	t.Helper()
	ctx := context.Background()
	now := int64(1_700_000_000)
	stmts := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO credentials (id, account_id, public_key, transports, sign_count, backup_eligible, backup_state, created_at_unix) VALUES (?,?,?,?,?,?,?,?)`,
			[]any{[]byte("cred-" + accountID), accountID, []byte("pk"), "internal", 0, 0, 0, now}},
		{`INSERT INTO envelopes (account_id, credential_ref, v, nonce, ct) VALUES (?,?,?,?,?)`,
			[]any{accountID, "recovery", 1, []byte("n"), []byte("c")}},
		{`INSERT INTO recovery_auth (account_id, verifier_hash) VALUES (?,?)`,
			[]any{accountID, []byte("vh")}},
		{`INSERT INTO transfer_slots (id, account_id, enrollment_token_hash, ct, created_at_unix, expires_at_unix) VALUES (?,?,?,?,?,?)`,
			[]any{"slot-" + accountID, accountID, []byte("th"), []byte("c"), now, now + 600}},
		{`INSERT INTO oplog (account_id, seq, record_type_tag, nonce, ct, created_at_unix) VALUES (?,?,?,?,?,?)`,
			[]any{accountID, 1, "note:n1", []byte("n"), []byte("c"), now}},
		{`INSERT INTO snapshots (account_id, snapshot_seq, nonce, ct, created_at_unix) VALUES (?,?,?,?,?)`,
			[]any{accountID, 1, []byte("n"), []byte("c"), now}},
		{`INSERT INTO sync_state (account_id, last_seq) VALUES (?,?)`,
			[]any{accountID, 1}},
		{`INSERT INTO push_subscriptions (account_id, endpoint, p256dh, auth, created_at_unix) VALUES (?,?,?,?,?)`,
			[]any{accountID, "https://push/" + accountID, "p", "a", now}},
		{`INSERT INTO scheduled_pushes (account_id, fire_at_unix, ct) VALUES (?,?,?)`,
			[]any{accountID, now, []byte("c")}},
		{`INSERT INTO mcp_remote (account_id, token, relay_url, pairing_id, pairing_key, created_at_unix) VALUES (?,?,?,?,?,?)`,
			[]any{accountID, "tok", "wss://x", "pid", []byte("pk"), now}},
		{`INSERT INTO tg_bots (account_id, bot_id, bot_username, token_ct, token_nonce, kind, webhook_secret, created_at_unix) VALUES (?,?,?,?,?,?,?,?)`,
			[]any{accountID, 42, "bot", []byte("tc"), []byte("tn"), "byo", "ws", now}},
		{`INSERT INTO tg_pending (suggested_username, account_id, created_at_unix, expires_at_unix) VALUES (?,?,?,?)`,
			[]any{"pending-" + accountID, accountID, now, now + 600}},
		{`INSERT INTO inbox_events (account_id, created_at_unix, ct) VALUES (?,?,?)`,
			[]any{accountID, now, []byte("c")}},
		{`INSERT INTO trial_usage (day, account_id, requests) VALUES (?,?,?)`,
			[]any{"2026-07-10", accountID, 3}},
		{`INSERT INTO feedback_queue (account_id, client_id, kind, app_version, ciphertext, created_at_unix) VALUES (?,?,?,?,?,?)`,
			[]any{accountID, "fb-" + accountID, "bug", "1.0", []byte("c"), now}},
	}
	for _, s := range stmts {
		if _, err := r.db.ExecContext(ctx, s.sql, s.args...); err != nil {
			t.Fatalf("seed (%s): %v", s.sql, err)
		}
	}
}

func countFor(t *testing.T, r *Repo, table, accountID string) int {
	t.Helper()
	var n int
	if err := r.db.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM `+table+` WHERE account_id = ?`, accountID).Scan(&n); err != nil {
		t.Fatalf("count %s: %v", table, err)
	}
	return n
}

// bd med-d5t.8 — the drift guard. accountKeyedTables (the delete's coverage
// list) must equal the set of account-keyed tables in the live schema. Add a
// table with an account_id column and forget to delete from it, and this fails
// — a partial delete is worse than none.
func TestDeleteAccount_CoverageMatchesSchema(t *testing.T) {
	r := setupRepo(t)
	discovered := discoverAccountKeyedTables(t, r)
	covered := append([]string(nil), accountKeyedTables...)
	sort.Strings(covered)

	if len(discovered) != len(covered) {
		t.Fatalf("account-keyed tables in schema = %v, but DeleteAccount covers %v", discovered, covered)
	}
	for i := range discovered {
		if discovered[i] != covered[i] {
			t.Fatalf("coverage drift:\n schema  = %v\n covered = %v", discovered, covered)
		}
	}
}

func TestDeleteAccountByID_LeavesNoRows(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	now := time.Unix(1_700_000_000, 0).UTC()
	if _, err := r.CreateAccount(ctx, "victim", "brave-otter-abc123", []byte("h"), now.Add(time.Hour), now, "", "", ""); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}
	// A bystander that must survive the delete untouched.
	if _, err := r.CreateAccount(ctx, "bystander", "quiet-otter-def456", []byte("h"), now.Add(time.Hour), now, "", "", ""); err != nil {
		t.Fatalf("CreateAccount bystander: %v", err)
	}
	seedAllAccountTables(t, r, "victim")
	seedAllAccountTables(t, r, "bystander")

	if err := r.DeleteAccountByID(ctx, "victim"); err != nil {
		t.Fatalf("DeleteAccountByID: %v", err)
	}

	for _, table := range discoverAccountKeyedTables(t, r) {
		if n := countFor(t, r, table, "victim"); n != 0 {
			t.Errorf("after delete, %s still has %d rows for the deleted account", table, n)
		}
		// The bystander's rows are untouched.
		if n := countFor(t, r, table, "bystander"); n != 1 {
			t.Errorf("delete wiped the bystander's %s (%d rows, want 1)", table, n)
		}
	}
	// The accounts row itself is gone.
	if _, err := r.AccountBySubdomain(ctx, "brave-otter-abc123"); err == nil {
		t.Error("account row survived the delete")
	}
	if _, err := r.AccountBySubdomain(ctx, "quiet-otter-def456"); err != nil {
		t.Errorf("bystander account was deleted: %v", err)
	}
}

// The subdomain-based admin path must delete the same complete set — it was
// itself a partial delete before this change.
func TestDeleteAccount_BySubdomain_LeavesNoRows(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	now := time.Unix(1_700_000_000, 0).UTC()
	if _, err := r.CreateAccount(ctx, "victim", "brave-otter-abc123", []byte("h"), now.Add(time.Hour), now, "", "", ""); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}
	seedAllAccountTables(t, r, "victim")

	if err := r.DeleteAccount(ctx, "brave-otter-abc123"); err != nil {
		t.Fatalf("DeleteAccount: %v", err)
	}

	for _, table := range discoverAccountKeyedTables(t, r) {
		if n := countFor(t, r, table, "victim"); n != 0 {
			t.Errorf("after subdomain delete, %s still has %d rows", table, n)
		}
	}
}
