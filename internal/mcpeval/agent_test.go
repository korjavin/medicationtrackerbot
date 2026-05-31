package mcpeval

import (
	"net/http"
	"testing"
	"time"
)

// TestIsRetryableQuota_PerDayFailsFast verifies a per-DAY Google quota 429 is
// classified non-retryable (it won't clear within a run), while a per-minute /
// generic 429 stays retryable. The per-day body is the real Gemini free-tier
// shape: a top-level array of error objects with a QuotaFailure violation whose
// quotaId contains "PerDay".
func TestIsRetryableQuota_PerDayFailsFast(t *testing.T) {
	perDay := []byte(`[{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[
		{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[
			{"quotaMetric":"generativelanguage.googleapis.com/generate_content_free_tier_requests",
			 "quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}]`)
	if isRetryableQuota(perDay) {
		t.Error("per-day quota 429 should be non-retryable (won't clear within a run)")
	}

	perMinute := []byte(`{"error":{"code":429,"details":[
		{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[
			{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}]}]}}`)
	if !isRetryableQuota(perMinute) {
		t.Error("per-minute quota 429 should be retryable")
	}

	// Unparseable / non-Google 429 defaults to retryable (conservative).
	if !isRetryableQuota([]byte(`Too Many Requests`)) {
		t.Error("unparseable 429 body should default to retryable")
	}
}

// TestRetryAfter_PrefersServerAdvisedDelay verifies retryAfter honors the
// Retry-After header and the Google RetryInfo.retryDelay, clamps to [1s,60s],
// and falls back to exponential backoff when neither is present.
func TestRetryAfter_PrefersServerAdvisedDelay(t *testing.T) {
	// Retry-After header (seconds) wins.
	h := http.Header{}
	h.Set("Retry-After", "12")
	if got := retryAfter(h, nil, 0); got != 12*time.Second {
		t.Errorf("Retry-After=12 → %v, want 12s", got)
	}

	// Google RetryInfo.retryDelay in the body, clamped to the 60s ceiling.
	body := []byte(`[{"error":{"details":[
		{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"120s"}]}}]`)
	if got := retryAfter(http.Header{}, body, 0); got != 60*time.Second {
		t.Errorf("retryDelay=120s should clamp to 60s, got %v", got)
	}

	// No hints → exponential backoff keyed on attempt: 2<<2 = 8s.
	if got := retryAfter(http.Header{}, nil, 2); got != 8*time.Second {
		t.Errorf("attempt=2 backoff → %v, want 8s", got)
	}
}
