package cloudserver

import (
	"bytes"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"
)

var updateVector = flag.Bool("update-inbox-vector", false, "rewrite the cross-language sealed-inbox test vector")

const vectorPath = "testdata/inbox_sealed_vector.json"

// sealedVector pins the mt/v1/inbox wire format so the Go sealer and the
// WebCrypto opener in web/cloud/js/crypto.js cannot drift apart. The JS side
// reads this same file (web/cloud/js/tests/crypto.inbox.test.js) and must
// decrypt `Sealed` to `Plaintext` using `RecipientPrivate`.
type sealedVector struct {
	Note             string `json:"note"`
	AccountID        string `json:"account_id"`
	RecipientPrivate string `json:"recipient_private_b64"`
	RecipientPublic  string `json:"recipient_public_b64"`
	Plaintext        string `json:"plaintext"`
	Sealed           string `json:"sealed_b64"`
}

// countingReader yields a fixed byte pattern so sealInbox picks a deterministic
// ephemeral key + nonce and the vector is reproducible.
type countingReader struct{ n byte }

func (r *countingReader) Read(p []byte) (int, error) {
	for i := range p {
		r.n++
		p[i] = r.n
	}
	return len(p), nil
}

func fixedRecipient(t *testing.T) (*ecdh.PrivateKey, []byte) {
	t.Helper()
	// A fixed, obviously-test scalar. X25519 clamps, so any 32 bytes work.
	raw := make([]byte, 32)
	for i := range raw {
		raw[i] = byte(i + 1)
	}
	priv, err := ecdh.X25519().NewPrivateKey(raw)
	if err != nil {
		t.Fatalf("NewPrivateKey: %v", err)
	}
	return priv, raw
}

// TestSealInbox_RoundTrip is the core property: the server can seal to a public
// key it holds, and only the private-key holder can open it.
func TestSealInbox_RoundTrip(t *testing.T) {
	priv, privRaw := fixedRecipient(t)
	plaintext := []byte(`{"kind":"intake_action","intake_id":"intake-7-1767225600","action":"confirm","at_unix":1767225600}`)

	sealed, err := sealInbox(rand.Reader, priv.PublicKey().Bytes(), "acct-1", plaintext)
	if err != nil {
		t.Fatalf("sealInbox: %v", err)
	}
	if bytes.Contains(sealed, plaintext) {
		t.Fatal("sealed payload contains its own plaintext")
	}

	got, err := openInbox(privRaw, "acct-1", sealed)
	if err != nil {
		t.Fatalf("openInbox: %v", err)
	}
	if !bytes.Equal(got, plaintext) {
		t.Fatalf("round-trip mismatch: %q", got)
	}
}

// The AAD binds the ciphertext to its account, so a mailbox row moved between
// accounts must fail to open rather than decrypt into the wrong vault.
func TestSealInbox_AccountBinding(t *testing.T) {
	priv, privRaw := fixedRecipient(t)
	sealed, err := sealInbox(rand.Reader, priv.PublicKey().Bytes(), "acct-1", []byte("hi"))
	if err != nil {
		t.Fatalf("sealInbox: %v", err)
	}
	if _, err := openInbox(privRaw, "acct-2", sealed); err == nil {
		t.Fatal("a payload sealed for acct-1 opened under acct-2")
	}
}

// A different recipient must not be able to open it, and a tampered byte must
// fail the GCM tag rather than yield garbage.
func TestSealInbox_WrongKeyAndTamper(t *testing.T) {
	priv, _ := fixedRecipient(t)
	other, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	sealed, err := sealInbox(rand.Reader, priv.PublicKey().Bytes(), "acct-1", []byte("secret"))
	if err != nil {
		t.Fatalf("sealInbox: %v", err)
	}

	if _, err := openInbox(other.Bytes(), "acct-1", sealed); err == nil {
		t.Fatal("a foreign private key opened the payload")
	}

	tampered := bytes.Clone(sealed)
	tampered[len(tampered)-1] ^= 0x01
	privRaw := make([]byte, 32)
	for i := range privRaw {
		privRaw[i] = byte(i + 1)
	}
	if _, err := openInbox(privRaw, "acct-1", tampered); err == nil {
		t.Fatal("a tampered payload opened")
	}
}

func TestSealInbox_RejectsBadPublicKey(t *testing.T) {
	for _, bad := range [][]byte{nil, make([]byte, 31), make([]byte, 33)} {
		if _, err := sealInbox(rand.Reader, bad, "acct-1", []byte("x")); err == nil {
			t.Fatalf("sealInbox accepted a %d-byte public key", len(bad))
		}
		if validInboxPublicKey(bad) {
			t.Fatalf("validInboxPublicKey accepted a %d-byte key", len(bad))
		}
	}
	priv, _ := fixedRecipient(t)
	if !validInboxPublicKey(priv.PublicKey().Bytes()) {
		t.Fatal("validInboxPublicKey rejected a real X25519 public key")
	}
}

// TestSealInbox_CrossLanguageVector regenerates the sealed vector from fixed
// randomness and asserts it still matches the committed file. If this fails,
// the wire format moved and web/cloud/js/crypto.js can no longer open what this
// server seals. Rerun with -update-inbox-vector only when that is intended.
func TestSealInbox_CrossLanguageVector(t *testing.T) {
	priv, privRaw := fixedRecipient(t)
	plaintext := `{"kind":"intake_action","intake_id":"intake-7-1767225600","action":"confirm","at_unix":1767225600}`

	sealed, err := sealInbox(&countingReader{}, priv.PublicKey().Bytes(), "acct-vector", []byte(plaintext))
	if err != nil {
		t.Fatalf("sealInbox: %v", err)
	}

	got := sealedVector{
		Note:             "mt/v1/inbox sealed box. Go seals (internal/cloudserver/sealedbox.go), the browser opens (web/cloud/js/crypto.js openInboxEvent). Regenerate with: go test ./internal/cloudserver -run CrossLanguageVector -update-inbox-vector",
		AccountID:        "acct-vector",
		RecipientPrivate: base64.StdEncoding.EncodeToString(privRaw),
		RecipientPublic:  base64.StdEncoding.EncodeToString(priv.PublicKey().Bytes()),
		Plaintext:        plaintext,
		Sealed:           base64.StdEncoding.EncodeToString(sealed),
	}

	if *updateVector {
		if err := os.MkdirAll(filepath.Dir(vectorPath), 0o755); err != nil {
			t.Fatalf("mkdir testdata: %v", err)
		}
		blob, _ := json.MarshalIndent(got, "", "  ")
		if err := os.WriteFile(vectorPath, append(blob, '\n'), 0o644); err != nil {
			t.Fatalf("write vector: %v", err)
		}
		t.Log("wrote", vectorPath)
		return
	}

	raw, err := os.ReadFile(vectorPath)
	if err != nil {
		t.Fatalf("read vector (regenerate with -update-inbox-vector): %v", err)
	}
	var want sealedVector
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatalf("unmarshal vector: %v", err)
	}
	if got.Sealed != want.Sealed {
		t.Fatalf("sealed vector drifted — the browser can no longer open what the server seals.\n got: %s\nwant: %s", got.Sealed, want.Sealed)
	}

	// And the committed vector must still open, proving it isn't merely stable.
	privBytes, _ := base64.StdEncoding.DecodeString(want.RecipientPrivate)
	sealedBytes, _ := base64.StdEncoding.DecodeString(want.Sealed)
	opened, err := openInbox(privBytes, want.AccountID, sealedBytes)
	if err != nil {
		t.Fatalf("committed vector does not open: %v", err)
	}
	if string(opened) != want.Plaintext {
		t.Fatalf("committed vector opened to %q", opened)
	}
}
