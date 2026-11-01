package cloudserver

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
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
	"strings"
	"sync"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/appattest"
	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
	"github.com/korjavin/medicationtrackerbot/internal/playintegrity"
)

// Anonymous AI trial for local mode (bd med-o7zq.15, docs/cloud-mode.md →
// "Anonymous trial (local mode) — App Attest / Play Integrity"). Base-domain
// routes, no session: the subject is the install's attested key id (one per
// install) — an App Attest key on iOS, an Android Keystore key enrolled via
// Play Integrity on Android (bd med-nt9p.32.8.3, install kind "android").
// SECURITY INVARIANT (as trial_proxy.go): no TrialConfig value, DeviceCheck
// key, device token, Play Integrity token or verdict payload (only the
// accepted app-verdict label, an enum, as env), service-account key,
// access token or JWT in any response or log line.
//
// PRIVACY: iOS enrollment calls Apple DeviceCheck (https://api.devicecheck.apple.com,
// via internal/appattest); Android enrollment calls Google Play Integrity
// (https://playintegrity.googleapis.com, bearer from https://oauth2.googleapis.com,
// via internal/playintegrity). This file owns the 'local-trial'
// privacy-manifest row, whose host anchors this comment keeps checkable.

const (
	attestPathPrefix    = "/api/attest/"
	attestChallengePath = "/api/attest/challenge"
	attestEnrollPath    = "/api/attest/enroll"
	attestChatPath      = "/api/attest/trial/openai/chat/completions"
	attestFeedbackPath  = "/api/attest/feedback"
	attestFoodSearch    = "/api/attest/food/search"
	attestFoodBarcode   = "/api/attest/food/barcode/"
	attestVoiceStart    = "/api/attest/voice/start"
	attestVoiceDevice   = "/api/attest/voice/device"
	attestDeletePath    = "/api/attest/delete"

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

	// Anonymous voice (bd med-o7zq.22), in seconds of call time. OFF by
	// default: lifetime 0 until the operator sets
	// TRIAL_ANON_VOICE_LIFETIME_SECONDS (the others only apply then).
	attestDefaultVoiceLifetime    = 0
	attestDefaultVoiceDaily       = 300
	attestDefaultVoiceGlobalDaily = 7200
	// The per-call grant ceiling; keep the shared trial agent's
	// max_duration_seconds (TRIAL_VOICE_MAX_CALL_SECONDS) at or below it.
	attestDefaultVoiceCallMax = 120
	// attestVoiceFloorSeconds: no call is granted below it.
	attestVoiceFloorSeconds = 30

	// localAppOrigin is the iOS local-mode page origin (ios/App/LocalOrigin.swift
	// scheme "wgapp", host "local"); it calls these routes cross-origin.
	localAppOrigin = "wgapp://local"
	// androidLocalOrigin is the Android local-mode page origin (WebViewAssetLoader's
	// fixed asset host, docs/android.md); it is an Origin we accept, never a
	// host the server calls.
	androidLocalOrigin = "https://appassets.androidplatform.net"
)

// AttestConfig is the anonymous trial's env config. Configured is false unless
// all four Apple vars are set; AndroidConfigured is false unless both
// PLAY_INTEGRITY_* vars are set. With neither, every route answers 503
// trial_not_configured; with one, enrollment of the other kind does.
type AttestConfig struct {
	AppAttest appattest.Config
	Android   playintegrity.Config
	Lifetime  int // TRIAL_ANON_LIFETIME_REQUESTS
	Daily     int // TRIAL_ANON_DAILY; 0 disables the per-install daily cap
	FoodDaily int // TRIAL_ANON_FOOD_DAILY; 0 disables the per-install daily food cap
	// Voice budgets in seconds (TRIAL_ANON_VOICE_*): VoiceLifetime 0 disables
	// anonymous voice; VoiceDaily / VoiceGlobal 0 disable that cap.
	VoiceLifetime int
	VoiceDaily    int
	VoiceGlobal   int
	VoiceCallMax  int
	Configured    bool // iOS: App Attest + DeviceCheck
	// AndroidConfigured: Play Integrity (bd med-nt9p.32.8.3).
	AndroidConfigured bool
	// AndroidRecall: PLAY_INTEGRITY_DEVICE_RECALL (bd med-nt9p.32.8.6) — the
	// device-recall twin of the DeviceCheck bits. Off unless set.
	AndroidRecall bool
}

// kindConfigured reports whether installs of kind can enroll and assert.
func (c AttestConfig) kindConfigured(kind string) bool {
	if kind == cloudstore.AttestKindAndroid {
		return c.AndroidConfigured
	}
	return c.Configured
}

// androidAttestFromEnv loads PLAY_INTEGRITY_* into cfg (bd med-nt9p.32.8.3).
// All unset → Android stays off, no error. Errors name the var only.
func androidAttestFromEnv(cfg *AttestConfig) error {
	pkg, saFile, verdicts := os.Getenv("PLAY_INTEGRITY_PACKAGE_NAME"), os.Getenv("PLAY_INTEGRITY_SERVICE_ACCOUNT_FILE"), os.Getenv("PLAY_INTEGRITY_ACCEPT_APP_VERDICTS")
	recall := false
	if v := os.Getenv("PLAY_INTEGRITY_DEVICE_RECALL"); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			return errors.New("PLAY_INTEGRITY_DEVICE_RECALL must be 1/true or 0/false")
		}
		recall = b
	}
	if recall && (pkg == "" || saFile == "") {
		return errors.New("PLAY_INTEGRITY_DEVICE_RECALL needs PLAY_INTEGRITY_PACKAGE_NAME and PLAY_INTEGRITY_SERVICE_ACCOUNT_FILE")
	}
	if pkg == "" && saFile == "" && verdicts == "" {
		return nil
	}
	if pkg == "" || saFile == "" {
		return errors.New("PLAY_INTEGRITY_PACKAGE_NAME and PLAY_INTEGRITY_SERVICE_ACCOUNT_FILE must be set together")
	}
	accept := []string{playintegrity.VerdictPlayRecognized}
	if verdicts != "" {
		accept = nil
		for _, v := range strings.Split(verdicts, ",") {
			v = strings.TrimSpace(v)
			if v != playintegrity.VerdictPlayRecognized && v != "UNRECOGNIZED_VERSION" {
				return errors.New("PLAY_INTEGRITY_ACCEPT_APP_VERDICTS must list only PLAY_RECOGNIZED and/or UNRECOGNIZED_VERSION")
			}
			accept = append(accept, v)
		}
	}
	b, err := os.ReadFile(saFile)
	if err != nil {
		return errors.New("PLAY_INTEGRITY_SERVICE_ACCOUNT_FILE is unreadable")
	}
	sa, err := playintegrity.ParseServiceAccountJSON(b)
	if err != nil {
		// playintegrity's errors name the field, never its value.
		return errors.New("PLAY_INTEGRITY_SERVICE_ACCOUNT_FILE: " + err.Error())
	}
	// CertDigests stays empty: PLAY_RECOGNIZED already implies Play's signing
	// cert, and the pin's encoding is unverified against live Google.
	cfg.Android = playintegrity.Config{PackageName: pkg, ServiceAccount: sa, AcceptAppVerdicts: accept}
	cfg.AndroidConfigured = true
	cfg.AndroidRecall = recall
	return nil
}

// envSeconds reads a non-negative integer env var; the error names the
// variable only.
func envSeconds(name string, def int, rule string) (int, error) {
	v := os.Getenv(name)
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		return def, errors.New(name + " must be " + rule)
	}
	return n, nil
}

// AttestConfigFromEnv loads APP_ATTEST_* / DEVICECHECK_* / PLAY_INTEGRITY_* /
// TRIAL_ANON_*. With none of the Apple or Play vars set it returns an
// unconfigured config and no error.
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
	var err error
	if cfg.VoiceLifetime, err = envSeconds("TRIAL_ANON_VOICE_LIFETIME_SECONDS", attestDefaultVoiceLifetime, "a non-negative integer (unset or 0 = anonymous voice off)"); err != nil {
		return cfg, err
	}
	if cfg.VoiceDaily, err = envSeconds("TRIAL_ANON_VOICE_DAILY_SECONDS", attestDefaultVoiceDaily, "a non-negative integer (0 disables the per-install daily voice cap)"); err != nil {
		return cfg, err
	}
	if cfg.VoiceGlobal, err = envSeconds("TRIAL_ANON_VOICE_GLOBAL_DAILY_SECONDS", attestDefaultVoiceGlobalDaily, "a non-negative integer (0 disables the global daily voice cap)"); err != nil {
		return cfg, err
	}
	if cfg.VoiceCallMax, err = envSeconds("TRIAL_ANON_VOICE_CALL_MAX_SECONDS", attestDefaultVoiceCallMax, "an integer of at least 30"); err != nil || cfg.VoiceCallMax < attestVoiceFloorSeconds {
		return cfg, errors.New("TRIAL_ANON_VOICE_CALL_MAX_SECONDS must be an integer of at least 30")
	}
	if err := androidAttestFromEnv(&cfg); err != nil {
		return cfg, err
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
	voice     *VoiceLLMRelayAPI // nil until SetVoiceRelay: the voice routes 503
	// feedback supplies the age recipient and admin ping of the session
	// feedback route; nil until SetFeedback: the feedback route 503s.
	feedback *FeedbackAPI
	// android verifies Play Integrity enrollments (caches the Google bearer);
	// nil unless cfg.AndroidConfigured.
	android   *playintegrity.Verifier
	ipLimiter *rateLimiter
	mu        sync.Mutex
	// grantMu serializes DeviceCheck query → insert → bit write: DeviceCheck
	// tokens differ per call, so two keys from one device racing would both
	// read bit0 unset. ponytail: one global lock (enrollment is rare and one
	// instance runs); a multi-instance deploy needs a DB-level lease instead.
	grantMu    sync.Mutex
	challenges map[string]time.Time
	// Free never-attached voice starts per bucket on abandonDay (UTC), under mu
	// (bd med-02b0). ponytail: in memory, a restart resets it — acceptable at
	// deploy frequency; persist it if deploys get frequent.
	abandonDay string
	abandons   map[string]int
	// refunded is the unused seconds handed back per bucket on abandonDay to
	// calls that attached and ended early (bd med-dngs), under mu.
	refunded map[string]int
	// abandonFree is the ElevenLabs time the day's free refunds may have let
	// run, server-wide; capped at cfg.VoiceGlobal / 2 (Argus 8452, Miles 8461).
	abandonFree int
	mux         *http.ServeMux
}

// attestVoiceFreeAbandons is how many never-attached starts a bucket gets
// refunded per UTC day; later ones are charged (docs/cloud-mode.md, Metering).
const attestVoiceFreeAbandons = 3

// takeFreeAbandon counts one never-attached start of bucket on now's UTC day
// and reports whether it is still free: within the bucket's 3, and within
// the server-wide daily cap. The refund gives the global budget (the SUM of
// the daily rows) back too, so the free sessions are capped separately; each
// costs max(grant, call max), what its ElevenLabs session can have run.
func (a *AttestAPI) takeFreeAbandon(bucket string, now time.Time, grant int) bool {
	cost := max(grant, a.cfg.VoiceCallMax)
	a.mu.Lock()
	defer a.mu.Unlock()
	a.rollFreeDayLocked(now)
	if a.abandons[bucket] >= attestVoiceFreeAbandons {
		return false
	}
	// The free-session allowance is half the global daily cap (Miles 8461).
	if a.cfg.VoiceGlobal > 0 && a.abandonFree+cost > a.cfg.VoiceGlobal/2 {
		return false
	}
	a.abandons[bucket]++
	a.abandonFree += cost
	return true
}

func (a *AttestAPI) rollFreeDayLocked(now time.Time) {
	if day := now.UTC().Format("2006-01-02"); a.abandonDay != day {
		a.abandonDay, a.abandons, a.refunded, a.abandonFree = day, map[string]int{}, map[string]int{}, 0
	}
}

// takeUnusedRefund is how many of an early-ended attached call's unused
// seconds it may hand back (bd med-dngs). The ElevenLabs session can outlive
// the hang-up, so each refund is trust: a bucket gets back at most its daily
// cap a UTC day (the lifetime budget when there is no daily cap), and the
// refunds count against the same server-wide half of the global cap as the
// free abandons — a start/hang-up loop cannot run unbounded sessions.
func (a *AttestAPI) takeUnusedRefund(bucket string, now time.Time, seconds int) int {
	limit := a.cfg.VoiceDaily
	if limit <= 0 {
		limit = a.cfg.VoiceLifetime
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.rollFreeDayLocked(now)
	seconds = min(seconds, limit-a.refunded[bucket])
	if a.cfg.VoiceGlobal > 0 {
		seconds = min(seconds, a.cfg.VoiceGlobal/2-a.abandonFree)
	}
	if seconds <= 0 {
		return 0
	}
	a.refunded[bucket] += seconds
	a.abandonFree += seconds
	return seconds
}

// NewAttestAPI builds the routes; trial supplies the provider config, the
// per-subject burst limiter and the shared upstream proxy; food supplies the
// operator FastFoodDB proxy (bd med-o7zq.19).
func NewAttestAPI(store *cloudstore.Repo, trial *TrialProxyAPI, food *FoodProxyAPI, cfg AttestConfig) *AttestAPI {
	a := &AttestAPI{cfg: cfg, store: store, trial: trial, food: food, ipLimiter: newRateLimiter(attestIPRatePerMin, time.Minute), challenges: map[string]time.Time{}, mux: http.NewServeMux()}
	if cfg.AndroidConfigured {
		a.android = playintegrity.New(cfg.Android)
	}
	a.mux.HandleFunc("POST "+attestChallengePath, a.challenge)
	a.mux.HandleFunc("POST "+attestEnrollPath, a.enroll)
	a.mux.HandleFunc("POST "+attestChatPath, a.chat)
	a.mux.HandleFunc("POST "+attestFeedbackPath, a.submitFeedback)
	a.mux.HandleFunc("GET "+attestFoodSearch, a.foodLookup)
	a.mux.HandleFunc("GET "+attestFoodBarcode+"{code}", a.foodLookup)
	a.mux.HandleFunc("POST "+attestVoiceStart, a.voiceStart)
	a.mux.HandleFunc("GET "+attestVoiceDevice, a.voiceDevice)
	a.mux.HandleFunc("POST "+attestDeletePath, a.eraseInstall)
	return a
}

// SetVoiceRelay enables anonymous voice (bd med-o7zq.22): calls are minted
// in relay and their turns answered by this API's trial proxy.
func (a *AttestAPI) SetVoiceRelay(relay *VoiceLLMRelayAPI) {
	a.voice = relay
	relay.trial = a.trial
}

// SetFeedback enables local-mode feedback (bd med-ta2n.19) with fb's age
// recipient and admin notifier, read per request (SetNotifier may run later).
func (a *AttestAPI) SetFeedback(fb *FeedbackAPI) { a.feedback = fb }

func (a *AttestAPI) feedbackRecipient() string {
	if a.feedback == nil {
		return ""
	}
	return a.feedback.recipient
}

// submitFeedback is the attested POST /api/attest/feedback (bd med-ta2n.19):
// the session route's body ({client_id, kind, app_version, ciphertext}, an
// age blob sealed in the app to feedbackRecipient) and cap, queued under
// cloudstore.AttestFeedbackAccount(bucket id) so cmd/feedbackpull drains it
// unchanged and the cap is per bucket. The assertion binds this URI and the
// exact body. Never logs the ciphertext, key id or bucket id; the admin ping
// carries kind + app version only.
func (a *AttestAPI) submitFeedback(w http.ResponseWriter, r *http.Request) {
	if a.feedbackRecipient() == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "feedback_disabled"})
		return
	}
	q, ok := a.assertHeaders(w, r)
	if !ok {
		return
	}
	// The body may be a 5 MB attachment blob: lift the unauth read deadline
	// only now that the key is known.
	extendTrialDeadlines(w)
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxFeedbackBodyBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "body_too_large"})
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return
	}
	if !a.verifyAssertion(w, r, q, body) {
		return
	}
	var req submitFeedbackRequest
	if err := json.Unmarshal(body, &req); err != nil || req.ClientID == "" || len(req.Ciphertext) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return
	}
	queued, err := a.store.AppendAttestFeedback(r.Context(), q.keyID, q.counter, req.ClientID, req.Kind, req.AppVersion, req.Ciphertext, time.Now().UTC())
	switch {
	case errors.Is(err, cloudstore.ErrAttestCounter):
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "assertion_invalid"})
		return
	case errors.Is(err, cloudstore.ErrFeedbackQueueFull):
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "feedback_queue_full"})
		return
	case err != nil:
		slog.Error("attest feedback append failed", "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "feedback_unavailable"})
		return
	}
	w.WriteHeader(http.StatusNoContent)
	// Same metadata-only ping as the session route, only for a new item.
	if notify := a.feedback.notify; notify != nil && queued {
		go notify(req.Kind, req.AppVersion)
	}
}

// eraseInstall is the attested POST /api/attest/delete (bd med-egb3, contract
// points 1-2 in the bead's topic): local mode's "Erase data on this device"
// deletes the caller's whole bucket — every install of this device's trial
// and the bucket's counters and pass hash. Empty body; the assertion binds
// this URI, so only a key of the bucket can delete it. No trialGranted gate:
// a feedback-only install erases too. No counter compare-and-set: the
// challenge is single-use and the rows are gone after. Idempotent: a key
// already gone answers assertHeaders' 401 install_unknown, which the page
// counts as done. Under grantMu so an enrollment's DeviceCheck query →
// insert never interleaves with the delete. Never logs the key or bucket id.
func (a *AttestAPI) eraseInstall(w http.ResponseWriter, r *http.Request) {
	q, ok := a.assertHeaders(w, r)
	if !ok || !a.verifyAssertion(w, r, q, nil) {
		return
	}
	a.grantMu.Lock()
	err := a.store.DeleteAttestBucket(r.Context(), q.install.BucketID)
	a.grantMu.Unlock()
	if err != nil {
		slog.Error("attest bucket erase failed", "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "erase_unavailable"})
		return
	}
	slog.Info("attest bucket erased by its holder", "kind", q.install.Kind)
	w.WriteHeader(http.StatusNoContent)
}

// voiceConfigured is the anonymous voice master switch (attestation is already
// checked by ServeHTTP / assertHeaders): a relay, a voice budget, the operator's ElevenLabs
// agent AND trial AI (the relay answers the turns with it).
func (a *AttestAPI) voiceConfigured(w http.ResponseWriter) bool {
	if a.voiceOn() {
		return true
	}
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "voice_not_configured"})
	return false
}

func (a *AttestAPI) voiceOn() bool {
	return a.voice != nil && a.cfg.VoiceLifetime > 0 && a.trial.cfg.TrialVoiceConfigured() && a.trial.cfg.TrialAIConfigured()
}

// voiceLimits are the operator's voice budgets for the client's copy (bd
// med-o7zq.28), so a TRIAL_ANON_VOICE_* change needs no app release.
// Additive fields: older builds ignore them.
func (a *AttestAPI) voiceLimits(resp map[string]any) {
	resp["voice_lifetime_seconds"] = a.cfg.VoiceLifetime
	resp["voice_daily_seconds"] = a.cfg.VoiceDaily
	resp["voice_call_max_seconds"] = a.cfg.VoiceCallMax
}

// voiceStart is the attested POST /api/attest/voice/start (empty body; the
// assertion binds the URI like the food routes). One transaction CHARGES the
// whole grant; then the signed URL is minted with the operator key (never
// logged) and the call is pre-registered in the relay. The charge is refunded
// when no signed URL reached the client (mint failure, lost relay race), and
// for a call no device leg ever attached to (bounded per bucket per day, see
// takeFreeAbandon). Once a leg attached, the ElevenLabs session can run to the
// agent's own max_duration_seconds whatever the leg does, so an early hang-up
// or a dropped leg gets its unused seconds back only within the bounded
// allowance of takeUnusedRefund (bd med-dngs).
func (a *AttestAPI) voiceStart(w http.ResponseWriter, r *http.Request) {
	if !a.voiceConfigured(w) {
		return
	}
	q, ok := a.assertHeaders(w, r)
	if !ok || !trialGranted(w, q) || !a.verifyAssertion(w, r, q, nil) {
		return
	}
	keyID, bucket := q.keyID, q.install.BucketID
	// One call per bucket: two installs of one device share the minutes. A
	// call no leg ever attached to is ended (and refunded, bounded) first, so
	// the retry after a failed attach mints anew (bd med-02b0).
	if a.voice.EndPendingAnonCall(bucket) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "call_in_progress"})
		return
	}
	// The ElevenLabs mint is a short upstream call: lift the unauth deadline.
	extendTrialDeadlines(w)
	now := time.Now().UTC()
	grant, scope, remaining, dayRemaining, err := a.store.ReserveAttestVoice(r.Context(), keyID, q.counter, now,
		a.cfg.VoiceLifetime, a.cfg.VoiceDaily, a.cfg.VoiceGlobal, a.cfg.VoiceCallMax, attestVoiceFloorSeconds)
	if errors.Is(err, cloudstore.ErrAttestCounter) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "assertion_invalid"})
		return
	}
	if err != nil {
		slog.Error("attest voice budget check failed", "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_budget_unavailable"})
		return
	}
	w.Header().Set("X-Trial-Voice-Remaining", strconv.Itoa(remaining))
	if scope != "" {
		slog.Warn("attest voice budget exhausted", "install", keyID, "scope", scope)
		resp := map[string]any{"error": "trial_budget_exhausted", "scope": scope}
		if scope != cloudstore.AttestScopeVoice {
			resp["resets_at"] = now.Truncate(24 * time.Hour).Add(24 * time.Hour).Format(time.RFC3339)
		}
		writeJSON(w, http.StatusTooManyRequests, resp)
		return
	}
	refund := func(seconds int) {
		if err := a.store.RefundAttestVoice(context.Background(), keyID, now, seconds); err != nil {
			slog.Error("attest voice refund failed", "install", keyID, "seconds", seconds, "error", err)
		}
	}
	signedURL, err := a.trial.mintTrialSignedURL(r.Context(), "install", keyID, true)
	if err != nil {
		refund(grant)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "upstream_error"})
		return
	}
	// A call that never attaches costs nothing — up to attestVoiceFreeAbandons
	// a bucket per UTC day and the server-wide daily cap, so devices cannot run
	// unbounded free ElevenLabs sessions from signed URLs they never attach
	// to (bd med-02b0).
	// A call that attached and ended before its grant ran out (hang-up,
	// dropped leg) is charged what it used — nothing when no turn was ever
	// answered — and gets the rest back, bounded by takeUnusedRefund (bd
	// med-dngs).
	end := func(attached bool, used int) {
		if !attached {
			refunded := a.takeFreeAbandon(bucket, time.Now(), grant)
			if refunded {
				refund(grant)
			}
			slog.Info("attest voice start abandoned", "install", keyID, "seconds", grant, "refunded", refunded)
			return
		}
		back := 0
		if unused := grant - used; unused > 0 {
			back = a.takeUnusedRefund(bucket, time.Now(), unused)
			refund(back)
		}
		slog.Info("attest voice call ended", "install", keyID, "granted_seconds", grant, "used_seconds", used, "refunded_seconds", back)
	}
	call, ok := a.voice.MintAnonCall(bucket, time.Duration(grant)*time.Second, end)
	if !ok {
		// A concurrent start for this install won the relay slot; this signed
		// URL never left the server, so no ElevenLabs session can use it.
		refund(grant)
		writeJSON(w, http.StatusConflict, map[string]string{"error": "call_in_progress"})
		return
	}
	slog.Info("attest voice start", "install", keyID, "granted_seconds", grant)
	resp := map[string]any{
		"signed_url": signedURL, "call": call, "granted_seconds": grant,
		"remaining_seconds": remaining, "daily_remaining_seconds": dayRemaining,
	}
	a.voiceLimits(resp)
	writeJSON(w, http.StatusOK, resp)
}

// voiceDevice is the anonymous call's device leg (WebSocket upgrade, token in
// ?call=); the relay checks the token.
func (a *AttestAPI) voiceDevice(w http.ResponseWriter, r *http.Request) {
	if !a.voiceConfigured(w) {
		return
	}
	a.voice.AnonDeviceSocket(w, r)
}

// RegisterRoutes mounts the whole prefix (CORS preflight included). The router
// forwards it only from the base domain.
func (a *AttestAPI) RegisterRoutes(mux *http.ServeMux) { mux.Handle(attestPathPrefix, a) }

func (a *AttestAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if origin := r.Header.Get("Origin"); origin == localAppOrigin || origin == androidLocalOrigin {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", origin)
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
	// Challenge, enroll and food need only an attestation kind; chat also
	// checks the AI trial config. One enrollment serves both. Enroll and the
	// assertion routes further refuse a kind that is not configured.
	if !a.cfg.Configured && !a.cfg.AndroidConfigured {
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
	// feedback_recipient (bd med-ta2n.19): the age PUBLIC key local-mode
	// feedback is sealed to ("" = feedback off), so the client needs no extra
	// unauthenticated route. Additive: older builds ignore it.
	writeJSON(w, http.StatusOK, map[string]any{"challenge": c, "expires_in": int(attestChallengeTTL.Seconds()), "feedback_recipient": a.feedbackRecipient()})
}

func (a *AttestAPI) enroll(w http.ResponseWriter, r *http.Request) {
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(attestUnauthReadTimeout))
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxAttestEnrollBytes+1))
	if err != nil || len(raw) > maxAttestEnrollBytes {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "body_too_large"})
		return
	}
	// A body without kind is the iOS body (every iOS build sends none).
	var probe struct {
		Kind string `json:"kind"`
	}
	_ = json.Unmarshal(raw, &probe)
	switch probe.Kind {
	case "", cloudstore.AttestKindIOS:
	case cloudstore.AttestKindAndroid:
		a.enrollAndroid(w, r, raw)
		return
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
		return
	}
	if !a.cfg.Configured {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_not_configured"})
		return
	}
	var req struct {
		KeyID       string `json:"key_id"`
		Attestation string `json:"attestation"`
		Challenge   string `json:"challenge"`
		DeviceToken string `json:"device_token"`
		// Pass is the trial pass of an earlier install on this device (bd
		// med-o7zq.26, from the iOS Keychain): the key rejoins that bucket.
		Pass string `json:"pass"`
		// Trial false (bd med-ta2n.25): key the install for feedback only.
		Trial *bool `json:"trial"`
	}
	if json.Unmarshal(raw, &req) != nil || req.KeyID == "" || (!noTrial(req.Trial) && req.DeviceToken == "" && req.Pass == "") {
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
	// Idempotent re-enroll: the key is already granted (or only feedback is
	// asked for), no DeviceCheck call. A feedback-only key asking for the
	// trial goes through the grant gate (upgrade).
	if in, err := a.store.AttestInstall(ctx, req.KeyID); err == nil {
		switch {
		case in.Granted || noTrial(req.Trial):
			a.enrolled(ctx, w, in, "")
		case req.Pass != "":
			a.rejoin(w, r, *in, req.Pass, true)
		default:
			a.upgrade(w, r, in, req.DeviceToken, nil, "")
		}
		return
	} else if !errors.Is(err, sql.ErrNoRows) {
		slog.Error("attest enroll lookup failed", "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_unavailable"})
		return
	}
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_unavailable"})
		return
	}
	install := cloudstore.AttestInstall{KeyID: req.KeyID, Kind: cloudstore.AttestKindIOS, PublicKey: der, Env: env, CreatedAt: time.Now().UTC()}
	if noTrial(req.Trial) {
		a.keyed(w, r, install)
		return
	}
	install.Granted = true
	if req.Pass != "" {
		a.rejoin(w, r, install, req.Pass, false)
		return
	}
	a.grantMu.Lock()
	defer a.grantMu.Unlock()
	// DeviceCheck bit0 = "this device had its trial", set at the first grant;
	// bit1 = "and a second, pass-less one" (bd med-o7zq.26: a wiped phone, or
	// an install from before trial passes). Fail CLOSED: the trial is
	// optional, BYOK is unaffected.
	bit0, bit1, _, err := a.cfg.AppAttest.QueryBits(ctx, req.DeviceToken)
	if err != nil {
		slog.Warn("attest enroll devicecheck query failed", "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_unavailable"})
		return
	}
	if bit0 && bit1 {
		slog.Info("attest enroll refused: device already had its trial")
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "trial_already_used"})
		return
	}
	// A fresh bucket. Its pass goes out in this response only; the server
	// keeps the secret's SHA-256.
	pass, hash := newTrialPass(req.KeyID)
	install.PassHash = hash
	if err := a.store.InsertAttestInstall(ctx, install); err != nil {
		// A concurrent enroll of the same key won the insert.
		if in, lerr := a.store.AttestInstall(ctx, req.KeyID); lerr == nil {
			a.enrolled(ctx, w, in, "")
			return
		}
		slog.Error("attest enroll insert failed", "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_unavailable"})
		return
	}
	// Crash between the insert and this write leaves a row with the bit unset:
	// at worst one extra trial on reinstall (accepted, docs/cloud-mode.md).
	if err := a.cfg.AppAttest.UpdateBits(ctx, req.DeviceToken, true, bit0 || bit1); err != nil {
		slog.Warn("attest enroll devicecheck update failed", "error", err)
		if derr := a.store.DeleteAttestInstall(context.WithoutCancel(ctx), req.KeyID); derr != nil {
			slog.Error("attest enroll rollback failed", "error", derr)
		}
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_unavailable"})
		return
	}
	slog.Info("attest enroll granted", "env", env, "second_grant", bit0)
	a.enrolled(ctx, w, &install, pass)
}

// enrollAndroid enrolls an Android Keystore P-256 key (bd med-nt9p.32.8.3):
// body {kind:"android", key_id, public_key (std base64 SPKI DER),
// integrity_token, challenge, pass?}. The Play Integrity standard-request
// token binds the challenge and the key through requestHash
// (playintegrity.RequestHash). Then the iOS flow, with Play Integrity device
// recall standing in for DeviceCheck when PLAY_INTEGRITY_DEVICE_RECALL is on
// (bd med-nt9p.32.8.6, see enrollAndroidRecall). With it off a pass-less
// enroll always founds a bucket — the known gap, bounded by the per-IP limit,
// TRIAL_DAILY_GLOBAL and the global voice cap.
// SECURITY: the token, its verdict payload and the pass are never logged;
// only the accepted app-verdict label (env, a fixed enum) is.
func (a *AttestAPI) enrollAndroid(w http.ResponseWriter, r *http.Request, raw []byte) {
	if !a.cfg.AndroidConfigured {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_not_configured"})
		return
	}
	var req struct {
		KeyID          string `json:"key_id"`
		PublicKey      string `json:"public_key"`
		IntegrityToken string `json:"integrity_token"`
		Challenge      string `json:"challenge"`
		Pass           string `json:"pass"`
		Trial          *bool  `json:"trial"` // false: feedback only (bd med-ta2n.25)
	}
	if json.Unmarshal(raw, &req) != nil || req.KeyID == "" || req.PublicKey == "" || req.IntegrityToken == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
		return
	}
	challenge := a.consumeChallenge(req.Challenge)
	if challenge == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "challenge_invalid"})
		return
	}
	der, err := base64.StdEncoding.DecodeString(req.PublicKey)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "attestation_invalid"})
		return
	}
	ctx := r.Context()
	// The decode is a Google round trip: lift the unauth deadline.
	extendTrialDeadlines(w)
	_, vd, err := a.android.VerifyEnrollment(ctx, req.IntegrityToken, challenge, req.KeyID, der)
	switch {
	case errors.Is(err, playintegrity.ErrUnavailable):
		// Fail CLOSED like DeviceCheck: the trial is optional, BYOK is unaffected.
		slog.Warn("attest android enroll: play integrity unavailable", "reason", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_unavailable"})
		return
	case errors.Is(err, playintegrity.ErrMalformed):
		// The only ErrMalformed reachable here is Google's 400 (token and
		// package are non-empty): a forged token, or PLAY_INTEGRITY_PACKAGE_NAME
		// not matching the app — then EVERY Android enroll lands here.
		slog.Warn("attest android enroll: Google refused to decode the integrity token (HTTP 400); if every Android enroll fails, check PLAY_INTEGRITY_PACKAGE_NAME", "reason", err)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "attestation_invalid"})
		return
	case err != nil:
		slog.Info("attest enroll rejected", "kind", cloudstore.AttestKindAndroid, "reason", err)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "attestation_invalid"})
		return
	}
	if a.cfg.AndroidRecall {
		// Held from the idempotent lookup through the recall write, so a
		// concurrent enroll of the same key never answers 200 for a row a
		// failed write is about to roll back. Flag off: no lock, as before.
		a.grantMu.Lock()
		defer a.grantMu.Unlock()
	}
	// Idempotent re-enroll: the key id is derived from the key, so a row with
	// it is this key's. A feedback-only key asking for the trial goes through
	// the grant gate (upgrade).
	if in, err := a.store.AttestInstall(ctx, req.KeyID); err == nil {
		switch {
		case in.Granted || noTrial(req.Trial):
			a.enrolled(ctx, w, in, "")
		case req.Pass != "":
			a.rejoin(w, r, *in, req.Pass, true)
		default:
			a.upgrade(w, r, in, "", vd.DeviceRecall, req.IntegrityToken)
		}
		return
	} else if !errors.Is(err, sql.ErrNoRows) {
		slog.Error("attest enroll lookup failed", "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_unavailable"})
		return
	}
	// Env records the accepted app verdict, so a sideload-test-window grant
	// (UNRECOGNIZED_VERSION) is visible in the row.
	verdict := vd.AppRecognitionVerdict
	install := cloudstore.AttestInstall{KeyID: req.KeyID, Kind: cloudstore.AttestKindAndroid, PublicKey: der, Env: verdict, CreatedAt: time.Now().UTC()}
	if noTrial(req.Trial) {
		a.keyed(w, r, install)
		return
	}
	install.Granted = true
	if req.Pass != "" {
		a.rejoin(w, r, install, req.Pass, false)
		return
	}
	if a.cfg.AndroidRecall {
		a.enrollAndroidRecall(w, r, install, vd.DeviceRecall, req.IntegrityToken)
		return
	}
	pass, hash := newTrialPass(req.KeyID)
	install.PassHash = hash
	if err := a.store.InsertAttestInstall(ctx, install); err != nil {
		if in, lerr := a.store.AttestInstall(ctx, req.KeyID); lerr == nil {
			a.enrolled(ctx, w, in, "")
			return
		}
		slog.Error("attest enroll insert failed", "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_unavailable"})
		return
	}
	slog.Info("attest enroll granted", "kind", cloudstore.AttestKindAndroid, "env", verdict)
	a.enrolled(ctx, w, &install, pass)
}

// enrollAndroidRecall is the pass-less Android grant with device recall on
// (bd med-nt9p.32.8.6), the twin of the iOS DeviceCheck branch in enroll:
// recall bitFirst = "this device had its trial", bitSecond = "and a second,
// pass-less one"; bitThird is unused. Google keeps the bits per device across
// reinstall and factory reset. The write only ever SETS bits (SetDeviceRecall
// never sends false): the verdict's values may be a stale snapshot, and
// clearing a held bit would reopen farming. Fail CLOSED: the trial is
// optional, BYOK is unaffected. The caller holds a.grantMu.
// SECURITY: the token is never logged.
func (a *AttestAPI) enrollAndroidRecall(w http.ResponseWriter, r *http.Request, install cloudstore.AttestInstall, recall *playintegrity.DeviceRecall, token string) {
	ctx := r.Context()
	if recall == nil {
		slog.Warn("device recall is on in env but not in the Play Integrity verdict: enable Device recall in Play Console (Protected with Play → Play Integrity API → Manage → Change responses)")
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_unavailable"})
		return
	}
	if recall.First && recall.Second {
		slog.Info("attest enroll refused: device already had its trial", "kind", cloudstore.AttestKindAndroid)
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "trial_already_used"})
		return
	}
	pass, hash := newTrialPass(install.KeyID)
	install.PassHash = hash
	if err := a.store.InsertAttestInstall(ctx, install); err != nil {
		if in, lerr := a.store.AttestInstall(ctx, install.KeyID); lerr == nil {
			a.enrolled(ctx, w, in, "")
			return
		}
		slog.Error("attest enroll insert failed", "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_unavailable"})
		return
	}
	// Crash between the insert and this write leaves the bits unset: at worst
	// one extra trial on reinstall (accepted, docs/cloud-mode.md). An
	// unevaluated recall reads all false and Google refuses the write, so it
	// rolls back here.
	if err := a.android.SetDeviceRecall(ctx, token, playintegrity.DeviceRecall{First: true, Second: recall.First}); err != nil {
		slog.Warn("attest android enroll: device recall write failed", "reason", err)
		if derr := a.store.DeleteAttestInstall(context.WithoutCancel(ctx), install.KeyID); derr != nil {
			slog.Error("attest enroll rollback failed", "error", derr)
		}
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_unavailable"})
		return
	}
	slog.Info("attest enroll granted", "kind", cloudstore.AttestKindAndroid, "env", install.Env, "second_grant", recall.First)
	a.enrolled(ctx, w, &install, pass)
}

// rejoin binds a freshly attested key to the bucket its trial pass names (bd
// med-o7zq.26): the reinstall shares that bucket's counters, nothing resets,
// and DeviceCheck is not asked. A pass that opens no bucket is refused like
// any other invalid attest input (the per-IP limit applies; each try costs a
// genuine attestation); the client drops it and enrolls without one.
// known: the key is already stored (feedback-only, bd med-ta2n.25) and moves
// to the pass's bucket; its own empty bucket stays, inert.
// SECURITY: the pass is never logged.
func (a *AttestAPI) rejoin(w http.ResponseWriter, r *http.Request, install cloudstore.AttestInstall, pass string, known bool) {
	ctx := r.Context()
	bucket, err := a.passBucket(ctx, pass)
	if err != nil {
		slog.Error("attest enroll pass lookup failed", "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_unavailable"})
		return
	}
	if bucket == "" {
		slog.Info("attest enroll rejected", "reason", "trial pass invalid")
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "trial_pass_invalid"})
		return
	}
	if known {
		err = a.store.MoveAttestInstall(ctx, install.KeyID, bucket)
	} else {
		install.BucketID = bucket
		err = a.store.InsertAttestInstall(ctx, install)
	}
	in, lerr := a.store.AttestInstall(ctx, install.KeyID)
	if known && err != nil {
		lerr = errors.Join(err, lerr)
	}
	// err with a readable row: a concurrent enroll of the same key won the insert.
	if lerr != nil {
		slog.Error("attest enroll rejoin failed", "error", errors.Join(err, lerr))
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_unavailable"})
		return
	}
	slog.Info("attest enroll rejoined", "env", install.Env)
	a.enrolled(ctx, w, in, "")
}

// noTrial is the enroll body's "trial": false (bd med-ta2n.25); absent or true
// is the trial enroll every older client sends.
func noTrial(trial *bool) bool { return trial != nil && !*trial }

// keyed stores a freshly attested key WITHOUT a trial grant (bd med-ta2n.25,
// enroll "trial": false): its own bucket with granted = 0 and no pass, no
// DeviceCheck / Play recall read or write. The key signs feedback; chat, food
// and voice answer trial_not_granted until an upgrade (see upgrade).
func (a *AttestAPI) keyed(w http.ResponseWriter, r *http.Request, install cloudstore.AttestInstall) {
	ctx := r.Context()
	install.Granted = false
	if err := a.store.InsertAttestInstall(ctx, install); err != nil {
		// A concurrent enroll of the same key won the insert.
		if in, lerr := a.store.AttestInstall(ctx, install.KeyID); lerr == nil {
			a.enrolled(ctx, w, in, "")
			return
		}
		slog.Error("attest enroll insert failed", "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_unavailable"})
		return
	}
	slog.Info("attest enroll keyed", "kind", install.Kind, "trial", false)
	a.enrolled(ctx, w, &install, "")
}

// upgrade runs the trial grant gate on a known feedback-only key (bd
// med-ta2n.25): the same DeviceCheck bits (iOS, deviceToken) or Play recall
// (Android with recall on; off, no gate — as a fresh recall-off enroll) as a
// fresh enroll, then grants the key's own bucket with a new pass. Refused →
// 403 trial_already_used and the row stays (the key keeps signing feedback).
// A failed bit write revokes the grant again. The caller holds a.grantMu for
// an Android recall-on enroll; every other kind takes it here.
// Reach: Android re-enrolls the same Keystore key with a new integrity token.
// Apple attests a key once, so the iOS shell's attest.enroll on an attested
// key mints a NEW key (ios/App/Attest.swift): an iOS upgrade arrives as a
// fresh key on the ordinary grant path, and this branch serves only a client
// replaying a key's attestation over a new challenge (tests).
// SECURITY: the tokens and the pass are never logged.
func (a *AttestAPI) upgrade(w http.ResponseWriter, r *http.Request, in *cloudstore.AttestInstall, deviceToken string, recall *playintegrity.DeviceRecall, integrityToken string) {
	ctx := r.Context()
	android := in.Kind == cloudstore.AttestKindAndroid
	if !android || !a.cfg.AndroidRecall {
		a.grantMu.Lock()
		defer a.grantMu.Unlock()
		// A concurrent upgrade of this key may have granted it meanwhile.
		fresh, err := a.store.AttestInstall(ctx, in.KeyID)
		if err != nil {
			slog.Error("attest enroll lookup failed", "error", err)
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_unavailable"})
			return
		}
		if fresh.Granted {
			a.enrolled(ctx, w, fresh, "")
			return
		}
	}
	var write func() error
	second := false
	switch {
	case android && !a.cfg.AndroidRecall:
	case android:
		if recall == nil {
			slog.Warn("device recall is on in env but not in the Play Integrity verdict: enable Device recall in Play Console (Protected with Play → Play Integrity API → Manage → Change responses)")
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_unavailable"})
			return
		}
		if recall.First && recall.Second {
			slog.Info("attest enroll refused: device already had its trial", "kind", in.Kind)
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "trial_already_used"})
			return
		}
		second = recall.First
		write = func() error {
			return a.android.SetDeviceRecall(ctx, integrityToken, playintegrity.DeviceRecall{First: true, Second: recall.First})
		}
	default:
		bit0, bit1, _, err := a.cfg.AppAttest.QueryBits(ctx, deviceToken)
		if err != nil {
			slog.Warn("attest enroll devicecheck query failed", "error", err)
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_unavailable"})
			return
		}
		if bit0 && bit1 {
			slog.Info("attest enroll refused: device already had its trial")
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "trial_already_used"})
			return
		}
		second = bit0
		write = func() error { return a.cfg.AppAttest.UpdateBits(ctx, deviceToken, true, bit0 || bit1) }
	}
	pass, hash := newTrialPass(in.BucketID)
	if err := a.store.SetAttestBucketGrant(ctx, in.BucketID, hash); err != nil {
		slog.Error("attest enroll grant failed", "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_unavailable"})
		return
	}
	if write != nil {
		if err := write(); err != nil {
			slog.Warn("attest enroll upgrade: device bit write failed", "kind", in.Kind, "reason", err)
			if derr := a.store.SetAttestBucketGrant(context.WithoutCancel(ctx), in.BucketID, nil); derr != nil {
				slog.Error("attest enroll rollback failed", "error", derr)
			}
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_unavailable"})
			return
		}
	}
	slog.Info("attest enroll granted", "kind", in.Kind, "env", in.Env, "second_grant", second, "upgrade", true)
	in.Granted = true
	a.enrolled(ctx, w, in, pass)
}

// trialPassBytes is the trial pass secret's size (256 bits of crypto/rand).
const trialPassBytes = 32

// newTrialPass mints a bucket's pass "<bucketID>.<secret>" (secret raw
// base64url) and the secret's SHA-256, the only part the server stores.
func newTrialPass(bucketID string) (pass string, hash []byte) {
	secret := make([]byte, trialPassBytes)
	_, _ = rand.Read(secret) // never fails (crypto/rand, Go 1.24+)
	sum := sha256.Sum256(secret)
	return bucketID + "." + base64.RawURLEncoding.EncodeToString(secret), sum[:]
}

// passBucket is the bucket a trial pass opens, "" when it opens none (unknown
// bucket, a bucket without a pass, a wrong or malformed secret). The hash
// compare is constant-time.
func (a *AttestAPI) passBucket(ctx context.Context, pass string) (string, error) {
	i := strings.LastIndexByte(pass, '.')
	if i <= 0 {
		return "", nil
	}
	secret, err := base64.RawURLEncoding.DecodeString(pass[i+1:])
	if err != nil || len(secret) != trialPassBytes {
		return "", nil
	}
	want, err := a.store.AttestBucketPassHash(ctx, pass[:i])
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	got := sha256.Sum256(secret)
	if subtle.ConstantTimeCompare(got[:], want) != 1 {
		return "", nil
	}
	return pass[:i], nil
}

// enrolled answers an enrolled key. pass is set only for a freshly granted
// bucket. granted (bd med-ta2n.25) is the client's only signal whether the key
// carries a trial; a feedback-only key answers remaining 0 and no voice
// fields. With anonymous voice on a granted key also carries the bucket's
// voice seconds left and the voice limits (bd med-o7zq.28), so Settings shows
// the minutes before any call — a rejoin included.
func (a *AttestAPI) enrolled(ctx context.Context, w http.ResponseWriter, in *cloudstore.AttestInstall, pass string) {
	remaining := 0
	if in.Granted {
		remaining = max(a.cfg.Lifetime-in.Used, 0)
	}
	w.Header().Set("X-Trial-Remaining", strconv.Itoa(remaining))
	a.setNextChallenge(w)
	resp := map[string]any{"remaining": remaining, "daily": a.cfg.Daily, "granted": in.Granted}
	if pass != "" {
		resp["pass"] = pass
	}
	if a.voiceOn() && in.Granted {
		if life, day, err := a.store.AttestVoiceUsage(ctx, in.KeyID, time.Now()); err != nil {
			// The grant stands; Settings just shows the minutes after a call.
			slog.Warn("attest enroll voice usage lookup failed", "error", err)
		} else {
			// Same arithmetic as cloudstore.ReserveAttestVoice.
			lifeLeft := max(a.cfg.VoiceLifetime-life, 0)
			dayLeft := lifeLeft
			if a.cfg.VoiceDaily > 0 {
				dayLeft = min(max(a.cfg.VoiceDaily-day, 0), lifeLeft)
			}
			resp["voice_remaining_seconds"] = lifeLeft
			resp["voice_daily_remaining_seconds"] = dayLeft
			a.voiceLimits(resp)
		}
	}
	writeJSON(w, http.StatusOK, resp)
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
	if !ok || !trialGranted(w, q) {
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
	// The burst limiter, like every budget, is the bucket's (bd med-o7zq.26).
	if !a.trial.rateLimit(w, a.trial.limiter, cloudstore.AttestSubject(q.install.BucketID)) {
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
	// A kind the operator has switched off answers like the whole prefix off.
	if !a.cfg.kindConfigured(q.install.Kind) {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_not_configured"})
		return nil, false
	}
	// The stored key is only ever one enrollment verified, so the assertion
	// verifier's trust in its curve holds.
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

// trialGranted refuses a feedback-only install (bd med-ta2n.25, enrolled with
// "trial": false) on the budgeted routes — chat, food, voice start — before
// any budget is touched. submitFeedback does not call it: that is the point.
func trialGranted(w http.ResponseWriter, q *attested) bool {
	if q.install.Granted {
		return true
	}
	writeJSON(w, http.StatusForbidden, map[string]string{"error": "trial_not_granted"})
	return false
}

// verifyAssertion checks the assertion over clientDataHash =
// SHA256(challenge || SHA256(pathAndQuery || "\n" || body)) — this
// single-use challenge, this exact request URI (query included) and this
// exact body (empty for a GET) — and records the new counter on q. The
// counter is committed only by the store's compare-and-set afterwards.
func (a *AttestAPI) verifyAssertion(w http.ResponseWriter, r *http.Request, q *attested, body []byte) bool {
	reqHash := sha256.Sum256(append([]byte(r.URL.RequestURI()+"\n"), body...))
	clientDataHash := sha256.Sum256(append(append([]byte{}, q.challenge...), reqHash[:]...))
	var counter uint32
	var err error
	if q.install.Kind == cloudstore.AttestKindAndroid {
		// counterBE ‖ ECDSA DER over clientDataHash ‖ counterBE (playintegrity).
		counter, err = playintegrity.VerifyAssertion(q.assertion, q.pub, clientDataHash[:], q.install.Counter)
	} else {
		counter, err = appattest.VerifyAssertion(q.assertion, q.pub, clientDataHash[:], a.cfg.AppAttest, q.install.Counter)
	}
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
	if !ok || !trialGranted(w, q) || !a.verifyAssertion(w, r, q, nil) {
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
