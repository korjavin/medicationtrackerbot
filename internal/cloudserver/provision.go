package cloudserver

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

// subdomainWords are small, PII-free wordlists used to build a human-typeable
// subdomain label (<adjective>-<animal>-<6 base32 chars>). Deliberately not
// exhaustive — the trailing random suffix carries the entropy, the words are
// just for memorability.
var (
	subdomainAdjectives = []string{
		"brave", "calm", "eager", "fuzzy", "gentle", "happy", "jolly", "keen",
		"lively", "misty", "nimble", "quiet", "rapid", "sunny", "tidy", "vivid",
		"witty", "zesty", "amber", "bold", "crisp", "dusty", "fleet", "golden",
	}
	subdomainAnimals = []string{
		"otter", "falcon", "badger", "heron", "lynx", "marten", "puffin", "raven",
		"salmon", "tapir", "urchin", "vole", "walrus", "yak", "zebra", "gecko",
		"ibis", "jackal", "koala", "mantis", "newt", "opossum", "panda", "quail",
	}
)

// ErrAccountsExhausted is returned by Provision when it cannot find a free
// subdomain after several random attempts (practically unreachable given the
// wordlist size × random suffix space; a sign the wordlists need widening
// long before this fires).
var ErrAccountsExhausted = fmt.Errorf("cloudserver: could not allocate a free subdomain")

// provisionStore is the subset of *cloudstore.Repo Provision needs.
type provisionStore interface {
	CreateAccount(ctx context.Context, id, subdomain string, claimTokenHash []byte, claimExpiresAt, createdAt time.Time, vapidPublicKey, vapidPrivateKey string) (*cloudstore.Account, error)
	SweepExpiredClaims(ctx context.Context, now time.Time) (int, error)
}

// Invite is the result of provisioning a new unclaimed account: the claim
// token in cleartext, which exists only in memory / on the operator's
// terminal — the store only ever holds its hash.
type Invite struct {
	Account *cloudstore.Account
	Token   string
}

// ClaimURL returns the personal claim link for this invite. The token
// travels in the URL fragment so it never hits server access logs.
func (inv Invite) ClaimURL(baseDomain string) string {
	return fmt.Sprintf("https://%s.%s/#claim=%s", inv.Account.Subdomain, baseDomain, inv.Token)
}

const maxSubdomainAttempts = 10

// Provision pre-provisions a new unclaimed account: random account_id,
// human-memorable subdomain, and a one-time claim token valid for ttl. It
// opportunistically sweeps expired unclaimed invites first so stale
// subdomains free up without a background job.
func Provision(ctx context.Context, store provisionStore, ttl time.Duration, now time.Time) (*Invite, error) {
	if _, err := store.SweepExpiredClaims(ctx, now); err != nil {
		return nil, fmt.Errorf("sweep expired claims: %w", err)
	}

	token, tokenHash, err := NewClaimToken()
	if err != nil {
		return nil, err
	}

	for attempt := 0; attempt < maxSubdomainAttempts; attempt++ {
		accountID, err := randomToken(16)
		if err != nil {
			return nil, err
		}
		sub, err := randomSubdomain()
		if err != nil {
			return nil, err
		}
		acc, err := store.CreateAccount(ctx, accountID, sub, tokenHash, now.Add(ttl), now, "", "")
		if err == nil {
			return &Invite{Account: acc, Token: token}, nil
		}
		if !isUniqueViolation(err) {
			return nil, err
		}
	}
	return nil, ErrAccountsExhausted
}

// NewClaimToken returns a random 32-byte claim token (hex-encoded, for the
// URL fragment) and its SHA-256 hash (what gets stored) — used both by
// Provision and by the admin `reset-claim` command.
func NewClaimToken() (token string, hash []byte, err error) {
	raw, err := randomBytes(32)
	if err != nil {
		return "", nil, err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(raw), sum[:], nil
}

// randomToken returns n random bytes, base32-encoded (lowercase, unpadded).
func randomToken(n int) (string, error) {
	b, err := randomBytes(n)
	if err != nil {
		return "", err
	}
	return strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b)), nil
}

func randomBytes(n int) ([]byte, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return nil, fmt.Errorf("read random bytes: %w", err)
	}
	return b, nil
}

func randomSubdomain() (string, error) {
	adjIdx, err := randomIndex(len(subdomainAdjectives))
	if err != nil {
		return "", err
	}
	animalIdx, err := randomIndex(len(subdomainAnimals))
	if err != nil {
		return "", err
	}
	suffix, err := randomToken(5) // 5 bytes base32-encode cleanly to 8 chars; keep 6
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%s-%s-%s", subdomainAdjectives[adjIdx], subdomainAnimals[animalIdx], suffix[:6]), nil
}

func randomIndex(n int) (int, error) {
	b, err := randomBytes(1)
	if err != nil {
		return 0, err
	}
	return int(b[0]) % n, nil
}

// isUniqueViolation reports whether err is a SQLite UNIQUE constraint
// failure. The message text is emitted directly by the SQLite C library, so
// it's stable across drivers -- ponytail: string match, revisit only if the
// driver ever wraps errors differently.
func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}
