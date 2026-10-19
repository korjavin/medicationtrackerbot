package cloudserver

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
	"github.com/korjavin/medicationtrackerbot/internal/playintegrity"
)

// Android twin of the App Attest fakes (bd med-nt9p.32.8.3). The fake Google
// mirrors internal/playintegrity's own fake: token_uri answers the
// JWT-bearer grant with a bearer, decodeIntegrityToken answers
// {"tokenPayloadExternal": payload} or 400 for a token it cannot decode. Here
// the "integrity token" is the payload JSON, base64url-encoded, so each test
// shapes the verdict it needs. No Google network in CI.

const androidTestPkg = "ai.example.app"

type fakePlayIntegrity struct {
	status atomic.Int32 // non-zero: decode answers this status
	// deviceRecall:write (bd med-nt9p.32.8.6): recorded newValues;
	// writeStatus non-zero answers that status.
	mu          sync.Mutex
	writes      []map[string]bool
	writeStatus atomic.Int32
}

func (f *fakePlayIntegrity) recallWrites() []map[string]bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]map[string]bool(nil), f.writes...)
}

func (f *fakePlayIntegrity) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/token":
		if r.ParseForm() != nil || r.PostForm.Get("grant_type") != "urn:ietf:params:oauth:grant-type:jwt-bearer" || r.PostForm.Get("assertion") == "" {
			http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "ya29.fake", "expires_in": 3599, "token_type": "Bearer"})
	case "/v1/" + androidTestPkg + ":decodeIntegrityToken":
		if r.Header.Get("Authorization") != "Bearer ya29.fake" {
			http.Error(w, "{}", http.StatusUnauthorized)
			return
		}
		if s := f.status.Load(); s != 0 {
			http.Error(w, "{}", int(s))
			return
		}
		var body struct {
			Token string `json:"integrity_token"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		raw, err := base64.RawURLEncoding.DecodeString(body.Token)
		var payload map[string]any
		if err != nil || json.Unmarshal(raw, &payload) != nil {
			http.Error(w, `{"error":{"code":400,"status":"INVALID_ARGUMENT"}}`, http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"tokenPayloadExternal": payload})
	case "/v1/" + androidTestPkg + "/deviceRecall:write":
		var body struct {
			Token     string          `json:"integrityToken"`
			NewValues map[string]bool `json:"newValues"`
		}
		if r.Header.Get("Authorization") != "Bearer ya29.fake" || json.NewDecoder(r.Body).Decode(&body) != nil || body.Token == "" {
			http.Error(w, "{}", http.StatusBadRequest)
			return
		}
		f.mu.Lock()
		f.writes = append(f.writes, body.NewValues)
		f.mu.Unlock()
		if s := f.writeStatus.Load(); s != 0 {
			http.Error(w, `{"error":{"code":400,"status":"FAILED_PRECONDITION"}}`, int(s))
			return
		}
		_, _ = w.Write([]byte("{}"))
	default:
		http.NotFound(w, r)
	}
}

// androidConfig is a Play Integrity config pointing at the fake.
func androidConfig(t *testing.T, base string, accept ...string) playintegrity.Config {
	t.Helper()
	rk, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return playintegrity.Config{
		PackageName:       androidTestPkg,
		ServiceAccount:    playintegrity.ServiceAccount{ClientEmail: "verifier@example.iam.gserviceaccount.com", PrivateKey: rk, TokenURI: base + "/token"},
		AcceptAppVerdicts: accept,
		BaseURL:           base,
	}
}

type androidEnv struct {
	*attestEnv
	g    *fakePlayIntegrity
	base string
}

// newAndroidEnv is newAttestEnv (iOS configured) with Play Integrity on too.
func newAndroidEnv(t *testing.T, lifetime int) *androidEnv {
	t.Helper()
	e := &androidEnv{attestEnv: newAttestEnv(t, lifetime, 0, 0), g: &fakePlayIntegrity{}}
	srv := httptest.NewServer(e.g)
	t.Cleanup(srv.Close)
	e.base = srv.URL
	e.setAndroid(androidConfig(t, e.base))
	return e
}

func (e *androidEnv) setAndroid(cfg playintegrity.Config) {
	e.attest.cfg.Android, e.attest.cfg.AndroidConfigured = cfg, true
	e.attest.android = playintegrity.New(cfg)
}

func androidDER(t *testing.T, k *ecdsa.PrivateKey) []byte {
	t.Helper()
	der, err := x509.MarshalPKIXPublicKey(&k.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return der
}

func androidKeyID(t *testing.T, k *ecdsa.PrivateKey) string {
	return playintegrity.KeyID(androidDER(t, k))
}

// androidToken is a fake integrity token whose verdict binds chal (std base64,
// as the challenge route returns it) and k; mut edits the payload.
func androidToken(t *testing.T, k *ecdsa.PrivateKey, chal string, mut func(p map[string]map[string]any)) string {
	t.Helper()
	raw, _ := base64.StdEncoding.DecodeString(chal)
	der := androidDER(t, k)
	p := map[string]map[string]any{
		"requestDetails": {
			"requestPackageName": androidTestPkg,
			"requestHash":        playintegrity.RequestHash(raw, playintegrity.KeyID(der), der),
			"timestampMillis":    strconv.FormatInt(time.Now().UnixMilli(), 10),
		},
		"appIntegrity":    {"appRecognitionVerdict": "PLAY_RECOGNIZED", "packageName": androidTestPkg},
		"deviceIntegrity": {"deviceRecognitionVerdict": []string{"MEETS_DEVICE_INTEGRITY"}},
	}
	if mut != nil {
		mut(p)
	}
	b, _ := json.Marshal(p)
	return base64.RawURLEncoding.EncodeToString(b)
}

func (e *androidEnv) enrollAndroid(k *ecdsa.PrivateKey, chal, token, pass string) *httptest.ResponseRecorder {
	req := map[string]string{
		"kind": "android", "key_id": androidKeyID(e.t, k), "challenge": chal,
		"public_key": base64.StdEncoding.EncodeToString(androidDER(e.t, k)), "integrity_token": token,
	}
	if pass != "" {
		req["pass"] = pass
	}
	body, _ := json.Marshal(req)
	return e.do("localhost", attestEnrollPath, string(body), nil)
}

// androidAssertion is the Keystore wire format playintegrity.VerifyAssertion
// checks: counterBE ‖ ECDSA-DER over SHA256(clientDataHash ‖ counterBE).
func androidAssertion(t *testing.T, k *ecdsa.PrivateKey, counter uint32, clientDataHash []byte) string {
	t.Helper()
	cb := binary.BigEndian.AppendUint32(nil, counter)
	digest := sha256.Sum256(append(append([]byte{}, clientDataHash...), cb...))
	sig, err := ecdsa.SignASN1(rand.Reader, k, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(append(cb, sig...))
}

func (e *androidEnv) androidChat(k *ecdsa.PrivateKey, counter uint32, chal string) *httptest.ResponseRecorder {
	raw, _ := base64.StdEncoding.DecodeString(chal)
	rh := sha256.Sum256([]byte(attestChatPath + "\n" + attestChatBody))
	cdh := sha256.Sum256(append(raw, rh[:]...))
	return e.do("localhost", attestChatPath, attestChatBody, map[string]string{
		"X-Attest-Key-Id": androidKeyID(e.t, k), "X-Attest-Challenge": chal,
		"X-Attest-Assertion": androidAssertion(e.t, k, counter, cdh[:]),
	})
}

func (e *androidEnv) androidFood(k *ecdsa.PrivateKey, counter uint32, chal, path string) *httptest.ResponseRecorder {
	raw, _ := base64.StdEncoding.DecodeString(chal)
	rh := sha256.Sum256([]byte(path + "\n"))
	cdh := sha256.Sum256(append(raw, rh[:]...))
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Host = "localhost"
	req.Header.Set("X-Attest-Key-Id", androidKeyID(e.t, k))
	req.Header.Set("X-Attest-Challenge", chal)
	req.Header.Set("X-Attest-Assertion", androidAssertion(e.t, k, counter, cdh[:]))
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	return rec
}

func TestAttestEnrollAndroid(t *testing.T) {
	ctx := context.Background()

	// An iOS-only deploy refuses Android enrollment like a trial that is off.
	ios := &androidEnv{attestEnv: newAttestEnv(t, 3, 0, 0)}
	k := attestKey(t)
	c := ios.challenge()
	wantErr(t, ios.enrollAndroid(k, c, androidToken(t, k, c, nil), ""), http.StatusServiceUnavailable, "trial_not_configured")

	e := newAndroidEnv(t, 3)
	c = e.challenge()
	rec := e.enrollAndroid(k, c, androidToken(t, k, c, nil), "")
	pass := passOf(rec)
	if rec.Code != http.StatusOK || pass == "" || !strings.Contains(rec.Body.String(), `"remaining":3`) || rec.Header().Get("X-Attest-Challenge") == "" {
		t.Fatalf("grant: %d %s", rec.Code, rec.Body.String())
	}
	in, err := e.store.AttestInstall(ctx, androidKeyID(t, k))
	if err != nil || in.Kind != cloudstore.AttestKindAndroid || in.Env != playintegrity.VerdictPlayRecognized || in.BucketID != in.KeyID {
		t.Fatalf("row: %+v %v", in, err)
	}
	// Idempotent re-enroll: same key, no new pass.
	c = e.challenge()
	if rec := e.enrollAndroid(k, c, androidToken(t, k, c, nil), ""); rec.Code != http.StatusOK || passOf(rec) != "" {
		t.Fatalf("re-enroll: %d %s", rec.Code, rec.Body.String())
	}
	// A consumed challenge is refused before Google is asked.
	wantErr(t, e.enrollAndroid(k, c, androidToken(t, k, c, nil), ""), http.StatusBadRequest, "challenge_invalid")

	k2 := attestKey(t)
	for name, mut := range map[string]func(p map[string]map[string]any){
		"wrong package":       func(p map[string]map[string]any) { p["requestDetails"]["requestPackageName"] = "ai.example.other" },
		"wrong app package":   func(p map[string]map[string]any) { p["appIntegrity"]["packageName"] = "ai.example.other" },
		"wrong request hash":  func(p map[string]map[string]any) { p["requestDetails"]["requestHash"] = "AAAA" },
		"stale":               func(p map[string]map[string]any) { p["requestDetails"]["timestampMillis"] = "1000" },
		"device verdict":      func(p map[string]map[string]any) { p["deviceIntegrity"]["deviceRecognitionVerdict"] = []string{} },
		"unrecognized (off)":  func(p map[string]map[string]any) { p["appIntegrity"]["appRecognitionVerdict"] = "UNRECOGNIZED_VERSION" },
		"unevaluated":         func(p map[string]map[string]any) { p["appIntegrity"]["appRecognitionVerdict"] = "UNEVALUATED" },
		"token for other key": nil,
	} {
		c := e.challenge()
		tok := androidToken(t, k2, c, mut)
		if mut == nil {
			tok = androidToken(t, k, c, nil)
		}
		if rec := e.enrollAndroid(k2, c, tok, ""); rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "attestation_invalid") {
			t.Fatalf("%s: %d %s", name, rec.Code, rec.Body.String())
		}
	}
	// Google cannot decode the token (400) → 401; Google down → 503, fail closed.
	wantErr(t, e.enrollAndroid(k2, e.challenge(), "not-a-token!", ""), http.StatusUnauthorized, "attestation_invalid")
	e.g.status.Store(http.StatusInternalServerError)
	c = e.challenge()
	wantErr(t, e.enrollAndroid(k2, c, androidToken(t, k2, c, nil), ""), http.StatusServiceUnavailable, "trial_unavailable")
	e.g.status.Store(0)
	if _, err := e.store.AttestInstall(ctx, androidKeyID(t, k2)); err == nil {
		t.Fatal("a refused enroll stored a row")
	}
	// A key id that is not the key's own is refused.
	c = e.challenge()
	body, _ := json.Marshal(map[string]string{
		"kind": "android", "key_id": androidKeyID(t, k), "challenge": c,
		"public_key": base64.StdEncoding.EncodeToString(androidDER(t, k2)), "integrity_token": androidToken(t, k2, c, nil),
	})
	wantErr(t, e.do("localhost", attestEnrollPath, string(body), nil), http.StatusUnauthorized, "attestation_invalid")
	wantErr(t, e.do("localhost", attestEnrollPath, `{"kind":"windows","key_id":"x"}`, nil), http.StatusBadRequest, "invalid_json")

	// UNRECOGNIZED_VERSION is accepted once listed (a sideload test window),
	// and the row says so.
	e.setAndroid(androidConfig(t, e.base, "PLAY_RECOGNIZED", "UNRECOGNIZED_VERSION"))
	c = e.challenge()
	unrec := func(p map[string]map[string]any) { p["appIntegrity"]["appRecognitionVerdict"] = "UNRECOGNIZED_VERSION" }
	if rec := e.enrollAndroid(k2, c, androidToken(t, k2, c, unrec), ""); rec.Code != http.StatusOK {
		t.Fatalf("listed unrecognized: %d %s", rec.Code, rec.Body.String())
	}
	if in, _ := e.store.AttestInstall(ctx, androidKeyID(t, k2)); in == nil || in.Env != "UNRECOGNIZED_VERSION" {
		t.Fatalf("unrecognized row: %+v", in)
	}

	// The reinstall: a new key presenting the pass rejoins the bucket.
	k3 := attestKey(t)
	c = e.challenge()
	if rec := e.enrollAndroid(k3, c, androidToken(t, k3, c, nil), pass); rec.Code != http.StatusOK || passOf(rec) != "" {
		t.Fatalf("rejoin: %d %s", rec.Code, rec.Body.String())
	}
	if in, _ := e.store.AttestInstall(ctx, androidKeyID(t, k3)); in == nil || in.BucketID != androidKeyID(t, k) || in.Kind != cloudstore.AttestKindAndroid {
		t.Fatalf("rejoined row: %+v", in)
	}
	c = e.challenge()
	wantErr(t, e.enrollAndroid(attestKey(t), c, "", "x.y"), http.StatusBadRequest, "invalid_json")

	// An Android-only deploy refuses the iOS body.
	e.attest.cfg.Configured = false
	wantErr(t, e.enroll(attestKey(t), attestTestAppID, e.challenge(), "tok"), http.StatusServiceUnavailable, "trial_not_configured")
}

func TestAttestChatAndroidAssertion(t *testing.T) {
	e := newAndroidEnv(t, 5)
	k := attestKey(t)
	c := e.challenge()
	if rec := e.enrollAndroid(k, c, androidToken(t, k, c, nil), ""); rec.Code != http.StatusOK {
		t.Fatalf("enroll: %d %s", rec.Code, rec.Body.String())
	}
	if rec := e.androidChat(k, 1, e.challenge()); rec.Code != http.StatusOK || rec.Header().Get("X-Trial-Remaining") != "4" {
		t.Fatalf("chat: %d %s", rec.Code, rec.Body.String())
	}
	wantErr(t, e.androidChat(k, 1, e.challenge()), http.StatusUnauthorized, "assertion_invalid") // counter replay
	// An App Attest-format assertion under the Android key id is refused.
	{
		chal := e.challenge()
		raw, _ := base64.StdEncoding.DecodeString(chal)
		rh := sha256.Sum256([]byte(attestChatPath + "\n" + attestChatBody))
		cdh := sha256.Sum256(append(raw, rh[:]...))
		wantErr(t, e.do("localhost", attestChatPath, attestChatBody, map[string]string{
			"X-Attest-Key-Id": androidKeyID(t, k), "X-Attest-Challenge": chal, "X-Attest-Assertion": fakeAssertion(t, k, 9, cdh[:]),
		}), http.StatusUnauthorized, "assertion_invalid")
	}
	// Food rides the same assertion.
	if rec := e.androidFood(k, 2, e.challenge(), "/api/attest/food/search?q=oats"); rec.Code != http.StatusOK {
		t.Fatalf("food: %d %s", rec.Code, rec.Body.String())
	}
	// Two concurrent requests with the same counter: exactly one 200 (the
	// store's compare-and-set).
	c1, c2 := e.challenge(), e.challenge()
	var wg sync.WaitGroup
	codes := make([]int, 2)
	for i, c := range []string{c1, c2} {
		wg.Add(1)
		go func() { defer wg.Done(); codes[i] = e.androidChat(k, 7, c).Code }()
	}
	wg.Wait()
	if (codes[0] == 200) == (codes[1] == 200) {
		t.Fatalf("concurrent same counter: %v", codes)
	}
	// Android switched off: its installs answer like the trial being off,
	// while iOS installs keep working.
	ik := attestKey(t)
	if rec := e.enroll(ik, attestTestAppID, e.challenge(), "tok"); rec.Code != http.StatusOK {
		t.Fatalf("ios enroll: %d %s", rec.Code, rec.Body.String())
	}
	e.attest.cfg.AndroidConfigured = false
	wantErr(t, e.androidChat(k, 8, e.challenge()), http.StatusServiceUnavailable, "trial_not_configured")
	if rec := e.chat(ik, 1, e.challenge(), attestChatBody, attestChatBody); rec.Code != http.StatusOK {
		t.Fatalf("ios chat: %d %s", rec.Code, rec.Body.String())
	}
}

func TestAttestCORSOrigins(t *testing.T) {
	e := newAttestEnv(t, 3, 0, 0)
	for origin, allowed := range map[string]bool{localAppOrigin: true, androidLocalOrigin: true, "https://evil.example": false} {
		req := httptest.NewRequest(http.MethodOptions, attestEnrollPath, nil)
		req.Host = "localhost"
		req.Header.Set("Origin", origin)
		rec := httptest.NewRecorder()
		e.h.ServeHTTP(rec, req)
		got := rec.Header().Get("Access-Control-Allow-Origin")
		if allowed && (rec.Code != http.StatusNoContent || got != origin || !strings.Contains(rec.Header().Get("Access-Control-Allow-Headers"), "X-Attest-Assertion")) {
			t.Fatalf("%s preflight: %d %v", origin, rec.Code, rec.Header())
		}
		if !allowed && got != "" {
			t.Fatalf("%s allowed: %v", origin, rec.Header())
		}
	}
}

func TestAttestConfigFromEnvAndroid(t *testing.T) {
	rk, _ := rsa.GenerateKey(rand.Reader, 2048)
	der, _ := x509.MarshalPKCS8PrivateKey(rk)
	sa, _ := json.Marshal(map[string]string{"type": "service_account", "client_email": "v@example.iam.gserviceaccount.com",
		"private_key": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))})
	dir := t.TempDir()
	saFile, badFile := filepath.Join(dir, "sa.json"), filepath.Join(dir, "bad.json")
	_ = os.WriteFile(saFile, sa, 0o600)
	_ = os.WriteFile(badFile, []byte(`{"client_email":"x"}`), 0o600)

	cfg, err := AttestConfigFromEnv()
	if err != nil || cfg.AndroidConfigured {
		t.Fatalf("unset: %+v %v", cfg, err)
	}
	for name, env := range map[string][2]string{"package only": {androidTestPkg, ""}, "file only": {"", saFile}} {
		t.Setenv("PLAY_INTEGRITY_PACKAGE_NAME", env[0])
		t.Setenv("PLAY_INTEGRITY_SERVICE_ACCOUNT_FILE", env[1])
		if _, err := AttestConfigFromEnv(); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
	t.Setenv("PLAY_INTEGRITY_PACKAGE_NAME", androidTestPkg)
	t.Setenv("PLAY_INTEGRITY_SERVICE_ACCOUNT_FILE", filepath.Join(dir, "missing.json"))
	if _, err := AttestConfigFromEnv(); err == nil || !strings.Contains(err.Error(), "PLAY_INTEGRITY_SERVICE_ACCOUNT_FILE") {
		t.Fatalf("missing file: %v", err)
	}
	t.Setenv("PLAY_INTEGRITY_SERVICE_ACCOUNT_FILE", badFile)
	if _, err := AttestConfigFromEnv(); err == nil || !strings.Contains(err.Error(), "PLAY_INTEGRITY_SERVICE_ACCOUNT_FILE") {
		t.Fatalf("bad file: %v", err)
	}
	t.Setenv("PLAY_INTEGRITY_SERVICE_ACCOUNT_FILE", saFile)
	cfg, err = AttestConfigFromEnv()
	if err != nil || !cfg.AndroidConfigured || cfg.Configured || cfg.Android.PackageName != androidTestPkg ||
		strings.Join(cfg.Android.AcceptAppVerdicts, ",") != "PLAY_RECOGNIZED" || len(cfg.Android.CertDigests) != 0 {
		t.Fatalf("configured: %+v %v", cfg.Android.AcceptAppVerdicts, err)
	}
	t.Setenv("PLAY_INTEGRITY_ACCEPT_APP_VERDICTS", "PLAY_RECOGNIZED, UNRECOGNIZED_VERSION")
	if cfg, err := AttestConfigFromEnv(); err != nil || len(cfg.Android.AcceptAppVerdicts) != 2 {
		t.Fatalf("verdicts: %+v %v", cfg.Android.AcceptAppVerdicts, err)
	}
	t.Setenv("PLAY_INTEGRITY_ACCEPT_APP_VERDICTS", "UNEVALUATED")
	if _, err := AttestConfigFromEnv(); err == nil {
		t.Fatal("UNEVALUATED accepted")
	}
}

// withRecall is an androidToken mutator setting deviceIntegrity.deviceRecall.
func withRecall(values map[string]any) func(p map[string]map[string]any) {
	return func(p map[string]map[string]any) {
		p["deviceIntegrity"]["deviceRecall"] = map[string]any{"values": values, "writeDates": map[string]any{}}
	}
}

// Device recall, the DeviceCheck twin (bd med-nt9p.32.8.6).
func TestAttestEnrollAndroidDeviceRecall(t *testing.T) {
	ctx := context.Background()
	both := map[string]any{"bitFirst": true, "bitSecond": true}
	var logs bytes.Buffer
	captureSlog(t, slog.NewTextHandler(&logs, nil))

	// Flag off: the bits are ignored, nothing is written — today's behaviour.
	e := newAndroidEnv(t, 3)
	k := attestKey(t)
	c := e.challenge()
	if rec := e.enrollAndroid(k, c, androidToken(t, k, c, withRecall(both)), ""); rec.Code != http.StatusOK || passOf(rec) == "" {
		t.Fatalf("flag off: %d %s", rec.Code, rec.Body.String())
	}
	if n := len(e.g.recallWrites()); n != 0 {
		t.Fatalf("flag off wrote recall %d times", n)
	}

	e = newAndroidEnv(t, 3)
	e.attest.cfg.AndroidRecall = true
	noRow := func(name string, k *ecdsa.PrivateKey) {
		t.Helper()
		if _, err := e.store.AttestInstall(ctx, androidKeyID(t, k)); err == nil {
			t.Fatalf("%s stored a row", name)
		}
		if _, err := e.store.AttestBucketPassHash(ctx, androidKeyID(t, k)); err == nil {
			t.Fatalf("%s left a bucket", name)
		}
	}
	// Flag on, recall absent from the verdict (Console opt-in missing): fail closed.
	k = attestKey(t)
	c = e.challenge()
	wantErr(t, e.enrollAndroid(k, c, androidToken(t, k, c, nil), ""), http.StatusServiceUnavailable, "trial_unavailable")
	noRow("absent", k)
	if !strings.Contains(logs.String(), "enable Device recall in Play Console") {
		t.Fatalf("no operator hint logged: %s", logs.String())
	}
	// Unevaluated ({}): grants, Google refuses the write, rolled back.
	e.g.writeStatus.Store(http.StatusBadRequest)
	c = e.challenge()
	wantErr(t, e.enrollAndroid(k, c, androidToken(t, k, c, withRecall(map[string]any{})), ""), http.StatusServiceUnavailable, "trial_unavailable")
	noRow("unevaluated", k)
	e.g.writeStatus.Store(0)

	// No bit set: the first grant, write {true,false,false}.
	c = e.challenge()
	rec := e.enrollAndroid(k, c, androidToken(t, k, c, withRecall(map[string]any{})), "")
	pass := passOf(rec)
	if rec.Code != http.StatusOK || pass == "" {
		t.Fatalf("first grant: %d %s", rec.Code, rec.Body.String())
	}
	// bitFirst only: the second pass-less grant, write {true,true,bitThird}.
	k2 := attestKey(t)
	c = e.challenge()
	if rec := e.enrollAndroid(k2, c, androidToken(t, k2, c, withRecall(map[string]any{"bitFirst": true, "bitThird": true})), ""); rec.Code != http.StatusOK || passOf(rec) == "" {
		t.Fatalf("second grant: %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(logs.String(), "second_grant=true") {
		t.Fatalf("second grant not logged: %s", logs.String())
	}
	// Both bits: refused, nothing stored, nothing written.
	k3 := attestKey(t)
	c = e.challenge()
	wantErr(t, e.enrollAndroid(k3, c, androidToken(t, k3, c, withRecall(both)), ""), http.StatusForbidden, "trial_already_used")
	noRow("both bits", k3)
	// A pass rejoin never touches recall, whatever the bits.
	c = e.challenge()
	if rec := e.enrollAndroid(k3, c, androidToken(t, k3, c, withRecall(both)), pass); rec.Code != http.StatusOK {
		t.Fatalf("rejoin: %d %s", rec.Code, rec.Body.String())
	}
	got, _ := json.Marshal(e.g.recallWrites())
	if want := `[{"bitFirst":true,"bitSecond":false,"bitThird":false},{"bitFirst":true,"bitSecond":false,"bitThird":false},{"bitFirst":true,"bitSecond":true,"bitThird":true}]`; string(got) != want {
		t.Fatalf("writes = %s, want %s", got, want)
	}
	if strings.Contains(logs.String(), "ya29") || strings.Contains(logs.String(), pass) {
		t.Fatal("a secret reached the log")
	}
}

func TestAttestConfigFromEnvAndroidRecall(t *testing.T) {
	t.Setenv("PLAY_INTEGRITY_DEVICE_RECALL", "1")
	if _, err := AttestConfigFromEnv(); err == nil || !strings.Contains(err.Error(), "PLAY_INTEGRITY_DEVICE_RECALL") {
		t.Fatalf("recall alone: %v", err)
	}
	t.Setenv("PLAY_INTEGRITY_DEVICE_RECALL", "yes please")
	if _, err := AttestConfigFromEnv(); err == nil {
		t.Fatal("bad value accepted")
	}
	t.Setenv("PLAY_INTEGRITY_DEVICE_RECALL", "0")
	if cfg, err := AttestConfigFromEnv(); err != nil || cfg.AndroidRecall {
		t.Fatalf("off alone: %+v %v", cfg.AndroidRecall, err)
	}
	rk, _ := rsa.GenerateKey(rand.Reader, 2048)
	der, _ := x509.MarshalPKCS8PrivateKey(rk)
	sa, _ := json.Marshal(map[string]string{"type": "service_account", "client_email": "v@example.iam.gserviceaccount.com",
		"private_key": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))})
	saFile := filepath.Join(t.TempDir(), "sa.json")
	_ = os.WriteFile(saFile, sa, 0o600)
	t.Setenv("PLAY_INTEGRITY_PACKAGE_NAME", androidTestPkg)
	t.Setenv("PLAY_INTEGRITY_SERVICE_ACCOUNT_FILE", saFile)
	if cfg, err := AttestConfigFromEnv(); err != nil || !cfg.AndroidConfigured || cfg.AndroidRecall {
		t.Fatalf("configured, recall 0: %+v %v", cfg.AndroidRecall, err)
	}
	t.Setenv("PLAY_INTEGRITY_DEVICE_RECALL", "true")
	if cfg, err := AttestConfigFromEnv(); err != nil || !cfg.AndroidRecall {
		t.Fatalf("configured, recall on: %+v %v", cfg.AndroidRecall, err)
	}
}
