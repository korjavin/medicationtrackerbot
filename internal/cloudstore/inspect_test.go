package cloudstore

import (
	"context"
	"testing"
	"time"
)

func TestInspectAccountAndSummaries(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	now := time.Now().UTC()

	// Account 1: claimed, two devices, ops from both, a snapshot, and a
	// mixed push queue.
	acc1Token := []byte("tokenhash-1-32-bytes-of-junk!!!")
	acc1, err := r.CreateAccount(ctx, "acc-1", "busy-otter-abc123", acc1Token, now.Add(time.Hour), now, "", "", "")
	if err != nil {
		t.Fatalf("CreateAccount acc1: %v", err)
	}
	// Clear the claim token so acc-1 is genuinely claimed (claim_token_hash NULL),
	// matching the authoritative claim definition AccountSummaries reports.
	if _, err := r.ConsumeClaimToken(ctx, "busy-otter-abc123", acc1Token, now); err != nil {
		t.Fatalf("ConsumeClaimToken acc1: %v", err)
	}
	cred1 := []byte("credential-one-bytes")
	cred2 := []byte("credential-two-bytes")
	if err := r.AddCredential(ctx, Credential{ID: cred1, AccountID: acc1.ID, PublicKey: []byte("pk1"), CreatedAt: now}); err != nil {
		t.Fatalf("AddCredential cred1: %v", err)
	}
	if err := r.AddCredential(ctx, Credential{ID: cred2, AccountID: acc1.ID, PublicKey: []byte("pk2"), CreatedAt: now}); err != nil {
		t.Fatalf("AddCredential cred2: %v", err)
	}
	if err := r.PutEnvelope(ctx, Envelope{AccountID: acc1.ID, CredentialRef: CredentialRefPrefix(cred1), V: 1, Nonce: []byte("n1"), CT: []byte("ciphertext-one")}); err != nil {
		t.Fatalf("PutEnvelope: %v", err)
	}

	if _, err := r.AppendOps(ctx, acc1.ID, []OpInput{
		{DeviceCredentialID: cred1, RecordTypeTag: "bp:1", Nonce: []byte("n"), CT: []byte("ct1")},
		{DeviceCredentialID: cred1, RecordTypeTag: "bp:2", Nonce: []byte("n"), CT: []byte("ct2")},
		{DeviceCredentialID: cred2, RecordTypeTag: "weight:1", Nonce: []byte("n"), CT: []byte("ct3")},
	}, 0, now); err != nil {
		t.Fatalf("AppendOps: %v", err)
	}

	// PutSnapshot compacts (deletes) every oplog row with seq <= snapshotSeq,
	// so snapshotting at seq 1 here folds only the first "bp:1" op, leaving
	// "bp:2" and "weight:1" live in the oplog — exercising both the snapshot
	// section and a post-compaction oplog view in the same fixture.
	if err := r.PutSnapshot(ctx, acc1.ID, 1, []byte("nonce"), []byte("snapshot-ciphertext"), now); err != nil {
		t.Fatalf("PutSnapshot: %v", err)
	}

	if err := r.UpsertPushSubscription(ctx, acc1.ID, "https://push.example/ep1", "p256dh", "auth", now); err != nil {
		t.Fatalf("UpsertPushSubscription: %v", err)
	}
	if err := r.UpsertPushSubscription(ctx, acc1.ID, "https://push.example/ep2", "p256dh", "auth", now); err != nil {
		t.Fatalf("UpsertPushSubscription ep2: %v", err)
	}
	if err := r.Disable(ctx, "https://push.example/ep2"); err != nil {
		t.Fatalf("Disable: %v", err)
	}
	if err := r.ReplaceSchedule(ctx, acc1.ID, []ScheduledPushInput{{FireAt: now.Add(time.Hour), CT: []byte("sched-ct")}}, now); err != nil {
		t.Fatalf("ReplaceSchedule: %v", err)
	}

	// Account 2: empty/unclaimed.
	if _, err := r.CreateAccount(ctx, "acc-2", "quiet-otter-def456", []byte("tokenhash-2-32-bytes-of-junk!!!"), now.Add(time.Hour), now, "", "", ""); err != nil {
		t.Fatalf("CreateAccount acc2: %v", err)
	}

	// InspectAccount must be strictly read-only: reusing the mutating
	// GetSnapshot here would stamp sync_state.last_sync_unix and clobber the
	// staleness signal this tool exists to surface. Pin the contract.
	var beforeSync int64
	if err := r.db.QueryRowContext(ctx, `SELECT last_sync_unix FROM sync_state WHERE account_id = ?`, acc1.ID).Scan(&beforeSync); err != nil {
		t.Fatalf("read last_sync_unix before inspect: %v", err)
	}

	insp, err := r.InspectAccount(ctx, acc1.ID)
	if err != nil {
		t.Fatalf("InspectAccount acc1: %v", err)
	}

	var afterSync int64
	if err := r.db.QueryRowContext(ctx, `SELECT last_sync_unix FROM sync_state WHERE account_id = ?`, acc1.ID).Scan(&afterSync); err != nil {
		t.Fatalf("read last_sync_unix after inspect: %v", err)
	}
	if afterSync != beforeSync {
		t.Fatalf("InspectAccount mutated sync_state.last_sync_unix: before=%d after=%d", beforeSync, afterSync)
	}
	if len(insp.Devices) != 2 {
		t.Fatalf("expected 2 devices, got %d", len(insp.Devices))
	}
	if len(insp.Envelopes) != 1 || insp.Envelopes[0].CTBytes != len("ciphertext-one") {
		t.Fatalf("unexpected envelopes: %+v", insp.Envelopes)
	}
	if insp.Sync.OpCount != 2 || insp.Sync.MinSeq != 2 || insp.Sync.MaxSeq != 3 {
		t.Fatalf("unexpected sync stats (expected seq 1 compacted away): %+v", insp.Sync)
	}
	if insp.Sync.LastAppendAt == nil {
		t.Fatalf("expected LastAppendAt to be set")
	}
	if insp.Sync.LastDeviceCredRef != CredentialRefPrefix(cred2) {
		t.Fatalf("expected last device cred ref %q, got %q", CredentialRefPrefix(cred2), insp.Sync.LastDeviceCredRef)
	}
	if insp.RecordTypeCount["bp"] != 1 || insp.RecordTypeCount["weight"] != 1 {
		t.Fatalf("unexpected record type histogram: %+v", insp.RecordTypeCount)
	}
	if !insp.Snapshot.Exists || insp.Snapshot.Seq != 1 || insp.Snapshot.CTBytes != len("snapshot-ciphertext") {
		t.Fatalf("unexpected snapshot state: %+v", insp.Snapshot)
	}
	if insp.Push.ActiveSubscriptions != 1 || insp.Push.DisabledSubscriptions != 1 {
		t.Fatalf("unexpected push subscription counts: %+v", insp.Push)
	}
	if insp.Push.PendingScheduled != 1 || insp.Push.NextFireAt == nil {
		t.Fatalf("unexpected push schedule state: %+v", insp.Push)
	}
	if insp.Push.LastSentAt != nil {
		t.Fatalf("expected LastSentAt nil (nothing sent yet), got %v", insp.Push.LastSentAt)
	}

	insp2, err := r.InspectAccount(ctx, "acc-2")
	if err != nil {
		t.Fatalf("InspectAccount acc2: %v", err)
	}
	if len(insp2.Devices) != 0 || len(insp2.Envelopes) != 0 {
		t.Fatalf("expected empty account to have no devices/envelopes, got %+v", insp2)
	}
	if insp2.Sync.OpCount != 0 || insp2.Sync.LastAppendAt != nil {
		t.Fatalf("expected empty account to have zero sync stats, got %+v", insp2.Sync)
	}
	if insp2.Snapshot.Exists {
		t.Fatalf("expected empty account to have no snapshot, got %+v", insp2.Snapshot)
	}
	if insp2.Push.ActiveSubscriptions != 0 || insp2.Push.PendingScheduled != 0 {
		t.Fatalf("expected empty account to have no push state, got %+v", insp2.Push)
	}

	summaries, err := r.AccountSummaries(ctx)
	if err != nil {
		t.Fatalf("AccountSummaries: %v", err)
	}
	if len(summaries) != 2 {
		t.Fatalf("expected 2 account summaries, got %d", len(summaries))
	}
	byID := map[string]AccountSummary{}
	for _, s := range summaries {
		byID[s.Account.ID] = s
	}
	if s := byID["acc-1"]; !s.Claimed || s.DeviceCount != 2 || s.OpCount != 2 || s.LastSyncAt == nil {
		t.Fatalf("unexpected acc-1 summary: %+v", s)
	}
	if s := byID["acc-2"]; s.Claimed || s.DeviceCount != 0 || s.OpCount != 0 {
		t.Fatalf("unexpected acc-2 summary: %+v", s)
	}
}
