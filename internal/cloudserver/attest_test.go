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
	food     *FoodProxyAPI
	foodHits atomic.Int32 // requests the fake FastFoodDB received
	// Anonymous voice (med-o7zq.22): off until a test sets the ElevenLabs
	// config on trial and the Voice* budgets on attest.
	attest    *AttestAPI
	trial     *TrialProxyAPI
	relay     *VoiceLLMRelayAPI
	upHits    atomic.Int32
	mintFail  atomic.Bool
	mintCalls atomic.Int32
	mintQuery atomic.Value // last get_signed_url query string
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
		e.upHits.Add(1)
		if s := e.upstream.Load(); s != 0 {
			w.WriteHeader(int(s))
			return
		}
		if strings.Contains(string(b), `"stream":true`) {
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = w.Write([]byte("data: {\"model\":\"trial-model\",\"choices\":[{\"delta\":{\"content\":\"spoken answer\"}}]}\n\ndata: [DONE]\n\n"))
			return
		}
		_, _ = w.Write([]byte(`{"model":"trial-model","choices":[{"message":{"content":"ok"}}]}`))
	}))
	t.Cleanup(up.Close)
	// Fake ElevenLabs get_signed_url (the shape trial_proxy_test.go's fake answers).
	el := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		e.mintCalls.Add(1)
		e.mintQuery.Store(r.URL.RawQuery)
		if e.mintFail.Load() || r.Header.Get("xi-api-key") != "xi-trial" {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(`{"signed_url":"wss://api.elevenlabs.io/v1/convai/conversation?conversation_signature=sig"}`))
	}))
	t.Cleanup(el.Close)
	tc := TrialConfig{
		OpenAIAPIKey: "sk-trial", OpenAIURL: up.URL, OpenAIModel: "trial-model",
		VisionAPIKey: "sk-trial", VisionURL: up.URL, VisionModel: "trial-vision-model",
		RatePerMinute: 1000, DailyGlobal: global,
	}
	if len(trialCfg) > 0 {
		tc = trialCfg[0]
	}
	trial := NewTrialProxyAPI(e.store, "test-session-secret-at-least-32-bytes-long", tc)
	trial.elevenLabsSignedURLBase = el.URL
	e.trial = trial
	foodUp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		e.foodHits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"path":` + strconv.Quote(r.URL.Path) + `,"q":` + strconv.Quote(r.URL.Query().Get("q")) + `}`))
	}))
	t.Cleanup(foodUp.Close)
	e.food = NewFoodProxyAPI(e.store, "test-session-secret-at-least-32-bytes-long", foodUp.URL, "")
	cfg := AttestConfig{Configured: true, Lifetime: lifetime, Daily: daily, FoodDaily: attestDefaultFoodDaily, AppAttest: appattest.Config{
		AppID: attestTestAppID, Roots: e.ca.pool,
		DeviceCheck: appattest.DeviceCheckConfig{KeyID: "K", TeamID: "T", PrivateKey: attestKey(t), BaseURL: dcSrv.URL},
	}}
	mux := http.NewServeMux()
	e.attest = NewAttestAPI(e.store, trial, e.food, cfg)
	e.relay = NewVoiceLLMRelayAPI(e.store, "test-session-secret-at-least-32-bytes-long")
	e.attest.SetVoiceRelay(e.relay)
	e.attest.RegisterRoutes(mux)
	e.relay.RegisterRoutes(mux)
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
	return e.enrollPass(k, appID, chal, token, "")
}

// enrollPass enrolls presenting a trial pass (bd med-o7zq.26); "" sends none.
func (e *attestEnv) enrollPass(k *ecdsa.PrivateKey, appID, chal, token, pass string) *httptest.ResponseRecorder {
	raw, _ := base64.StdEncoding.DecodeString(chal)
	req := map[string]string{
		"key_id": attestKeyID(e.t, k), "challenge": chal, "device_token": token,
		"attestation": base64.StdEncoding.EncodeToString(fakeAttestation(e.t, e.ca, k, appID, raw)),
	}
	if pass != "" {
		req["pass"] = pass
	}
	body, _ := json.Marshal(req)
	return e.do("localhost", attestEnrollPath, string(body), nil)
}

// passOf is the trial pass a grant response carries ("" when none).
func passOf(rec *httptest.ResponseRecorder) string {
	var out struct{ Pass string }
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return out.Pass
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
	// bd med-ta2n.25: today's body (no "trial") is a trial grant, now saying so.
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"remaining":3`) || !strings.Contains(rec.Body.String(), `"granted":true`) || rec.Header().Get("X-Attest-Challenge") == "" {
		t.Fatalf("enroll: %d %s", rec.Code, rec.Body.String())
	}
	if bits, _ := e.dc.state("tok-1"); bits != [2]bool{true, false} {
		t.Fatalf("bit0 not set: %v", bits)
	}
	// The grant carries the bucket's pass; the server keeps only the
	// secret's SHA-256 (bd med-o7zq.26).
	pass := passOf(rec)
	bucket, secretB64, _ := strings.Cut(pass, ".")
	secret, _ := base64.RawURLEncoding.DecodeString(secretB64)
	if bucket != attestKeyID(t, k) || len(secret) < 16 {
		t.Fatalf("pass shape: %q", pass)
	}
	sum := sha256.Sum256(secret)
	if h, err := e.store.AttestBucketPassHash(context.Background(), bucket); err != nil || string(h) != string(sum[:]) {
		t.Fatalf("stored pass hash: %x %v", h, err)
	}
	wantErr(t, e.enroll(k, attestTestAppID, chal, "tok-1"), http.StatusBadRequest, "challenge_invalid")

	// Re-enroll the same key: 200, no DeviceCheck call.
	_, calls := e.dc.state("")
	rec = e.enroll(k, attestTestAppID, e.challenge(), "tok-1")
	if _, after := e.dc.state(""); rec.Code != http.StatusOK || after != calls || passOf(rec) != "" {
		t.Fatalf("re-enroll: %d calls %d→%d %s", rec.Code, calls, after, rec.Body.String())
	}
	// Second key on the same device without a pass (a wiped phone, or an
	// install from before passes): bit0 set, bit1 clear → ONE fresh bucket,
	// bit1 set.
	k2 := attestKey(t)
	rec = e.enroll(k2, attestTestAppID, e.challenge(), "tok-1")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"remaining":3`) || passOf(rec) == "" || passOf(rec) == pass {
		t.Fatalf("second grant: %d %s", rec.Code, rec.Body.String())
	}
	if bits, _ := e.dc.state("tok-1"); bits != [2]bool{true, true} {
		t.Fatalf("bit1 not set: %v", bits)
	}
	if in, _ := e.store.AttestInstall(context.Background(), attestKeyID(t, k2)); in.BucketID != attestKeyID(t, k2) {
		t.Fatalf("second grant joined a bucket: %+v", in)
	}
	// Both bits set, no pass: trial_already_used.
	wantErr(t, e.enroll(attestKey(t), attestTestAppID, e.challenge(), "tok-1"), http.StatusForbidden, "trial_already_used")
	// Three new keys from one device racing: exactly two grants (bit0, bit1).
	var wg sync.WaitGroup
	codes := make([]int, 3)
	for i := range codes {
		k, c := attestKey(t), e.challenge()
		wg.Add(1)
		go func() { defer wg.Done(); codes[i] = e.enroll(k, attestTestAppID, c, "tok-race").Code }()
	}
	wg.Wait()
	if countOK(codes) != 2 {
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
	NewAttestAPI(store, NewTrialProxyAPI(store, "s", TrialConfig{RatePerMinute: 1}), nil, AttestConfig{}).RegisterRoutes(mux)
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

// foodGet sends an attested GET to path, signing signedPath with an empty
// body: clientDataHash = SHA256(challenge || SHA256(signedPath || "\n")).
func (e *attestEnv) foodGet(host string, k *ecdsa.PrivateKey, counter uint32, chal, path, signedPath string) *httptest.ResponseRecorder {
	raw, _ := base64.StdEncoding.DecodeString(chal)
	rh := sha256.Sum256([]byte(signedPath + "\n"))
	cdh := sha256.Sum256(append(raw, rh[:]...))
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Host = host
	req.Header.Set("X-Attest-Key-Id", attestKeyID(e.t, k))
	req.Header.Set("X-Attest-Challenge", chal)
	req.Header.Set("X-Attest-Assertion", fakeAssertion(e.t, k, counter, cdh[:]))
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	return rec
}

// Food lookups need App Attest only (not the AI trial), are bound to the
// exact query/barcode, and never spend the AI budget (bd med-o7zq.19).
func TestAttestFood(t *testing.T) {
	e := newAttestEnv(t, 3, 0, 0, TrialConfig{RatePerMinute: 1000}) // AI trial unconfigured
	k := attestKey(t)
	rec := e.enroll(k, attestTestAppID, e.challenge(), "tok")
	if rec.Code != http.StatusOK {
		t.Fatalf("enroll with AI unconfigured: %d %s", rec.Code, rec.Body.String())
	}
	wantErr(t, e.chat(k, 1, rec.Header().Get("X-Attest-Challenge"), attestChatBody, attestChatBody), http.StatusServiceUnavailable, "trial_not_configured")

	bc := attestFoodBarcode + "4006381333931"
	rec = e.foodGet("localhost", k, 1, e.challenge(), bc, bc)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"/api/v1/food/barcode/4006381333931"`) || rec.Header().Get("X-Attest-Challenge") == "" {
		t.Fatalf("barcode: %d %s", rec.Code, rec.Body.String())
	}
	srch := attestFoodSearch + "?q=apple"
	rec = e.foodGet("localhost", k, 2, rec.Header().Get("X-Attest-Challenge"), srch, srch)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"q":"apple"`) || rec.Header().Get("X-Trial-Remaining") != "" {
		t.Fatalf("search: %d %s %v", rec.Code, rec.Body.String(), rec.Header())
	}

	used := e.foodHits.Load()
	chal := e.challenge()
	e.foodGet("localhost", k, 3, chal, bc, bc)
	wantErr(t, e.foodGet("localhost", k, 4, chal, bc, bc), http.StatusBadRequest, "challenge_invalid") // replayed challenge
	wantErr(t, e.foodGet("localhost", k, 5, "bogus", bc, bc), http.StatusBadRequest, "challenge_invalid")
	wantErr(t, e.foodGet("localhost", k, 5, e.challenge(), attestFoodBarcode+"1111", bc), http.StatusUnauthorized, "assertion_invalid")
	wantErr(t, e.foodGet("localhost", k, 5, e.challenge(), attestFoodSearch+"?q=other", srch), http.StatusUnauthorized, "assertion_invalid")
	wantErr(t, e.foodGet("localhost", attestKey(t), 1, e.challenge(), bc, bc), http.StatusUnauthorized, "install_unknown")
	wantErr(t, e.foodGet("localhost", k, 3, e.challenge(), bc, bc), http.StatusUnauthorized, "assertion_invalid") // reused counter
	if n := e.foodHits.Load(); n != used+1 {
		t.Fatalf("upstream hits after rejects: %d, want %d", n, used+1)
	}

	// 1000/day: fill the day to the cap through the store, request 1001 → 429.
	ctx := context.Background()
	keyID := attestKeyID(t, k)
	now := time.Now().UTC()
	for c := uint32(10); c < 10+attestDefaultFoodDaily-3; c++ {
		if ok, err := e.store.ConsumeAttestFoodRequest(ctx, keyID, c, now, attestDefaultFoodDaily); !ok || err != nil {
			t.Fatalf("seed %d: %v %v", c, ok, err)
		}
	}
	rec = e.foodGet("localhost", k, 5000, e.challenge(), bc, bc)
	wantErr(t, rec, http.StatusTooManyRequests, "trial_budget_exhausted")
	if !strings.Contains(rec.Body.String(), `"scope":"install-day"`) || !strings.Contains(rec.Body.String(), `"resets_at"`) {
		t.Fatalf("cap: %s", rec.Body.String())
	}
	// The AI budget did not move: lifetime unused, global SUM still empty.
	if in, err := e.store.AttestInstall(ctx, keyID); err != nil || in.Used != 0 {
		t.Fatalf("lifetime used by food: %+v %v", in, err)
	}
	if ok, scope, err := e.store.ConsumeTrialRequest(ctx, "acct", now, 0, 1); !ok || err != nil {
		t.Fatalf("global budget spent by food: %v %s %v", ok, scope, err)
	}

	// Food DB unset: 503 food_not_configured, no upstream call.
	e.food.foodDBURL = ""
	hits := e.foodHits.Load()
	wantErr(t, e.foodGet("localhost", k, 6000, e.challenge(), bc, bc), http.StatusServiceUnavailable, "food_not_configured")
	if e.foodHits.Load() != hits {
		t.Fatal("upstream called with the food DB unset")
	}

	// Account hosts never answer the anonymous food routes.
	account, _ := setupInvite(t, e.store)
	if rec := e.foodGet(account.Subdomain+".localhost", k, 7000, e.challenge(), bc, bc); rec.Code != http.StatusNotFound {
		t.Fatalf("account host: %d", rec.Code)
	}

	// CORS preflight from the iOS local origin lists GET.
	req := httptest.NewRequest(http.MethodOptions, bc, nil)
	req.Host = "localhost"
	req.Header.Set("Origin", localAppOrigin)
	rec = httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent || !strings.Contains(rec.Header().Get("Access-Control-Allow-Methods"), "GET") {
		t.Fatalf("preflight: %d %v", rec.Code, rec.Header())
	}
}

func countOK(codes []int) (n int) {
	for _, c := range codes {
		if c == http.StatusOK {
			n++
		}
	}
	return n
}

// bd med-o7zq.26: a reinstall presenting the trial pass rejoins its bucket.
// Every budget is the bucket's: lifetime, daily, food daily, the burst
// limiter; concurrent installs of one bucket never double-spend.
func TestAttestRejoin(t *testing.T) {
	ctx := context.Background()
	e := newAttestEnv(t, 4, 0, 0)
	e.attest.cfg.FoodDaily = 1
	k1 := attestKey(t)
	rec := e.enroll(k1, attestTestAppID, e.challenge(), "tok-A")
	pass := passOf(rec)
	if rec.Code != http.StatusOK || pass == "" {
		t.Fatalf("grant: %d %s", rec.Code, rec.Body.String())
	}
	if rec := e.chat(k1, 1, e.challenge(), attestChatBody, attestChatBody); rec.Code != http.StatusOK || rec.Header().Get("X-Trial-Remaining") != "3" {
		t.Fatalf("k1 chat: %d %s", rec.Code, rec.Header().Get("X-Trial-Remaining"))
	}
	if rec := e.foodGet("localhost", k1, 2, e.challenge(), "/api/attest/food/search?q=oats", "/api/attest/food/search?q=oats"); rec.Code != http.StatusOK {
		t.Fatalf("k1 food: %d", rec.Code)
	}

	// The reinstall: a new key, the pass, no DeviceCheck call, nothing reset.
	_, calls := e.dc.state("")
	k2 := attestKey(t)
	rec = e.enrollPass(k2, attestTestAppID, e.challenge(), "tok-A2", pass)
	if _, after := e.dc.state(""); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"remaining":3`) || passOf(rec) != "" || after != calls {
		t.Fatalf("rejoin: %d %s dc calls %d→%d", rec.Code, rec.Body.String(), calls, after)
	}
	if in, _ := e.store.AttestInstall(ctx, attestKeyID(t, k2)); in.BucketID != attestKeyID(t, k1) {
		t.Fatalf("rejoined bucket: %+v", in)
	}
	// Food: the bucket's one lookup today is spent.
	wantErr(t, e.foodGet("localhost", k2, 1, e.challenge(), "/api/attest/food/search?q=oats", "/api/attest/food/search?q=oats"),
		http.StatusTooManyRequests, "trial_budget_exhausted")
	// Lifetime: k2 and k1 spend one budget; two concurrent last-but-one
	// requests from both installs never overshoot it.
	if rec := e.chat(k2, 2, e.challenge(), attestChatBody, attestChatBody); rec.Code != http.StatusOK || rec.Header().Get("X-Trial-Remaining") != "2" {
		t.Fatalf("k2 chat: %d %s", rec.Code, rec.Header().Get("X-Trial-Remaining"))
	}
	var wg sync.WaitGroup
	codes := make([]int, 3)
	for i, k := range []*ecdsa.PrivateKey{k1, k2, k1} {
		c, counter := e.challenge(), uint32(10+i)
		wg.Add(1)
		go func() { defer wg.Done(); codes[i] = e.chat(k, counter, c, attestChatBody, attestChatBody).Code }()
	}
	wg.Wait()
	if n := countOK(codes); n != 2 {
		t.Fatalf("concurrent bucket spend: %v", codes)
	}
	rec = e.chat(k2, 20, e.challenge(), attestChatBody, attestChatBody)
	wantErr(t, rec, http.StatusTooManyRequests, "trial_budget_exhausted")
	if !strings.Contains(rec.Body.String(), `"scope":"install"`) {
		t.Fatalf("scope: %s", rec.Body.String())
	}
	// Another reinstall rejoins the exhausted bucket: still exhausted.
	k3 := attestKey(t)
	if rec := e.enrollPass(k3, attestTestAppID, e.challenge(), "tok-A3", pass); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"remaining":0`) {
		t.Fatalf("rejoin exhausted: %d %s", rec.Code, rec.Body.String())
	}

	// Bad passes are refused and store nothing: a wrong secret, an unknown
	// bucket, a malformed pass, and a backfilled bucket (no pass at all).
	bucket, _, _ := strings.Cut(pass, ".")
	wrong := bucket + "." + base64.RawURLEncoding.EncodeToString(make([]byte, trialPassBytes))
	_, secret, _ := strings.Cut(pass, ".")
	if err := e.store.InsertAttestInstall(ctx, cloudstore.AttestInstall{KeyID: "legacy", PublicKey: []byte{1}, Granted: true, Env: "production", CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{wrong, "unknown." + secret, "no-dot", "." + secret, bucket + ".!!", "legacy." + secret} {
		k := attestKey(t)
		wantErr(t, e.enrollPass(k, attestTestAppID, e.challenge(), "tok-bad", bad), http.StatusUnauthorized, "trial_pass_invalid")
		if _, err := e.store.AttestInstall(ctx, attestKeyID(t, k)); err == nil {
			t.Fatalf("row stored for bad pass %q", bad)
		}
	}
	if bits, _ := e.dc.state("tok-bad"); bits != [2]bool{} {
		t.Fatalf("bad pass touched DeviceCheck: %v", bits)
	}
}

// bd med-o7zq.26: voice is the bucket's too — one call at a time per bucket,
// and the seconds are shared.
func TestAttestRejoinVoice(t *testing.T) {
	e := newAttestEnv(t, 10, 0, 0)
	e.voiceOn()
	k1 := attestKey(t)
	pass := passOf(e.enroll(k1, attestTestAppID, e.challenge(), "tok-V"))
	k2 := attestKey(t)
	if rec := e.enrollPass(k2, attestTestAppID, e.challenge(), "tok-V2", pass); rec.Code != http.StatusOK {
		t.Fatalf("rejoin: %d %s", rec.Code, rec.Body.String())
	}
	rec, out := e.voiceStart(k1, 1)
	if rec.Code != http.StatusOK || out.Granted != attestDefaultVoiceCallMax {
		t.Fatalf("k1 start: %d %s", rec.Code, rec.Body.String())
	}
	// Live (a pending call would be replaced, bd med-02b0) and used up (no
	// refund at the end, bd med-dngs).
	usedUp(e.relay.lookup(out.Call))
	wantErr(t, mustRec(e.voiceStart(k2, 1)), http.StatusConflict, "call_in_progress")
	e.reapNow(out.Call)
	rec, out = e.voiceStart(k2, 2)
	if rec.Code != http.StatusOK || out.Remaining != 600-2*attestDefaultVoiceCallMax {
		t.Fatalf("k2 start: %d %s", rec.Code, rec.Body.String())
	}
	if e.voiceUsed(k1) != 2*attestDefaultVoiceCallMax {
		t.Fatalf("bucket voice used: %d", e.voiceUsed(k1))
	}
	// bd med-o7zq.28: a rejoin answers the bucket's voice seconds left and
	// the limits, so Settings shows the minutes before any call.
	e.dropAttached(out.Call)
	e.attest.cfg.VoiceDaily = 300
	k3 := attestKey(t)
	rec = e.enrollPass(k3, attestTestAppID, e.challenge(), "tok-V3", pass)
	var got map[string]int
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	want := map[string]int{
		"voice_remaining_seconds":       600 - 2*attestDefaultVoiceCallMax,
		"voice_daily_remaining_seconds": 300 - 2*attestDefaultVoiceCallMax,
		"voice_lifetime_seconds":        600,
		"voice_daily_seconds":           300,
		"voice_call_max_seconds":        attestDefaultVoiceCallMax,
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("rejoin %s = %d, want %d (%s)", k, got[k], v, rec.Body.String())
		}
	}
	if !strings.Contains(mustRec(e.voiceStart(k3, 1)).Body.String(), `"voice_call_max_seconds":120`) {
		t.Fatal("voice start carries no call max")
	}
}

// Voice off: the enroll body carries no voice fields (older builds and the
// copy treat "absent" as "no voice trial").
func TestAttestEnrollNoVoiceFields(t *testing.T) {
	e := newAttestEnv(t, 10, 0, 0)
	rec := e.enroll(attestKey(t), attestTestAppID, e.challenge(), "tok-N")
	if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), "voice_") {
		t.Fatalf("enroll: %d %s", rec.Code, rec.Body.String())
	}
}

func mustRec(rec *httptest.ResponseRecorder, _ voiceStartResp) *httptest.ResponseRecorder { return rec }
