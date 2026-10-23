package cloudserver

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
	"github.com/korjavin/medicationtrackerbot/internal/playintegrity"
)

// decodeJWT splits a compact JWS and returns its header, claims, signing
// input digest and raw signature.
func decodeJWT(t *testing.T, tok string) (header, claims map[string]any, digest, sig []byte) {
	t.Helper()
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		t.Fatalf("JWT has %d parts, want 3", len(parts))
	}
	for i, dst := range []*map[string]any{&header, &claims} {
		b, err := base64.RawURLEncoding.DecodeString(parts[i])
		if err != nil || json.Unmarshal(b, dst) != nil {
			t.Fatalf("JWT part %d is not base64url JSON", i)
		}
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatalf("JWT signature is not base64url")
	}
	d := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	return header, claims, d[:], sig
}

func newTLSFake(t *testing.T, h http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewUnstartedServer(h)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return srv
}

// TestAPNsSender mirrors Apple's APNs HTTP/2 provider API ("Sending
// notification requests to APNs", "Establishing a token-based connection to
// APNs", "Handling notification responses from APNs"): POST /3/device/<token>
// over HTTP/2, `authorization: bearer <ES256 JWT {alg,kid}/{iss,iat}>`,
// apns-topic/apns-push-type/apns-priority headers; 200 = accepted, 410
// {"reason":"Unregistered"} and 400 {"reason":"BadDeviceToken"} = dead token.
func TestAPNsSender(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	var bearers []string
	srv := newTLSFake(t, func(w http.ResponseWriter, r *http.Request) {
		if r.ProtoMajor != 2 {
			t.Errorf("proto = %s, APNs requires HTTP/2", r.Proto)
		}
		if r.Header.Get("apns-topic") != "com.example.app" || r.Header.Get("apns-push-type") != "alert" || r.Header.Get("apns-priority") != "10" {
			t.Errorf("headers = %v", r.Header)
		}
		bearer, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok {
			t.Errorf("no bearer")
		}
		bearers = append(bearers, bearer)
		header, claims, digest, sig := decodeJWT(t, bearer)
		if header["alg"] != "ES256" || header["kid"] != "KEY123" || claims["iss"] != "TEAM123" || claims["iat"] == nil {
			t.Errorf("JWT header %v claims %v", header, claims)
		}
		if len(sig) != 64 || !ecdsa.Verify(&key.PublicKey, digest, new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
			t.Errorf("JWT is not a valid ES256 (raw R||S) signature")
		}
		var body struct {
			APS struct {
				Alert struct{ Title, Body string } `json:"alert"`
				CA    int                          `json:"content-available"`
			} `json:"aps"`
			Kind string `json:"kind"`
		}
		raw, _ := io.ReadAll(r.Body)
		if json.Unmarshal(raw, &body) != nil || body.Kind != nativeKindInboxWake || body.APS.CA != 1 || body.APS.Alert.Body != nativeWakeBody[nativeKindInboxWake] {
			t.Errorf("payload = %s", raw)
		}
		switch strings.TrimPrefix(r.URL.Path, "/3/device/") {
		case "good":
			w.WriteHeader(http.StatusOK)
		case "dead":
			w.WriteHeader(http.StatusGone)
			w.Write([]byte(`{"reason":"Unregistered","timestamp":1}`))
		case "bad":
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{"reason":"BadDeviceToken"}`))
		default:
			w.WriteHeader(http.StatusTooManyRequests)
			w.Write([]byte(`{"reason":"TooManyRequests"}`))
		}
	})
	s := &APNsSender{KeyID: "KEY123", TeamID: "TEAM123", Topic: "com.example.app", Key: key, BaseURL: srv.URL, Client: srv.Client()}
	ctx := t.Context()
	for tok, wantGone := range map[string]bool{"good": false, "dead": true, "bad": true} {
		gone, err := s.Send(ctx, tok, nativeKindInboxWake)
		if err != nil || gone != wantGone {
			t.Errorf("Send(%s) = %v, %v; want gone=%v", tok, gone, err, wantGone)
		}
	}
	if _, err := s.Send(ctx, "throttled", nativeKindInboxWake); err == nil || strings.Contains(err.Error(), "throttled") {
		t.Errorf("429 err = %v, want an error that never names the token", err)
	}
	for _, b := range bearers[1:] {
		if b != bearers[0] {
			t.Fatal("provider token was re-minted per send, want it cached")
		}
	}
}

// TestFCMSender mirrors FCM HTTP v1 (projects.messages.send: POST
// /v1/projects/<id>/messages:send with an OAuth2 bearer; 404 NOT_FOUND with
// FcmError errorCode UNREGISTERED = dead token) and Google's service-account
// OAuth2 JWT-bearer grant (POST token_uri, grant_type
// urn:ietf:params:oauth:grant-type:jwt-bearer, RS256 assertion {iss, scope,
// aud=token_uri, iat, exp} → {access_token, expires_in}).
func TestFCMSender(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	var mints int
	var srv *httptest.Server
	srv = newTLSFake(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			mints++
			if r.FormValue("grant_type") != "urn:ietf:params:oauth:grant-type:jwt-bearer" {
				t.Errorf("grant_type = %q", r.FormValue("grant_type"))
			}
			header, claims, digest, sig := decodeJWT(t, r.FormValue("assertion"))
			if header["alg"] != "RS256" || claims["iss"] != "svc@example.iam.gserviceaccount.com" || claims["scope"] != fcmScope || claims["aud"] != srv.URL+"/token" {
				t.Errorf("assertion header %v claims %v", header, claims)
			}
			if rsa.VerifyPKCS1v15(&key.PublicKey, crypto.SHA256, digest, sig) != nil {
				t.Errorf("assertion is not a valid RS256 signature")
			}
			w.Write([]byte(`{"access_token":"ya29.test","expires_in":3599,"token_type":"Bearer"}`))
		case "/v1/projects/proj-1/messages:send":
			if r.Header.Get("Authorization") != "Bearer ya29.test" {
				t.Errorf("auth = %q", r.Header.Get("Authorization"))
			}
			var body struct {
				Message struct {
					Token   string `json:"token"`
					Android struct {
						Priority     string            `json:"priority"`
						CollapseKey  string            `json:"collapse_key"`
						Notification map[string]string `json:"notification"`
					} `json:"android"`
					Notification map[string]string `json:"notification"`
					Data         map[string]string `json:"data"`
				} `json:"message"`
			}
			raw, _ := io.ReadAll(r.Body)
			m := &body.Message
			if json.Unmarshal(raw, &body) != nil || m.Android.Priority != "high" || m.Android.CollapseKey != nativeKindDryQueue || m.Android.Notification["tag"] != nativeKindDryQueue || m.Data["kind"] != nativeKindDryQueue || m.Notification["body"] != nativeWakeBody[nativeKindDryQueue] {
				t.Errorf("payload = %s", raw)
			}
			if m.Token == "misrouted" { // a bare 404 with no FcmError: config, not token
				w.WriteHeader(http.StatusNotFound)
				w.Write([]byte(`{"error":{"code":404,"status":"NOT_FOUND"}}`))
				return
			}
			if m.Token == "dead" {
				w.WriteHeader(http.StatusNotFound)
				w.Write([]byte(`{"error":{"code":404,"status":"NOT_FOUND","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"UNREGISTERED"}]}}`))
				return
			}
			w.Write([]byte(`{"name":"projects/proj-1/messages/1"}`))
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	})
	s := &FCMSender{
		ProjectID: "proj-1",
		SA:        playintegrity.ServiceAccount{ClientEmail: "svc@example.iam.gserviceaccount.com", PrivateKey: key, TokenURI: srv.URL + "/token"},
		BaseURL:   srv.URL,
		Client:    srv.Client(),
	}
	ctx := t.Context()
	if gone, err := s.Send(ctx, "good", nativeKindDryQueue); gone || err != nil {
		t.Fatalf("Send(good) = %v, %v", gone, err)
	}
	if gone, err := s.Send(ctx, "dead", nativeKindDryQueue); !gone || err != nil {
		t.Fatalf("Send(dead) = %v, %v; want gone", gone, err)
	}
	if gone, err := s.Send(ctx, "misrouted", nativeKindDryQueue); gone || err == nil {
		t.Fatalf("Send(misrouted) = %v, %v; want an error, token kept", gone, err)
	}
	if mints != 1 {
		t.Fatalf("access token minted %d times, want 1 (cached)", mints)
	}
}

// TestNativePushSendersFromEnv: unset = no sender and no error (deploy-compat);
// a partial set leaves the platform off rather than failing startup.
func TestNativePushSendersFromEnv(t *testing.T) {
	for _, k := range []string{"APNS_KEY_P8", "APNS_KEY_ID", "APNS_TEAM_ID", "APNS_BUNDLE_ID", "APNS_SANDBOX", "FCM_PROJECT_ID", "FCM_SERVICE_ACCOUNT_JSON"} {
		t.Setenv(k, "")
	}
	if got := NativePushSendersFromEnv(); len(got) != 0 {
		t.Fatalf("unset env senders = %v, want none", got)
	}

	t.Setenv("APNS_KEY_ID", "KEY123") // partial
	t.Setenv("FCM_PROJECT_ID", "proj-1")
	if got := NativePushSendersFromEnv(); len(got) != 0 {
		t.Fatalf("partial env senders = %v, want none", got)
	}

	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, _ := x509.MarshalPKCS8PrivateKey(key)
	p8 := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
	t.Setenv("APNS_KEY_P8", base64.StdEncoding.EncodeToString(p8))
	t.Setenv("APNS_TEAM_ID", "TEAM123")
	t.Setenv("APNS_BUNDLE_ID", "com.example.app")
	t.Setenv("APNS_SANDBOX", "1")
	got := NativePushSendersFromEnv()
	apns, ok := got[cloudstore.NativePushIOS].(*APNsSender)
	if !ok || apns.BaseURL != apnsSandboxURL || len(got) != 1 {
		t.Fatalf("senders = %v, want only a sandbox APNs sender", got)
	}

	// ES256 is P-256 only: a P-384 key would panic at signing, so it is refused.
	k384, _ := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	der384, _ := x509.MarshalPKCS8PrivateKey(k384)
	t.Setenv("APNS_KEY_P8", string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der384})))
	if _, ok := NativePushSendersFromEnv()[cloudstore.NativePushIOS]; ok {
		t.Fatal("a P-384 APNS_KEY_P8 was accepted")
	}

	// A PEM pasted inline with flattened "\n" escapes also parses.
	t.Setenv("APNS_KEY_P8", strings.ReplaceAll(string(p8), "\n", `\n`))
	if _, ok := NativePushSendersFromEnv()[cloudstore.NativePushIOS]; !ok {
		t.Fatal("inline PEM with literal \\n escapes was rejected")
	}
}
