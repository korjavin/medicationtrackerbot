package main

import (
	"bufio"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
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
  list                    list accounts (subdomain, claimed?, created, last-asserted)
  reset-claim <subdomain> issue a fresh claim token for an unclaimed account
  revoke <subdomain>      delete an unclaimed account (withdraw an unused invite)
  delete <subdomain>      delete an account and all its data (asks for confirmation)`)
}

func adminInvite(ctx context.Context, store *cloudstore.Repo, cfg config) int {
	inv, err := cloudserver.Provision(ctx, store, cfg.claimTTL, time.Now().UTC())
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
	accounts, err := store.ListAccounts(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "list failed: %v\n", err)
		return 1
	}
	if len(accounts) == 0 {
		fmt.Println("no accounts")
		return 0
	}

	fmt.Printf("%-32s %-8s %-25s %-25s\n", "subdomain", "claimed", "created", "last-asserted")
	for _, a := range accounts {
		claimed := "yes"
		if a.ClaimTokenHash != nil {
			claimed = "no"
		}

		lastAsserted := "-"
		creds, err := store.CredentialsByAccount(ctx, a.ID)
		if err != nil {
			fmt.Fprintf(os.Stderr, "credentials for %s: %v\n", a.Subdomain, err)
			return 1
		}
		var latest *time.Time
		for _, c := range creds {
			if c.LastAssertedAt != nil && (latest == nil || c.LastAssertedAt.After(*latest)) {
				latest = c.LastAssertedAt
			}
		}
		if latest != nil {
			lastAsserted = latest.Format(time.RFC3339)
		}

		fmt.Printf("%-32s %-8s %-25s %-25s\n", a.Subdomain, claimed, a.CreatedAt.Format(time.RFC3339), lastAsserted)
	}
	return 0
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
