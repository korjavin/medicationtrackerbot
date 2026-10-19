package playintegrity

import (
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"testing"
)

// Fixed vectors shared with the Android client's AttestTest.kt (bd
// med-nt9p.32.8.4): the same constants on both sides, so a derivation drift
// fails one of the two suites. The key is a test-only P-256 key; the assertion
// is the Keystore wire format (counter 7 BE ‖ DER sig).
const (
	vecSPKI      = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEzGYJQtUGrDQLlbhnpu5m7FpJWXKdyz2t3aPcZl7hzL//l14nuDgbLKoeYahIBARHu4HLq1m9dpmpXe+UrDAZRA=="
	vecChallenge = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
	vecKeyID     = "sMWYpk6crsaslQBz45WxqHi8LJ2Odh408gDcvi_IYhM"
	vecReqHash   = "V8MTBbLV2H-_wX5oNckgSyPGhwvIAUOFELnxUajsCN0"
	vecBodySHA   = "o9O/8yZ9pMhwboNHptZVx4i4nsqlpeMeo0yi9Sj9Nt0=" // SHA256("/api/attest/chat\n{}")
	vecCDH       = "FP/0RIIEpZDVmjTeuN6w/hqNznmfwPSYxfnroOEyGSk=" // SHA256(challenge ‖ bodySha256)
	vecAssertion = "AAAABzBGAiEAlgEpsJErU/Yhwd4gYYkDdFWGpcL5D7gcvLeAOIs7Le4CIQDZ8vieZzkuy5O49jZdx/0oe8X7Aja/68yOXZ9GSWaQig=="
)

func TestSharedClientVectors(t *testing.T) {
	std := base64.StdEncoding
	der, _ := std.DecodeString(vecSPKI)
	chal, _ := std.DecodeString(vecChallenge)
	if got := KeyID(der); got != vecKeyID {
		t.Fatalf("KeyID = %s", got)
	}
	if got := RequestHash(chal, vecKeyID, der); got != vecReqHash {
		t.Fatalf("RequestHash = %s", got)
	}
	body, _ := std.DecodeString(vecBodySHA)
	cdh := sha256.Sum256(append(append([]byte{}, chal...), body...))
	if got := std.EncodeToString(cdh[:]); got != vecCDH {
		t.Fatalf("clientDataHash = %s", got)
	}
	k, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		t.Fatal(err)
	}
	as, _ := std.DecodeString(vecAssertion)
	if c, err := VerifyAssertion(as, k.(*ecdsa.PublicKey), cdh[:], 6); err != nil || c != 7 {
		t.Fatalf("assertion: %d %v", c, err)
	}
}
