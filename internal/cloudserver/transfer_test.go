package cloudserver

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/descope/virtualwebauthn"
	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

const testSessionSecret = "test-session-secret-at-least-32-bytes-long"

// newTestTransferHandler mirrors cmd/cloud/main.go's wiring for the WebAuthn +
// transfer + device routes so a test can mint a real session via the register
// ceremony before exercising /api/transfer.
func newTestTransferHandler(t *testing.T) (http.Handler, string, string) {
	h, _, account, claimToken := newTestTransferHandlerWithStore(t)
	return h, account.Subdomain + ".localhost", claimToken
}

func newTestTransferHandlerWithStore(t *testing.T) (http.Handler, *cloudstore.Repo, *cloudstore.Account, string) {
	t.Helper()
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	mux := http.NewServeMux()
	NewWebAuthnAPI(store, testSessionSecret).RegisterRoutes(mux)
	NewTransferAPI(store, testSessionSecret).RegisterRoutes(mux)
	NewDeviceAPI(store, testSessionSecret).RegisterRoutes(mux)
	return New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false), store, account, claimToken
}

// Fixed protocol values: the server validates sizes only, never content.
var (
	testCommit = bytes.Repeat([]byte{0xc0}, transferCommitLen)
	testNPub   = append([]byte{0x02}, bytes.Repeat([]byte{0x11}, transferPubLen-1)...)
	testOPub   = append([]byte{0x03}, bytes.Repeat([]byte{0x22}, transferPubLen-1)...)
	testMacN   = bytes.Repeat([]byte{0xaa}, transferMACLen)
	testMacO   = bytes.Repeat([]byte{0xbb}, transferMACLen)
	testConfN  = bytes.Repeat([]byte{0xcc}, transferMACLen)
	testCT     = []byte("dek-wrapped-under-k-wrap")
)

// transferReq sends one request; body (if non-nil) is JSON-encoded.
func transferReq(t *testing.T, h http.Handler, method, host, path string, body any, session *http.Cookie, claimToken string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		reader = bytes.NewReader(raw)
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Host = host
	if session != nil {
		req.AddCookie(session)
	}
	if claimToken != "" {
		req.Header.Set(transferTokenHeader, claimToken)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// newSlotID derives a slot id the way the origin does: a fresh 16-byte TK,
// slot = base64url(SHA-256(TK))[:22].
func newSlotID(t *testing.T) string {
	t.Helper()
	tk := make([]byte, 16)
	if _, err := rand.Read(tk); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(tk)
	return base64.RawURLEncoding.EncodeToString(sum[:])[:transferSlotIDLen]
}

func createSlot(t *testing.T, h http.Handler, host string, session *http.Cookie) string {
	t.Helper()
	rec := transferReq(t, h, http.MethodPost, host, "/api/transfer", createTransferRequest{SlotID: newSlotID(t), Commit: testCommit}, session, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/transfer status = %d, body %q", rec.Code, rec.Body.String())
	}
	var created createTransferResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil || created.SlotID == "" {
		t.Fatalf("create response %q: %v", rec.Body.String(), err)
	}
	return created.SlotID
}

func claimSlot(t *testing.T, h http.Handler, host, slotID string) *httptest.ResponseRecorder {
	t.Helper()
	return transferReq(t, h, http.MethodPost, host, "/api/transfer/"+slotID+"/claim",
		claimTransferRequest{NPub: testNPub, Platform: "android", MacN: testMacN}, nil, "")
}

func mustClaimToken(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("claim status = %d, body %q", rec.Code, rec.Body.String())
	}
	var claimed claimTransferResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &claimed); err != nil || claimed.ClaimToken == "" {
		t.Fatalf("claim response %q: %v", rec.Body.String(), err)
	}
	return claimed.ClaimToken
}

func revealSlot(t *testing.T, h http.Handler, host, slotID string, session *http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	return transferReq(t, h, http.MethodPost, host, "/api/transfer/"+slotID+"/reveal",
		revealTransferRequest{OPub: testOPub, MacO: testMacO}, session, "")
}

func approveSlot(t *testing.T, h http.Handler, host, slotID string, session *http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	return transferReq(t, h, http.MethodPost, host, "/api/transfer/"+slotID+"/approve",
		approveTransferRequest{CT: testCT}, session, "")
}

func pollSlot(t *testing.T, h http.Handler, host, slotID, token string) (int, transferPollView) {
	t.Helper()
	rec := transferReq(t, h, http.MethodGet, host, "/api/transfer/"+slotID, nil, nil, token)
	var view transferPollView
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
			t.Fatalf("poll response %q: %v", rec.Body.String(), err)
		}
	}
	return rec.Code, view
}

func originSlot(t *testing.T, h http.Handler, host, slotID string, session *http.Cookie) (int, transferOriginView) {
	t.Helper()
	rec := transferReq(t, h, http.MethodGet, host, "/api/transfer/"+slotID, nil, session, "")
	var view transferOriginView
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
			t.Fatalf("origin response %q: %v", rec.Body.String(), err)
		}
	}
	return rec.Code, view
}

func wantCode(t *testing.T, what string, rec *httptest.ResponseRecorder, want int) {
	t.Helper()
	if rec.Code != want {
		t.Fatalf("%s status = %d, want %d, body %q", what, rec.Code, want, rec.Body.String())
	}
}

// driveToApproved runs create -> claim -> reveal -> approve over HTTP and
// returns the slot id + the claimant's token (= the enrollment token).
func driveToApproved(t *testing.T, h http.Handler, host string, session *http.Cookie) (string, string) {
	t.Helper()
	slotID := createSlot(t, h, host, session)
	token := mustClaimToken(t, claimSlot(t, h, host, slotID))
	wantCode(t, "reveal", revealSlot(t, h, host, slotID, session), http.StatusNoContent)
	wantCode(t, "approve", approveSlot(t, h, host, slotID, session), http.StatusNoContent)
	return slotID, token
}

// enrollViaToken registers a fresh virtual passkey with an enrollment token
// (and conf_n) and returns the finish response.
func enrollViaToken(t *testing.T, h http.Handler, host, token string, confN []byte) *httptest.ResponseRecorder {
	t.Helper()
	opts, cookie, code := beginRegistrationWith(t, h, host, registerBeginRequest{EnrollmentToken: token, ConfN: confN})
	if code != http.StatusOK {
		t.Fatalf("register/begin via enrollment token status = %d, want 200", code)
	}
	rp := virtualwebauthn.RelyingParty{Name: "Med Tracker Cloud", ID: host, Origin: "http://" + host}
	response := virtualwebauthn.CreateAttestationResponse(rp, virtualwebauthn.NewAuthenticator(), virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2), *opts)
	return finishRegistration(t, h, host, cookie, response)
}

// The whole v2 hand-off, checking at every step that nothing is released
// early: the poller sees commit, then o_pub/mac_o, and ct + enrollment token
// only after approve and only with the claim token.
func TestTransferV2_FullLifecycle(t *testing.T) {
	h, store, account, invite := newTestTransferHandlerWithStore(t)
	host := account.Subdomain + ".localhost"
	session := registerAndGetSession(t, h, host, invite)
	slotID := createSlot(t, h, host, session)

	code, poll := pollSlot(t, h, host, slotID, "")
	if code != http.StatusOK || poll.Status != "pending" || !bytes.Equal(poll.Commit, testCommit) || poll.ExpiresAt.IsZero() {
		t.Fatalf("pending poll = %d %+v", code, poll)
	}

	token := mustClaimToken(t, claimSlot(t, h, host, slotID))

	code, origin := originSlot(t, h, host, slotID, session)
	if code != http.StatusOK || origin.Status != "claimed" || origin.Platform != "android" ||
		!bytes.Equal(origin.NPub, testNPub) || !bytes.Equal(origin.MacN, testMacN) {
		t.Fatalf("origin view after claim = %d %+v", code, origin)
	}
	if _, poll = pollSlot(t, h, host, slotID, token); poll.Status != "claimed" || poll.OPub != nil || poll.CT != nil || poll.EnrollmentToken != "" {
		t.Fatalf("claimed poll leaked: %+v", poll)
	}
	// The claim token is inert until approve.
	if _, _, code := beginRegistrationWith(t, h, host, registerBeginRequest{EnrollmentToken: token}); code != http.StatusForbidden {
		t.Fatalf("register/begin before approve = %d, want 403", code)
	}

	wantCode(t, "reveal", revealSlot(t, h, host, slotID, session), http.StatusNoContent)
	_, poll = pollSlot(t, h, host, slotID, token)
	if poll.Status != "revealed" || !bytes.Equal(poll.OPub, testOPub) || !bytes.Equal(poll.MacO, testMacO) || poll.CT != nil || poll.EnrollmentToken != "" {
		t.Fatalf("revealed poll = %+v", poll)
	}
	if _, _, code := beginRegistrationWith(t, h, host, registerBeginRequest{EnrollmentToken: token}); code != http.StatusForbidden {
		t.Fatalf("register/begin before approve (revealed) = %d, want 403", code)
	}

	wantCode(t, "approve", approveSlot(t, h, host, slotID, session), http.StatusNoContent)
	// Without (or with a wrong) claim token, approved releases nothing.
	for _, tok := range []string{"", "00ff"} {
		if _, poll = pollSlot(t, h, host, slotID, tok); poll.Status != "approved" || poll.CT != nil || poll.EnrollmentToken != "" {
			t.Fatalf("approved poll with token %q leaked: %+v", tok, poll)
		}
	}
	_, poll = pollSlot(t, h, host, slotID, token)
	if !bytes.Equal(poll.CT, testCT) || poll.EnrollmentToken != token || poll.AccountID != account.ID || !bytes.Equal(poll.OPub, testOPub) {
		t.Fatalf("claimant's approved poll = %+v", poll)
	}

	wantCode(t, "register/finish", enrollViaToken(t, h, host, poll.EnrollmentToken, testConfN), http.StatusOK)

	code, origin = originSlot(t, h, host, slotID, session)
	if code != http.StatusOK || origin.Status != "enrolled" || !bytes.Equal(origin.ConfN, testConfN) {
		t.Fatalf("origin view after enroll = %d %+v", code, origin)
	}
	if _, poll = pollSlot(t, h, host, slotID, token); poll.CT != nil || poll.EnrollmentToken != "" {
		t.Fatalf("enrolled poll still releases: %+v", poll)
	}
	slot, err := store.GetTransferSlot(t.Context(), slotID, account.ID, time.Now().UTC())
	if err != nil || len(slot.CT) != 0 {
		t.Fatalf("enrolled slot must drop ct: %+v %v", slot, err)
	}

	creds, err := store.CredentialsByAccount(t.Context(), account.ID)
	if err != nil || len(creds) != 2 {
		t.Fatalf("credentials = %d, %v", len(creds), err)
	}
	platforms := map[string]int{}
	for _, c := range creds {
		platforms[c.Platform]++
	}
	if platforms["android"] != 1 || platforms[""] != 1 {
		t.Fatalf("platform labels = %v, want one android + one unlabelled", platforms)
	}

	listRec := transferReq(t, h, http.MethodGet, host, "/api/devices", nil, session, "")
	if !bytes.Contains(listRec.Body.Bytes(), []byte(`"platform":"android"`)) || bytes.Count(listRec.Body.Bytes(), []byte(`"platform"`)) != 1 {
		t.Fatalf("devices list should label only the transferred device: %s", listRec.Body.String())
	}
}

// Every illegal transition, and the immutability Socrates' sign-off requires:
// no re-claim, no re-reveal, no approve outside revealed.
func TestTransferV2_IllegalTransitions(t *testing.T) {
	h, host, invite := newTestTransferHandler(t)
	session := registerAndGetSession(t, h, host, invite)
	slotID := createSlot(t, h, host, session)

	wantCode(t, "reveal from pending", revealSlot(t, h, host, slotID, session), http.StatusConflict)
	wantCode(t, "approve from pending", approveSlot(t, h, host, slotID, session), http.StatusConflict)

	mustClaimToken(t, claimSlot(t, h, host, slotID))
	wantCode(t, "second claim", claimSlot(t, h, host, slotID), http.StatusConflict)
	wantCode(t, "approve from claimed", approveSlot(t, h, host, slotID, session), http.StatusConflict)

	wantCode(t, "reveal", revealSlot(t, h, host, slotID, session), http.StatusNoContent)
	wantCode(t, "second reveal", revealSlot(t, h, host, slotID, session), http.StatusConflict)
	wantCode(t, "claim after reveal", claimSlot(t, h, host, slotID), http.StatusConflict)

	wantCode(t, "approve", approveSlot(t, h, host, slotID, session), http.StatusNoContent)
	wantCode(t, "second approve", approveSlot(t, h, host, slotID, session), http.StatusConflict)
	wantCode(t, "reveal after approve", revealSlot(t, h, host, slotID, session), http.StatusConflict)
	wantCode(t, "claim after approve", claimSlot(t, h, host, slotID), http.StatusConflict)

	// The claim fields never changed.
	_, origin := originSlot(t, h, host, slotID, session)
	if !bytes.Equal(origin.NPub, testNPub) || origin.Platform != "android" || !bytes.Equal(origin.OPub, testOPub) {
		t.Fatalf("claim/reveal fields mutated: %+v", origin)
	}

	// Unknown slots: origin routes 404, the claim 410.
	wantCode(t, "reveal unknown", revealSlot(t, h, host, "no-such-slot", session), http.StatusNotFound)
	wantCode(t, "approve unknown", approveSlot(t, h, host, "no-such-slot", session), http.StatusNotFound)
	wantCode(t, "claim unknown", claimSlot(t, h, host, "no-such-slot"), http.StatusGone)

	// Reveal / approve answer only to a session.
	wantCode(t, "reveal without session", revealSlot(t, h, host, slotID, nil), http.StatusUnauthorized)
	wantCode(t, "approve without session", approveSlot(t, h, host, slotID, nil), http.StatusUnauthorized)
}

func TestTransferV2_RejectsMalformedValues(t *testing.T) {
	h, host, invite := newTestTransferHandler(t)
	session := registerAndGetSession(t, h, host, invite)
	slotID := createSlot(t, h, host, session)

	wantCode(t, "short commit", transferReq(t, h, http.MethodPost, host, "/api/transfer", createTransferRequest{SlotID: newSlotID(t), Commit: []byte("x")}, session, ""), http.StatusBadRequest)
	for name, id := range map[string]string{"missing slot_id": "", "short slot_id": "abc", "non-base64url slot_id": "aaaaaaaaaaaaaaaaaaaa.="} {
		wantCode(t, name, transferReq(t, h, http.MethodPost, host, "/api/transfer", createTransferRequest{SlotID: id, Commit: testCommit}, session, ""), http.StatusBadRequest)
	}
	// A reused transfer key derives the same id: refused, never merged into the live slot.
	wantCode(t, "reused slot_id", transferReq(t, h, http.MethodPost, host, "/api/transfer", createTransferRequest{SlotID: slotID, Commit: testCommit}, session, ""), http.StatusConflict)
	for name, body := range map[string]claimTransferRequest{
		"short n_pub":      {NPub: testNPub[:10], Platform: "web", MacN: testMacN},
		"missing mac":      {NPub: testNPub, Platform: "web"},
		"unknown platform": {NPub: testNPub, Platform: "Pixel 8 of Alice", MacN: testMacN},
	} {
		wantCode(t, name, transferReq(t, h, http.MethodPost, host, "/api/transfer/"+slotID+"/claim", body, nil, ""), http.StatusBadRequest)
	}
	mustClaimToken(t, claimSlot(t, h, host, slotID))
	wantCode(t, "short o_pub", transferReq(t, h, http.MethodPost, host, "/api/transfer/"+slotID+"/reveal", revealTransferRequest{OPub: testOPub[:5], MacO: testMacO}, session, ""), http.StatusBadRequest)
	wantCode(t, "reveal", revealSlot(t, h, host, slotID, session), http.StatusNoContent)
	wantCode(t, "empty ct", transferReq(t, h, http.MethodPost, host, "/api/transfer/"+slotID+"/approve", approveTransferRequest{}, session, ""), http.StatusBadRequest)
	wantCode(t, "unknown approving credential", transferReq(t, h, http.MethodPost, host, "/api/transfer/"+slotID+"/approve",
		approveTransferRequest{CT: testCT, ApprovingCredentialID: base64.RawURLEncoding.EncodeToString([]byte("nope"))}, session, ""), http.StatusBadRequest)
}

// Breakage review (CLAUDE.md rule 15): a v1 client gets an explicit
// "update the app / reload" 409, never a hang or a silent success.
func TestTransferV2_OldClientsGetUpgradeRequired(t *testing.T) {
	h, host, invite := newTestTransferHandler(t)
	session := registerAndGetSession(t, h, host, invite)

	v1Create := transferReq(t, h, http.MethodPost, host, "/api/transfer", map[string][]byte{"ct": []byte("v1-ciphertext")}, session, "")
	wantCode(t, "v1 create", v1Create, http.StatusConflict)
	if !bytes.Contains(v1Create.Body.Bytes(), []byte("upgrade_required")) || !bytes.Contains(v1Create.Body.Bytes(), []byte("reload")) {
		t.Fatalf("v1 create body = %q", v1Create.Body.String())
	}

	slotID := createSlot(t, h, host, session)
	v1Claim := transferReq(t, h, http.MethodPost, host, "/api/transfer/"+slotID+"/claim", nil, nil, "")
	wantCode(t, "v1 claim", v1Claim, http.StatusConflict)
	if !bytes.Contains(v1Claim.Body.Bytes(), []byte("upgrade_required")) {
		t.Fatalf("v1 claim body = %q", v1Claim.Body.String())
	}
	// The v1 attempt consumed nothing: the real device can still claim.
	mustClaimToken(t, claimSlot(t, h, host, slotID))
}

// Deny / Cancel = DELETE, from every state. After it the poller gets 410 and a
// registration already begun cannot finish.
func TestTransferV2_DeleteFromEveryState(t *testing.T) {
	h, host, invite := newTestTransferHandler(t)
	session := registerAndGetSession(t, h, host, invite)

	t.Run("after claim", func(t *testing.T) {
		slotID := createSlot(t, h, host, session)
		token := mustClaimToken(t, claimSlot(t, h, host, slotID))
		wantCode(t, "delete", transferReq(t, h, http.MethodDelete, host, "/api/transfer/"+slotID, nil, session, ""), http.StatusNoContent)
		if code, _ := pollSlot(t, h, host, slotID, token); code != http.StatusGone {
			t.Fatalf("poll after delete = %d, want 410", code)
		}
		wantCode(t, "reveal after delete", revealSlot(t, h, host, slotID, session), http.StatusNotFound)
		wantCode(t, "claim after delete", claimSlot(t, h, host, slotID), http.StatusGone)
	})

	t.Run("after register/begin", func(t *testing.T) {
		slotID, token := driveToApproved(t, h, host, session)
		opts, cookie, code := beginRegistrationWith(t, h, host, registerBeginRequest{EnrollmentToken: token, ConfN: testConfN})
		if code != http.StatusOK {
			t.Fatalf("register/begin = %d", code)
		}
		wantCode(t, "delete", transferReq(t, h, http.MethodDelete, host, "/api/transfer/"+slotID, nil, session, ""), http.StatusNoContent)
		if code, _ := pollSlot(t, h, host, slotID, token); code != http.StatusGone {
			t.Fatalf("poll after delete = %d, want 410", code)
		}
		rp := virtualwebauthn.RelyingParty{Name: "Med Tracker Cloud", ID: host, Origin: "http://" + host}
		response := virtualwebauthn.CreateAttestationResponse(rp, virtualwebauthn.NewAuthenticator(), virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2), *opts)
		wantCode(t, "finish after delete", finishRegistration(t, h, host, cookie, response), http.StatusConflict)
	})

	t.Run("idempotent and session-only", func(t *testing.T) {
		slotID := createSlot(t, h, host, session)
		wantCode(t, "delete without session", transferReq(t, h, http.MethodDelete, host, "/api/transfer/"+slotID, nil, nil, ""), http.StatusUnauthorized)
		for range 2 {
			wantCode(t, "delete", transferReq(t, h, http.MethodDelete, host, "/api/transfer/"+slotID, nil, session, ""), http.StatusNoContent)
		}
		if code, _ := originSlot(t, h, host, slotID, session); code != http.StatusNotFound {
			t.Fatalf("origin GET after delete = %d, want 404", code)
		}
	})
}

// Two ceremonies begun on one approved token: only the first finish redeems.
func TestTransferV2_DuplicateFinishRejected(t *testing.T) {
	h, host, invite := newTestTransferHandler(t)
	session := registerAndGetSession(t, h, host, invite)
	_, token := driveToApproved(t, h, host, session)

	// A v2 slot's token needs the key confirmation (the origin's final check).
	if _, _, code := beginRegistrationWith(t, h, host, registerBeginRequest{EnrollmentToken: token}); code != http.StatusForbidden {
		t.Fatalf("register/begin without conf_n on a v2 slot = %d, want 403", code)
	}
	optsA, cookieA, codeA := beginRegistrationWith(t, h, host, registerBeginRequest{EnrollmentToken: token, ConfN: testConfN})
	optsB, cookieB, codeB := beginRegistrationWith(t, h, host, registerBeginRequest{EnrollmentToken: token, ConfN: testConfN})
	if codeA != http.StatusOK || codeB != http.StatusOK {
		t.Fatalf("begin = %d / %d", codeA, codeB)
	}
	rp := virtualwebauthn.RelyingParty{Name: "Med Tracker Cloud", ID: host, Origin: "http://" + host}
	respA := virtualwebauthn.CreateAttestationResponse(rp, virtualwebauthn.NewAuthenticator(), virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2), *optsA)
	respB := virtualwebauthn.CreateAttestationResponse(rp, virtualwebauthn.NewAuthenticator(), virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2), *optsB)
	wantCode(t, "first finish", finishRegistration(t, h, host, cookieA, respA), http.StatusOK)
	wantCode(t, "second finish", finishRegistration(t, h, host, cookieB, respB), http.StatusConflict)
	if _, _, code := beginRegistrationWith(t, h, host, registerBeginRequest{EnrollmentToken: token, ConfN: testConfN}); code != http.StatusForbidden {
		t.Fatalf("begin after redeem = %d, want 403", code)
	}
}

// Redeem itself refuses a v2 slot without conf_n, not just register/begin.
func TestTransferV2_RedeemRequiresConfN(t *testing.T) {
	h, store, account, invite := newTestTransferHandlerWithStore(t)
	host := account.Subdomain + ".localhost"
	session := registerAndGetSession(t, h, host, invite)
	_, token := driveToApproved(t, h, host, session)
	hash, _ := hashHexToken(token)
	cred := cloudstore.Credential{ID: []byte("no-conf-cred"), AccountID: account.ID, PublicKey: []byte("pk"), CreatedAt: time.Now().UTC()}
	env := cloudstore.Envelope{AccountID: account.ID, CredentialRef: "bm8tY29uZi1jcmVk", V: 1, Nonce: []byte("n"), CT: []byte("c")}
	if err := store.RedeemTransferToken(t.Context(), account.ID, hash, nil, cred, env, time.Now().UTC()); !errors.Is(err, cloudstore.ErrTransferSlotInvalid) {
		t.Fatalf("redeem without conf_n = %v, want ErrTransferSlotInvalid", err)
	}
}

// Argus P1: credential liveness is checked in the same statement as the
// create / approve, so a revocation that commits after RequireSession passed
// cannot leave a live slot tagged with (or approved by) a revoked credential.
func TestTransferV2_RevokedCredentialCannotCreateOrApprove(t *testing.T) {
	store, db := setupStoreWithDB(t)
	account, invite := setupInvite(t, store)
	mux := http.NewServeMux()
	NewWebAuthnAPI(store, testSessionSecret).RegisterRoutes(mux)
	NewTransferAPI(store, testSessionSecret).RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)
	host := account.Subdomain + ".localhost"
	first := registerAndGetSession(t, h, host, invite)
	second := enrollSecondDevice(t, h, host, first)
	_, firstCred, _ := VerifySessionToken(first.Value, testSessionSecret)
	_, secondCred, _ := VerifySessionToken(second.Value, testSessionSecret)
	ctx, now := t.Context(), time.Now().UTC()

	if err := store.CreateTransferSlot(ctx, "ghost-slot", account.ID, []byte("placeholder-hash-32-bytes-xxxxxx"), testCommit, []byte("revoked-cred"), now, now.Add(time.Minute)); !errors.Is(err, cloudstore.ErrSourceCredentialRevoked) {
		t.Fatalf("create by a missing credential = %v, want ErrSourceCredentialRevoked", err)
	}

	revealedBy := func(session *http.Cookie) string {
		slotID := createSlot(t, h, host, session)
		mustClaimToken(t, claimSlot(t, h, host, slotID))
		wantCode(t, "reveal", revealSlot(t, h, host, slotID, session), http.StatusNoContent)
		return slotID
	}
	// Approve naming a credential that is gone (revoked after the handler's check).
	slotA := revealedBy(first)
	if err := store.ApproveTransferSlot(ctx, slotA, account.ID, testCT, []byte("revoked-cred"), now); !errors.Is(err, cloudstore.ErrSourceCredentialRevoked) {
		t.Fatalf("approve naming a missing credential = %v, want ErrSourceCredentialRevoked", err)
	}
	// Approve of a slot whose opener is gone, re-tagging to a live credential.
	slotB := revealedBy(second)
	// Delete the opener's credential row directly — the state a revocation that
	// commits between the handler's checks and this UPDATE would leave.
	if _, err := db.ExecContext(ctx, `DELETE FROM credentials WHERE id = ?`, secondCred); err != nil {
		t.Fatal(err)
	}
	if err := store.ApproveTransferSlot(ctx, slotB, account.ID, testCT, firstCred, now); !errors.Is(err, cloudstore.ErrSourceCredentialRevoked) {
		t.Fatalf("approve of a revoked opener's slot = %v, want ErrSourceCredentialRevoked", err)
	}
	if slot, err := store.GetTransferSlot(ctx, slotB, account.ID, now); err != nil || slot.State != "revealed" {
		t.Fatalf("slot must stay unapproved: %+v %v", slot, err)
	}
}

// Release of ct + enrollment token is gated on state = approved, never on ct
// being non-empty: ct holds an empty-blob placeholder before approve, so a
// "ct present" check would be the wrong gate in both directions.
func TestTransferV2_ReleaseGatedOnStateNotCT(t *testing.T) {
	store, db := setupStoreWithDB(t)
	account, invite := setupInvite(t, store)
	mux := http.NewServeMux()
	NewWebAuthnAPI(store, testSessionSecret).RegisterRoutes(mux)
	NewTransferAPI(store, testSessionSecret).RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)
	host := account.Subdomain + ".localhost"
	session := registerAndGetSession(t, h, host, invite)
	setCT := func(slotID string, ct []byte) {
		t.Helper()
		if _, err := db.ExecContext(t.Context(), `UPDATE transfer_slots SET ct = ? WHERE id = ?`, ct, slotID); err != nil {
			t.Fatal(err)
		}
	}

	// A non-empty ct in a pre-approve state releases nothing.
	for _, reveal := range []bool{false, true} {
		slotID := createSlot(t, h, host, session)
		token := mustClaimToken(t, claimSlot(t, h, host, slotID))
		if reveal {
			wantCode(t, "reveal", revealSlot(t, h, host, slotID, session), http.StatusNoContent)
		}
		setCT(slotID, testCT)
		if _, poll := pollSlot(t, h, host, slotID, token); poll.CT != nil || poll.EnrollmentToken != "" || poll.AccountID != "" {
			t.Fatalf("%s slot with ct set leaked: %+v", poll.Status, poll)
		}
		if _, _, code := beginRegistrationWith(t, h, host, registerBeginRequest{EnrollmentToken: token, ConfN: testConfN}); code != http.StatusForbidden {
			t.Fatalf("register/begin on unapproved slot with ct set = %d, want 403", code)
		}
	}

	// An approved slot whose ct is the empty placeholder still releases the
	// enrollment token to the claimant: the gate is the state.
	slotID, token := driveToApproved(t, h, host, session)
	setCT(slotID, []byte{})
	if _, poll := pollSlot(t, h, host, slotID, token); poll.Status != "approved" || poll.EnrollmentToken != token || poll.AccountID != account.ID {
		t.Fatalf("approved slot with empty ct = %+v, want enrollment token released", poll)
	}
	if _, _, code := beginRegistrationWith(t, h, host, registerBeginRequest{EnrollmentToken: token, ConfN: testConfN}); code != http.StatusOK {
		t.Fatalf("register/begin on approved slot with empty ct = %d, want 200", code)
	}
}

// Expiry in any state behaves like DELETE.
func TestTransferV2_ExpiryInEveryState(t *testing.T) {
	h, store, account, invite := newTestTransferHandlerWithStore(t)
	host := account.Subdomain + ".localhost"
	session := registerAndGetSession(t, h, host, invite)
	_, credID, _ := VerifySessionToken(session.Value, testSessionSecret)

	tokenHex, tokenHash, err := NewClaimToken()
	if err != nil {
		t.Fatal(err)
	}
	// Slots that expired a minute ago, advanced while they were still live.
	now := time.Now().UTC()
	past := now.Add(-2 * time.Minute)
	ctx := t.Context()
	for _, state := range []string{"pending", "claimed", "revealed", "approved"} {
		t.Run(state, func(t *testing.T) {
			slotID := "expired-" + state
			if err := store.CreateTransferSlot(ctx, slotID, account.ID, []byte("placeholder-hash-32-bytes-xxxxxx"), testCommit, credID, now.Add(-time.Hour), now.Add(-time.Minute)); err != nil {
				t.Fatal(err)
			}
			steps := []func() error{
				func() error {
					return store.ClaimTransferSlot(ctx, slotID, account.ID, tokenHash, testNPub, testMacN, "web", past)
				},
				func() error { return store.RevealTransferSlot(ctx, slotID, account.ID, testOPub, testMacO, past) },
				func() error { return store.ApproveTransferSlot(ctx, slotID, account.ID, testCT, credID, past) },
			}
			n := map[string]int{"pending": 0, "claimed": 1, "revealed": 2, "approved": 3}[state]
			for _, step := range steps[:n] {
				if err := step(); err != nil {
					t.Fatal(err)
				}
			}
			if code, _ := pollSlot(t, h, host, slotID, tokenHex); code != http.StatusGone {
				t.Errorf("poll = %d, want 410", code)
			}
			if code, _ := originSlot(t, h, host, slotID, session); code != http.StatusNotFound {
				t.Errorf("origin GET = %d, want 404", code)
			}
			if rec := claimSlot(t, h, host, slotID); rec.Code != http.StatusGone {
				t.Errorf("claim = %d, want 410", rec.Code)
			}
			if rec := revealSlot(t, h, host, slotID, session); rec.Code != http.StatusNotFound {
				t.Errorf("reveal = %d, want 404", rec.Code)
			}
			if rec := approveSlot(t, h, host, slotID, session); rec.Code != http.StatusNotFound {
				t.Errorf("approve = %d, want 404", rec.Code)
			}
		})
	}
	if _, _, code := beginRegistrationWith(t, h, host, registerBeginRequest{EnrollmentToken: tokenHex}); code != http.StatusForbidden {
		t.Fatalf("register/begin on an expired approved slot = %d, want 403", code)
	}
}

// Revoking the device that opened/approved a hand-off kills its unfinished
// slots in every state, but leaves an enrolled one (history) alone.
func TestTransferV2_RevokeKillsApproversUnfinishedSlots(t *testing.T) {
	h, store, account, invite := newTestTransferHandlerWithStore(t)
	host := account.Subdomain + ".localhost"
	first := registerAndGetSession(t, h, host, invite)
	second := enrollSecondDevice(t, h, host, first)

	pending := createSlot(t, h, host, second)
	claimed := createSlot(t, h, host, second)
	mustClaimToken(t, claimSlot(t, h, host, claimed))
	revealed := createSlot(t, h, host, second)
	mustClaimToken(t, claimSlot(t, h, host, revealed))
	wantCode(t, "reveal", revealSlot(t, h, host, revealed, second), http.StatusNoContent)
	approved, _ := driveToApproved(t, h, host, second)
	enrolled, token := driveToApproved(t, h, host, second)
	wantCode(t, "enroll third", enrollViaToken(t, h, host, token, testConfN), http.StatusOK)
	firstsOwn := createSlot(t, h, host, first)

	_, secondCred, _ := VerifySessionToken(second.Value, testSessionSecret)
	wantCode(t, "revoke second", transferReq(t, h, http.MethodDelete, host, "/api/devices/"+base64.RawURLEncoding.EncodeToString(secondCred), nil, first, ""), http.StatusNoContent)

	now := time.Now().UTC()
	for _, id := range []string{pending, claimed, revealed, approved} {
		if _, err := store.GetTransferSlot(t.Context(), id, account.ID, now); !errors.Is(err, cloudstore.ErrTransferSlotInvalid) {
			t.Errorf("slot %s survived its approver's revocation: %v", id, err)
		}
	}
	for _, id := range []string{enrolled, firstsOwn} {
		if _, err := store.GetTransferSlot(t.Context(), id, account.ID, now); err != nil {
			t.Errorf("slot %s should survive: %v", id, err)
		}
	}
}

// A slot id must not be a status oracle or a handle on another account.
func TestTransferV2_OtherAccountLearnsNothing(t *testing.T) {
	store := setupStore(t)
	victim, victimInvite := setupInvite(t, store)
	attacker, attackerInvite := setupInvite(t, store)
	mux := http.NewServeMux()
	NewWebAuthnAPI(store, testSessionSecret).RegisterRoutes(mux)
	NewTransferAPI(store, testSessionSecret).RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)

	victimHost := victim.Subdomain + ".localhost"
	victimSlot := createSlot(t, h, victimHost, registerAndGetSession(t, h, victimHost, victimInvite))
	attackerHost := attacker.Subdomain + ".localhost"
	attackerSession := registerAndGetSession(t, h, attackerHost, attackerInvite)

	if code, _ := originSlot(t, h, attackerHost, victimSlot, attackerSession); code != http.StatusNotFound {
		t.Errorf("GET another account's slot = %d, want 404", code)
	}
	if code, _ := pollSlot(t, h, attackerHost, victimSlot, ""); code != http.StatusGone {
		t.Errorf("poll on another account's host = %d, want 410", code)
	}
	wantCode(t, "claim on another account's host", claimSlot(t, h, attackerHost, victimSlot), http.StatusGone)
	wantCode(t, "DELETE another account's slot (no oracle)", transferReq(t, h, http.MethodDelete, attackerHost, "/api/transfer/"+victimSlot, nil, attackerSession, ""), http.StatusNoContent)
	mustClaimToken(t, claimSlot(t, h, victimHost, victimSlot))
}

// TestTransferV2_ClaimPushOncePerSlot (bd med-r1j2.9): the claim transition —
// and only it — sends the content-free "approve the new device?" push to every
// web-push subscription and native token of the account, once per slot. A
// refused second claim, reveal, approve, enroll and delete send nothing.
func TestTransferV2_ClaimPushOncePerSlot(t *testing.T) {
	store := setupStore(t)
	account, invite := setupInvite(t, store)
	host := account.Subdomain + ".localhost"
	ctx := t.Context()
	if err := store.UpsertPushSubscription(ctx, account.ID, "https://push.example/a", "p256dh", "auth", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertNativePushToken(ctx, account.ID, cloudstore.NativePushIOS, "ios-1", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	sender, native := &fakeSender{}, &fakeNativeSender{}
	relay := NewRelay(store, sender, nil, 0)
	relay.SetNativePush(map[string]NativePushSender{cloudstore.NativePushIOS: native})

	transfer := NewTransferAPI(store, testSessionSecret)
	transfer.SetClaimNotifier(relay.NotifyTransferClaimed) // synchronous here; cmd/cloud detaches it
	mux := http.NewServeMux()
	NewWebAuthnAPI(store, testSessionSecret).RegisterRoutes(mux)
	transfer.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)
	session := registerAndGetSession(t, h, host, invite)

	pushes := func() int { return len(sender.sent) + len(native.sent) }
	slotID := createSlot(t, h, host, session)
	if n := pushes(); n != 0 {
		t.Fatalf("create sent %d pushes, want 0", n)
	}
	token := mustClaimToken(t, claimSlot(t, h, host, slotID))
	if len(sender.sent) != 1 || len(native.sent) != 1 || native.sent[0] != "ios-1/"+transferClaimedKind {
		t.Fatalf("claim pushes: web %+v native %v, want one each", sender.sent, native.sent)
	}
	if got := string(sender.sent[0].ct); got != `{"kind":"transfer_claimed"}` {
		t.Fatalf("web payload = %s, want the bare kind tag (no slot data)", got)
	}

	wantCode(t, "second claim", claimSlot(t, h, host, slotID), http.StatusConflict)
	wantCode(t, "reveal", revealSlot(t, h, host, slotID, session), http.StatusNoContent)
	wantCode(t, "approve", approveSlot(t, h, host, slotID, session), http.StatusNoContent)
	wantCode(t, "register/finish", enrollViaToken(t, h, host, token, testConfN), http.StatusOK)
	other := createSlot(t, h, host, session)
	wantCode(t, "delete", transferReq(t, h, http.MethodDelete, host, "/api/transfer/"+other, nil, session, ""), http.StatusNoContent)
	if n := pushes(); n != 2 {
		t.Fatalf("pushes after the other transitions = %d, want still 2", n)
	}
}
