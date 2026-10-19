// Package playintegrity verifies Google Play Integrity standard-request tokens
// and Android Keystore assertions. It is the Android twin of
// internal/appattest and backs the anonymous AI trial for Android local mode
// (bd med-nt9p.32.8): the subject is an app-generated Keystore P-256 key, not
// an account.
//
// Google contract this package implements (comments cite it):
//   - Standard request: the app calls StandardIntegrityTokenProvider.request
//     with StandardIntegrityTokenRequest.setRequestHash(<requestHash>)
//     (https://developer.android.com/google/play/integrity/standard).
//   - Server decode: POST
//     https://playintegrity.googleapis.com/v1/{packageName}:decodeIntegrityToken
//     body {"integrity_token": "..."} with an OAuth2 bearer for scope
//     https://www.googleapis.com/auth/playintegrity; the answer is
//     {"tokenPayloadExternal": {...}}
//     (https://developer.android.com/google/play/integrity/reference/rest/v1/v1/decodeIntegrityToken).
//   - Payload fields checked (https://developer.android.com/google/play/integrity/verdicts):
//     requestDetails.{requestPackageName, requestHash, timestampMillis},
//     appIntegrity.{appRecognitionVerdict, packageName, certificateSha256Digest[]},
//     deviceIntegrity.deviceRecognitionVerdict[]; deviceIntegrity.deviceRecall
//     is read, not checked (the caller decides, bd med-nt9p.32.8.6).
//   - Device recall write: POST
//     https://playintegrity.googleapis.com/v1/{packageName}/deviceRecall:write
//     (https://developer.android.com/google/play/integrity/device-recall).
//   - Service-account auth: OAuth2 JWT-bearer grant (RFC 7523), RS256 JWT
//     {iss: client_email, scope, aud: token_uri, iat, exp} POSTed to token_uri
//     (https://developers.google.com/identity/protocols/oauth2/service-account#httprest).
//
// Replay: a token is bound to one server challenge through requestHash; the
// caller's challenge map is single-use, so a replayed token fails on the
// consumed challenge. timestampMillis bounds how old a token may be.
//
// PRIVACY: Decode/VerifyEnrollment/SetDeviceRecall make outbound HTTP to
// playintegrity.googleapis.com and the service account's token_uri
// (oauth2.googleapis.com). The privacy-claims guard scans only
// internal/cloudserver, so the routes that call this package (bd
// med-nt9p.32.8.3) own the 'local-trial' privacy-manifest row disclosing it.
//
// SECURITY INVARIANT (as attest.go / trial_proxy.go): no integrity token,
// service-account key, signed JWT or access token may appear in any error
// string or log line. This package does not log; its errors carry fixed
// strings and, for Google calls, the HTTP status only. Errors are typed
// (errors.Is): ErrInvalid → 401, ErrUnavailable → 503. It reads no
// environment; the caller fills Config.
package playintegrity

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	// DefaultBaseURL is the Play Integrity API host.
	DefaultBaseURL = "https://playintegrity.googleapis.com"
	// Scope is the OAuth2 scope decodeIntegrityToken requires.
	Scope = "https://www.googleapis.com/auth/playintegrity"

	// VerdictPlayRecognized is the only appRecognitionVerdict accepted by
	// default: the app and certificate match the version Play distributes.
	VerdictPlayRecognized = "PLAY_RECOGNIZED"
	// VerdictMeetsDeviceIntegrity must be among deviceRecognitionVerdict.
	VerdictMeetsDeviceIntegrity = "MEETS_DEVICE_INTEGRITY"

	// MaxTokenAge bounds |now − requestDetails.timestampMillis|.
	MaxTokenAge = 10 * time.Minute

	defaultTokenURI = "https://oauth2.googleapis.com/token"
	maxBody         = 64 << 10
)

var (
	// ErrInvalid wraps every verification failure (→ 401).
	ErrInvalid = errors.New("playintegrity: invalid")

	ErrMalformed     = fmt.Errorf("%w: malformed", ErrInvalid)
	ErrPackage       = fmt.Errorf("%w: package name", ErrInvalid)
	ErrRequestHash   = fmt.Errorf("%w: request hash", ErrInvalid)
	ErrStale         = fmt.Errorf("%w: stale token", ErrInvalid)
	ErrAppVerdict    = fmt.Errorf("%w: app verdict", ErrInvalid)
	ErrCertificate   = fmt.Errorf("%w: certificate digest", ErrInvalid)
	ErrDeviceVerdict = fmt.Errorf("%w: device verdict", ErrInvalid)
	ErrKey           = fmt.Errorf("%w: key", ErrInvalid)
	ErrSignature     = fmt.Errorf("%w: signature", ErrInvalid)
	ErrCounter       = fmt.Errorf("%w: counter", ErrInvalid)

	// ErrUnavailable wraps Google/transport/config failures (→ 503). It
	// carries at most the HTTP status.
	ErrUnavailable = errors.New("playintegrity: unavailable")
)

// ServiceAccount is the verifier's Google service account.
type ServiceAccount struct {
	ClientEmail string
	PrivateKey  *rsa.PrivateKey
	TokenURI    string
}

// Config is filled by the caller (the routes bead maps env vars to it).
type Config struct {
	// PackageName is the Android applicationId the token must name.
	PackageName    string
	ServiceAccount ServiceAccount
	// AcceptAppVerdicts lists accepted appRecognitionVerdict values; empty
	// means [PLAY_RECOGNIZED].
	AcceptAppVerdicts []string
	// CertDigests, when non-empty, requires one of
	// appIntegrity.certificateSha256Digest to match (the base64url-nopad
	// SHA-256 of the app signing certificate, as Google encodes it).
	// PLAY_RECOGNIZED already implies Play's signing cert; this pins it.
	CertDigests []string
	// Now overrides the clock. Tests ONLY.
	Now func() time.Time
	// HTTPClient overrides the default 10 s client.
	HTTPClient *http.Client
	// BaseURL overrides DefaultBaseURL. Tests ONLY.
	BaseURL string
}

// ParseServiceAccountJSON reads a Google service-account key file. Errors name
// the field, never its value.
func ParseServiceAccountJSON(b []byte) (ServiceAccount, error) {
	var f struct {
		Type        string `json:"type"`
		ClientEmail string `json:"client_email"`
		PrivateKey  string `json:"private_key"`
		TokenURI    string `json:"token_uri"`
	}
	if json.Unmarshal(b, &f) != nil {
		return ServiceAccount{}, errors.New("playintegrity: service account is not JSON")
	}
	if f.Type != "" && f.Type != "service_account" {
		return ServiceAccount{}, errors.New("playintegrity: service account type is not service_account")
	}
	if f.ClientEmail == "" {
		return ServiceAccount{}, errors.New("playintegrity: service account client_email missing")
	}
	block, _ := pem.Decode([]byte(f.PrivateKey))
	if block == nil {
		return ServiceAccount{}, errors.New("playintegrity: service account private_key is not PEM")
	}
	k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return ServiceAccount{}, errors.New("playintegrity: service account private_key is not PKCS#8")
	}
	rk, ok := k.(*rsa.PrivateKey)
	if !ok {
		return ServiceAccount{}, errors.New("playintegrity: service account private_key is not RSA")
	}
	if f.TokenURI == "" {
		f.TokenURI = defaultTokenURI
	}
	if u, err := url.Parse(f.TokenURI); err != nil || u.Scheme != "https" || u.Host == "" {
		return ServiceAccount{}, errors.New("playintegrity: service account token_uri is not an https URL")
	}
	return ServiceAccount{ClientEmail: f.ClientEmail, PrivateKey: rk, TokenURI: f.TokenURI}, nil
}

// Verdict is the subset of tokenPayloadExternal this package checks.
type Verdict struct {
	RequestPackageName    string
	RequestHash           string
	TimestampMillis       int64
	AppRecognitionVerdict string
	AppPackageName        string
	CertificateDigests    []string
	DeviceVerdicts        []string
	// DeviceRecall is deviceIntegrity.deviceRecall.values (bd
	// med-nt9p.32.8.6): nil when the object is absent (the app is not opted
	// in to device recall in Play Console); all false when it is present but
	// unevaluated ({"values":{}}) or no bit was ever written.
	DeviceRecall *DeviceRecall
}

// DeviceRecall holds the three app-defined device-recall bits Google keeps per
// device (https://developer.android.com/google/play/integrity/device-recall).
type DeviceRecall struct {
	First, Second, Third bool
}

// Verifier decodes tokens and caches the service-account access token.
type Verifier struct {
	cfg Config

	mu        sync.Mutex
	access    string
	accessExp time.Time
}

// New returns a Verifier. It does no I/O.
func New(cfg Config) *Verifier { return &Verifier{cfg: cfg} }

func (v *Verifier) now() time.Time {
	if v.cfg.Now != nil {
		return v.cfg.Now()
	}
	return time.Now()
}

func (v *Verifier) client() *http.Client {
	if v.cfg.HTTPClient != nil {
		return v.cfg.HTTPClient
	}
	return defaultHTTP
}

var defaultHTTP = &http.Client{Timeout: 10 * time.Second}

// accessToken returns a cached bearer, minting a new one via the JWT-bearer
// grant when it is within 60 s of expiry.
func (v *Verifier) accessToken(ctx context.Context) (string, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	now := v.now()
	if v.access != "" && now.Before(v.accessExp.Add(-60*time.Second)) {
		return v.access, nil
	}
	sa := v.cfg.ServiceAccount
	if sa.PrivateKey == nil || sa.ClientEmail == "" || sa.TokenURI == "" {
		return "", fmt.Errorf("%w: not configured", ErrUnavailable)
	}
	assertion, err := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"iss":   sa.ClientEmail,
		"scope": Scope,
		"aud":   sa.TokenURI,
		"iat":   now.Unix(),
		"exp":   now.Add(time.Hour).Unix(),
	}).SignedString(sa.PrivateKey)
	if err != nil {
		return "", fmt.Errorf("%w: sign", ErrUnavailable)
	}
	form := url.Values{
		"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"},
		"assertion":  {assertion},
	}
	body, status, err := v.post(ctx, sa.TokenURI, "application/x-www-form-urlencoded", strings.NewReader(form.Encode()), "")
	if err != nil {
		return "", err
	}
	if status != http.StatusOK {
		return "", fmt.Errorf("%w: token status %d", ErrUnavailable, status)
	}
	var tr struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
	}
	if json.Unmarshal(body, &tr) != nil || tr.AccessToken == "" || tr.ExpiresIn <= 0 {
		return "", fmt.Errorf("%w: unreadable token response", ErrUnavailable)
	}
	v.access, v.accessExp = tr.AccessToken, now.Add(time.Duration(tr.ExpiresIn)*time.Second)
	return v.access, nil
}

func (v *Verifier) post(ctx context.Context, u, ctype string, body io.Reader, bearer string) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, body)
	if err != nil {
		return nil, 0, fmt.Errorf("%w: request", ErrUnavailable)
	}
	req.Header.Set("Content-Type", ctype)
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := v.client().Do(req)
	if err != nil {
		// SECURITY INVARIANT: fixed string; never the transport error text
		// (it can echo the URL and request).
		return nil, 0, fmt.Errorf("%w: transport", ErrUnavailable)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return nil, 0, fmt.Errorf("%w: read", ErrUnavailable)
	}
	return b, resp.StatusCode, nil
}

// int64 fields are strings in proto3 JSON; accept a bare number too.
type flexInt64 int64

func (f *flexInt64) UnmarshalJSON(b []byte) error {
	n, err := strconv.ParseInt(strings.Trim(string(b), `"`), 10, 64)
	*f = flexInt64(n)
	return err
}

// Decode calls decodeIntegrityToken and returns the payload. Google answers
// 400 for a token it cannot decrypt (→ ErrMalformed); any other non-200 is
// ErrUnavailable.
func (v *Verifier) Decode(ctx context.Context, token string) (*Verdict, error) {
	if token == "" || v.cfg.PackageName == "" {
		return nil, ErrMalformed
	}
	bearer, err := v.accessToken(ctx)
	if err != nil {
		return nil, err
	}
	base := v.cfg.BaseURL
	if base == "" {
		base = DefaultBaseURL
	}
	reqBody, _ := json.Marshal(map[string]string{"integrity_token": token})
	body, status, err := v.post(ctx, base+"/v1/"+url.PathEscape(v.cfg.PackageName)+":decodeIntegrityToken", "application/json", bytes.NewReader(reqBody), bearer)
	if err != nil {
		return nil, err
	}
	switch status {
	case http.StatusOK:
	case http.StatusBadRequest:
		return nil, ErrMalformed
	case http.StatusUnauthorized:
		// Bearer rejected (revoked/rotated): drop the cache so the next call re-mints.
		v.mu.Lock()
		v.access = ""
		v.mu.Unlock()
		return nil, fmt.Errorf("%w: status %d", ErrUnavailable, status)
	default:
		return nil, fmt.Errorf("%w: status %d", ErrUnavailable, status)
	}
	var r struct {
		P *struct {
			RequestDetails struct {
				RequestPackageName string    `json:"requestPackageName"`
				RequestHash        string    `json:"requestHash"`
				TimestampMillis    flexInt64 `json:"timestampMillis"`
			} `json:"requestDetails"`
			AppIntegrity struct {
				AppRecognitionVerdict   string   `json:"appRecognitionVerdict"`
				PackageName             string   `json:"packageName"`
				CertificateSha256Digest []string `json:"certificateSha256Digest"`
			} `json:"appIntegrity"`
			DeviceIntegrity struct {
				DeviceRecognitionVerdict []string `json:"deviceRecognitionVerdict"`
				DeviceRecall             *struct {
					Values struct {
						BitFirst  bool `json:"bitFirst"`
						BitSecond bool `json:"bitSecond"`
						BitThird  bool `json:"bitThird"`
					} `json:"values"`
				} `json:"deviceRecall"`
			} `json:"deviceIntegrity"`
		} `json:"tokenPayloadExternal"`
	}
	if json.Unmarshal(body, &r) != nil || r.P == nil {
		return nil, fmt.Errorf("%w: unreadable decode response", ErrUnavailable)
	}
	p := r.P
	var recall *DeviceRecall
	if dr := p.DeviceIntegrity.DeviceRecall; dr != nil {
		recall = &DeviceRecall{First: dr.Values.BitFirst, Second: dr.Values.BitSecond, Third: dr.Values.BitThird}
	}
	return &Verdict{
		RequestPackageName:    p.RequestDetails.RequestPackageName,
		RequestHash:           p.RequestDetails.RequestHash,
		TimestampMillis:       int64(p.RequestDetails.TimestampMillis),
		AppRecognitionVerdict: p.AppIntegrity.AppRecognitionVerdict,
		AppPackageName:        p.AppIntegrity.PackageName,
		CertificateDigests:    p.AppIntegrity.CertificateSha256Digest,
		DeviceVerdicts:        p.DeviceIntegrity.DeviceRecognitionVerdict,
		DeviceRecall:          recall,
	}, nil
}

// SetDeviceRecall sets the true bits of set with the token the device sent
// (bd med-nt9p.32.8.6): POST {base}/v1/{packageName}/deviceRecall:write body
// {"integrityToken": token, "newValues": {<only the true bits>: true}}, same
// bearer and scope as decodeIntegrityToken.
//
// MONOTONIC: a false bit is never sent, so this can only set bits, never
// clear one. The verdict's recall values are a snapshot (a standard-request
// provider caches them at warm-up), so echoing a stale false would clear a bit
// Google already holds and reopen pass-less farming. The guide says
// unspecified bits stay unchanged; the REST reference lists all three as
// required — if Google enforces that, the write fails, the caller rolls the
// grant back and fails closed (never a cleared bit). Google also refuses the
// write when the token's recall is unevaluated. Any non-200 is ErrUnavailable
// carrying the status only.
func (v *Verifier) SetDeviceRecall(ctx context.Context, token string, set DeviceRecall) error {
	if token == "" || v.cfg.PackageName == "" {
		return ErrMalformed
	}
	bearer, err := v.accessToken(ctx)
	if err != nil {
		return err
	}
	base := v.cfg.BaseURL
	if base == "" {
		base = DefaultBaseURL
	}
	bits := map[string]bool{}
	for name, on := range map[string]bool{"bitFirst": set.First, "bitSecond": set.Second, "bitThird": set.Third} {
		if on {
			bits[name] = true
		}
	}
	if len(bits) == 0 {
		return ErrMalformed
	}
	reqBody, _ := json.Marshal(map[string]any{"integrityToken": token, "newValues": bits})
	_, status, err := v.post(ctx, base+"/v1/"+url.PathEscape(v.cfg.PackageName)+"/deviceRecall:write", "application/json", bytes.NewReader(reqBody), bearer)
	if err != nil {
		return err
	}
	if status == http.StatusUnauthorized {
		v.mu.Lock()
		v.access = ""
		v.mu.Unlock()
	}
	if status != http.StatusOK {
		return fmt.Errorf("%w: device recall write status %d", ErrUnavailable, status)
	}
	return nil
}

var b64 = base64.RawURLEncoding

// KeyID is the derived key id: base64url-nopad(SHA256(SPKI DER)).
func KeyID(pubDER []byte) string {
	h := sha256.Sum256(pubDER)
	return b64.EncodeToString(h[:])
}

// RequestHash is what the client passes to setRequestHash:
// base64url-nopad(SHA256(challenge ‖ keyID ‖ pubDER)).
func RequestHash(challenge []byte, keyID string, pubDER []byte) string {
	h := sha256.New()
	h.Write(challenge)
	h.Write([]byte(keyID))
	h.Write(pubDER)
	return b64.EncodeToString(h.Sum(nil))
}

// VerifyEnrollment checks a standard-request token that binds challenge to the
// app's Keystore P-256 key and returns that key and the verdict (the accepted
// appRecognitionVerdict is vd.AppRecognitionVerdict). The caller must have issued challenge and consume it
// (single use).
func (v *Verifier) VerifyEnrollment(ctx context.Context, token string, challenge []byte, keyID string, pubDER []byte) (*ecdsa.PublicKey, *Verdict, error) {
	if len(challenge) == 0 {
		return nil, nil, ErrMalformed
	}
	// Local checks first: never spend a Google call on a bad key.
	// The key must be an ECDSA P-256 SPKI (ParsePKIXPublicKey rejects trailing data).
	k, err := x509.ParsePKIXPublicKey(pubDER)
	if err != nil {
		return nil, nil, ErrKey
	}
	pub, ok := k.(*ecdsa.PublicKey)
	if !ok || pub.Curve != elliptic.P256() {
		return nil, nil, ErrKey
	}
	// The key id is derived, never chosen.
	if subtle.ConstantTimeCompare([]byte(keyID), []byte(KeyID(pubDER))) != 1 {
		return nil, nil, ErrKey
	}
	vd, err := v.Decode(ctx, token)
	if err != nil {
		return nil, nil, err
	}
	// requestDetails.requestPackageName: the token was requested by our app.
	if vd.RequestPackageName != v.cfg.PackageName {
		return nil, nil, ErrPackage
	}
	// requestDetails.requestHash: binds this challenge and this key.
	if subtle.ConstantTimeCompare([]byte(vd.RequestHash), []byte(RequestHash(challenge, keyID, pubDER))) != 1 {
		return nil, nil, ErrRequestHash
	}
	// requestDetails.timestampMillis: freshness, both directions.
	if age := v.now().Sub(time.UnixMilli(vd.TimestampMillis)); vd.TimestampMillis <= 0 || age > MaxTokenAge || age < -MaxTokenAge {
		return nil, nil, ErrStale
	}
	// appIntegrity.appRecognitionVerdict.
	accept := v.cfg.AcceptAppVerdicts
	if len(accept) == 0 {
		accept = []string{VerdictPlayRecognized}
	}
	if !slices.Contains(accept, vd.AppRecognitionVerdict) {
		return nil, nil, ErrAppVerdict
	}
	// appIntegrity.packageName: the app Play evaluated is ours.
	if vd.AppPackageName != v.cfg.PackageName {
		return nil, nil, ErrPackage
	}
	// appIntegrity.certificateSha256Digest: optional signing-cert pin.
	if len(v.cfg.CertDigests) > 0 && !slices.ContainsFunc(vd.CertificateDigests, func(d string) bool {
		return slices.Contains(v.cfg.CertDigests, d)
	}) {
		return nil, nil, ErrCertificate
	}
	// deviceIntegrity.deviceRecognitionVerdict ∋ MEETS_DEVICE_INTEGRITY.
	if !slices.Contains(vd.DeviceVerdicts, VerdictMeetsDeviceIntegrity) {
		return nil, nil, ErrDeviceVerdict
	}
	return pub, vd, nil
}

// VerifyAssertion checks an Android Keystore assertion. Wire format:
// counter (uint32 big-endian, 4 bytes) ‖ ECDSA ASN.1 DER signature. The
// Keystore signs SHA256withECDSA over message = clientDataHash ‖ counterBE, so
// the verified digest is SHA256(message). The counter must exceed prevCounter
// (replay guard). Shape mirrors appattest.VerifyAssertion.
func VerifyAssertion(assertion []byte, pub *ecdsa.PublicKey, clientDataHash []byte, prevCounter uint32) (uint32, error) {
	if pub == nil || pub.Curve != elliptic.P256() || len(assertion) <= 4 || len(clientDataHash) == 0 {
		return 0, ErrMalformed
	}
	counter := binary.BigEndian.Uint32(assertion[:4])
	msg := append(append([]byte{}, clientDataHash...), assertion[:4]...)
	digest := sha256.Sum256(msg)
	if !ecdsa.VerifyASN1(pub, digest[:], assertion[4:]) {
		return 0, ErrSignature
	}
	if counter <= prevCounter {
		return 0, ErrCounter
	}
	return counter, nil
}
