package cloudserver

import (
	"context"
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
	"encoding/pem"
	"io"
	"math/big"
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

	"github.com/fxamacker/cbor/v2"
	"github.com/korjavin/medicationtrackerbot/internal/appattest"
	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

// Fakes mirror Apple's contract the way internal/appattest's own tests do
// (appattest_test.go fakeCA, devicecheck_test.go fakeDeviceCheck): a
// throwaway root stands in for the Apple App Attestation Root CA, and an
// httptest server answers DeviceCheck's query/update two-bit API. No Apple
// network in CI.

const attestTestAppID = "ABCDE12345.ai.example.app"

func attestKey(t *testing.T) *ecdsa.PrivateKey {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func attestIssue(t *testing.T, tmpl *x509.Certificate, pub *ecdsa.PublicKey, parent *x509.Certificate, parentKey *ecdsa.PrivateKey) *x509.Certificate {
	t.Helper()
	tmpl.SerialNumber = big.NewInt(time.Now().UnixNano())
	tmpl.NotBefore, tmpl.NotAfter = time.Now().Add(-time.Hour), time.Now().Add(24*time.Hour)
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

type attestCA struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
	pool *x509.CertPool
}

func newAttestCA(t *testing.T) attestCA {
	rootKey, interKey := attestKey(t), attestKey(t)
	root := attestIssue(t, &x509.Certificate{Subject: pkix.Name{CommonName: "Fake root"}, IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}, &rootKey.PublicKey, nil, rootKey)
	inter := attestIssue(t, &x509.Certificate{Subject: pkix.Name{CommonName: "Fake CA 1"}, IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}, &interKey.PublicKey, root, rootKey)
	pool := x509.NewCertPool()
	pool.AddCert(root)
	return attestCA{cert: inter, key: interKey, pool: pool}
}

func attestKeyID(t *testing.T, k *ecdsa.PrivateKey) string {
	p, err := k.PublicKey.ECDH()
	if err != nil {
		t.Fatal(err)
	}
	h := sha256.Sum256(p.Bytes())
	return base64.StdEncoding.EncodeToString(h[:])
}

// fakeAttestation builds an attestation object for k over challenge (raw bytes).
func fakeAttestation(t *testing.T, ca attestCA, k *ecdsa.PrivateKey, appID string, challenge []byte) []byte {
	t.Helper()
	keyID, _ := base64.StdEncoding.DecodeString(attestKeyID(t, k))
	rp := sha256.Sum256([]byte(appID))
	ad := append(append([]byte{}, rp[:]...), 0x40)
	ad = binary.BigEndian.AppendUint32(ad, 0)
	ad = append(ad, append([]byte("appattest"), make([]byte, 7)...)...)
	ad = binary.BigEndian.AppendUint16(ad, uint16(len(keyID)))
	ad = append(ad, keyID...)
	cdh := sha256.Sum256(challenge)
	nonce := sha256.Sum256(append(append([]byte{}, ad...), cdh[:]...))
	ext, _ := asn1.Marshal(struct {
		Nonce []byte `asn1:"tag:1,explicit"`
	}{nonce[:]})
	leaf := attestIssue(t, &x509.Certificate{Subject: pkix.Name{CommonName: "credCert"}, ExtraExtensions: []pkix.Extension{{Id: asn1.ObjectIdentifier{1, 2, 840, 113635, 100, 8, 2}, Value: ext}}}, &k.PublicKey, ca.cert, ca.key)
	b, err := cbor.Marshal(map[string]any{"fmt": "apple-appattest", "attStmt": map[string]any{"x5c": [][]byte{leaf.Raw, ca.cert.Raw}, "receipt": []byte("r")}, "authData": ad})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// fakeAssertion signs SHA256(authenticatorData || clientDataHash) like DCAppAttestService.generateAssertion.
func fakeAssertion(t *testing.T, k *ecdsa.PrivateKey, counter uint32, clientDataHash []byte) string {
	t.Helper()
	rp := sha256.Sum256([]byte(attestTestAppID))
	ad := binary.BigEndian.AppendUint32(append(append([]byte{}, rp[:]...), 0x00), counter)
	nonce := sha256.Sum256(append(append([]byte{}, ad...), clientDataHash...))
	digest := sha256.Sum256(nonce[:])
	sig, err := ecdsa.SignASN1(rand.Reader, k, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	b, _ := cbor.Marshal(map[string]any{"signature": sig, "authenticatorData": ad})
	return base64.StdEncoding.EncodeToString(b)
}

type attestFakeDC struct {
	mu         sync.Mutex
	bits       map[string][2]bool
	fail       bool
	failUpdate bool // only the bit write fails (enroll rollback path)
	calls      int
}

func (f *attestFakeDC) state(token string) ([2]bool, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.bits[token], f.calls
}

func (f *attestFakeDC) setFail(v bool) { f.mu.Lock(); f.fail = v; f.mu.Unlock() }

func (f *attestFakeDC) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req struct {
		DeviceToken string `json:"device_token"`
		Bit0, Bit1  bool
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.fail || (f.failUpdate && r.URL.Path == "/v1/update_two_bits") || !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	switch r.URL.Path {
	case "/v1/query_two_bits":
		b, ok := f.bits[req.DeviceToken]
		if !ok {
			_, _ = w.Write([]byte("Failed to find bit state"))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]bool{"bit0": b[0], "bit1": b[1]})
	case "/v1/update_two_bits":
		f.bits[req.DeviceToken] = [2]bool{req.Bit0, req.Bit1}
	}
}

type attestEnv struct {
	t        *testing.T
	h        http.Handler
	store    *cloudstore.Repo
	ca       attestCA
	dc       *attestFakeDC
	upstream atomic.Int32 // status the fake provider answers (0 = 200)
	lastBody atomic.Value
}

// newAttestEnv wires the attest API over a fake OpenAI upstream; trialCfg, if
// given, replaces the trial config (e.g. the anthropic provider).
func newAttestEnv(t *testing.T, lifetime, daily, global int, trialCfg ...TrialConfig) *attestEnv {
	t.Helper()
	e := &attestEnv{t: t, store: setupStore(t), ca: newAttestCA(t), dc: &attestFakeDC{bits: map[string][2]bool{}}}
	dcSrv := httptest.NewServer(e.dc)
	t.Cleanup(dcSrv.Close)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		e.lastBody.Store(string(b))
		if s := e.upstream.Load(); s != 0 {
			w.WriteHeader(int(s))
			return
		}
		_, _ = w.Write([]byte(`{"model":"trial-model","choices":[{"message":{"content":"ok"}}]}`))
	}))
	t.Cleanup(up.Close)
	tc := TrialConfig{
		OpenAIAPIKey: "sk-trial", OpenAIURL: up.URL, OpenAIModel: "trial-model",
		VisionAPIKey: "sk-trial", VisionURL: up.URL, VisionModel: "trial-vision-model",
		RatePerMinute: 1000, DailyGlobal: global,
	}
	if len(trialCfg) > 0 {
		tc = trialCfg[0]
	}
	trial := NewTrialProxyAPI(e.store, "test-session-secret-at-least-32-bytes-long", tc)
	cfg := AttestConfig{Configured: true, Lifetime: lifetime, Daily: daily, AppAttest: appattest.Config{
		AppID: attestTestAppID, Roots: e.ca.pool,
		DeviceCheck: appattest.DeviceCheckConfig{KeyID: "K", TeamID: "T", PrivateKey: attestKey(t), BaseURL: dcSrv.URL},
	}}
	mux := http.NewServeMux()
	NewAttestAPI(e.store, trial, cfg).RegisterRoutes(mux)
	e.h = New("localhost", e.store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)
	return e
}

func (e *attestEnv) do(host, path, body string, hdr map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Host = host
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	return rec
}

func (e *attestEnv) challenge() string {
	rec := e.do("localhost", attestChallengePath, "", nil)
	var out struct{ Challenge string }
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &out) != nil || out.Challenge == "" {
		e.t.Fatalf("challenge: %d %s", rec.Code, rec.Body.String())
	}
	return out.Challenge
}

func (e *attestEnv) enroll(k *ecdsa.PrivateKey, appID, chal, token string) *httptest.ResponseRecorder {
	raw, _ := base64.StdEncoding.DecodeString(chal)
	body, _ := json.Marshal(map[string]string{
		"key_id": attestKeyID(e.t, k), "challenge": chal, "device_token": token,
		"attestation": base64.StdEncoding.EncodeToString(fakeAttestation(e.t, e.ca, k, appID, raw)),
	})
	return e.do("localhost", attestEnrollPath, string(body), nil)
}

// chat signs signedBody but sends body (equal unless a test forges it).
func (e *attestEnv) chat(k *ecdsa.PrivateKey, counter uint32, chal, body, signedBody string) *httptest.ResponseRecorder {
	return e.chatAt(k, counter, chal, attestChatPath, attestChatPath, body, signedBody)
}

// chatAt posts to path but signs signedPath — the client's clientDataHash
// input SHA256(challenge || SHA256(pathAndQuery || "\n" || body)).
func (e *attestEnv) chatAt(k *ecdsa.PrivateKey, counter uint32, chal, path, signedPath, body, signedBody string) *httptest.ResponseRecorder {
	raw, _ := base64.StdEncoding.DecodeString(chal)
	rh := sha256.Sum256([]byte(signedPath + "\n" + signedBody))
	cdh := sha256.Sum256(append(raw, rh[:]...))
	return e.do("localhost", path, body, map[string]string{
		"X-Attest-Key-Id": attestKeyID(e.t, k), "X-Attest-Challenge": chal,
		"X-Attest-Assertion": fakeAssertion(e.t, k, counter, cdh[:]),
	})
}

const attestChatBody = `{"model":"x","n":8,"max_tokens":5000,"messages":[{"role":"user","content":"hi"}]}`

func wantErr(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	var out struct{ Error, Scope string }
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if rec.Code != status || out.Error != code {
		t.Fatalf("got %d %s, want %d %s", rec.Code, rec.Body.String(), status, code)
	}
}

func TestAttestEnroll(t *testing.T) {
	e := newAttestEnv(t, 3, 0, 0)
	k := attestKey(t)
	chal := e.challenge()
	rec := e.enroll(k, attestTestAppID, chal, "tok-1")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"remaining":3`) || rec.Header().Get("X-Attest-Challenge") == "" {
		t.Fatalf("enroll: %d %s", rec.Code, rec.Body.String())
	}
	if bits, _ := e.dc.state("tok-1"); bits != [2]bool{true, false} {
		t.Fatalf("bit0 not set: %v", bits)
	}
	wantErr(t, e.enroll(k, attestTestAppID, chal, "tok-1"), http.StatusBadRequest, "challenge_invalid")

	// Re-enroll the same key: 200, no DeviceCheck call.
	_, calls := e.dc.state("")
	rec = e.enroll(k, attestTestAppID, e.challenge(), "tok-1")
	if _, after := e.dc.state(""); rec.Code != http.StatusOK || after != calls {
		t.Fatalf("re-enroll: %d calls %d→%d", rec.Code, calls, after)
	}
	// Second key on the same device: bit0 already set.
	wantErr(t, e.enroll(attestKey(t), attestTestAppID, e.challenge(), "tok-1"), http.StatusForbidden, "trial_already_used")
	// Two new keys from one device racing: exactly one grant.
	var wg sync.WaitGroup
	codes := make([]int, 2)
	for i := range codes {
		k, c := attestKey(t), e.challenge()
		wg.Add(1)
		go func() { defer wg.Done(); codes[i] = e.enroll(k, attestTestAppID, c, "tok-race").Code }()
	}
	wg.Wait()
	if (codes[0] == 200) == (codes[1] == 200) {
		t.Fatalf("concurrent same-device enroll: %v", codes)
	}
	wantErr(t, e.enroll(attestKey(t), "OTHER.ai.example.app", e.challenge(), "tok-2"), http.StatusUnauthorized, "attestation_invalid")

	e.dc.setFail(true)
	k3 := attestKey(t)
	wantErr(t, e.enroll(k3, attestTestAppID, e.challenge(), "tok-3"), http.StatusServiceUnavailable, "trial_unavailable")
	if _, err := e.store.AttestInstall(context.Background(), attestKeyID(t, k3)); err == nil {
		t.Fatal("row stored despite DeviceCheck outage")
	}

	// The bit write fails after the insert: the row is rolled back, 503.
	e.dc.setFail(false)
	e.dc.mu.Lock()
	e.dc.failUpdate = true
	e.dc.mu.Unlock()
	k4 := attestKey(t)
	wantErr(t, e.enroll(k4, attestTestAppID, e.challenge(), "tok-4"), http.StatusServiceUnavailable, "trial_unavailable")
	if _, err := e.store.AttestInstall(context.Background(), attestKeyID(t, k4)); err == nil {
		t.Fatal("row kept after the DeviceCheck bit write failed")
	}

	big := `{"key_id":"` + strings.Repeat("A", maxAttestEnrollBytes) + `"}`
	wantErr(t, e.do("localhost", attestEnrollPath, big, nil), http.StatusRequestEntityTooLarge, "body_too_large")
}

func TestAttestChat(t *testing.T) {
	e := newAttestEnv(t, 3, 0, 0)
	k := attestKey(t)
	rec := e.enroll(k, attestTestAppID, e.challenge(), "tok")
	chal := rec.Header().Get("X-Attest-Challenge")

	rec = e.chat(k, 1, chal, attestChatBody, attestChatBody)
	if rec.Code != http.StatusOK || rec.Header().Get("X-Trial-Remaining") != "2" || strings.Contains(rec.Body.String(), "trial-model") {
		t.Fatalf("chat: %d %s remaining=%s", rec.Code, rec.Body.String(), rec.Header().Get("X-Trial-Remaining"))
	}
	var fwd map[string]any
	_ = json.Unmarshal([]byte(e.lastBody.Load().(string)), &fwd)
	if fwd["model"] != "trial-model" || fwd["max_tokens"] != float64(attestMaxTokens) || fwd["n"] != nil {
		t.Fatalf("forwarded: %v", fwd)
	}
	next := rec.Header().Get("X-Attest-Challenge")
	wantErr(t, e.chat(k, 2, chal, attestChatBody, attestChatBody), http.StatusBadRequest, "challenge_invalid")
	wantErr(t, e.chat(attestKey(t), 1, e.challenge(), attestChatBody, attestChatBody), http.StatusUnauthorized, "install_unknown")
	wantErr(t, e.chat(k, 2, next, `{"messages":[]}`, attestChatBody), http.StatusUnauthorized, "assertion_invalid")
	wantErr(t, e.chat(k, 1, e.challenge(), attestChatBody, attestChatBody), http.StatusUnauthorized, "assertion_invalid") // counter replay
	stream := `{"stream":true,"messages":[]}`
	wantErr(t, e.chat(k, 5, e.challenge(), stream, stream), http.StatusBadRequest, "stream_unsupported")

	// Upstream 500 → 502 and the lifetime request is refunded.
	e.upstream.Store(500)
	rec = e.chat(k, 6, e.challenge(), attestChatBody, attestChatBody)
	if rec.Code != http.StatusBadGateway || rec.Header().Get("X-Trial-Remaining") != "2" {
		t.Fatalf("upstream 500: %d remaining=%s", rec.Code, rec.Header().Get("X-Trial-Remaining"))
	}
	e.upstream.Store(0)

	// Two concurrent requests with the same counter: exactly one 200.
	c1, c2 := e.challenge(), e.challenge()
	var wg sync.WaitGroup
	codes := make([]int, 2)
	for i, c := range []string{c1, c2} {
		wg.Add(1)
		go func() { defer wg.Done(); codes[i] = e.chat(k, 7, c, attestChatBody, attestChatBody).Code }()
	}
	wg.Wait()
	if (codes[0] == 200) == (codes[1] == 200) {
		t.Fatalf("concurrent same counter: %v", codes)
	}
	if rec := e.chat(k, 8, e.challenge(), attestChatBody, attestChatBody); rec.Code != http.StatusOK {
		t.Fatalf("third: %d", rec.Code)
	}
	rec = e.chat(k, 9, e.challenge(), attestChatBody, attestChatBody)
	wantErr(t, rec, http.StatusTooManyRequests, "trial_budget_exhausted")
	if !strings.Contains(rec.Body.String(), `"scope":"install"`) {
		t.Fatalf("scope: %s", rec.Body.String())
	}
}

func TestAttestChatDailyAndGlobal(t *testing.T) {
	e := newAttestEnv(t, 100, 1, 3)
	k := attestKey(t)
	e.enroll(k, attestTestAppID, e.challenge(), "tok")
	if rec := e.chat(k, 1, e.challenge(), attestChatBody, attestChatBody); rec.Code != http.StatusOK {
		t.Fatalf("first: %d", rec.Code)
	}
	rec := e.chat(k, 2, e.challenge(), attestChatBody, attestChatBody)
	wantErr(t, rec, http.StatusTooManyRequests, "trial_budget_exhausted")
	if !strings.Contains(rec.Body.String(), `"scope":"install-day"`) {
		t.Fatalf("scope: %s", rec.Body.String())
	}
	// Global budget shared with account subjects: 1 install + 2 account = 3.
	k2 := attestKey(t)
	e.enroll(k2, attestTestAppID, e.challenge(), "tok2")
	for range 2 {
		if ok, _, _ := e.store.ConsumeTrialRequest(context.Background(), "acct", time.Now(), 0, 0); !ok {
			t.Fatal("account refused")
		}
	}
	rec = e.chat(k2, 1, e.challenge(), attestChatBody, attestChatBody)
	if !strings.Contains(rec.Body.String(), `"scope":"global"`) {
		t.Fatalf("global: %d %s", rec.Code, rec.Body.String())
	}
}

func TestAttestRouting(t *testing.T) {
	// Unconfigured: every /api/attest/* route 503s, nothing else moves.
	store := setupStore(t)
	mux := http.NewServeMux()
	NewAttestAPI(store, NewTrialProxyAPI(store, "s", TrialConfig{RatePerMinute: 1}), AttestConfig{}).RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)
	for _, p := range []string{attestChallengePath, attestEnrollPath, attestChatPath} {
		req := httptest.NewRequest(http.MethodPost, p, nil)
		req.Host = "localhost"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		wantErr(t, rec, http.StatusServiceUnavailable, "trial_not_configured")
	}
	// Other base-domain /api/ paths still 404 (the forward is exact-prefix).
	req := httptest.NewRequest(http.MethodPost, "/api/trial/openai/chat/completions", nil)
	req.Host = "localhost"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("base /api/trial: %d", rec.Code)
	}
	// Account hosts never answer the anonymous trial.
	account, _ := setupInvite(t, store)
	req = httptest.NewRequest(http.MethodPost, attestChallengePath, nil)
	req.Host = account.Subdomain + ".localhost"
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("account host: %d", rec.Code)
	}
	// CORS preflight from the iOS local origin only.
	req = httptest.NewRequest(http.MethodOptions, attestChatPath, nil)
	req.Host = "localhost"
	req.Header.Set("Origin", localAppOrigin)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent || rec.Header().Get("Access-Control-Allow-Origin") != localAppOrigin ||
		!strings.Contains(rec.Header().Get("Access-Control-Allow-Headers"), "X-Attest-Assertion") {
		t.Fatalf("preflight: %d %v", rec.Code, rec.Header())
	}
}

func TestAttestConfigFromEnv(t *testing.T) {
	cfg, err := AttestConfigFromEnv()
	if err != nil || cfg.Configured || cfg.Lifetime != 200 || cfg.Daily != 50 {
		t.Fatalf("defaults: %+v %v", cfg, err)
	}
	t.Setenv("APP_ATTEST_APP_ID", attestTestAppID)
	if _, err := AttestConfigFromEnv(); err == nil {
		t.Fatal("partial config accepted")
	}
	k := attestKey(t)
	der, _ := x509.MarshalPKCS8PrivateKey(k)
	p8 := filepath.Join(t.TempDir(), "dc.p8")
	_ = os.WriteFile(p8, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600)
	t.Setenv("DEVICECHECK_KEY_ID", "K")
	t.Setenv("DEVICECHECK_TEAM_ID", "T")
	t.Setenv("DEVICECHECK_PRIVATE_KEY_FILE", p8)
	t.Setenv("TRIAL_ANON_LIFETIME_REQUESTS", strconv.Itoa(7))
	cfg, err = AttestConfigFromEnv()
	if err != nil || !cfg.Configured || cfg.Lifetime != 7 || cfg.AppAttest.Env != appattest.EnvProduction {
		t.Fatalf("configured: %+v %v", cfg, err)
	}
	t.Setenv("APP_ATTEST_ENV", "staging")
	if _, err := AttestConfigFromEnv(); err == nil || strings.Contains(err.Error(), "staging") {
		t.Fatalf("bad env: %v", err)
	}
}

func TestAttestClampMaxTokens(t *testing.T) {
	p := map[string]json.RawMessage{"max_completion_tokens": json.RawMessage(`300`)}
	if n := clampMaxTokens(p, TrialProviderAnthropic); n != 300 {
		t.Fatalf("anthropic n = %d", n)
	}
	p = map[string]json.RawMessage{}
	clampMaxTokens(p, TrialProviderOpenAI)
	if string(p["max_completion_tokens"]) != "1024" || p["max_tokens"] != nil {
		t.Fatalf("openai default: %v", p)
	}
}

// The anthropic adapter gets the anonymous cap via proxyChat; the account
// route keeps its fixed max_tokens even when a client sends a smaller one.
func TestAttestAnthropicCapIsAttestOnly(t *testing.T) {
	f := newFakeMessagesAPI(t)
	reply := `{"id":"m","model":"` + anthModel + `","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{}}`
	f.replies = []string{reply, reply}
	cfg := anthropicTrialCfg(f.srv.URL)
	cfg.RatePerMinute = 1000
	e := newAttestEnv(t, 5, 0, 0, cfg)
	k := attestKey(t)
	e.enroll(k, attestTestAppID, e.challenge(), "tok")
	if rec := e.chat(k, 1, e.challenge(), attestChatBody, attestChatBody); rec.Code != http.StatusOK {
		t.Fatalf("attest anthropic: %d %s", rec.Code, rec.Body.String())
	}
	if f.bodies[0]["max_tokens"] != float64(attestMaxTokens) {
		t.Fatalf("attest max_tokens = %v", f.bodies[0]["max_tokens"])
	}

	h, _, host, claim := newTrialTestHandlerAPI(t, anthropicTrialCfg(f.srv.URL))
	session := registerAndGetSession(t, h, host, claim)
	rec := postTrialChat(h, host, "/api/trial/openai/chat/completions", `{"max_tokens":300,"messages":[{"role":"user","content":"hi"}]}`, session)
	if rec.Code != http.StatusOK || f.bodies[1]["max_tokens"] != float64(trialAnthropicMaxTokens) {
		t.Fatalf("account route max_tokens = %v (status %d)", f.bodies[1]["max_tokens"], rec.Code)
	}
}

// bodyProbe records whether the handler read the request body.
type bodyProbe struct{ read atomic.Bool }

func (b *bodyProbe) Read(p []byte) (int, error) { b.read.Store(true); return 0, io.EOF }

// Unauthenticated input is rejected from the headers alone: the (up to
// 12 MiB) body is never read for a bogus challenge or an unenrolled key.
func TestAttestChatRejectsBeforeReadingBody(t *testing.T) {
	e := newAttestEnv(t, 5, 0, 0)
	for _, c := range []struct {
		name, chal, code string
		status           int
	}{
		{"bogus challenge", "bogus", "challenge_invalid", http.StatusBadRequest},
		{"unenrolled key", e.challenge(), "install_unknown", http.StatusUnauthorized},
	} {
		probe := &bodyProbe{}
		req := httptest.NewRequest(http.MethodPost, attestChatPath, probe)
		req.Host = "localhost"
		req.Header.Set("X-Attest-Key-Id", attestKeyID(t, attestKey(t)))
		req.Header.Set("X-Attest-Challenge", c.chal)
		req.Header.Set("X-Attest-Assertion", base64.StdEncoding.EncodeToString([]byte("x")))
		rec := httptest.NewRecorder()
		e.h.ServeHTTP(rec, req)
		wantErr(t, rec, c.status, c.code)
		if probe.read.Load() {
			t.Fatalf("%s: body was read", c.name)
		}
	}
}

// ?vision=1 is inside the signed input: flipping it after signing fails.
func TestAttestChatVisionIsSigned(t *testing.T) {
	e := newAttestEnv(t, 5, 0, 0)
	k := attestKey(t)
	e.enroll(k, attestTestAppID, e.challenge(), "tok")
	vision := attestChatPath + "?vision=1"
	wantErr(t, e.chatAt(k, 1, e.challenge(), vision, attestChatPath, attestChatBody, attestChatBody), http.StatusUnauthorized, "assertion_invalid")
	if rec := e.chatAt(k, 2, e.challenge(), vision, vision, attestChatBody, attestChatBody); rec.Code != http.StatusOK {
		t.Fatalf("signed vision: %d %s", rec.Code, rec.Body.String())
	}
	var fwd map[string]any
	_ = json.Unmarshal([]byte(e.lastBody.Load().(string)), &fwd)
	if fwd["model"] != "trial-vision-model" {
		t.Fatalf("vision model not used: %v", fwd["model"])
	}
}
