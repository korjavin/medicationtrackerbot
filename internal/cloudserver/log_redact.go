package cloudserver

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
)

// endpointFingerprint returns a short, non-reversible tag for a push-service
// subscription endpoint, safe to place in application/proxy logs for
// correlation. The raw endpoint URL is a per-device bearer capability (anyone
// holding it can push to that device), so it must never be logged verbatim.
//
// A plain truncated SHA-256 is deliberate: correlation across log lines needs
// only a stable non-reversible id, not defence against a dictionary of known
// endpoints — so no keying material or new config is introduced. 48 bits is
// ample to distinguish the handful of subscriptions on a self-hosted box.
//
// ponytail: unkeyed hash; switch to HMAC under SESSION_SECRET if endpoints ever
// need to resist a precomputed-URL guessing attack.
func endpointFingerprint(endpoint string) string {
	if endpoint == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(endpoint))
	return "fp_" + hex.EncodeToString(sum[:6])
}

// redactEndpointErr strips the request URL from a push-send error before it
// reaches a log line. Transport failures from webpush-go surface as *url.Error,
// whose Error() embeds the full endpoint URL ("Post \"https://fcm...<token>\":
// context deadline exceeded") — the same bearer capability endpointFingerprint
// exists to keep out of logs. Non-URL errors pass through unchanged.
func redactEndpointErr(err error) error {
	var uerr *url.Error
	if errors.As(err, &uerr) {
		return fmt.Errorf("%s <endpoint redacted>: %w", uerr.Op, uerr.Err)
	}
	return err
}
