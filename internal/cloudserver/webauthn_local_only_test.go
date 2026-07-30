package cloudserver

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/descope/virtualwebauthn"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

// Tests for the bd med-eas.2.1 local-only-passkey POC. The mode is off unless
// the operator opts in, is only reachable for the first credential, and stores
// NO new decrypting material server-side.

var localOnlyVerifier = []byte("recovery-verifier-bytes")

func localOnlyRecovery() *recoveryMaterialRequest {
	return &recoveryMaterialRequest{
		Envelope: envelopeWire{V: 1, Nonce: []byte("nonce-bytes-1234"), CT: []byte("recovery-ct-bytes"), MAC: []byte("mac-bytes")},
		Verifier: localOnlyVerifier,
	}
}

// finishLocalOnly posts a register/finish body in local-only shape: key_mode
// set, recovery material attached, and no credential envelope.
func finishLocalOnly(t *testing.T, h http.Handler, host string, challengeCookie *http.Cookie, response string, req registerFinishRequest) *httptest.ResponseRecorder {
	t.Helper()
	req.Credential = json.RawMessage(response)
	body, _ := json.Marshal(req)
	httpReq := httptest.NewRequest(http.MethodPost, "/api/webauthn/register/finish", bytes.NewReader(body))
	httpReq.Host = host
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.AddCookie(challengeCookie)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httpReq)
	return rec
}

const localOnlyTestSecret = "test-session-secret-at-least-32-bytes-long"

type localOnlyRun struct {
	store      *cloudstore.Repo
	account    *cloudstore.Account
	claimToken string
	handler    http.Handler
	host       string
	rec        *httptest.ResponseRecorder
}

// registerLocalOnly runs a full create ceremony against a fresh invite and
// finishes it in local-only mode. The handler carries the device routes too, so
// tests can read the device list back through the real HTTP surface.
func registerLocalOnly(t *testing.T, enabled bool, req registerFinishRequest) localOnlyRun {
	t.Helper()
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	api := NewWebAuthnAPI(store, localOnlyTestSecret)
	api.SetLocalOnlyPasskeyPOC(enabled)
	mux := http.NewServeMux()
	api.RegisterRoutes(mux)
	NewDeviceAPI(store, localOnlyTestSecret).RegisterRoutes(mux)
	NewRecoveryAPI(store).RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)

	rp := virtualwebauthn.RelyingParty{Name: "Med Tracker Cloud", ID: host, Origin: "http://" + host}
	authenticator := virtualwebauthn.NewAuthenticator()
	cred := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)

	opts, challengeCookie := beginRegistration(t, h, host, claimToken)
	response := virtualwebauthn.CreateAttestationResponse(rp, authenticator, cred, *opts)
	return localOnlyRun{
		store:      store,
		account:    account,
		claimToken: claimToken,
		handler:    h,
		host:       host,
		rec:        finishLocalOnly(t, h, host, challengeCookie, response, req),
	}
}

// sessionCookieFrom pulls the session cookie minted by a successful finish.
func sessionCookieFrom(t *testing.T, rec *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()
	for _, c := range rec.Result().Cookies() {
		if c.Name == SessionCookieName && c.Value != "" {
			return c
		}
	}
	t.Fatal("no session cookie set on finish")
	return nil
}

// The POC is inert on any deployment that has not opted in: same request, 403,
// nothing stored, and the invite is still spendable by a PRF-capable device.
func TestLocalOnlyRegistration_RejectedWhenPOCDisabled(t *testing.T) {
	run := registerLocalOnly(t, false, registerFinishRequest{
		KeyMode:  cloudstore.KeyModeLocalOnly,
		Recovery: localOnlyRecovery(),
	})
	if run.rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, body %q; want 403 with the POC disabled", run.rec.Code, run.rec.Body.String())
	}
	creds, _ := run.store.CredentialsByAccount(t.Context(), run.account.ID)
	if len(creds) != 0 {
		t.Fatalf("expected no credential stored, got %d", len(creds))
	}
	if _, err := run.store.ConsumeClaimToken(t.Context(), run.account.Subdomain, sha256Sum(run.claimToken), time.Now().UTC()); err != nil {
		t.Fatalf("claim must remain spendable after a rejected local-only attempt, got %v", err)
	}
}

// The happy path, and the server-side security claim of the whole mode: the
// account ends up with a local_only-typed credential, NO credential envelope,
// and only the recovery envelope + verifier — i.e. nothing the operator can
// decrypt with and nothing offline-guessable.
func TestLocalOnlyRegistration_StoresNoDecryptingMaterial(t *testing.T) {
	run := registerLocalOnly(t, true, registerFinishRequest{
		KeyMode:  cloudstore.KeyModeLocalOnly,
		Recovery: localOnlyRecovery(),
	})
	if run.rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %q", run.rec.Code, run.rec.Body.String())
	}

	creds, err := run.store.CredentialsByAccount(t.Context(), run.account.ID)
	if err != nil || len(creds) != 1 {
		t.Fatalf("CredentialsByAccount: %d creds, err %v", len(creds), err)
	}
	if creds[0].KeyMode != cloudstore.KeyModeLocalOnly {
		t.Fatalf("KeyMode = %q, want %q", creds[0].KeyMode, cloudstore.KeyModeLocalOnly)
	}

	envs, err := run.store.ListEnvelopes(t.Context(), run.account.ID)
	if err != nil {
		t.Fatalf("ListEnvelopes: %v", err)
	}
	if len(envs) != 1 || envs[0].CredentialRef != "recovery" {
		t.Fatalf("envelopes = %+v; want exactly the recovery envelope (no credential envelope)", envs)
	}

	// The recovery code is the only server-side route to the DEK, so it has to
	// actually work — an enrollment that stored a broken verifier would be worse
	// than one that refused.
	verifierHash := sha256.Sum256(localOnlyVerifier)
	if err := run.store.VerifyRecoveryAttempt(t.Context(), run.account.ID, verifierHash[:], time.Now().UTC()); err != nil {
		t.Fatalf("VerifyRecoveryAttempt: %v", err)
	}
}

// Recovery material is mandatory, not encouraged: without it the enrollment is
// refused outright and the invite stays spendable.
func TestLocalOnlyRegistration_RequiresRecoveryMaterial(t *testing.T) {
	run := registerLocalOnly(t, true, registerFinishRequest{
		KeyMode: cloudstore.KeyModeLocalOnly,
	})
	if run.rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body %q; want 400", run.rec.Code, run.rec.Body.String())
	}
	creds, _ := run.store.CredentialsByAccount(t.Context(), run.account.ID)
	if len(creds) != 0 {
		t.Fatalf("expected no credential stored, got %d", len(creds))
	}
	if _, err := run.store.ConsumeClaimToken(t.Context(), run.account.Subdomain, sha256Sum(run.claimToken), time.Now().UTC()); err != nil {
		t.Fatalf("claim must remain spendable, got %v", err)
	}
}

// A local-only credential has no KEK, so an envelope claiming to be for it is
// either junk or an attempt to smuggle one in. Reject rather than ignore.
func TestLocalOnlyRegistration_RejectsCredentialEnvelope(t *testing.T) {
	run := registerLocalOnly(t, true, registerFinishRequest{
		KeyMode:  cloudstore.KeyModeLocalOnly,
		Recovery: localOnlyRecovery(),
		Envelope: envelopeWire{V: 1, Nonce: []byte("nonce-bytes-1234"), CT: []byte("ciphertext-bytes"), MAC: []byte("mac-bytes")},
	})
	if run.rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body %q; want 400", run.rec.Code, run.rec.Body.String())
	}
}

// validateKeyMode's matrix, including the two gates the POC deliberately does
// not cover (device transfer and an already-unlocked session adding a passkey):
// mixed-mode accounts are out of POC scope, so those must be refused rather than
// silently permitted.
func TestValidateKeyMode(t *testing.T) {
	envelope := envelopeWire{V: 1, Nonce: []byte("nonce"), CT: []byte("ct"), MAC: []byte("mac")}

	cases := []struct {
		name       string
		enabled    bool
		gate       registerGate
		req        registerFinishRequest
		wantStatus int
		wantLocal  bool
	}{
		{"prf default unchanged", false, gateClaim, registerFinishRequest{Envelope: envelope}, 0, false},
		{"prf explicit", false, gateClaim, registerFinishRequest{KeyMode: cloudstore.KeyModePRF, Envelope: envelope}, 0, false},
		{"prf missing envelope", false, gateClaim, registerFinishRequest{}, http.StatusBadRequest, false},
		{"prf with recovery material", false, gateClaim, registerFinishRequest{Envelope: envelope, Recovery: localOnlyRecovery()}, http.StatusBadRequest, false},
		{"unknown mode", true, gateClaim, registerFinishRequest{KeyMode: "server_share", Envelope: envelope}, http.StatusBadRequest, false},
		{"local-only disabled", false, gateClaim, registerFinishRequest{KeyMode: cloudstore.KeyModeLocalOnly, Recovery: localOnlyRecovery()}, http.StatusForbidden, true},
		{"local-only enabled", true, gateClaim, registerFinishRequest{KeyMode: cloudstore.KeyModeLocalOnly, Recovery: localOnlyRecovery()}, 0, true},
		// Re-enrollment (Emergency Kit redemption / device transfer) is allowed —
		// the Emergency Kit has to actually work for the authenticators this mode
		// targets — but must not carry NEW recovery material, which would burn the
		// code the user is holding.
		{"local-only re-enrollment", true, gateEnrollment, registerFinishRequest{KeyMode: cloudstore.KeyModeLocalOnly}, 0, true},
		{"local-only re-enrollment with recovery material", true, gateEnrollment, registerFinishRequest{KeyMode: cloudstore.KeyModeLocalOnly, Recovery: localOnlyRecovery()}, http.StatusBadRequest, true},
		{"local-only via session gate", true, gateSession, registerFinishRequest{KeyMode: cloudstore.KeyModeLocalOnly}, http.StatusForbidden, true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			api := NewWebAuthnAPI(nil, "secret")
			api.SetLocalOnlyPasskeyPOC(tc.enabled)
			req := tc.req
			localOnly, status, msg := api.validateKeyMode(&req, tc.gate)
			if status != tc.wantStatus {
				t.Fatalf("status = %d (%q), want %d", status, msg, tc.wantStatus)
			}
			if localOnly != tc.wantLocal {
				t.Fatalf("localOnly = %v, want %v", localOnly, tc.wantLocal)
			}
		})
	}
}

// Cold unlock has to be able to tell "this credential has no envelope by
// design" from "this credential's envelope is missing", so login/finish reports
// the stored mode rather than leaving the client to infer it from a 404.
func TestLogin_ReportsKeyMode(t *testing.T) {
	for _, tc := range []struct {
		name    string
		enabled bool
		req     registerFinishRequest
		want    string
	}{
		{"prf credential", false, registerFinishRequest{Envelope: envelopeWire{V: 1, Nonce: []byte("nonce-bytes-1234"), CT: []byte("ciphertext-bytes"), MAC: []byte("mac-bytes")}}, cloudstore.KeyModePRF},
		{"local-only credential", true, registerFinishRequest{KeyMode: cloudstore.KeyModeLocalOnly, Recovery: localOnlyRecovery()}, cloudstore.KeyModeLocalOnly},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := setupStore(t)
			account, claimToken := setupInvite(t, store)
			host := account.Subdomain + ".localhost"
			h, api := newTestWebAuthnHandler(store)
			api.SetLocalOnlyPasskeyPOC(tc.enabled)

			rp := virtualwebauthn.RelyingParty{Name: "Med Tracker Cloud", ID: host, Origin: "http://" + host}
			authenticator := virtualwebauthn.NewAuthenticator()
			cred := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)

			opts, challengeCookie := beginRegistration(t, h, host, claimToken)
			response := virtualwebauthn.CreateAttestationResponse(rp, authenticator, cred, *opts)
			if rec := finishLocalOnly(t, h, host, challengeCookie, response, tc.req); rec.Code != http.StatusOK {
				t.Fatalf("register/finish status = %d, body %q", rec.Code, rec.Body.String())
			}
			authenticator.AddCredential(cred)

			assertOpts, loginCookie := beginLogin(t, h, host)
			assertion := virtualwebauthn.CreateAssertionResponse(rp, authenticator, cred, *assertOpts)
			rec := finishLogin(t, h, host, loginCookie, assertion)
			if rec.Code != http.StatusOK {
				t.Fatalf("login/finish status = %d, body %q", rec.Code, rec.Body.String())
			}
			var body struct {
				KeyMode string `json:"key_mode"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("decode login/finish: %v", err)
			}
			if body.KeyMode != tc.want {
				t.Fatalf("key_mode = %q, want %q", body.KeyMode, tc.want)
			}
		})
	}
}

// The device list has to distinguish "no envelope by design" from "envelope
// missing / forged", or every local-only passkey shows the alarm badge that is
// supposed to mean something.
func TestDeviceList_ReportsKeyMode(t *testing.T) {
	run := registerLocalOnly(t, true, registerFinishRequest{
		KeyMode:  cloudstore.KeyModeLocalOnly,
		Recovery: localOnlyRecovery(),
	})
	if run.rec.Code != http.StatusOK {
		t.Fatalf("register/finish status = %d, body %q", run.rec.Code, run.rec.Body.String())
	}

	req := httptest.NewRequest(http.MethodGet, "/api/devices", nil)
	req.Host = run.host
	req.AddCookie(sessionCookieFrom(t, run.rec))
	listRec := httptest.NewRecorder()
	run.handler.ServeHTTP(listRec, req)
	if listRec.Code != http.StatusOK {
		t.Fatalf("GET /api/devices status = %d, body %q", listRec.Code, listRec.Body.String())
	}

	var items []deviceListItem
	if err := json.Unmarshal(listRec.Body.Bytes(), &items); err != nil {
		t.Fatalf("decode device list: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("expected 1 device, got %d", len(items))
	}
	if items[0].KeyMode != cloudstore.KeyModeLocalOnly {
		t.Fatalf("key_mode = %q, want %q", items[0].KeyMode, cloudstore.KeyModeLocalOnly)
	}
	if items[0].Envelope != nil {
		t.Fatalf("local-only credential must have no envelope, got %+v", items[0].Envelope)
	}
}

// The whole mode rests on "your Emergency Kit is the way back". If redeeming it
// then demanded a PRF-capable authenticator to re-enroll, the mandatory recovery
// path would be unreachable for exactly the users this mode exists for. Drive
// the real thing: local-only signup -> POST /api/recover with the verifier ->
// re-enroll a second local-only credential through the enrollment gate.
func TestLocalOnlyRecovery_ReEnrollsWithoutPRF(t *testing.T) {
	run := registerLocalOnly(t, true, registerFinishRequest{
		KeyMode:  cloudstore.KeyModeLocalOnly,
		Recovery: localOnlyRecovery(),
	})
	if run.rec.Code != http.StatusOK {
		t.Fatalf("register/finish status = %d, body %q", run.rec.Code, run.rec.Body.String())
	}

	body, _ := json.Marshal(recoveryVerifierRequest{Verifier: localOnlyVerifier})
	recoverReq := httptest.NewRequest(http.MethodPost, "/api/recover", bytes.NewReader(body))
	recoverReq.Host = run.host
	recoverReq.Header.Set("Content-Type", "application/json")
	recoverRec := httptest.NewRecorder()
	run.handler.ServeHTTP(recoverRec, recoverReq)
	if recoverRec.Code != http.StatusOK {
		t.Fatalf("POST /api/recover status = %d, body %q", recoverRec.Code, recoverRec.Body.String())
	}
	var recovered recoverResponse
	if err := json.Unmarshal(recoverRec.Body.Bytes(), &recovered); err != nil {
		t.Fatalf("decode recover response: %v", err)
	}

	rp := virtualwebauthn.RelyingParty{Name: "Med Tracker Cloud", ID: run.host, Origin: "http://" + run.host}
	authenticator := virtualwebauthn.NewAuthenticator()
	cred := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)
	opts, challengeCookie, code := beginRegistrationWithEnrollmentToken(t, run.handler, run.host, recovered.EnrollmentToken)
	if code != http.StatusOK {
		t.Fatalf("register/begin via recovery enrollment token status = %d", code)
	}
	response := virtualwebauthn.CreateAttestationResponse(rp, authenticator, cred, *opts)
	// No recovery material in the body: the code the user just typed is still
	// theirs until the client rotates it, and re-enrollment must not burn it.
	finishRec := finishLocalOnly(t, run.handler, run.host, challengeCookie, response, registerFinishRequest{
		KeyMode: cloudstore.KeyModeLocalOnly,
	})
	if finishRec.Code != http.StatusOK {
		t.Fatalf("local-only re-enrollment status = %d, body %q", finishRec.Code, finishRec.Body.String())
	}

	creds, err := run.store.CredentialsByAccount(t.Context(), run.account.ID)
	if err != nil || len(creds) != 2 {
		t.Fatalf("expected 2 credentials after recovery, got %d (err %v)", len(creds), err)
	}
	for _, c := range creds {
		if c.KeyMode != cloudstore.KeyModeLocalOnly {
			t.Fatalf("credential %x has key_mode %q, want local_only", c.ID, c.KeyMode)
		}
	}
	// Still exactly one envelope, still only the recovery one: re-enrolling
	// added no server-side decrypting material.
	envs, err := run.store.ListEnvelopes(t.Context(), run.account.ID)
	if err != nil || len(envs) != 1 || envs[0].CredentialRef != "recovery" {
		t.Fatalf("envelopes = %+v (err %v); want exactly the recovery envelope", envs, err)
	}
}

// The client-visible flag: absent by default so /api/version stays byte-identical
// on every deployment that has not opted in.
func TestServeVersion_LocalOnlyPOCFlag(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		store := setupStore(t)
		account, _ := setupInvite(t, store)
		h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), http.NewServeMux(), "", false, false)
		h.SetLocalOnlyPasskeyPOC(enabled)

		req := httptest.NewRequest(http.MethodGet, "/api/version", nil)
		req.Host = account.Subdomain + ".localhost"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)

		var body map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode /api/version: %v", err)
		}
		_, present := body["local_only_passkey_poc"]
		if present != enabled {
			t.Fatalf("enabled=%v: local_only_passkey_poc present=%v, body %q", enabled, present, rec.Body.String())
		}
	}
}
