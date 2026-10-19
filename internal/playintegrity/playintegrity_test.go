package playintegrity

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const testPkg = "com.example.app"

var testNow = time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)

// fakeGoogle mirrors Google's contract: token_uri accepts the JWT-bearer grant
// (form grant_type + assertion, RS256 JWT iss/scope/aud/exp) and returns
// {access_token, expires_in, token_type}; decodeIntegrityToken accepts
// POST /v1/{pkg}:decodeIntegrityToken {"integrity_token"} with that bearer and
// returns {"tokenPayloadExternal": payload} (400 for an unknown token).
type fakeGoogle struct {
	t          *testing.T
	sa         ServiceAccount
	payload    map[string]any
	tokenCalls atomic.Int32
	decodes    atomic.Int32
	status     int // non-zero: decode answers this status
}

func (f *fakeGoogle) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/token":
		f.tokenCalls.Add(1)
		if r.ParseForm() != nil || r.PostForm.Get("grant_type") != "urn:ietf:params:oauth:grant-type:jwt-bearer" {
			http.Error(w, `{"error":"unsupported_grant_type"}`, http.StatusBadRequest)
			return
		}
		tok, err := jwt.Parse(r.PostForm.Get("assertion"), func(*jwt.Token) (any, error) {
			return &f.sa.PrivateKey.PublicKey, nil
		}, jwt.WithValidMethods([]string{"RS256"}), jwt.WithAudience(f.sa.TokenURI),
			jwt.WithIssuer(f.sa.ClientEmail), jwt.WithExpirationRequired(), jwt.WithTimeFunc(func() time.Time { return testNow }))
		if err != nil || tok.Claims.(jwt.MapClaims)["scope"] != Scope {
			http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"access_token": "ya29.fake", "expires_in": 3599, "token_type": "Bearer"})
	case r.URL.Path == "/v1/"+testPkg+":decodeIntegrityToken":
		f.decodes.Add(1)
		if r.Header.Get("Authorization") != "Bearer ya29.fake" {
			http.Error(w, "{}", http.StatusUnauthorized)
			return
		}
		if f.status != 0 {
			http.Error(w, "{}", f.status)
			return
		}
		var body struct {
			Token string `json:"integrity_token"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.Token != "good-token" {
			http.Error(w, `{"error":{"code":400,"status":"INVALID_ARGUMENT"}}`, http.StatusBadRequest)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"tokenPayloadExternal": f.payload})
	default:
		http.NotFound(w, r)
	}
}

type fixture struct {
	g         *fakeGoogle
	v         *Verifier
	challenge []byte
	key       *ecdsa.PrivateKey
	pubDER    []byte
	keyID     string
}

func newFixture(t *testing.T, mut func(*Config)) *fixture {
	t.Helper()
	rk, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	g := &fakeGoogle{t: t}
	srv := httptest.NewServer(g)
	t.Cleanup(srv.Close)
	g.sa = ServiceAccount{ClientEmail: "verifier@proj.iam.gserviceaccount.com", PrivateKey: rk, TokenURI: srv.URL + "/token"}
	ek, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	pubDER, _ := x509.MarshalPKIXPublicKey(&ek.PublicKey)
	f := &fixture{g: g, challenge: []byte("0123456789abcdef0123456789abcdef"), key: ek, pubDER: pubDER, keyID: KeyID(pubDER)}
	g.payload = map[string]any{
		"requestDetails": map[string]any{
			"requestPackageName": testPkg,
			"requestHash":        RequestHash(f.challenge, f.keyID, pubDER),
			"timestampMillis":    "1792411200000", // proto3 JSON int64 = string
		},
		"appIntegrity": map[string]any{
			"appRecognitionVerdict":   "PLAY_RECOGNIZED",
			"packageName":             testPkg,
			"certificateSha256Digest": []string{"6a6a1474b5cbbb2b1aa57e0bc3"},
			"versionCode":             "42",
		},
		"deviceIntegrity": map[string]any{"deviceRecognitionVerdict": []string{"MEETS_DEVICE_INTEGRITY"}},
		"accountDetails":  map[string]any{"appLicensingVerdict": "LICENSED"},
	}
	if time.UnixMilli(1792411200000).UTC() != testNow {
		t.Fatalf("fixture timestamp drifted: %v", time.UnixMilli(1792411200000).UTC())
	}
	cfg := Config{PackageName: testPkg, ServiceAccount: g.sa, Now: func() time.Time { return testNow }, BaseURL: srv.URL}
	if mut != nil {
		mut(&cfg)
	}
	f.v = New(cfg)
	return f
}

func (f *fixture) enroll() (*ecdsa.PublicKey, error) {
	return f.v.VerifyEnrollment(context.Background(), "good-token", f.challenge, f.keyID, f.pubDER)
}

func set(m map[string]any, section, key string, v any) {
	if v == nil {
		delete(m[section].(map[string]any), key)
		return
	}
	m[section].(map[string]any)[key] = v
}

func TestVerifyEnrollment_Happy(t *testing.T) {
	f := newFixture(t, nil)
	pub, err := f.enroll()
	if err != nil {
		t.Fatal(err)
	}
	if !pub.Equal(&f.key.PublicKey) {
		t.Fatal("returned key differs")
	}
	// Second call reuses the cached access token.
	if _, err := f.enroll(); err != nil {
		t.Fatal(err)
	}
	if n := f.g.tokenCalls.Load(); n != 1 {
		t.Fatalf("token calls = %d, want 1 (cached)", n)
	}
}

func TestVerifyEnrollment_Rejections(t *testing.T) {
	otherKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	otherDER, _ := x509.MarshalPKIXPublicKey(&otherKey.PublicKey)
	p384, _ := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	p384DER, _ := x509.MarshalPKIXPublicKey(&p384.PublicKey)

	cases := []struct {
		name    string
		cfg     func(*Config)
		mut     func(f *fixture)
		token   string
		want    error
		decodes int32 // expected Google decode calls
	}{
		{name: "unknown token", token: "bad-token", want: ErrMalformed, decodes: 1},
		{name: "empty token", token: "", want: ErrMalformed},
		{name: "request package", mut: func(f *fixture) { set(f.g.payload, "requestDetails", "requestPackageName", "com.evil") }, want: ErrPackage, decodes: 1},
		{name: "app package", mut: func(f *fixture) { set(f.g.payload, "appIntegrity", "packageName", "com.evil") }, want: ErrPackage, decodes: 1},
		{name: "request hash other challenge", mut: func(f *fixture) {
			set(f.g.payload, "requestDetails", "requestHash", RequestHash([]byte("other"), f.keyID, f.pubDER))
		}, want: ErrRequestHash, decodes: 1},
		{name: "request hash other key", mut: func(f *fixture) {
			// Token bound to a different key; the enroll presents ours.
			set(f.g.payload, "requestDetails", "requestHash", RequestHash(f.challenge, KeyID(otherDER), otherDER))
		}, want: ErrRequestHash, decodes: 1},
		{name: "request hash missing", mut: func(f *fixture) { set(f.g.payload, "requestDetails", "requestHash", nil) }, want: ErrRequestHash, decodes: 1},
		{name: "stale", mut: func(f *fixture) {
			set(f.g.payload, "requestDetails", "timestampMillis", testNow.Add(-MaxTokenAge-time.Second).UnixMilli())
		}, want: ErrStale, decodes: 1},
		{name: "future", mut: func(f *fixture) {
			set(f.g.payload, "requestDetails", "timestampMillis", testNow.Add(MaxTokenAge+time.Second).UnixMilli())
		}, want: ErrStale, decodes: 1},
		{name: "timestamp missing", mut: func(f *fixture) { set(f.g.payload, "requestDetails", "timestampMillis", nil) }, want: ErrStale, decodes: 1},
		{name: "unrecognized version", mut: func(f *fixture) { set(f.g.payload, "appIntegrity", "appRecognitionVerdict", "UNRECOGNIZED_VERSION") }, want: ErrAppVerdict, decodes: 1},
		{name: "unevaluated", mut: func(f *fixture) { set(f.g.payload, "appIntegrity", "appRecognitionVerdict", "UNEVALUATED") }, want: ErrAppVerdict, decodes: 1},
		{name: "cert pin mismatch", cfg: func(c *Config) { c.CertDigests = []string{"pinned"} }, want: ErrCertificate, decodes: 1},
		{name: "basic integrity only", mut: func(f *fixture) {
			set(f.g.payload, "deviceIntegrity", "deviceRecognitionVerdict", []string{"MEETS_BASIC_INTEGRITY"})
		}, want: ErrDeviceVerdict, decodes: 1},
		{name: "no device verdict", mut: func(f *fixture) { set(f.g.payload, "deviceIntegrity", "deviceRecognitionVerdict", nil) }, want: ErrDeviceVerdict, decodes: 1},
		{name: "key id chosen", mut: func(f *fixture) { f.keyID = KeyID(otherDER) }, want: ErrKey},
		{name: "key not P-256", mut: func(f *fixture) { f.pubDER, f.keyID = p384DER, KeyID(p384DER) }, want: ErrKey},
		{name: "key garbage", mut: func(f *fixture) { f.pubDER, f.keyID = []byte("nope"), KeyID([]byte("nope")) }, want: ErrKey},
		{name: "key trailing data", mut: func(f *fixture) {
			d := append(append([]byte{}, f.pubDER...), 0)
			f.pubDER, f.keyID = d, KeyID(d)
		}, want: ErrKey},
		{name: "empty challenge", mut: func(f *fixture) { f.challenge = nil }, want: ErrMalformed},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t, tc.cfg)
			if tc.mut != nil {
				tc.mut(f)
			}
			tok := "good-token"
			if tc.token != "" || tc.name == "empty token" {
				tok = tc.token
			}
			_, err := f.v.VerifyEnrollment(context.Background(), tok, f.challenge, f.keyID, f.pubDER)
			if !errors.Is(err, tc.want) || !errors.Is(err, ErrInvalid) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
			if n := f.g.decodes.Load(); n != tc.decodes {
				t.Fatalf("decode calls = %d, want %d", n, tc.decodes)
			}
		})
	}
}

func TestVerifyEnrollment_ConfigVariants(t *testing.T) {
	f := newFixture(t, func(c *Config) {
		c.AcceptAppVerdicts = []string{"PLAY_RECOGNIZED", "UNRECOGNIZED_VERSION"}
		c.CertDigests = []string{"other", "6a6a1474b5cbbb2b1aa57e0bc3"}
	})
	set(f.g.payload, "appIntegrity", "appRecognitionVerdict", "UNRECOGNIZED_VERSION")
	set(f.g.payload, "requestDetails", "timestampMillis", testNow.Add(-MaxTokenAge+time.Second).UnixMilli()) // bare number
	set(f.g.payload, "deviceIntegrity", "deviceRecognitionVerdict", []string{"MEETS_BASIC_INTEGRITY", "MEETS_DEVICE_INTEGRITY", "MEETS_STRONG_INTEGRITY"})
	if _, err := f.enroll(); err != nil {
		t.Fatal(err)
	}
}

func TestDecode_Unavailable(t *testing.T) {
	for _, st := range []int{http.StatusInternalServerError, http.StatusForbidden, http.StatusTooManyRequests} {
		f := newFixture(t, nil)
		f.g.status = st
		_, err := f.enroll()
		if !errors.Is(err, ErrUnavailable) || errors.Is(err, ErrInvalid) {
			t.Fatalf("status %d: err = %v", st, err)
		}
	}
	// Unconfigured service account → unavailable, no network.
	v := New(Config{PackageName: testPkg, BaseURL: "http://127.0.0.1:1"})
	if _, err := v.Decode(context.Background(), "t"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("unconfigured: %v", err)
	}
	// Transport error text (URL) never leaks.
	f := newFixture(t, nil)
	f.v.cfg.ServiceAccount.TokenURI = "http://127.0.0.1:1/secret-path"
	_, err := f.v.Decode(context.Background(), "good-token")
	if !errors.Is(err, ErrUnavailable) || strings.Contains(err.Error(), "secret-path") {
		t.Fatalf("transport: %v", err)
	}
}

func TestDecode_401DropsCachedToken(t *testing.T) {
	f := newFixture(t, nil)
	if _, err := f.enroll(); err != nil {
		t.Fatal(err)
	}
	f.v.access = "revoked"
	if _, err := f.enroll(); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v", err)
	}
	if _, err := f.enroll(); err != nil {
		t.Fatalf("after re-mint: %v", err)
	}
	if n := f.g.tokenCalls.Load(); n != 2 {
		t.Fatalf("token calls = %d, want 2", n)
	}
}

func TestAccessTokenRefreshNearExpiry(t *testing.T) {
	now := testNow
	f := newFixture(t, func(c *Config) { c.Now = func() time.Time { return now } })
	if _, err := f.v.Decode(context.Background(), "good-token"); err != nil {
		t.Fatal(err)
	}
	now = now.Add(3599*time.Second - 59*time.Second) // inside the 60 s margin
	// The fake's JWT check uses testNow; iat/exp are still valid there.
	if _, err := f.v.Decode(context.Background(), "good-token"); err != nil {
		t.Fatal(err)
	}
	if n := f.g.tokenCalls.Load(); n != 2 {
		t.Fatalf("token calls = %d, want 2", n)
	}
}

func TestParseServiceAccountJSON(t *testing.T) {
	rk, _ := rsa.GenerateKey(rand.Reader, 2048)
	der, _ := x509.MarshalPKCS8PrivateKey(rk)
	pemKey := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	ek, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	ecDER, _ := x509.MarshalPKCS8PrivateKey(ek)
	ecPEM := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: ecDER}))
	js := func(m map[string]string) []byte { b, _ := json.Marshal(m); return b }

	sa, err := ParseServiceAccountJSON(js(map[string]string{"type": "service_account", "client_email": "a@b", "private_key": pemKey, "token_uri": "https://oauth2.googleapis.com/token"}))
	if err != nil || sa.ClientEmail != "a@b" || !sa.PrivateKey.Equal(rk) || sa.TokenURI != "https://oauth2.googleapis.com/token" {
		t.Fatalf("happy: %v", err)
	}
	if sa, _ := ParseServiceAccountJSON(js(map[string]string{"client_email": "a@b", "private_key": pemKey})); sa.TokenURI != defaultTokenURI {
		t.Fatal("default token_uri")
	}
	bad := map[string][]byte{
		"is not JSON":            []byte("{"),
		"type":                   js(map[string]string{"type": "authorized_user", "client_email": "a@b", "private_key": pemKey}),
		"client_email":           js(map[string]string{"private_key": pemKey}),
		"private_key is not PEM": js(map[string]string{"client_email": "a@b", "private_key": "secret-not-pem"}),
		"not RSA":                js(map[string]string{"client_email": "a@b", "private_key": ecPEM}),
		"token_uri":              js(map[string]string{"client_email": "a@b", "private_key": pemKey, "token_uri": "http://evil/secret-uri"}),
	}
	for want, in := range bad {
		_, err := ParseServiceAccountJSON(in)
		if err == nil || !strings.Contains(err.Error(), want) || strings.Contains(err.Error(), "secret") {
			t.Fatalf("%s: %v", want, err)
		}
	}
}

func signAssertion(t *testing.T, k *ecdsa.PrivateKey, cdh []byte, counter uint32) []byte {
	t.Helper()
	var c [4]byte
	binary.BigEndian.PutUint32(c[:], counter)
	d := sha256.Sum256(append(append([]byte{}, cdh...), c[:]...))
	sig, err := ecdsa.SignASN1(rand.Reader, k, d[:])
	if err != nil {
		t.Fatal(err)
	}
	return append(c[:], sig...)
}

func TestVerifyAssertion(t *testing.T) {
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	other, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	p384, _ := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	cdh := sha256.Sum256([]byte("challenge|request"))

	a := signAssertion(t, k, cdh[:], 5)
	if c, err := VerifyAssertion(a, &k.PublicKey, cdh[:], 4); err != nil || c != 5 {
		t.Fatalf("happy: %d %v", c, err)
	}
	tampered := append([]byte{}, a...)
	tampered[3] = 9 // counter bumped without re-signing
	otherCDH := sha256.Sum256([]byte("other"))
	cases := []struct {
		name string
		as   []byte
		pub  *ecdsa.PublicKey
		cdh  []byte
		prev uint32
		want error
	}{
		{"replay same counter", a, &k.PublicKey, cdh[:], 5, ErrCounter},
		{"counter rollback", a, &k.PublicKey, cdh[:], 6, ErrCounter},
		{"counter tampered", tampered, &k.PublicKey, cdh[:], 4, ErrSignature},
		{"other clientDataHash", a, &k.PublicKey, otherCDH[:], 4, ErrSignature},
		{"other key", a, &other.PublicKey, cdh[:], 4, ErrSignature},
		{"P-384 key", a, &p384.PublicKey, cdh[:], 4, ErrMalformed},
		{"nil key", a, nil, cdh[:], 4, ErrMalformed},
		{"short", a[:4], &k.PublicKey, cdh[:], 4, ErrMalformed},
		{"empty cdh", a, &k.PublicKey, nil, 4, ErrMalformed},
		{"garbage sig", append(a[:4:4], 1, 2, 3), &k.PublicKey, cdh[:], 4, ErrSignature},
	}
	for _, tc := range cases {
		if _, err := VerifyAssertion(tc.as, tc.pub, tc.cdh, tc.prev); !errors.Is(err, tc.want) {
			t.Errorf("%s: err = %v, want %v", tc.name, err, tc.want)
		}
	}
}
