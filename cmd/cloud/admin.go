package main

import (
	"bufio"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"text/tabwriter"
	"time"

	qrterminal "github.com/mdp/qrterminal/v3"

	"github.com/korjavin/medicationtrackerbot/internal/cloudserver"
	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

// runAdmin dispatches `cloud admin <subcommand> [args...]`. Each invocation
// opens its own DB handle — admin commands are one-shot CLI calls (typically
// `docker exec` into the running container), not part of the server process.
func runAdmin(cfg config, args []string) int {
	if len(args) == 0 {
		printAdminUsage()
		return 1
	}

	sharedDB, err := storedb.Open(cfg.dbPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "open database: %v\n", err)
		return 1
	}
	defer sharedDB.Close()

	store, err := cloudstore.New(sharedDB)
	if err != nil {
		fmt.Fprintf(os.Stderr, "initialize cloudstore: %v\n", err)
		return 1
	}

	ctx := context.Background()
	switch args[0] {
	case "invite":
		return adminInvite(ctx, store, cfg)
	case "list":
		return adminList(ctx, store)
	case "inspect":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "usage: cloud admin inspect <subdomain>")
			return 1
		}
		return adminInspect(ctx, store, args[1])
	case "reset-claim":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "usage: cloud admin reset-claim <subdomain>")
			return 1
		}
		return adminResetClaim(ctx, store, args[1], cfg)
	case "revoke":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "usage: cloud admin revoke <subdomain>")
			return 1
		}
		return adminRevoke(ctx, store, args[1])
	case "delete":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "usage: cloud admin delete <subdomain>")
			return 1
		}
		return adminDelete(ctx, store, args[1])
	default:
		fmt.Fprintf(os.Stderr, "unknown admin subcommand %q\n\n", args[0])
		printAdminUsage()
		return 1
	}
}

func printAdminUsage() {
	fmt.Fprintln(os.Stderr, `usage: cloud admin <subcommand> [args]

subcommands:
  invite                  pre-provision an account and print its claim URL + QR
  list                    list accounts (subdomain, claimed?, devices, ops, last-activity)
  inspect <subdomain>     show full read-only debug view of one account
  reset-claim <subdomain> issue a fresh claim token for an unclaimed account
  revoke <subdomain>      delete an unclaimed account (withdraw an unused invite)
  delete <subdomain>      delete an account and all its data (asks for confirmation)`)
}

func adminInvite(ctx context.Context, store *cloudstore.Repo, cfg config) int {
	inv, err := cloudserver.Provision(ctx, store, cfg.claimTTL, time.Now().UTC(), "")
	if err != nil {
		fmt.Fprintf(os.Stderr, "invite failed: %v\n", err)
		return 1
	}

	url := inv.ClaimURL(cfg.baseDomain)
	fmt.Printf("subdomain: %s\n", inv.Account.Subdomain)
	if inv.Account.ClaimExpiresAt != nil {
		fmt.Printf("expires:   %s\n", inv.Account.ClaimExpiresAt.Format(time.RFC3339))
	}
	fmt.Printf("claim URL: %s\n\n", url)
	qrterminal.GenerateHalfBlock(url, qrterminal.L, os.Stdout)
	return 0
}

func adminList(ctx context.Context, store *cloudstore.Repo) int {
	summaries, err := store.AccountSummaries(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "list failed: %v\n", err)
		return 1
	}
	if len(summaries) == 0 {
		fmt.Println("no accounts")
		return 0
	}

	w := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
	fmt.Fprintln(w, "subdomain\tclaimed\tcreated\tdevices\tops\tlast-activity")
	for _, s := range summaries {
		claimed := "no"
		if s.Claimed {
			claimed = "yes"
		}
		lastActivity := "-"
		if s.LastSyncAt != nil {
			lastActivity = s.LastSyncAt.Format(time.RFC3339)
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%d\t%d\t%s\n",
			s.Account.Subdomain, claimed, s.Account.CreatedAt.Format(time.RFC3339),
			s.DeviceCount, s.OpCount, lastActivity)
	}
	w.Flush()
	return 0
}

// adminInspect prints the full read-only debug view of one account: devices,
// envelopes, sync state, and push queue. Never prints secrets (claim tokens,
// nonces, MACs, ciphertext) — sizes and counts only.
func adminInspect(ctx context.Context, store *cloudstore.Repo, subdomain string) int {
	acc, err := store.AccountBySubdomain(ctx, subdomain)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			fmt.Fprintf(os.Stderr, "no such subdomain: %s\n", subdomain)
			return 1
		}
		fmt.Fprintf(os.Stderr, "inspect failed: %v\n", err)
		return 1
	}

	inspection, err := store.InspectAccount(ctx, acc.ID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "inspect failed: %v\n", err)
		return 1
	}

	fmt.Printf("account: %s\n", acc.Subdomain)
	fmt.Printf("  created: %s\n", acc.CreatedAt.Format(time.RFC3339))
	fmt.Printf("  claimed: %v\n\n", acc.ClaimTokenHash == nil)

	fmt.Println("devices:")
	if len(inspection.Devices) == 0 {
		fmt.Println("  none")
	} else {
		w := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
		fmt.Fprintln(w, "  ref\ttransports\tsynced\tsign_count\tcreated\tlast_unlock")
		for _, c := range inspection.Devices {
			lastUnlock := "never"
			if c.LastAssertedAt != nil {
				lastUnlock = c.LastAssertedAt.Format(time.RFC3339)
			}
			fmt.Fprintf(w, "  %s\t%s\t%v\t%d\t%s\t%s\n",
				cloudstore.CredentialRefPrefix(c.ID), c.Transports, c.BackupEligible, c.SignCount,
				c.CreatedAt.Format(time.RFC3339), lastUnlock)
		}
		w.Flush()
	}

	fmt.Println("\nenvelopes:")
	if len(inspection.Envelopes) == 0 {
		fmt.Println("  none")
	} else {
		w := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
		fmt.Fprintln(w, "  ref\tv\tsize")
		for _, e := range inspection.Envelopes {
			fmt.Fprintf(w, "  %s\t%d\t%s\n", envelopeRefPrefix(e.CredentialRef), e.V, humanBytes(e.CTBytes))
		}
		w.Flush()
	}

	fmt.Println("\nsync:")
	fmt.Printf("  ops: %d\n", inspection.Sync.OpCount)
	if inspection.Sync.OpCount > 0 {
		fmt.Printf("  seq range: %d..%d\n", inspection.Sync.MinSeq, inspection.Sync.MaxSeq)
		fmt.Printf("  last append: %s (device %s)\n",
			inspection.Sync.LastAppendAt.Format(time.RFC3339), inspection.Sync.LastDeviceCredRef)
		fmt.Println("  record types:")
		for typ, count := range inspection.RecordTypeCount {
			fmt.Printf("    %s: %d\n", typ, count)
		}
	}
	if inspection.Snapshot.Exists {
		fmt.Printf("  snapshot: seq %d, %s, written %s\n",
			inspection.Snapshot.Seq, humanBytes(inspection.Snapshot.CTBytes),
			inspection.Snapshot.CreatedAt.Format(time.RFC3339))
	} else {
		fmt.Println("  snapshot: none")
	}

	fmt.Println("\npush:")
	if inspection.Push.ActiveSubscriptions == 0 && inspection.Push.DisabledSubscriptions == 0 {
		fmt.Println("  no subscriptions")
	} else {
		fmt.Printf("  subscriptions: %d active, %d disabled\n",
			inspection.Push.ActiveSubscriptions, inspection.Push.DisabledSubscriptions)
	}
	fmt.Printf("  pending scheduled: %d\n", inspection.Push.PendingScheduled)
	if inspection.Push.NextFireAt != nil {
		fmt.Printf("  next fire: %s\n", inspection.Push.NextFireAt.Format(time.RFC3339))
	}
	if inspection.Push.LastSentAt != nil {
		fmt.Printf("  last sent: %s\n", inspection.Push.LastSentAt.Format(time.RFC3339))
	}

	return 0
}

// envelopeRefPrefix mirrors cloudstore.CredentialRefPrefix for the
// already-encoded string form stored in envelopes.credential_ref, so a device
// row and its envelope row print the same 8-char prefix.
func envelopeRefPrefix(ref string) string {
	const n = 8
	if ref == "recovery" || len(ref) <= n {
		return ref
	}
	return ref[:n]
}

// humanBytes renders a byte count in the largest unit that keeps it >= 1.
func humanBytes(n int) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%dB", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f%ciB", float64(n)/float64(div), "KMGTPE"[exp])
}

func adminResetClaim(ctx context.Context, store *cloudstore.Repo, subdomain string, cfg config) int {
	token, tokenHash, err := cloudserver.NewClaimToken()
	if err != nil {
		fmt.Fprintf(os.Stderr, "generate claim token: %v\n", err)
		return 1
	}
	expiresAt := time.Now().UTC().Add(cfg.claimTTL)
	if err := store.ResetClaim(ctx, subdomain, tokenHash, expiresAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			fmt.Fprintf(os.Stderr, "no such subdomain: %s\n", subdomain)
			return 1
		}
		if errors.Is(err, cloudstore.ErrAlreadyClaimed) {
			fmt.Fprintf(os.Stderr, "%s is already claimed — reset-claim only reopens unclaimed invites; use delete to remove it\n", subdomain)
			return 1
		}
		fmt.Fprintf(os.Stderr, "reset-claim failed: %v\n", err)
		return 1
	}
	url := fmt.Sprintf("https://%s.%s/#claim=%s", subdomain, cfg.baseDomain, token)
	fmt.Printf("claim URL: %s\n\n", url)
	qrterminal.GenerateHalfBlock(url, qrterminal.L, os.Stdout)
	return 0
}

func adminRevoke(ctx context.Context, store *cloudstore.Repo, subdomain string) int {
	acc, err := store.AccountBySubdomain(ctx, subdomain)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			fmt.Fprintf(os.Stderr, "no such subdomain: %s\n", subdomain)
			return 1
		}
		fmt.Fprintf(os.Stderr, "revoke failed: %v\n", err)
		return 1
	}
	if acc.ClaimTokenHash == nil {
		fmt.Fprintf(os.Stderr, "%s is already claimed — use 'delete' to remove a claimed account\n", subdomain)
		return 1
	}
	if err := store.DeleteAccount(ctx, subdomain); err != nil {
		fmt.Fprintf(os.Stderr, "revoke failed: %v\n", err)
		return 1
	}
	fmt.Printf("revoked unclaimed invite for %s\n", subdomain)
	return 0
}

func adminDelete(ctx context.Context, store *cloudstore.Repo, subdomain string) int {
	if _, err := store.AccountBySubdomain(ctx, subdomain); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			fmt.Fprintf(os.Stderr, "no such subdomain: %s\n", subdomain)
			return 1
		}
		fmt.Fprintf(os.Stderr, "delete failed: %v\n", err)
		return 1
	}

	fmt.Printf("This permanently deletes account %q and all its data. Type the subdomain to confirm: ", subdomain)
	reader := bufio.NewReader(os.Stdin)
	confirmation, _ := reader.ReadString('\n')
	confirmation = trimNewline(confirmation)
	if confirmation != subdomain {
		fmt.Fprintln(os.Stderr, "confirmation did not match, aborted")
		return 1
	}

	if err := store.DeleteAccount(ctx, subdomain); err != nil {
		fmt.Fprintf(os.Stderr, "delete failed: %v\n", err)
		return 1
	}
	fmt.Printf("deleted %s\n", subdomain)
	return 0
}

func trimNewline(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r') {
		s = s[:len(s)-1]
	}
	return s
}
