// Package appattest verifies Apple App Attest attestations and assertions and
// talks to Apple's DeviceCheck two-bit API. It backs the anonymous AI trial
// for iOS local mode (bd med-o7zq): the subject is an App Attest key id, not
// an account.
//
// Verification follows Apple's documented contract, "Validating apps that
// connect to your server"
// (https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server);
// comments cite its step numbers. The DeviceCheck client follows "Accessing
// and modifying per-device data"
// (https://developer.apple.com/documentation/devicecheck/accessing-and-modifying-per-device-data).
//
// PRIVACY: this package makes outbound HTTP to api(.development).devicecheck.apple.com.
// The privacy-claims guard (web/cloud/js/tests/architecture.privacy-claims.test.js)
// scans only internal/cloudserver, so this call is NOT auto-detected. The
// routes that call it (internal/cloudserver, bd med-o7zq.15) own the
// 'local-trial' privacy-manifest row that discloses it — that row is not
// stale, do not "clean it up".
//
// SECURITY INVARIANT: no key material, device token or JWT may appear in any
// error string or log line. This package does not log; its errors carry fixed
// strings and, for DeviceCheck, the HTTP status only. Errors are typed
// (errors.Is) so callers map them to 401 (ErrInvalid) vs 503 (ErrDeviceCheck)
// without leaking detail.
//
// # Capturing a real attestation for testdata
//
// The CI tests use fakes (fakeCA in appattest_test.go, fakeDeviceCheck in
// devicecheck_test.go). To pin a real production
// attestation, log on a TestFlight build the base64 key id, the base64
// attestation object returned by DCAppAttestService.attestKey and the
// base64 challenge that was hashed into clientDataHash, then write
// testdata/real_attestation.json:
//
//	{"appId":"<TEAMID>.<bundle id>","keyId":"…","attestation":"…",
//	 "challenge":"…","capturedAt":"<RFC3339 time of capture>"}
//
// TestRealAttestation verifies it against the embedded Apple root at
// capturedAt (the leaf certificate is short-lived) and skips when absent.
// Attestations contain no secrets, but never commit DeviceCheck .p8 keys.
package appattest

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/x509"
	_ "embed"
	"encoding/asn1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"time"

	"github.com/fxamacker/cbor/v2"
)

// Environments, as encoded in the authenticator data aaguid.
const (
	EnvProduction  = "production"
	EnvDevelopment = "development"
)

// Config is filled by the caller (the routes bead maps env vars to it); this
// package reads no environment.
type Config struct {
	// AppID is "<TEAMID>.<bundle id>"; its SHA256 is the expected rpIdHash.
	AppID string
	// Env is the accepted App Attest environment and selects the DeviceCheck
	// host. Empty means production.
	Env string
	// Roots overrides the embedded Apple App Attestation Root CA. Tests ONLY.
	Roots       *x509.CertPool
	DeviceCheck DeviceCheckConfig
}

func (c Config) env() string {
	if c.Env == "" {
		return EnvProduction
	}
	return c.Env
}

// ErrInvalid is the umbrella for every verification failure (→ 401). Each
// specific error below wraps it.
var ErrInvalid = errors.New("appattest: invalid")

var (
	ErrMalformed = fmt.Errorf("%w: malformed", ErrInvalid)
	ErrChain     = fmt.Errorf("%w: certificate chain", ErrInvalid)
	ErrNonce     = fmt.Errorf("%w: nonce mismatch", ErrInvalid)
	ErrKeyID     = fmt.Errorf("%w: key id mismatch", ErrInvalid)
	ErrAppID     = fmt.Errorf("%w: app id mismatch", ErrInvalid)
	ErrCounter   = fmt.Errorf("%w: counter", ErrInvalid)
	ErrEnv       = fmt.Errorf("%w: environment", ErrInvalid)
	ErrSignature = fmt.Errorf("%w: signature", ErrInvalid)
)

// Apple App Attestation Root CA, from
// https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem
// (SHA-256 fingerprint 1C:B9:82:3B:A2:8B:A6:AD:2D:33:A0:06:94:1D:E2:AE:4F:51:3E:F1:D4:E8:31:B9:F7:E0:FA:7B:62:42:C9:32).
//
//go:embed apple_app_attestation_root_ca.pem
var appleRootPEM []byte

var appleRoots = func() *x509.CertPool {
	p := x509.NewCertPool()
	if !p.AppendCertsFromPEM(appleRootPEM) {
		panic("appattest: embedded Apple root CA does not parse")
	}
	return p
}()

// timeNow is the chain-validation clock; tests pin it for captured blobs.
var timeNow = time.Now

// oidNonce is Apple's attestation nonce extension.
var oidNonce = asn1.ObjectIdentifier{1, 2, 840, 113635, 100, 8, 2}

var (
	aaguidProduction  = append([]byte("appattest"), make([]byte, 7)...)
	aaguidDevelopment = []byte("appattestdevelop")
)

type attestationObject struct {
	Fmt     string `cbor:"fmt"`
	AttStmt struct {
		X5c     [][]byte `cbor:"x5c"`
		Receipt []byte   `cbor:"receipt"`
	} `cbor:"attStmt"`
	AuthData []byte `cbor:"authData"`
}

// authData layout (WebAuthn authenticator data, Apple "Attestation object"):
// rpIdHash(32) | flags(1) | counter(4) | [aaguid(16) | credIdLen(2) | credId | COSE key].
type authData struct {
	rpIDHash []byte
	counter  uint32
	aaguid   []byte
	credID   []byte
}

func parseAuthData(b []byte, attested bool) (authData, error) {
	if len(b) < 37 {
		return authData{}, ErrMalformed
	}
	a := authData{rpIDHash: b[:32], counter: binary.BigEndian.Uint32(b[33:37])}
	if !attested {
		return a, nil
	}
	if b[32]&0x40 == 0 || len(b) < 55 {
		return authData{}, ErrMalformed
	}
	a.aaguid = b[37:53]
	n := int(binary.BigEndian.Uint16(b[53:55]))
	if len(b) < 55+n {
		return authData{}, ErrMalformed
	}
	a.credID = b[55 : 55+n]
	return a, nil
}

// VerifyAttestation checks an App Attest attestation object for keyID
// (base64, as DCAppAttestService returns it) over the server-issued challenge.
// It returns the attested public key (store it for VerifyAssertion) and the
// environment ("production"/"development"); an environment other than
// cfg.Env is rejected with ErrEnv. The receipt is not validated (only needed
// for Apple's fraud-metric API, which the trial does not use).
func VerifyAttestation(attestationCBOR []byte, keyID string, challenge []byte, cfg Config) (*ecdsa.PublicKey, string, error) {
	var att attestationObject
	if err := cbor.Unmarshal(attestationCBOR, &att); err != nil || att.Fmt != "apple-appattest" || len(att.AttStmt.X5c) == 0 {
		return nil, "", ErrMalformed
	}
	keyIDRaw, err := base64.StdEncoding.DecodeString(keyID)
	if err != nil || len(keyIDRaw) != sha256.Size {
		return nil, "", ErrKeyID
	}

	// Step 1: x5c[0] is credCert, the rest intermediates; verify to the Apple root.
	certs := make([]*x509.Certificate, len(att.AttStmt.X5c))
	for i, der := range att.AttStmt.X5c {
		if certs[i], err = x509.ParseCertificate(der); err != nil {
			return nil, "", ErrMalformed
		}
	}
	roots := cfg.Roots
	if roots == nil {
		roots = appleRoots
	}
	inter := x509.NewCertPool()
	for _, c := range certs[1:] {
		inter.AddCert(c)
	}
	if _, err := certs[0].Verify(x509.VerifyOptions{
		Roots: roots, Intermediates: inter, CurrentTime: timeNow(),
		KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageAny},
	}); err != nil {
		return nil, "", ErrChain
	}

	// Steps 2–4: nonce = SHA256(authData || SHA256(challenge)) must equal the
	// credCert extension 1.2.840.113635.100.8.2, a DER SEQUENCE { [1] OCTET STRING }.
	clientDataHash := sha256.Sum256(challenge)
	nonce := sha256.Sum256(append(append([]byte{}, att.AuthData...), clientDataHash[:]...))
	var certNonce []byte
	for _, ext := range certs[0].Extensions {
		if ext.Id.Equal(oidNonce) {
			var v struct {
				Nonce []byte `asn1:"tag:1,explicit"`
			}
			if rest, err := asn1.Unmarshal(ext.Value, &v); err != nil || len(rest) != 0 {
				return nil, "", ErrMalformed
			}
			certNonce = v.Nonce
		}
	}
	if !bytes.Equal(certNonce, nonce[:]) {
		return nil, "", ErrNonce
	}

	// Step 5: SHA256(credCert public key as an uncompressed X9.62 point) == keyId.
	pub, ok := certs[0].PublicKey.(*ecdsa.PublicKey)
	if !ok || pub.Curve != elliptic.P256() {
		return nil, "", ErrMalformed
	}
	point, err := pub.ECDH()
	if err != nil {
		return nil, "", ErrMalformed
	}
	if h := sha256.Sum256(point.Bytes()); !bytes.Equal(h[:], keyIDRaw) {
		return nil, "", ErrKeyID
	}

	ad, err := parseAuthData(att.AuthData, true)
	if err != nil {
		return nil, "", err
	}
	// Step 6: rpIdHash == SHA256(App ID).
	if appHash := sha256.Sum256([]byte(cfg.AppID)); !bytes.Equal(ad.rpIDHash, appHash[:]) {
		return nil, "", ErrAppID
	}
	// Step 7: counter == 0.
	if ad.counter != 0 {
		return nil, "", ErrCounter
	}
	// Step 8: aaguid is "appattest" + 7×0x00 (production) or "appattestdevelop".
	var env string
	switch {
	case bytes.Equal(ad.aaguid, aaguidProduction):
		env = EnvProduction
	case bytes.Equal(ad.aaguid, aaguidDevelopment):
		env = EnvDevelopment
	default:
		return nil, "", ErrEnv
	}
	if env != cfg.env() {
		return nil, "", ErrEnv
	}
	// Step 9: credentialId == keyId.
	if !bytes.Equal(ad.credID, keyIDRaw) {
		return nil, "", ErrKeyID
	}
	return pub, env, nil
}

// VerifyAssertion checks an App Attest assertion made with pubKey over
// clientDataHash (computed by the caller from what it expects the client to
// have signed). It returns the assertion's counter, which must exceed
// prevCounter; the caller persists it atomically (compare-and-set) — this
// package never stores state.
func VerifyAssertion(assertionCBOR []byte, pubKey *ecdsa.PublicKey, clientDataHash []byte, cfg Config, prevCounter uint32) (uint32, error) {
	var as struct {
		Signature         []byte `cbor:"signature"`
		AuthenticatorData []byte `cbor:"authenticatorData"`
	}
	if err := cbor.Unmarshal(assertionCBOR, &as); err != nil || pubKey == nil {
		return 0, ErrMalformed
	}
	ad, err := parseAuthData(as.AuthenticatorData, false)
	if err != nil {
		return 0, err
	}
	// Steps 1–3: nonce = SHA256(authenticatorData || clientDataHash); the
	// signature is ECDSA-P256-SHA256 over nonce (so the digest is SHA256(nonce)).
	nonce := sha256.Sum256(append(append([]byte{}, as.AuthenticatorData...), clientDataHash...))
	digest := sha256.Sum256(nonce[:])
	if !ecdsa.VerifyASN1(pubKey, digest[:], as.Signature) {
		return 0, ErrSignature
	}
	// Step 4: rpIdHash == SHA256(App ID).
	if appHash := sha256.Sum256([]byte(cfg.AppID)); !bytes.Equal(ad.rpIDHash, appHash[:]) {
		return 0, ErrAppID
	}
	// Step 5: counter strictly greater than the stored one (replay guard).
	if ad.counter <= prevCounter {
		return 0, ErrCounter
	}
	// Step 6 (challenge freshness) is the caller's: it is bound into clientDataHash.
	return ad.counter, nil
}
