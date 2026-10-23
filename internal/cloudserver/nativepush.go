package cloudserver

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/appattest"
	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
	"github.com/korjavin/medicationtrackerbot/internal/playintegrity"
)

// Native push (bd med-erq1.2): APNs (iOS shell) and FCM (Android shell) as a
// second, content-free wake channel next to Web Push. Only two payloads ever
// go out, each a fixed kind tag plus the fixed text the system shows when no
// page is alive to take the wake — never account data, never ids.
const (
	nativeKindInboxWake = "inbox-wake"
	nativeKindDryQueue  = "dry-queue"
	nativeWakeTitle     = "Med Tracker"
)

// nativeWakeBody is the notification text per kind: the same constants
// web/cloud/sw.js renders for the Web Push twins (INBOX_WAKE_NOTIFICATION,
// STALE_SYNC_WARNING).
var nativeWakeBody = map[string]string{
	nativeKindInboxWake: "Open the app to record what you sent",
	nativeKindDryQueue:  "Open the app to keep reminders running",
}

// NativePushSender delivers one content-free wake to one device token.
// gone=true means the provider reported the token dead (APNs 410 /
// BadDeviceToken, FCM UNREGISTERED); the relay then disables it. Errors never
// carry the token.
type NativePushSender interface {
	Send(ctx context.Context, token, kind string) (gone bool, err error)
}

var nativePushHTTP = &http.Client{Timeout: relaySendTimeout}

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// signJWT builds a compact JWS over header/claims; sign receives the SHA-256
// digest of the signing input. Stdlib only, no JWT library.
func signJWT(header, claims map[string]any, sign func(digest []byte) ([]byte, error)) (string, error) {
	h, err := json.Marshal(header)
	if err != nil {
		return "", err
	}
	c, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	input := b64url(h) + "." + b64url(c)
	digest := sha256.Sum256([]byte(input))
	sig, err := sign(digest[:])
	if err != nil {
		return "", err
	}
	return input + "." + b64url(sig), nil
}

// signES256 is JWS ES256 (RFC 7518 §3.4): the raw 32-byte R || S, not ASN.1.
func signES256(key *ecdsa.PrivateKey) func([]byte) ([]byte, error) {
	return func(digest []byte) ([]byte, error) {
		r, s, err := ecdsa.Sign(rand.Reader, key, digest)
		if err != nil {
			return nil, err
		}
		sig := make([]byte, 64)
		r.FillBytes(sig[:32])
		s.FillBytes(sig[32:])
		return sig, nil
	}
}

func signRS256(key *rsa.PrivateKey) func([]byte) ([]byte, error) {
	return func(digest []byte) ([]byte, error) {
		return rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest)
	}
}

// nativePost sends a JSON or form body and returns status + a bounded body. A
// transport error is unwrapped from *url.Error, whose text embeds the URL —
// and an APNs URL embeds the device token.
func nativePost(ctx context.Context, client *http.Client, u, ctype, bearer string, body []byte, hdr map[string]string) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(body))
	if err != nil {
		return 0, nil, errors.New("bad request")
	}
	req.Header.Set("Content-Type", ctype)
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("transport: %w", urlErrCause(err))
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	return resp.StatusCode, b, nil
}

// APNs hosts (Apple, "Sending notification requests to APNs").
const (
	apnsProductionURL = "https://api.push.apple.com"
	apnsSandboxURL    = "https://api.sandbox.push.apple.com"
	// Apple refuses a provider token older than an hour and throttles one
	// refreshed more often than every 20 minutes.
	apnsTokenTTL = 50 * time.Minute
)

// APNsSender speaks the APNs HTTP/2 provider API with token-based auth: an
// ES256 JWT {kid}/{iss, iat} signed by the team's .p8 key. net/http
// negotiates HTTP/2 over TLS by itself.
type APNsSender struct {
	KeyID, TeamID, Topic string
	Key                  *ecdsa.PrivateKey
	BaseURL              string // apnsProductionURL / apnsSandboxURL; tests: a fake
	Client               *http.Client

	mu    sync.Mutex
	jwt   string
	jwtAt time.Time
}

func (s *APNsSender) providerToken(reset bool) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	if !reset && s.jwt != "" && now.Sub(s.jwtAt) < apnsTokenTTL {
		return s.jwt, nil
	}
	tok, err := signJWT(map[string]any{"alg": "ES256", "kid": s.KeyID}, map[string]any{"iss": s.TeamID, "iat": now.Unix()}, signES256(s.Key))
	if err != nil {
		return "", errors.New("apns: sign provider token")
	}
	s.jwt, s.jwtAt = tok, now
	return tok, nil
}

func (s *APNsSender) Send(ctx context.Context, token, kind string) (bool, error) {
	jwt, err := s.providerToken(false)
	if err != nil {
		return false, err
	}
	body, _ := json.Marshal(map[string]any{
		"aps": map[string]any{
			"alert":             map[string]string{"title": nativeWakeTitle, "body": nativeWakeBody[kind]},
			"content-available": 1,
			"sound":             "default",
		},
		"kind": kind,
	})
	status, resp, err := nativePost(ctx, s.Client, s.BaseURL+"/3/device/"+url.PathEscape(token), "application/json", jwt, body, map[string]string{
		"apns-topic":       s.Topic,
		"apns-push-type":   "alert",
		"apns-priority":    "10",
		"apns-collapse-id": kind,
	})
	if err != nil {
		return false, fmt.Errorf("apns: %w", err)
	}
	if status == http.StatusOK {
		return false, nil
	}
	var r struct {
		Reason string `json:"reason"`
	}
	_ = json.Unmarshal(resp, &r)
	switch {
	case status == http.StatusGone, status == http.StatusBadRequest && r.Reason == "BadDeviceToken":
		return true, nil
	case status == http.StatusForbidden && (r.Reason == "ExpiredProviderToken" || r.Reason == "InvalidProviderToken"):
		_, _ = s.providerToken(true) // the next send carries a fresh one
	}
	return false, fmt.Errorf("apns: status %d %s", status, r.Reason)
}

const (
	fcmBaseURL = "https://fcm.googleapis.com"
	fcmScope   = "https://www.googleapis.com/auth/firebase.messaging"
)

// FCMSender speaks FCM HTTP v1 with a service-account OAuth2 bearer, minted
// by the JWT-bearer grant (RS256 assertion) and cached until a minute before
// expiry. No Firebase Admin SDK.
type FCMSender struct {
	ProjectID string
	SA        playintegrity.ServiceAccount
	BaseURL   string // fcmBaseURL; tests: a fake
	Client    *http.Client

	mu        sync.Mutex
	access    string
	accessExp time.Time
}

func (s *FCMSender) accessToken(ctx context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	if s.access != "" && now.Before(s.accessExp.Add(-time.Minute)) {
		return s.access, nil
	}
	assertion, err := signJWT(map[string]any{"alg": "RS256", "typ": "JWT"}, map[string]any{
		"iss":   s.SA.ClientEmail,
		"scope": fcmScope,
		"aud":   s.SA.TokenURI,
		"iat":   now.Unix(),
		"exp":   now.Add(time.Hour).Unix(),
	}, signRS256(s.SA.PrivateKey))
	if err != nil {
		return "", errors.New("fcm: sign assertion")
	}
	form := url.Values{"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"}, "assertion": {assertion}}
	status, body, err := nativePost(ctx, s.Client, s.SA.TokenURI, "application/x-www-form-urlencoded", "", []byte(form.Encode()), nil)
	if err != nil {
		return "", fmt.Errorf("fcm: token: %w", err)
	}
	var tr struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
	}
	if status != http.StatusOK || json.Unmarshal(body, &tr) != nil || tr.AccessToken == "" || tr.ExpiresIn <= 0 {
		return "", fmt.Errorf("fcm: token status %d", status)
	}
	s.access, s.accessExp = tr.AccessToken, now.Add(time.Duration(tr.ExpiresIn)*time.Second)
	return s.access, nil
}

func (s *FCMSender) Send(ctx context.Context, token, kind string) (bool, error) {
	bearer, err := s.accessToken(ctx)
	if err != nil {
		return false, err
	}
	body, _ := json.Marshal(map[string]any{"message": map[string]any{
		"token":        token,
		"android":      map[string]string{"priority": "high", "collapse_key": kind},
		"notification": map[string]string{"title": nativeWakeTitle, "body": nativeWakeBody[kind]},
		"data":         map[string]string{"kind": kind},
	}})
	status, resp, err := nativePost(ctx, s.Client, s.BaseURL+"/v1/projects/"+url.PathEscape(s.ProjectID)+"/messages:send", "application/json", bearer, body, nil)
	if err != nil {
		return false, fmt.Errorf("fcm: %w", err)
	}
	if status == http.StatusOK {
		return false, nil
	}
	var e struct {
		Error struct {
			Status  string `json:"status"`
			Details []struct {
				ErrorCode string `json:"errorCode"`
			} `json:"details"`
		} `json:"error"`
	}
	_ = json.Unmarshal(resp, &e)
	for _, d := range e.Error.Details {
		if d.ErrorCode == "UNREGISTERED" {
			return true, nil
		}
	}
	// A bare 404 (wrong FCM_PROJECT_ID, say) is a config error, not a dead
	// token: only the explicit UNREGISTERED code above disables one.
	if status == http.StatusUnauthorized {
		s.mu.Lock()
		s.access = "" // re-mint on the next send
		s.mu.Unlock()
	}
	return false, fmt.Errorf("fcm: status %d %s", status, e.Error.Status)
}

// envSecret reads a key/JSON env var given inline (it starts with prefix) or
// base64-encoded.
func envSecret(v, prefix string) ([]byte, error) {
	v = strings.TrimSpace(v)
	if strings.HasPrefix(v, prefix) {
		return []byte(v), nil
	}
	return base64.StdEncoding.DecodeString(v)
}

// NativePushSendersFromEnv builds the per-platform senders from APNS_* (ios)
// and FCM_* (android). A platform whose vars are all unset is simply absent —
// its tokens are skipped and the server runs exactly as before. A partial or
// unparseable set logs an error naming the variables (never values) and also
// leaves that platform off: native push is additive, never a startup failure.
func NativePushSendersFromEnv() map[string]NativePushSender {
	out := map[string]NativePushSender{}
	if s, err := apnsFromEnv(); err != nil {
		slog.Error("native push: APNs config invalid, iOS push off", "error", err)
	} else if s != nil {
		out[cloudstore.NativePushIOS] = s
	}
	if s, err := fcmFromEnv(); err != nil {
		slog.Error("native push: FCM config invalid, Android push off", "error", err)
	} else if s != nil {
		out[cloudstore.NativePushAndroid] = s
	}
	_, ios := out[cloudstore.NativePushIOS]
	_, android := out[cloudstore.NativePushAndroid]
	slog.Info("native push", "ios", ios, "android", android)
	return out
}

func apnsFromEnv() (*APNsSender, error) {
	p8, keyID, teamID, topic, sandbox := os.Getenv("APNS_KEY_P8"), os.Getenv("APNS_KEY_ID"), os.Getenv("APNS_TEAM_ID"), os.Getenv("APNS_BUNDLE_ID"), os.Getenv("APNS_SANDBOX")
	if p8 == "" && keyID == "" && teamID == "" && topic == "" {
		return nil, nil
	}
	if p8 == "" || keyID == "" || teamID == "" || topic == "" {
		return nil, errors.New("APNS_KEY_P8, APNS_KEY_ID, APNS_TEAM_ID and APNS_BUNDLE_ID must be set together")
	}
	pem, err := envSecret(p8, "-----BEGIN")
	if err != nil {
		return nil, errors.New("APNS_KEY_P8 is neither PEM nor base64")
	}
	// .env files often flatten the PEM's newlines into literal "\n".
	key, err := appattest.ParsePrivateKeyPEM(bytes.ReplaceAll(pem, []byte(`\n`), []byte("\n")))
	if err != nil || key.Curve != elliptic.P256() {
		return nil, errors.New("APNS_KEY_P8 is not a PKCS#8 EC P-256 key")
	}
	base := apnsProductionURL
	if sandbox != "" {
		on, err := strconv.ParseBool(sandbox)
		if err != nil {
			return nil, errors.New("APNS_SANDBOX must be 1/true or 0/false")
		}
		if on {
			base = apnsSandboxURL
		}
	}
	return &APNsSender{KeyID: keyID, TeamID: teamID, Topic: topic, Key: key, BaseURL: base, Client: nativePushHTTP}, nil
}

func fcmFromEnv() (*FCMSender, error) {
	project, saRaw := os.Getenv("FCM_PROJECT_ID"), os.Getenv("FCM_SERVICE_ACCOUNT_JSON")
	if project == "" && saRaw == "" {
		return nil, nil
	}
	if project == "" || saRaw == "" {
		return nil, errors.New("FCM_PROJECT_ID and FCM_SERVICE_ACCOUNT_JSON must be set together")
	}
	b, err := envSecret(saRaw, "{")
	if err != nil {
		return nil, errors.New("FCM_SERVICE_ACCOUNT_JSON is neither JSON nor base64")
	}
	sa, err := playintegrity.ParseServiceAccountJSON(b)
	if err != nil {
		// Its errors name the field, never the value.
		return nil, errors.New("FCM_SERVICE_ACCOUNT_JSON: " + strings.TrimPrefix(err.Error(), "playintegrity: "))
	}
	return &FCMSender{ProjectID: project, SA: sa, BaseURL: fcmBaseURL, Client: nativePushHTTP}, nil
}
