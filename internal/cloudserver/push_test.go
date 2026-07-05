package cloudserver

import "testing"

// TestValidatePushEndpoint guards the authenticated-SSRF filter: real push
// hosts pass; loopback / metadata / private literal-IP targets and non-https
// schemes are rejected before the endpoint can be stored and relayed to.
func TestValidatePushEndpoint(t *testing.T) {
	ok := []string{
		"https://fcm.googleapis.com/fcm/send/abc",
		"https://web.push.apple.com/xyz",
		"https://updates.push.services.mozilla.com/wpush/v2/gAAA",
	}
	for _, e := range ok {
		if err := validatePushEndpoint(e); err != nil {
			t.Errorf("validatePushEndpoint(%q) = %v, want nil", e, err)
		}
	}

	bad := []string{
		"http://fcm.googleapis.com/fcm/send/abc",    // not https
		"https://127.0.0.1/x",                       // loopback
		"https://169.254.169.254/latest/meta-data/", // cloud metadata (link-local)
		"https://10.0.0.5/x",                        // private
		"https://192.168.1.1/x",                     // private
		"https://[::1]/x",                           // loopback v6
		"https://0.0.0.0/x",                         // unspecified
		"",                                          // empty
		"://nonsense",                               // unparseable / no scheme
	}
	for _, e := range bad {
		if err := validatePushEndpoint(e); err == nil {
			t.Errorf("validatePushEndpoint(%q) = nil, want error", e)
		}
	}
}
