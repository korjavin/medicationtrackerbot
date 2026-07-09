package cloudserver

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"

	"golang.org/x/crypto/hkdf"
)

// Sealed-box format `mt/v1/inbox` — anonymous ephemeral-static X25519.
//
// The cloud relay receives inbound Telegram events (a Confirm tap) that it must
// hand to the account without ever reading them. It holds the account's inbox
// PUBLIC key only; the matching private key lives in the vault and never leaves
// an unlocked client. So the server seals to a public key it cannot open —
// write-only, by construction.
//
// Wire layout (single BLOB column, mirroring the push payload's packing):
//
//	ephPub(32) ‖ nonce(12) ‖ AES-256-GCM(K, plaintext, aad)
//
//	K   = HKDF-SHA256(ikm = X25519(ephPriv, inboxPub),
//	                  salt = ephPub ‖ inboxPub,
//	                  info = "mt/v1/inbox")
//	aad = len-prefixed("mt/v1/inbox", accountID)
//
// Salting with both public keys binds the derived key to this exact
// (ephemeral, recipient) pair, so a ciphertext cannot be replayed against a
// different recipient. The AAD binds it to the account, so a mailbox row copied
// between accounts fails to open rather than decrypting into the wrong vault.
//
// Both sides use their platform's native X25519 — crypto/ecdh here, WebCrypto's
// "X25519" in web/cloud/js/crypto.js — so neither language takes a new
// dependency. testdata/inbox_sealed_vector.json pins the format across both.
const (
	inboxSealLabel  = "mt/v1/inbox"
	inboxPubKeyLen  = 32
	inboxNonceLen   = 12
	inboxOverhead   = inboxPubKeyLen + inboxNonceLen
	inboxKeyBytes   = 32
	inboxGCMTagSize = 16
)

// ErrInvalidInboxKey is returned for a public key that is not a valid X25519
// point — e.g. a client uploaded garbage, or a column holds a truncated blob.
var ErrInvalidInboxKey = errors.New("cloudserver: invalid inbox public key")

// encodeFields length-prefixes each part (uint16 big-endian) so the AAD cannot
// be made ambiguous by moving bytes across a boundary. Mirrors encodeFields in
// web/cloud/js/crypto.js.
func encodeFields(parts ...[]byte) []byte {
	total := 0
	for _, p := range parts {
		total += 2 + len(p)
	}
	out := make([]byte, 0, total)
	for _, p := range parts {
		var l [2]byte
		binary.BigEndian.PutUint16(l[:], uint16(len(p)))
		out = append(out, l[:]...)
		out = append(out, p...)
	}
	return out
}

func inboxAAD(accountID string) []byte {
	return encodeFields([]byte(inboxSealLabel), []byte(accountID))
}

// sealInbox seals plaintext to the account's inbox public key. rnd supplies the
// ephemeral key and nonce; production passes crypto/rand.Reader, tests pass a
// deterministic reader to pin the wire format.
func sealInbox(rnd io.Reader, inboxPub []byte, accountID string, plaintext []byte) ([]byte, error) {
	curve := ecdh.X25519()
	recipient, err := curve.NewPublicKey(inboxPub)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidInboxKey, err)
	}
	// Read the ephemeral scalar straight from rnd rather than curve.GenerateKey:
	// GenerateKey deliberately consumes an extra random byte (crypto/internal
	// randutil.MaybeReadByte) to stop callers depending on determinism, which
	// would make the committed cross-language test vector unreproducible.
	// X25519 clamps the scalar, so any 32 bytes are a valid private key.
	ephSeed := make([]byte, inboxPubKeyLen)
	if _, err := io.ReadFull(rnd, ephSeed); err != nil {
		return nil, err
	}
	eph, err := curve.NewPrivateKey(ephSeed)
	if err != nil {
		return nil, err
	}
	shared, err := eph.ECDH(recipient)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidInboxKey, err)
	}

	ephPub := eph.PublicKey().Bytes()
	key, err := inboxDeriveKey(shared, ephPub, inboxPub)
	if err != nil {
		return nil, err
	}
	aead, err := newInboxAEAD(key)
	if err != nil {
		return nil, err
	}

	nonce := make([]byte, inboxNonceLen)
	if _, err := io.ReadFull(rnd, nonce); err != nil {
		return nil, err
	}

	packed := make([]byte, 0, inboxOverhead+len(plaintext)+inboxGCMTagSize)
	packed = append(packed, ephPub...)
	packed = append(packed, nonce...)
	return aead.Seal(packed, nonce, plaintext, inboxAAD(accountID)), nil
}

// openInbox is the inverse. The production server can never call it — it holds
// no inbox private key. It exists so the seal format is testable end to end in
// one language before the JS side is trusted to read it.
func openInbox(inboxPriv []byte, accountID string, packed []byte) ([]byte, error) {
	if len(packed) < inboxOverhead+inboxGCMTagSize {
		return nil, errors.New("cloudserver: sealed inbox payload too short")
	}
	curve := ecdh.X25519()
	priv, err := curve.NewPrivateKey(inboxPriv)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidInboxKey, err)
	}
	ephPub := packed[:inboxPubKeyLen]
	nonce := packed[inboxPubKeyLen:inboxOverhead]
	ct := packed[inboxOverhead:]

	eph, err := curve.NewPublicKey(ephPub)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidInboxKey, err)
	}
	shared, err := priv.ECDH(eph)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidInboxKey, err)
	}
	key, err := inboxDeriveKey(shared, ephPub, priv.PublicKey().Bytes())
	if err != nil {
		return nil, err
	}
	aead, err := newInboxAEAD(key)
	if err != nil {
		return nil, err
	}
	return aead.Open(nil, nonce, ct, inboxAAD(accountID))
}

func inboxDeriveKey(shared, ephPub, recipientPub []byte) ([]byte, error) {
	salt := make([]byte, 0, len(ephPub)+len(recipientPub))
	salt = append(salt, ephPub...)
	salt = append(salt, recipientPub...)
	key := make([]byte, inboxKeyBytes)
	if _, err := io.ReadFull(hkdf.New(sha256.New, shared, salt, []byte(inboxSealLabel)), key); err != nil {
		return nil, err
	}
	return key, nil
}

func newInboxAEAD(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// validInboxPublicKey reports whether b is a well-formed X25519 public key, so
// PUT /api/inbox/key rejects garbage at the edge rather than at seal time —
// where a bad key would silently strand every inbound event for that account.
func validInboxPublicKey(b []byte) bool {
	if len(b) != inboxPubKeyLen {
		return false
	}
	_, err := ecdh.X25519().NewPublicKey(b)
	return err == nil
}
