package mcpeval

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

// TestChatMessage_RoundTripsReasoningContent verifies an assistant message
// decoded from a reasoning model preserves reasoning_content and re-marshals it,
// so Agent.Run echoes it back on the next turn. Stripping it makes reasoning
// models (qwen3.5-9b) return empty content and stop — this guards the fix.
func TestChatMessage_RoundTripsReasoningContent(t *testing.T) {
	raw := `{"role":"assistant","content":"\n\n","reasoning_content":"step 1: find the op","tool_calls":[{"id":"c1","type":"function","function":{"name":"mcp_help","arguments":"{}"}}]}`
	var m chatMessage
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if m.ReasoningContent != "step 1: find the op" {
		t.Fatalf("reasoning_content not decoded, got %q", m.ReasoningContent)
	}
	out, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(out), `"reasoning_content":"step 1: find the op"`) {
		t.Errorf("re-marshaled message dropped reasoning_content: %s", out)
	}

	// A message without it must stay clean (omitempty) so non-reasoning providers
	// aren't sent an empty field.
	plain, _ := json.Marshal(chatMessage{Role: "assistant", Content: "hi"})
	if strings.Contains(string(plain), "reasoning_content") {
		t.Errorf("omitempty failed; plain message carries reasoning_content: %s", plain)
	}
}

// TestNewClient_MaxTokensDefault verifies maxTokens<=0 falls back to the
// generous default (so a reasoning model's chain-of-thought + answer both fit),
// while an explicit value is honored.
func TestNewClient_MaxTokensDefault(t *testing.T) {
	if c := NewClient("k", "", "m", 0); c.maxTokens != defaultMaxTokens {
		t.Errorf("maxTokens=0 should default to %d, got %d", defaultMaxTokens, c.maxTokens)
	}
	if c := NewClient("k", "", "m", -5); c.maxTokens != defaultMaxTokens {
		t.Errorf("negative maxTokens should default to %d, got %d", defaultMaxTokens, c.maxTokens)
	}
	if c := NewClient("k", "", "m", 8192); c.maxTokens != 8192 {
		t.Errorf("explicit maxTokens not honored, got %d", c.maxTokens)
	}
}

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
