package cloudserver

import (
	"bufio"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// Streaming (stream:true) half of the trial proxy, bd med-h849.4: the voice
// relay's browser half streams ElevenLabs turns through
// /api/trial/openai/chat/completions. Both providers answer OpenAI-style SSE
// (`data: <chat.completion.chunk>` lines, then `data: [DONE]`). SECURITY
// INVARIANT: nothing from TrialConfig — the forced model included — reaches a
// chunk, header, or log line.

// trialStreamRatePerMin is the per-account window for streaming requests,
// separate from TRIAL_RATE_PER_MIN (a voice call is a request per turn plus
// one per tool round). The daily budgets still count every request.
const trialStreamRatePerMin = 60

// sseUpstreamError is the one in-band error chunk a broken stream gets before
// [DONE]: the HTTP status is already 200, so this is the only signal left.
var sseUpstreamError = []byte(`{"error":"upstream_error"}`)

type sseWriter struct {
	w  http.ResponseWriter
	rc *http.ResponseController
}

func startSSE(w http.ResponseWriter) *sseWriter {
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	return &sseWriter{w: w, rc: http.NewResponseController(w)}
}

// data writes one `data:` event and flushes. False = the client is gone.
func (s *sseWriter) data(b []byte) bool {
	if _, err := s.w.Write(append(append([]byte("data: "), b...), '\n', '\n')); err != nil {
		return false
	}
	return s.rc.Flush() == nil
}

func (s *sseWriter) done() { s.data([]byte("[DONE]")) }

// sseDataLines yields the payload of every `data:` line; event:, comment and
// blank lines carry nothing our translation needs.
func sseDataLines(body io.Reader, yield func(data string) bool) error {
	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 64<<10), maxTrialBodyBytes)
	for sc.Scan() {
		data, ok := strings.CutPrefix(sc.Text(), "data:")
		if !ok {
			continue
		}
		if !yield(strings.TrimSpace(data)) {
			return nil
		}
	}
	return sc.Err()
}

// relayOpenAIStream passes an OpenAI-compatible upstream stream through,
// stripping "model" from every chunk. An in-band upstream error, a malformed
// chunk, or a stream that ends without [DONE] becomes one sanitized error
// chunk + [DONE] — never a hang, never the provider's error text.
func relayOpenAIStream(w http.ResponseWriter, accountID string, body io.Reader) {
	start := time.Now()
	sse := startSSE(w)
	chunks, done, clientGone := 0, false, false
	err := sseDataLines(body, func(data string) bool {
		if data == "[DONE]" {
			done = true
			return false
		}
		var obj map[string]json.RawMessage
		if json.Unmarshal([]byte(data), &obj) != nil || obj == nil {
			return false
		}
		if _, isErr := obj["error"]; isErr {
			return false
		}
		delete(obj, "model")
		out, err := json.Marshal(obj)
		if err != nil {
			return false
		}
		if !sse.data(out) {
			clientGone = true
			return false
		}
		chunks++
		return true
	})
	finishStream(sse, accountID, "openai", start, chunks, done, clientGone, err, "", 0)
}

// anthropicStreamEvent is the subset of a Messages SSE event we translate.
type anthropicStreamEvent struct {
	Type    string `json:"type"`
	Index   int    `json:"index"`
	Message struct {
		ID    string `json:"id"`
		Usage struct {
			CacheReadInputTokens int `json:"cache_read_input_tokens"`
		} `json:"usage"`
	} `json:"message"`
	ContentBlock struct {
		Type string `json:"type"`
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"content_block"`
	Delta struct {
		Type        string `json:"type"`
		Text        string `json:"text"`
		PartialJSON string `json:"partial_json"`
		StopReason  string `json:"stop_reason"`
	} `json:"delta"`
}

// relayAnthropicStream translates Messages API SSE into chat.completion.chunk
// lines: text_delta → delta.content; tool_use start → delta.tool_calls with
// id/name; input_json_delta → delta.tool_calls arguments; message_delta
// stop_reason → finish_reason; message_stop → [DONE]. Thinking blocks are
// skipped. The upstream "model" is never copied.
func relayAnthropicStream(w http.ResponseWriter, accountID string, body io.Reader) {
	start := time.Now()
	sse := startSSE(w)
	var (
		id, stopReason    string
		cacheRead, chunks int
		done, clientGone  bool
		toolIndex         = map[int]int{} // content block index → tool_calls index
		created           = time.Now().Unix()
	)
	emit := func(delta map[string]any, finish any) bool {
		out, _ := json.Marshal(map[string]any{
			"id": id, "object": "chat.completion.chunk", "created": created,
			"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}},
		})
		if !sse.data(out) {
			clientGone = true
			return false
		}
		chunks++
		return true
	}
	err := sseDataLines(body, func(data string) bool {
		var ev anthropicStreamEvent
		if json.Unmarshal([]byte(data), &ev) != nil {
			return false
		}
		switch ev.Type {
		case "message_start":
			id = ev.Message.ID
			cacheRead = ev.Message.Usage.CacheReadInputTokens
			return emit(map[string]any{"role": "assistant", "content": ""}, nil)
		case "content_block_start":
			if ev.ContentBlock.Type != "tool_use" {
				return true // text starts empty; thinking is skipped
			}
			n := len(toolIndex)
			toolIndex[ev.Index] = n
			return emit(map[string]any{"tool_calls": []any{map[string]any{
				"index": n, "id": ev.ContentBlock.ID, "type": "function",
				"function": map[string]string{"name": ev.ContentBlock.Name, "arguments": ""},
			}}}, nil)
		case "content_block_delta":
			switch ev.Delta.Type {
			case "text_delta":
				if ev.Delta.Text != "" {
					return emit(map[string]any{"content": ev.Delta.Text}, nil)
				}
			case "input_json_delta":
				if n, ok := toolIndex[ev.Index]; ok && ev.Delta.PartialJSON != "" {
					return emit(map[string]any{"tool_calls": []any{map[string]any{
						"index": n, "function": map[string]string{"arguments": ev.Delta.PartialJSON},
					}}}, nil)
				}
			}
			return true // thinking_delta, signature_delta, …
		case "message_delta":
			if ev.Delta.StopReason == "" {
				return true
			}
			stopReason = ev.Delta.StopReason
			return emit(map[string]any{}, anthropicFinishReason(stopReason))
		case "message_stop":
			done = true
			return false
		case "error":
			return false
		}
		return true // ping, content_block_stop
	})
	finishStream(sse, accountID, "anthropic", start, chunks, done, clientGone, err, stopReason, cacheRead)
}

// finishStream closes a relayed stream: [DONE] on success, one sanitized
// error chunk + [DONE] when upstream broke, nothing when the client left.
// One log line per request, sizes and outcome only.
func finishStream(sse *sseWriter, accountID, provider string, start time.Time, chunks int, done, clientGone bool, scanErr error, stopReason string, cacheRead int) {
	switch {
	case clientGone:
	case done:
		sse.done()
	default:
		sse.data(sseUpstreamError)
		sse.done()
	}
	attrs := []any{"account", accountID, "provider", provider, "status", http.StatusOK, "stream", true,
		"chunks", chunks, "complete", done, "client_gone", clientGone, "duration_ms", time.Since(start).Milliseconds()}
	if provider == "anthropic" {
		attrs = append(attrs, "stop_reason", stopReason, "cache_read_tokens", cacheRead)
	}
	if !done && !clientGone {
		// scanErr is a read/scan error on the upstream body (timeouts, token
		// too long) — no URL or key in it; nil means an early EOF or error event.
		attrs = append(attrs, "upstream_error", scanErr != nil)
		slog.Warn("trial chat proxy stream broken", attrs...)
		return
	}
	slog.Info("trial chat proxy stream", attrs...)
}
