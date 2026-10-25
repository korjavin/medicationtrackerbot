package cloudserver

import (
	"context"
	"crypto/ecdsa"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// eraseAs signs POST /api/attest/delete with signer, sending keyID's id.
func (e *attestEnv) eraseAs(keyID string, signer *ecdsa.PrivateKey, counter uint32) *httptest.ResponseRecorder {
	chal := e.challenge()
	raw, _ := base64.StdEncoding.DecodeString(chal)
	rh := sha256.Sum256([]byte(attestDeletePath + "\n"))
	cdh := sha256.Sum256(append(raw, rh[:]...))
	return e.do("localhost", attestDeletePath, "", map[string]string{
		"X-Attest-Key-Id": keyID, "X-Attest-Challenge": chal,
		"X-Attest-Assertion": fakeAssertion(e.t, signer, counter, cdh[:]),
	})
}

// bd med-egb3: POST /api/attest/delete takes only an assertion by a key of
// the bucket, deletes the whole bucket (a reinstall's stale install too) and
// nothing else, and is idempotent (install_unknown once gone).
func TestAttestEraseInstall(t *testing.T) {
	ctx := context.Background()
	e := newAttestEnv(t, 3, 0, 0)
	e.attest.SetFeedback(NewFeedbackAPI(e.store, "s", attestFeedbackRecipient))
	k1, k2, other, fb := attestKey(t), attestKey(t), attestKey(t), attestKey(t)
	id1, id2, idOther, idFB := attestKeyID(t, k1), attestKeyID(t, k2), attestKeyID(t, other), attestKeyID(t, fb)
	rec := e.enroll(k1, attestTestAppID, e.challenge(), "tok-1")
	if rec.Code != http.StatusOK {
		t.Fatalf("enroll k1: %d %s", rec.Code, rec.Body.String())
	}
	// k2 rejoins k1's bucket with its pass (a reinstall on the same device):
	// k1's row stays behind, stale.
	if rec := e.enrollPass(k2, attestTestAppID, e.challenge(), "tok-1", passOf(rec)); rec.Code != http.StatusOK {
		t.Fatalf("enroll k2: %d %s", rec.Code, rec.Body.String())
	}
	e.enrolled(other, "tok-2")
	gone := func(id string) bool {
		_, err := e.store.AttestInstall(ctx, id)
		return errors.Is(err, sql.ErrNoRows)
	}

	// Owner only: another enrolled key signing for k2's id is refused.
	wantErr(t, e.eraseAs(id2, other, 1), http.StatusUnauthorized, "assertion_invalid")
	if gone(id2) {
		t.Fatal("a foreign assertion deleted k2")
	}
	// A challenge that was never issued.
	wantErr(t, e.do("localhost", attestDeletePath, "", map[string]string{"X-Attest-Key-Id": id2, "X-Attest-Challenge": "bogus", "X-Attest-Assertion": "AA=="}),
		http.StatusBadRequest, "challenge_invalid")

	// k2 erases: 204 with the next challenge; the whole bucket goes, k1 too.
	rec = e.eraseAs(id2, k2, 1)
	if rec.Code != http.StatusNoContent || rec.Header().Get("X-Attest-Challenge") == "" {
		t.Fatalf("erase k2: %d %s", rec.Code, rec.Body.String())
	}
	if !gone(id1) || !gone(id2) || gone(idOther) {
		t.Fatalf("after erase: k1 gone %v, k2 gone %v, other gone %v", gone(id1), gone(id2), gone(idOther))
	}
	if _, err := e.store.AttestBucketPassHash(ctx, id1); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("bucket kept: %v", err)
	}
	// Idempotent: already gone answers install_unknown, with a challenge.
	rec = e.eraseAs(id2, k2, 2)
	wantErr(t, rec, http.StatusUnauthorized, "install_unknown")
	if rec.Header().Get("X-Attest-Challenge") == "" {
		t.Fatal("install_unknown without the next challenge")
	}

	// A feedback-only key (no trial grant) erases too.
	if got := readEnroll(t, e.enrollIOS(fb, "", feedbackOnly)); *got.Granted {
		t.Fatal("feedback-only key granted")
	}
	if rec := e.eraseAs(idFB, fb, 1); rec.Code != http.StatusNoContent || !gone(idFB) {
		t.Fatalf("erase feedback-only: %d %s", rec.Code, rec.Body.String())
	}
	if gone(idOther) {
		t.Fatal("another device's install deleted")
	}
}
