package cloudserver

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/appattest"
	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

// Anonymous AI trial for iOS local mode (bd med-o7zq.15, docs/cloud-mode.md →
// "Anonymous trial (iOS local mode) — App Attest + DeviceCheck"). Base-domain
// routes, no session: the subject is the App Attest key id (one per install).
// SECURITY INVARIANT (as trial_proxy.go): no TrialConfig value, DeviceCheck
// key, device token or JWT in any response or log line.
//
// PRIVACY: enrollment calls Apple DeviceCheck (https://api.devicecheck.apple.com,
// via internal/appattest); this file owns the 'local-trial' privacy-manifest
// row, whose host anchor this comment keeps checkable.

const (
	attestPathPrefix    = "/api/attest/"
	attestChallengePath = "/api/attest/challenge"
	attestEnrollPath    = "/api/attest/enroll"
	attestChatPath      = "/api/attest/trial/openai/chat/completions"
	attestFoodSearch    = "/api/attest/food/search"
	attestFoodBarcode   = "/api/attest/food/barcode/"

	attestChallengeTTL = 5 * time.Minute
	// attestMaxChallenges bounds the in-memory challenge map (the challenge
	// route is unauthenticated; per-IP limiting alone does not bound a botnet).
	attestMaxChallenges = 50_000
	// Enrollment body: key id + base64 attestation (~7 KB) + DeviceCheck token
	// (~3 KB). appattest puts no cap on x5c count or size, so this must.
	maxAttestEnrollBytes = 32 << 10
	// A real assertion is ~100 bytes of CBOR.
	maxAttestAssertionBytes = 4 << 10
	attestIPRatePerMin      = 60
	// Read deadline while the request is still unauthenticated (headers only).
	attestUnauthReadTimeout = 10 * time.Second
	// Anonymous output cap: the operator pays and the client is unknown.
	attestMaxTokens = 1024

	attestDefaultLifetime = 200
	attestDefaultDaily    = 50
	// Food lookups hit the operator's own FastFoodDB (no per-request bill), so
	// they have their own per-install daily cap and never touch the AI budget.
	attestDefaultFoodDaily = 1000

	// localAppOrigin is the iOS local-mode page origin (ios/App/LocalOrigin.swift
	// scheme "wgapp", host "local"); it calls these routes cross-origin.
	localAppOrigin = "wgapp://local"
)

// AttestConfig is the anonymous trial's env config. Configured is false unless
// all four Apple vars are set; the routes then answer 503 trial_not_configured.
type AttestConfig struct {
	AppAttest  appattest.Config
	Lifetime   int // TRIAL_ANON_LIFETIME_REQUESTS
	Daily      int // TRIAL_ANON_DAILY; 0 disables the per-install daily cap
	FoodDaily  int // TRIAL_ANON_FOOD_DAILY; 0 disables the per-install daily food cap
	Configured bool
}

// AttestConfigFromEnv loads APP_ATTEST_* / DEVICECHECK_* / TRIAL_ANON_*. With
// none of the Apple vars set it returns an unconfigured config and no error.
// Errors name the env var only, never its value.
func AttestConfigFromEnv() (AttestConfig, error) {
	cfg := AttestConfig{Lifetime: attestDefaultLifetime, Daily: attestDefaultDaily, FoodDaily: attestDefaultFoodDaily}
	if v := os.Getenv("TRIAL_ANON_LIFETIME_REQUESTS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			return cfg, errors.New("TRIAL_ANON_LIFETIME_REQUESTS must be a positive integer")
		}
		cfg.Lifetime = n
	}
	if v := os.Getenv("TRIAL_ANON_DAILY"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			return cfg, errors.New("TRIAL_ANON_DAILY must be a non-negative integer (0 disables the per-install daily cap)")
		}
		cfg.Daily = n
	}
	if v := os.Getenv("TRIAL_ANON_FOOD_DAILY"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			return cfg, errors.New("TRIAL_ANON_FOOD_DAILY must be a non-negative integer (0 disables the per-install daily food cap)")
		}
		cfg.FoodDaily = n
	}
	env := os.Getenv("APP_ATTEST_ENV")
	switch env {
	case "":
		env = appattest.EnvProduction
	case appattest.EnvProduction, appattest.EnvDevelopment:
	default:
		return cfg, errors.New("APP_ATTEST_ENV must be production or development")
	}
	appID, keyID, teamID, keyFile := os.Getenv("APP_ATTEST_APP_ID"), os.Getenv("DEVICECHECK_KEY_ID"), os.Getenv("DEVICECHECK_TEAM_ID"), os.Getenv("DEVICECHECK_PRIVATE_KEY_FILE")
	if appID == "" && keyID == "" && teamID == "" && keyFile == "" {
		return cfg, nil
	}
	if appID == "" || keyID == "" || teamID == "" || keyFile == "" {
		return cfg, errors.New("APP_ATTEST_APP_ID, DEVICECHECK_KEY_ID, DEVICECHECK_TEAM_ID and DEVICECHECK_PRIVATE_KEY_FILE must be set together")
	}
	p8, err := os.ReadFile(keyFile)
	if err != nil {
		return cfg, errors.New("DEVICECHECK_PRIVATE_KEY_FILE is unreadable")
	}
	key, err := appattest.ParsePrivateKeyPEM(p8)
	if err != nil {
		return cfg, errors.New("DEVICECHECK_PRIVATE_KEY_FILE is not a PKCS#8 EC key")
	}
	cfg.AppAttest = appattest.Config{AppID: appID, Env: env, DeviceCheck: appattest.DeviceCheckConfig{KeyID: keyID, TeamID: teamID, PrivateKey: key}}
	cfg.Configured = true
	return cfg, nil
}

// AttestAPI serves /api/attest/*.
type AttestAPI struct {
	cfg       AttestConfig
	store     *cloudstore.Repo
	trial     *TrialProxyAPI
	food      *FoodProxyAPI
	ipLimiter *rateLimiter
	mu        sync.Mutex
	// grantMu serializes DeviceCheck query → insert → bit write: DeviceCheck
	// tokens differ per call, so two keys from one device racing would both
	// read bit0 unset. ponytail: one global lock (enrollment is rare and one
	// instance runs); a multi-instance deploy needs a DB-level lease instead.
	grantMu    sync.Mutex
	challenges map[string]time.Time
	mux        *http.ServeMux
}

// NewAttestAPI builds the routes; trial supplies the provider config, the
// per-subject burst limiter and the shared upstream proxy; food supplies the
// operator FastFoodDB proxy (bd med-o7zq.19).
func NewAttestAPI(store *cloudstore.Repo, trial *TrialProxyAPI, food *FoodProxyAPI, cfg AttestConfig) *AttestAPI {
	a := &AttestAPI{cfg: cfg, store: store, trial: trial, food: food, ipLimiter: newRateLimiter(attestIPRatePerMin, time.Minute), challenges: map[string]time.Time{}, mux: http.NewServeMux()}
	a.mux.HandleFunc("POST "+attestChallengePath, a.challenge)
	a.mux.HandleFunc("POST "+attestEnrollPath, a.enroll)
	a.mux.HandleFunc("POST "+attestChatPath, a.chat)
	a.mux.HandleFunc("GET "+attestFoodSearch, a.foodLookup)
	a.mux.HandleFunc("GET "+attestFoodBarcode+"{code}", a.foodLookup)
	return a
}

// RegisterRoutes mounts the whole prefix (CORS preflight included). The router
// forwards it only from the base domain.
func (a *AttestAPI) RegisterRoutes(mux *http.ServeMux) { mux.Handle(attestPathPrefix, a) }

func (a *AttestAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Origin") == localAppOrigin {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", localAppOrigin)
		h.Set("Access-Control-Expose-Headers", "X-Attest-Challenge, X-Trial-Remaining, Retry-After")
		h.Add("Vary", "Origin")
		if r.Method == http.MethodOptions {
			h.Set("Access-Control-Allow-Methods", "GET, POST")
			h.Set("Access-Control-Allow-Headers", "Content-Type, X-Attest-Key-Id, X-Attest-Challenge, X-Attest-Assertion")
			h.Set("Access-Control-Max-Age", "600")
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	// Challenge, enroll and food need only App Attest; chat also checks the AI
	// trial config. One enrollment serves both.
	if !a.cfg.Configured {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_not_configured"})
		return
	}
	if !a.ipLimiter.Allow(clientIP(r)) {
		w.Header().Set("Retry-After", "60")
		writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "trial_rate_limit", "retry_after_seconds": 60})
		return
	}
	a.mux.ServeHTTP(w, r)
}

// issueChallenge mints a single-use 32-byte challenge (base64). "" when the
// map is full of live challenges.
func (a *AttestAPI) issueChallenge() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	c := base64.StdEncoding.EncodeToString(b)
	now := time.Now()
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.challenges) >= attestMaxChallenges {
		for k, exp := range a.challenges {
			if now.After(exp) {
				delete(a.challenges, k)
			}
		}
		if len(a.challenges) >= attestMaxChallenges {
			return ""
		}
	}
	a.challenges[c] = now.Add(attestChallengeTTL)
	return c
}

// consumeChallenge redeems c once; it returns the raw challenge bytes (what
// the client hashes) or nil when unknown, expired or already used.
func (a *AttestAPI) consumeChallenge(c string) []byte {
	a.mu.Lock()
	exp, ok := a.challenges[c]
	delete(a.challenges, c)
	a.mu.Unlock()
	if !ok || time.Now().After(exp) {
		return nil
	}
	raw, _ := base64.StdEncoding.DecodeString(c)
	return raw
}

// setNextChallenge puts the next single-use challenge on the response, so the
// steady state is one round trip per request.
func (a *AttestAPI) setNextChallenge(w http.ResponseWriter) {
	if c := a.issueChallenge(); c != "" {
		w.Header().Set("X-Attest-Challenge", c)
	}
}

func (a *AttestAPI) challenge(w http.ResponseWriter, r *http.Request) {
	c := a.issueChallenge()
	if c == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"challenge": c, "expires_in": int(attestChallengeTTL.Seconds())})
}

func (a *AttestAPI) enroll(w http.ResponseWriter, r *http.Request) {
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(attestUnauthReadTimeout))
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxAttestEnrollBytes+1))
	if err != nil || len(raw) > maxAttestEnrollBytes {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "body_too_large"})
		return
	}
	var req struct {
		KeyID       string `json:"key_id"`
		Attestation string `json:"attestation"`
		Challenge   string `json:"challenge"`
		DeviceToken string `json:"device_token"`
	}
	if json.Unmarshal(raw, &req) != nil || req.KeyID == "" || req.DeviceToken == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
		return
	}
	challenge := a.consumeChallenge(req.Challenge)
	if challenge == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "challenge_invalid"})
		return
	}
	attestation, err := base64.StdEncoding.DecodeString(req.Attestation)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "attestation_invalid"})
		return
	}
	pub, env, err := appattest.VerifyAttestation(attestation, req.KeyID, challenge, a.cfg.AppAttest)
	if err != nil {
		slog.Info("attest enroll rejected", "reason", err)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "attestation_invalid"})
		return
	}
	ctx := r.Context()
	// Idempotent re-enroll: the key is already granted, no DeviceCheck call.
	if in, err := a.store.AttestInstall(ctx, req.KeyID); err == nil {
		a.enrolled(w, in.Used)
		return
	} else if !errors.Is(err, sql.ErrNoRows) {
		slog.Error("attest enroll lookup failed", "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_unavailable"})
		return
	}
	a.grantMu.Lock()
	defer a.grantMu.Unlock()
	// DeviceCheck bit0 = "this device already had its trial", set at first
	// grant. Fail CLOSED: the trial is optional, BYOK is unaffected.
	bit0, bit1, _, err := a.cfg.AppAttest.QueryBits(ctx, req.DeviceToken)
	if err != nil {
		slog.Warn("attest enroll devicecheck query failed", "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_unavailable"})
		return
	}
	if bit0 {
		slog.Info("attest enroll refused: device already had its trial")
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "trial_already_used"})
		return
	}
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_unavailable"})
		return
	}
	if err := a.store.InsertAttestInstall(ctx, cloudstore.AttestInstall{KeyID: req.KeyID, PublicKey: der, Env: env, CreatedAt: time.Now().UTC()}); err != nil {
		// A concurrent enroll of the same key won the insert.
		if in, lerr := a.store.AttestInstall(ctx, req.KeyID); lerr == nil {
			a.enrolled(w, in.Used)
			return
		}
		slog.Error("attest enroll insert failed", "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_unavailable"})
		return
	}
	// Crash between the insert and this write leaves a row with the bit unset:
	// at worst one extra trial on reinstall (accepted, docs/cloud-mode.md).
	if err := a.cfg.AppAttest.UpdateBits(ctx, req.DeviceToken, true, bit1); err != nil {
		slog.Warn("attest enroll devicecheck update failed", "error", err)
		if derr := a.store.DeleteAttestInstall(context.WithoutCancel(ctx), req.KeyID); derr != nil {
			slog.Error("attest enroll rollback failed", "error", derr)
		}
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_unavailable"})
		return
	}
	slog.Info("attest enroll granted", "env", env)
	a.enrolled(w, 0)
}

func (a *AttestAPI) enrolled(w http.ResponseWriter, used int) {
	remaining := max(a.cfg.Lifetime-used, 0)
	w.Header().Set("X-Trial-Remaining", strconv.Itoa(remaining))
	a.setNextChallenge(w)
	writeJSON(w, http.StatusOK, map[string]int{"remaining": remaining, "daily": a.cfg.Daily})
}

// chat is the assertion-gated trial chat proxy. clientDataHash =
// SHA256(challenge || SHA256(pathAndQuery || "\n" || body)) binds the
// assertion to this single-use challenge, this route including ?vision=1, and
// this exact body. pathAndQuery is the request URI as sent, e.g.
// "/api/attest/trial/openai/chat/completions?vision=1".
//
// Order matters for availability: everything checkable from the headers (a
// live challenge, an enrolled key) runs under a short read deadline BEFORE the
// up-to-12-MiB body is read under the long upstream deadline.
func (a *AttestAPI) chat(w http.ResponseWriter, r *http.Request) {
	if !a.trial.cfg.TrialAIConfigured() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_not_configured"})
		return
	}
	q, ok := a.assertHeaders(w, r)
	if !ok {
		return
	}
	extendTrialDeadlines(w)
	body, ok := readTrialBody(w, r)
	if !ok {
		return
	}
	if !a.verifyAssertion(w, r, q, body) {
		return
	}
	keyID, counter, ctx := q.keyID, q.counter, r.Context()
	payload, ok := decodeTrialPayload(w, body)
	if !ok {
		return
	}
	if trialStreamRequested(payload) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "stream_unsupported"})
		return
	}
	maxTokens := clampMaxTokens(payload, a.trial.cfg.Provider)
	// One completion: the token cap is per choice, so n would multiply the bill.
	delete(payload, "n")
	subject := cloudstore.AttestSubject(keyID)
	if !a.trial.rateLimit(w, a.trial.limiter, subject) {
		return
	}
	now := time.Now().UTC()
	allowed, scope, remaining, err := a.store.ConsumeAttestRequest(ctx, keyID, counter, now, a.cfg.Lifetime, a.cfg.Daily, a.trial.cfg.DailyGlobal)
	if errors.Is(err, cloudstore.ErrAttestCounter) {
		// A concurrent request with the same counter won the compare-and-set.
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "assertion_invalid"})
		return
	}
	if err != nil {
		// Fails CLOSED like consumeBudget: the other side of this check is a bill.
		slog.Error("attest trial budget check failed", "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_budget_unavailable"})
		return
	}
	w.Header().Set("X-Trial-Remaining", strconv.Itoa(remaining))
	if !allowed {
		slog.Warn("attest trial budget exhausted", "install", keyID, "scope", scope)
		resp := map[string]any{"error": "trial_budget_exhausted", "scope": scope}
		if scope != cloudstore.AttestScopeInstall {
			resp["resets_at"] = now.Truncate(24 * time.Hour).Add(24 * time.Hour).Format(time.RFC3339)
		}
		writeJSON(w, http.StatusTooManyRequests, resp)
		return
	}
	// Any non-200 answer (upstream failure, sanitized 502) refunds the
	// lifetime request; X-Trial-Remaining follows.
	rw := &refundWriter{ResponseWriter: w, onStatus: func(code int) {
		if code == http.StatusOK {
			return
		}
		if err := a.store.RefundAttestRequest(context.WithoutCancel(ctx), keyID); err != nil {
			slog.Error("attest trial refund failed", "install", keyID, "error", err)
			return
		}
		w.Header().Set("X-Trial-Remaining", strconv.Itoa(remaining+1))
	}}
	a.trial.proxyChat(rw, r, "install", keyID, payload, r.URL.Query().Get("vision") == "1", false, maxTokens)
}

// attested is one assertion-gated request: what the headers carried and,
// after verifyAssertion, the new counter.
type attested struct {
	keyID     string
	challenge []byte
	assertion []byte
	install   *cloudstore.AttestInstall
	pub       *ecdsa.PublicKey
	counter   uint32
}

// assertHeaders runs everything checkable from the headers alone (a live
// challenge, a well-formed assertion, an enrolled key) under the short
// unauthenticated read deadline, and puts the next challenge on the response.
// false means the error response has been written.
func (a *AttestAPI) assertHeaders(w http.ResponseWriter, r *http.Request) (*attested, bool) {
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(attestUnauthReadTimeout))
	a.setNextChallenge(w)
	q := &attested{keyID: r.Header.Get("X-Attest-Key-Id")}
	q.challenge = a.consumeChallenge(r.Header.Get("X-Attest-Challenge"))
	if q.challenge == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "challenge_invalid"})
		return nil, false
	}
	var err error
	q.assertion, err = base64.StdEncoding.DecodeString(r.Header.Get("X-Attest-Assertion"))
	if err != nil || len(q.assertion) == 0 || len(q.assertion) > maxAttestAssertionBytes || q.keyID == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "assertion_invalid"})
		return nil, false
	}
	q.install, err = a.store.AttestInstall(r.Context(), q.keyID)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			slog.Error("attest install lookup failed", "error", err)
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_budget_unavailable"})
			return nil, false
		}
		// Distinct from assertion_invalid: the client's recovery is to enroll
		// a new key (a lost enroll response needs none — just call this route).
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "install_unknown"})
		return nil, false
	}
	// The stored key is only ever one VerifyAttestation returned (enroll), so
	// VerifyAssertion's trust in its curve holds.
	parsed, err := x509.ParsePKIXPublicKey(q.install.PublicKey)
	pub, isEC := parsed.(*ecdsa.PublicKey)
	if err != nil || !isEC {
		slog.Error("attest stored key unreadable")
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_budget_unavailable"})
		return nil, false
	}
	q.pub = pub
	return q, true
}

// verifyAssertion checks the assertion over clientDataHash =
// SHA256(challenge || SHA256(pathAndQuery || "\n" || body)) — this
// single-use challenge, this exact request URI (query included) and this
// exact body (empty for a GET) — and records the new counter on q. The
// counter is committed only by the store's compare-and-set afterwards.
func (a *AttestAPI) verifyAssertion(w http.ResponseWriter, r *http.Request, q *attested, body []byte) bool {
	reqHash := sha256.Sum256(append([]byte(r.URL.RequestURI()+"\n"), body...))
	clientDataHash := sha256.Sum256(append(append([]byte{}, q.challenge...), reqHash[:]...))
	counter, err := appattest.VerifyAssertion(q.assertion, q.pub, clientDataHash[:], a.cfg.AppAttest, q.install.Counter)
	if err != nil {
		slog.Info("attest assertion rejected", "reason", err)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "assertion_invalid"})
		return false
	}
	q.counter = counter
	return true
}

// foodLookup is the assertion-gated food lookup on the operator FastFoodDB
// (bd med-o7zq.19): GET /api/attest/food/search?q= and
// /api/attest/food/barcode/<code>. The assertion binds the request URI, so
// the query or barcode is signed. Own per-install daily cap (FoodDaily), no
// lifetime, global or refund: the AI budget is untouched.
// PRIVACY: search terms and barcodes transit in memory to the operator's food
// DB and are NEVER logged (health-adjacent); only a daily count is stored.
func (a *AttestAPI) foodLookup(w http.ResponseWriter, r *http.Request) {
	if a.food == nil || a.food.foodDBURL == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "food_not_configured"})
		return
	}
	q, ok := a.assertHeaders(w, r)
	if !ok || !a.verifyAssertion(w, r, q, nil) {
		return
	}
	now := time.Now().UTC()
	allowed, err := a.store.ConsumeAttestFoodRequest(r.Context(), q.keyID, q.counter, now, a.cfg.FoodDaily)
	if errors.Is(err, cloudstore.ErrAttestCounter) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "assertion_invalid"})
		return
	}
	if err != nil {
		// Fails CLOSED like the chat budget.
		slog.Error("attest food budget check failed", "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_budget_unavailable"})
		return
	}
	if !allowed {
		slog.Warn("attest food budget exhausted", "install", q.keyID, "scope", cloudstore.AttestScopeInstallDay)
		writeJSON(w, http.StatusTooManyRequests, map[string]any{
			"error": "trial_budget_exhausted", "scope": cloudstore.AttestScopeInstallDay,
			"resets_at": now.Truncate(24 * time.Hour).Add(24 * time.Hour).Format(time.RFC3339),
		})
		return
	}
	if code := r.PathValue("code"); code != "" {
		a.food.barcode(w, r, code)
		return
	}
	a.food.Search(w, r)
}

// clampMaxTokens returns the anonymous output cap n = min(client values,
// attestMaxTokens). On the OpenAI path it is forced onto whichever of
// max_tokens / max_completion_tokens the client sent (with neither, onto
// max_completion_tokens, the current name); the anthropic path takes n via
// proxyChat's maxTokens (toAnthropicRequest drops both fields).
func clampMaxTokens(payload map[string]json.RawMessage, provider string) int {
	n := attestMaxTokens
	for _, k := range []string{"max_tokens", "max_completion_tokens"} {
		var c int
		if json.Unmarshal(payload[k], &c) == nil && c > 0 && c < n {
			n = c
		}
	}
	if provider == TrialProviderAnthropic {
		return n
	}
	v := json.RawMessage(strconv.Itoa(n))
	_, hasMax := payload["max_tokens"]
	if hasMax {
		payload["max_tokens"] = v
	}
	if _, has := payload["max_completion_tokens"]; has || !hasMax {
		payload["max_completion_tokens"] = v
	}
	return n
}

// refundWriter calls onStatus once with the status the proxy answers, before
// the header goes out. Unwrap keeps http.NewResponseController working.
type refundWriter struct {
	http.ResponseWriter
	onStatus func(int)
	wrote    bool
}

func (rw *refundWriter) WriteHeader(code int) {
	if !rw.wrote {
		rw.wrote = true
		rw.onStatus(code)
	}
	rw.ResponseWriter.WriteHeader(code)
}

func (rw *refundWriter) Write(b []byte) (int, error) {
	if !rw.wrote {
		rw.WriteHeader(http.StatusOK)
	}
	return rw.ResponseWriter.Write(b)
}

func (rw *refundWriter) Unwrap() http.ResponseWriter { return rw.ResponseWriter }
