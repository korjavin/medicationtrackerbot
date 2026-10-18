package appattest

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"math/big"
	"os"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"
)

// The fake mirrors the shape of Apple's attestation object ("Validating apps
// that connect to your server" → "Attestation object"): CBOR
// {fmt:"apple-appattest", attStmt:{x5c:[credCert, intermediate], receipt},
// authData}, with a throwaway root standing in for the Apple App Attestation
// Root CA. Nothing here talks to Apple.

const testAppID = "ABCDE12345.ai.example.app"

type fakeCA struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
	pool *x509.CertPool
}

func newKey(t *testing.T) *ecdsa.PrivateKey {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func issue(t *testing.T, tmpl *x509.Certificate, pub *ecdsa.PublicKey, parent *x509.Certificate, parentKey *ecdsa.PrivateKey) *x509.Certificate {
	t.Helper()
	tmpl.SerialNumber = big.NewInt(time.Now().UnixNano())
	tmpl.NotBefore = time.Now().Add(-time.Hour)
	tmpl.NotAfter = time.Now().Add(24 * time.Hour)
	if parent == nil {
		parent = tmpl
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, parent, pub, parentKey)
	if err != nil {
		t.Fatal(err)
	}
	c, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// newCA builds root → intermediate, like Apple's root → "Apple App
// Attestation CA 1". Returned key/cert are the intermediate's; pool holds the root.
func newCA(t *testing.T) fakeCA {
	rootKey := newKey(t)
	root := issue(t, &x509.Certificate{Subject: pkix.Name{CommonName: "Fake App Attestation Root CA"}, IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}, &rootKey.PublicKey, nil, rootKey)
	interKey := newKey(t)
	inter := issue(t, &x509.Certificate{Subject: pkix.Name{CommonName: "Fake App Attestation CA 1"}, IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}, &interKey.PublicKey, root, rootKey)
	pool := x509.NewCertPool()
	pool.AddCert(root)
	return fakeCA{cert: inter, key: interKey, pool: pool}
}

type attestOpts struct {
	appID     string
	challenge []byte
	counter   uint32
	aaguid    []byte
	credID    []byte // defaults to keyID
	nonce     []byte // overrides the computed nonce in credCert
}

// attest returns the attestation object for device key k, credCert issued by ca.
func attest(t *testing.T, ca fakeCA, k *ecdsa.PrivateKey, o attestOpts) []byte {
	t.Helper()
	keyID := keyIDOf(t, k)
	if o.credID == nil {
		o.credID = keyID
	}
	if o.aaguid == nil {
		o.aaguid = aaguidProduction
	}
	rp := sha256.Sum256([]byte(o.appID))
	ad := append([]byte{}, rp[:]...)
	ad = append(ad, 0x40) // AT flag: attested credential data present
	ad = binary.BigEndian.AppendUint32(ad, o.counter)
	ad = append(ad, o.aaguid...)
	ad = binary.BigEndian.AppendUint16(ad, uint16(len(o.credID)))
	ad = append(ad, o.credID...)
	cose, _ := cbor.Marshal(map[int]any{1: 2, 3: -7, -1: 1, -2: k.X.FillBytes(make([]byte, 32)), -3: k.Y.FillBytes(make([]byte, 32))})
	ad = append(ad, cose...)

	nonce := o.nonce
	if nonce == nil {
		cdh := sha256.Sum256(o.challenge)
		n := sha256.Sum256(append(append([]byte{}, ad...), cdh[:]...))
		nonce = n[:]
	}
	ext, err := asn1.Marshal(struct {
		Nonce []byte `asn1:"tag:1,explicit"`
	}{nonce})
	if err != nil {
		t.Fatal(err)
	}
	leaf := issue(t, &x509.Certificate{Subject: pkix.Name{CommonName: "fake credCert"}, ExtraExtensions: []pkix.Extension{{Id: oidNonce, Value: ext}}}, &k.PublicKey, ca.cert, ca.key)
	obj := map[string]any{"fmt": "apple-appattest", "attStmt": map[string]any{"x5c": [][]byte{leaf.Raw, ca.cert.Raw}, "receipt": []byte("fake-receipt")}, "authData": ad}
	b, err := cbor.Marshal(obj)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func keyIDOf(t *testing.T, k *ecdsa.PrivateKey) []byte {
	p, err := k.PublicKey.ECDH()
	if err != nil {
		t.Fatal(err)
	}
	h := sha256.Sum256(p.Bytes())
	return h[:]
}

// assertion mirrors Apple's assertion object: CBOR {signature, authenticatorData}
// with signature = ECDSA-SHA256(SHA256(authenticatorData || clientDataHash)).
func assertion(t *testing.T, k *ecdsa.PrivateKey, appID string, counter uint32, clientDataHash []byte) []byte {
	t.Helper()
	rp := sha256.Sum256([]byte(appID))
	ad := binary.BigEndian.AppendUint32(append(append([]byte{}, rp[:]...), 0x00), counter)
	nonce := sha256.Sum256(append(append([]byte{}, ad...), clientDataHash...))
	digest := sha256.Sum256(nonce[:])
	sig, err := ecdsa.SignASN1(rand.Reader, k, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	b, _ := cbor.Marshal(map[string]any{"signature": sig, "authenticatorData": ad})
	return b
}

func TestVerifyAttestation(t *testing.T) {
	ca := newCA(t)
	k := newKey(t)
	keyID := base64.StdEncoding.EncodeToString(keyIDOf(t, k))
	challenge := []byte("server-challenge-32-bytes-000000")
	cfg := Config{AppID: testAppID, Roots: ca.pool}
	good := attestOpts{appID: testAppID, challenge: challenge}

	pub, env, err := VerifyAttestation(attest(t, ca, k, good), keyID, challenge, cfg)
	if err != nil || env != EnvProduction || !pub.Equal(&k.PublicKey) {
		t.Fatalf("good path: env=%q err=%v", env, err)
	}

	other := newKey(t)
	cases := []struct {
		name  string // the Apple rule exercised
		blob  []byte
		keyID string
		chal  []byte
		cfg   Config
		want  error
	}{
		{"step 1: chain to an unknown root", attest(t, newCA(t), k, good), keyID, challenge, cfg, ErrChain},
		{"step 1: embedded Apple root rejects a fake chain", attest(t, ca, k, good), keyID, challenge, Config{AppID: testAppID}, ErrChain},
		{"steps 2-4: nonce over a different challenge", attest(t, ca, k, good), keyID, []byte("other challenge"), cfg, ErrNonce},
		{"step 4: credCert nonce extension forged", attest(t, ca, k, attestOpts{appID: testAppID, challenge: challenge, nonce: make([]byte, 32)}), keyID, challenge, cfg, ErrNonce},
		{"step 5: keyId is not SHA256 of the credCert key", attest(t, ca, k, good), base64.StdEncoding.EncodeToString(keyIDOf(t, other)), challenge, cfg, ErrKeyID},
		{"step 6: rpIdHash for another App ID", attest(t, ca, k, attestOpts{appID: "OTHER.ai.example.app", challenge: challenge}), keyID, challenge, cfg, ErrAppID},
		{"step 7: counter != 0", attest(t, ca, k, attestOpts{appID: testAppID, challenge: challenge, counter: 1}), keyID, challenge, cfg, ErrCounter},
		{"step 8: development aaguid when production is required", attest(t, ca, k, attestOpts{appID: testAppID, challenge: challenge, aaguid: aaguidDevelopment}), keyID, challenge, cfg, ErrEnv},
		{"step 8: unknown aaguid", attest(t, ca, k, attestOpts{appID: testAppID, challenge: challenge, aaguid: make([]byte, 16)}), keyID, challenge, cfg, ErrEnv},
		{"step 9: credentialId != keyId", attest(t, ca, k, attestOpts{appID: testAppID, challenge: challenge, credID: keyIDOf(t, other)}), keyID, challenge, cfg, ErrKeyID},
		{"not CBOR", []byte("nope"), keyID, challenge, cfg, ErrMalformed},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, _, err := VerifyAttestation(c.blob, c.keyID, c.chal, c.cfg)
			if !errors.Is(err, c.want) || !errors.Is(err, ErrInvalid) {
				t.Fatalf("err=%v want %v", err, c.want)
			}
		})
	}

	t.Run("step 8: development aaguid accepted when cfg.Env=development", func(t *testing.T) {
		dev := attest(t, ca, k, attestOpts{appID: testAppID, challenge: challenge, aaguid: aaguidDevelopment})
		_, env, err := VerifyAttestation(dev, keyID, challenge, Config{AppID: testAppID, Env: EnvDevelopment, Roots: ca.pool})
		if err != nil || env != EnvDevelopment {
			t.Fatalf("env=%q err=%v", env, err)
		}
	})
}

func TestVerifyAssertion(t *testing.T) {
	k := newKey(t)
	cfg := Config{AppID: testAppID}
	cdh := sha256.Sum256([]byte("challenge||sha256(body)"))

	n, err := VerifyAssertion(assertion(t, k, testAppID, 5, cdh[:]), &k.PublicKey, cdh[:], cfg, 4)
	if err != nil || n != 5 {
		t.Fatalf("good path: n=%d err=%v", n, err)
	}
	otherCDH := sha256.Sum256([]byte("different body"))
	cases := []struct {
		name string // the Apple rule exercised
		blob []byte
		pub  *ecdsa.PublicKey
		cdh  []byte
		prev uint32
		want error
	}{
		{"step 3: signed over a different clientDataHash", assertion(t, k, testAppID, 5, cdh[:]), &k.PublicKey, otherCDH[:], 4, ErrSignature},
		{"step 3: signed by another key", assertion(t, newKey(t), testAppID, 5, cdh[:]), &k.PublicKey, cdh[:], 4, ErrSignature},
		{"step 4: rpIdHash for another App ID", assertion(t, k, "OTHER.ai.example.app", 5, cdh[:]), &k.PublicKey, cdh[:], 4, ErrAppID},
		{"step 5: replay (counter not increasing)", assertion(t, k, testAppID, 5, cdh[:]), &k.PublicKey, cdh[:], 5, ErrCounter},
		{"not CBOR", []byte("nope"), &k.PublicKey, cdh[:], 0, ErrMalformed},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := VerifyAssertion(c.blob, c.pub, c.cdh, cfg, c.prev)
			if !errors.Is(err, c.want) || !errors.Is(err, ErrInvalid) {
				t.Fatalf("err=%v want %v", err, c.want)
			}
		})
	}
}

// TestRealAttestation verifies an owner-captured production attestation (see
// the package doc) against the embedded Apple root. Skipped until one exists.
func TestRealAttestation(t *testing.T) {
	raw, err := os.ReadFile("testdata/real_attestation.json")
	if errors.Is(err, os.ErrNotExist) {
		t.Skip("no testdata/real_attestation.json captured yet")
	}
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		AppID, KeyID, Attestation, Challenge string
		CapturedAt                           time.Time
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	att, _ := base64.StdEncoding.DecodeString(f.Attestation)
	chal, _ := base64.StdEncoding.DecodeString(f.Challenge)
	defer func(orig func() time.Time) { timeNow = orig }(timeNow)
	timeNow = func() time.Time { return f.CapturedAt }
	if _, env, err := VerifyAttestation(att, f.KeyID, chal, Config{AppID: f.AppID}); err != nil || env != EnvProduction {
		t.Fatalf("env=%q err=%v", env, err)
	}
}
