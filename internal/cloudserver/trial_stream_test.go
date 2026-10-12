package cloudserver

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// sseUpstream answers every request with the canned SSE text and records the
// request bodies.
func sseUpstream(t *testing.T, status int, sse string) (*httptest.Server, *[]map[string]any) {
	t.Helper()
	var bodies []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		bodies = append(bodies, body)
		if status != http.StatusOK {
			w.WriteHeader(status)
			w.Write([]byte(`{"error":{"message":"upstream secret detail"}}`))
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte(sse))
	}))
	t.Cleanup(srv.Close)
	return srv, &bodies
}

// sseData returns the data payloads of an SSE response, in order.
func sseData(t *testing.T, rec *httptest.ResponseRecorder) []string {
	t.Helper()
	if ct := rec.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("Content-Type = %q, want text/event-stream (status %d body %q)", ct, rec.Code, rec.Body.String())
	}
	var out []string
	for _, line := range strings.Split(rec.Body.String(), "\n") {
		if d, ok := strings.CutPrefix(line, "data: "); ok {
			out = append(out, d)
		}
	}
	return out
}

// chunkDeltas decodes chat.completion.chunk payloads (all but [DONE]).
func chunkDeltas(t *testing.T, data []string) (deltas []map[string]any, finishes []any) {
	t.Helper()
	for _, d := range data {
		if d == "[DONE]" {
			continue
		}
		var c struct {
			Choices []struct {
				Delta        map[string]any `json:"delta"`
				FinishReason any            `json:"finish_reason"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(d), &c); err != nil || len(c.Choices) != 1 {
			t.Fatalf("not a chunk: %q", d)
		}
		deltas = append(deltas, c.Choices[0].Delta)
		finishes = append(finishes, c.Choices[0].FinishReason)
	}
	return deltas, finishes
}

const openAISSE = `data: {"id":"c1","object":"chat.completion.chunk","model":"trial-model","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

: keepalive comment
data: {"id":"c1","object":"chat.completion.chunk","model":"trial-model","choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}

data: {"id":"c1","object":"chat.completion.chunk","model":"trial-model","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}]}

data: [DONE]

`

func TestTrialStream_OpenAIPassThrough(t *testing.T) {
	up, bodies := sseUpstream(t, http.StatusOK, openAISSE)
	cfg := TrialConfig{OpenAIAPIKey: "sk-trial-secret", OpenAIURL: up.URL, OpenAIModel: "trial-model", RatePerMinute: 100}
	h, _, host, claim := newTrialTestHandlerAPI(t, cfg)
	session := registerAndGetSession(t, h, host, claim)

	rec := postTrialChat(h, host, "/api/trial/openai/chat/completions",
		`{"stream":true,"model":"client-pick","user":"el-caller-1","temperature":0.5,"max_tokens":200,"messages":[{"role":"user","content":"hi"}]}`, session)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body %q", rec.Code, rec.Body.String())
	}
	data := sseData(t, rec)
	if len(data) != 4 || data[3] != "[DONE]" {
		t.Fatalf("data = %q, want 3 chunks + [DONE]", data)
	}
	deltas, finishes := chunkDeltas(t, data)
	if deltas[1]["content"] != "Hel" || deltas[2]["content"] != "lo" || finishes[2] != "stop" {
		t.Fatalf("chunks out of order: %v %v", deltas, finishes)
	}
	assertNoTrialLeak(t, rec, "sk-trial-secret", "trial-model", up.URL)

	got := (*bodies)[0]
	if got["stream"] != true || got["model"] != "trial-model" {
		t.Fatalf("upstream body = %v, want stream:true + forced model", got)
	}
	if _, has := got["user"]; has {
		t.Fatalf("upstream body carries ElevenLabs user: %v", got)
	}
}

func TestTrialStream_OpenAIErrors(t *testing.T) {
	t.Run("upstream 4xx keeps the sanitized 502 JSON contract", func(t *testing.T) {
		up, _ := sseUpstream(t, http.StatusUnauthorized, "")
		cfg := TrialConfig{OpenAIAPIKey: "sk-trial", OpenAIURL: up.URL, OpenAIModel: "m", RatePerMinute: 100}
		h, _, host, claim := newTrialTestHandlerAPI(t, cfg)
		session := registerAndGetSession(t, h, host, claim)
		rec := postTrialChat(h, host, "/api/trial/openai/chat/completions", `{"stream":true,"messages":[]}`, session)
		if rec.Code != http.StatusBadGateway || rec.Body.String() != `{"error":"upstream_error","upstream_status":401}`+"\n" {
			t.Fatalf("status = %d body %q", rec.Code, rec.Body.String())
		}
	})

	for name, sse := range map[string]string{
		"stream ends without [DONE]": "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"x\"}}]}\n\n",
		"in-band provider error":     "data: {\"error\":{\"message\":\"upstream secret detail\"}}\n\n",
	} {
		t.Run(name, func(t *testing.T) {
			up, _ := sseUpstream(t, http.StatusOK, sse)
			cfg := TrialConfig{OpenAIAPIKey: "sk-trial", OpenAIURL: up.URL, OpenAIModel: "m", RatePerMinute: 100}
			h, _, host, claim := newTrialTestHandlerAPI(t, cfg)
			session := registerAndGetSession(t, h, host, claim)
			rec := postTrialChat(h, host, "/api/trial/openai/chat/completions", `{"stream":true,"messages":[]}`, session)
			data := sseData(t, rec)
			n := len(data)
			if n < 2 || data[n-2] != `{"error":"upstream_error"}` || data[n-1] != "[DONE]" {
				t.Fatalf("data = %q, want error chunk + [DONE]", data)
			}
			if strings.Contains(rec.Body.String(), "secret detail") {
				t.Fatalf("provider error text relayed: %q", rec.Body.String())
			}
		})
	}
}

const anthropicToolSSE = `event: message_start
data: {"type":"message_start","message":{"id":"msg_s1","model":"claude-trial-text","usage":{"input_tokens":5,"cache_read_input_tokens":42}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Logging "}}

event: ping
data: {"type":"ping"}

event: content_block_start
data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"log_weight","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"kg\": 8"}}

event: content_block_delta
data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"0.5}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":2}

event: content_block_start
data: {"type":"content_block_start","index":3,"content_block":{"type":"tool_use","id":"toolu_2","name":"end_call","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":3,"delta":{"type":"input_json_delta","partial_json":""}}

event: content_block_stop
data: {"type":"content_block_stop","index":3}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}

event: message_stop
data: {"type":"message_stop"}

`

func TestTrialStream_AnthropicTranslation(t *testing.T) {
	up, bodies := sseUpstream(t, http.StatusOK, anthropicToolSSE)
	cfg := anthropicTrialCfg(up.URL)
	h, _, host, claim := newTrialTestHandlerAPI(t, cfg)
	session := registerAndGetSession(t, h, host, claim)

	tools := `[{"type":"function","function":{"name":"log_weight","parameters":{"type":"object"}}},{"type":"function","function":{"name":"end_call"}}]`
	rec := postTrialChat(h, host, "/api/trial/openai/chat/completions",
		`{"stream":true,"user":"el","temperature":0.3,"max_tokens":100,"messages":[{"role":"user","content":"80.5"}],"tools":`+tools+`}`, session)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body %q", rec.Code, rec.Body.String())
	}
	data := sseData(t, rec)
	if data[len(data)-1] != "[DONE]" {
		t.Fatalf("data = %q, want trailing [DONE]", data)
	}
	deltas, finishes := chunkDeltas(t, data)
	if deltas[0]["role"] != "assistant" {
		t.Fatalf("first delta = %v, want role:assistant", deltas[0])
	}

	var text strings.Builder
	type call struct{ id, name, args string }
	calls := map[int]*call{}
	for _, d := range deltas {
		if s, ok := d["content"].(string); ok {
			text.WriteString(s)
		}
		tcs, _ := d["tool_calls"].([]any)
		for _, tc := range tcs {
			m := tc.(map[string]any)
			i := int(m["index"].(float64))
			if calls[i] == nil {
				calls[i] = &call{}
			}
			if id, ok := m["id"].(string); ok {
				calls[i].id = id
			}
			fn := m["function"].(map[string]any)
			if n, ok := fn["name"].(string); ok {
				calls[i].name = n
			}
			calls[i].args += fn["arguments"].(string)
		}
	}
	if text.String() != "Logging " {
		t.Fatalf("text = %q (thinking must be skipped)", text.String())
	}
	if len(calls) != 2 || *calls[0] != (call{"toolu_1", "log_weight", `{"kg": 80.5}`}) || *calls[1] != (call{"toolu_2", "end_call", "{}"}) {
		t.Fatalf("tool calls = %+v %+v", calls[0], calls[1])
	}
	if finishes[len(finishes)-1] != "tool_calls" {
		t.Fatalf("finish = %v, want tool_calls", finishes)
	}
	if strings.Contains(rec.Body.String(), "sig") || strings.Contains(rec.Body.String(), "hmm") {
		t.Fatalf("thinking leaked: %q", rec.Body.String())
	}
	assertNoTrialLeak(t, rec, anthKey, anthModel, up.URL)

	got := (*bodies)[0]
	if got["stream"] != true || got["model"] != anthModel {
		t.Fatalf("upstream body = %v", got)
	}
	if oc, _ := got["output_config"].(map[string]any); oc["effort"] != "low" {
		t.Fatalf("voice turn output_config = %v, want effort low", got["output_config"])
	}
	if cc, _ := got["cache_control"].(map[string]any); cc["type"] != "ephemeral" {
		t.Fatalf("top-level cache_control = %v, want ephemeral", got["cache_control"])
	}
	for _, banned := range []string{"thinking", "user", "temperature"} {
		if _, has := got[banned]; has {
			t.Fatalf("upstream body carries %q: %v", banned, got)
		}
	}
}

func TestTrialStream_AnthropicTextAndStopReasons(t *testing.T) {
	for stop, want := range map[string]string{"end_turn": "stop", "max_tokens": "length", "refusal": "content_filter"} {
		sse := `data: {"type":"message_start","message":{"id":"m","usage":{}}}
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi "}}
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"there"}}
data: {"type":"message_delta","delta":{"stop_reason":"` + stop + `"}}
data: {"type":"message_stop"}
`
		up, _ := sseUpstream(t, http.StatusOK, sse)
		h, _, host, claim := newTrialTestHandlerAPI(t, anthropicTrialCfg(up.URL))
		session := registerAndGetSession(t, h, host, claim)
		rec := postTrialChat(h, host, "/api/trial/openai/chat/completions", `{"stream":true,"messages":[{"role":"user","content":"x"}]}`, session)
		deltas, finishes := chunkDeltas(t, sseData(t, rec))
		if len(deltas) != 4 || deltas[1]["content"] != "Hi " || deltas[2]["content"] != "there" || finishes[3] != want {
			t.Fatalf("%s: deltas %v finishes %v", stop, deltas, finishes)
		}
	}

	// Upstream dies mid-stream (no message_stop): one error chunk, then [DONE].
	up, _ := sseUpstream(t, http.StatusOK, `data: {"type":"message_start","message":{"id":"m","usage":{}}}
data: {"type":"error","error":{"type":"overloaded_error","message":"secret detail"}}
`)
	h, _, host, claim := newTrialTestHandlerAPI(t, anthropicTrialCfg(up.URL))
	session := registerAndGetSession(t, h, host, claim)
	rec := postTrialChat(h, host, "/api/trial/openai/chat/completions", `{"stream":true,"messages":[{"role":"user","content":"x"}]}`, session)
	data := sseData(t, rec)
	if n := len(data); data[n-2] != `{"error":"upstream_error"}` || data[n-1] != "[DONE]" || strings.Contains(rec.Body.String(), "secret") {
		t.Fatalf("data = %q", data)
	}
}

// A voice call is many turns: streaming requests draw on their own 60/min
// window, while the daily budget still counts each one.
func TestTrialStream_SeparateLimiterSameBudget(t *testing.T) {
	up, bodies := sseUpstream(t, http.StatusOK, openAISSE)
	cfg := TrialConfig{OpenAIAPIKey: "sk", OpenAIURL: up.URL, OpenAIModel: "m", RatePerMinute: 10, DailyPerAccount: 12}
	h, _, host, claim := newTrialTestHandlerAPI(t, cfg)
	session := registerAndGetSession(t, h, host, claim)

	for i := range 11 {
		if rec := postTrialChat(h, host, "/api/trial/openai/chat/completions", `{"stream":true,"messages":[]}`, session); rec.Code != http.StatusOK {
			t.Fatalf("stream request %d status = %d body %q", i+1, rec.Code, rec.Body.String())
		}
	}
	// The shared limiter is untouched by the streams (the canned SSE answer
	// makes the non-stream path 502, which is past both gates — not a 429).
	if rec := postTrialChat(h, host, "/api/trial/openai/chat/completions", `{"messages":[]}`, session); rec.Code == http.StatusTooManyRequests {
		t.Fatalf("non-stream status = 429 body %q (streams must not drain the shared limiter)", rec.Body.String())
	}
	// …but the budget counted all 12.
	rec := postTrialChat(h, host, "/api/trial/openai/chat/completions", `{"stream":true,"messages":[]}`, session)
	if rec.Code != http.StatusTooManyRequests || !strings.Contains(rec.Body.String(), "trial_budget_exhausted") {
		t.Fatalf("13th status = %d body %q, want budget exhausted", rec.Code, rec.Body.String())
	}
	if len(*bodies) != 12 {
		t.Fatalf("upstream calls = %d, want 12", len(*bodies))
	}
}

// ElevenLabs replays assistant tool_calls without our anthropic_content
// round-trip; they must rebuild into a valid tool_use/tool_result pair.
func TestToAnthropicRequest_ReplayedToolCallsWithoutAnthropicContent(t *testing.T) {
	var payload map[string]json.RawMessage
	_ = json.Unmarshal([]byte(`{"messages":[
		{"role":"user","content":"log 80"},
		{"role":"assistant","content":null,"tool_calls":[{"id":"toolu_9","type":"function","function":{"name":"log_weight","arguments":"{\"kg\":80}"}}]},
		{"role":"tool","tool_call_id":"toolu_9","content":"ok"}
	],"tools":[{"type":"function","function":{"name":"log_weight"}}]}`), &payload)
	req, err := toAnthropicRequest(payload, "m")
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(req)
	var got struct {
		Messages []struct {
			Role    string           `json:"role"`
			Content []map[string]any `json:"content"`
		} `json:"messages"`
		Thinking any `json:"thinking"`
	}
	_ = json.Unmarshal(raw, &got)
	if len(got.Messages) != 3 || got.Thinking != nil {
		t.Fatalf("request = %s", raw)
	}
	use, res := got.Messages[1].Content[0], got.Messages[2].Content[0]
	if use["type"] != "tool_use" || use["id"] != "toolu_9" || use["input"].(map[string]any)["kg"] != float64(80) {
		t.Fatalf("tool_use = %v", use)
	}
	if res["type"] != "tool_result" || res["tool_use_id"] != "toolu_9" || res["content"] != "ok" {
		t.Fatalf("tool_result = %v", res)
	}
}

// deadlineRecorder lets http.ResponseController reach the deadline setters,
// standing in for cmd/cloud's real conn with its 15s/45s server deadlines.
type deadlineRecorder struct {
	*httptest.ResponseRecorder
	read, write time.Time
}

func (d *deadlineRecorder) SetReadDeadline(t time.Time) error  { d.read = t; return nil }
func (d *deadlineRecorder) SetWriteDeadline(t time.Time) error { d.write = t; return nil }

// A slow voice stream must outlive the server's 45s WriteTimeout: the handler
// pushes both deadlines past the 90s upstream timeout before streaming.
func TestTrialStream_ExtendsServerDeadlines(t *testing.T) {
	up, _ := sseUpstream(t, http.StatusOK, openAISSE)
	cfg := TrialConfig{OpenAIAPIKey: "sk", OpenAIURL: up.URL, OpenAIModel: "m", RatePerMinute: 10}
	api := NewTrialProxyAPI(nil, "", cfg)
	setup := setupStore(t)
	account, _ := setupInvite(t, setup)

	req := httptest.NewRequest(http.MethodPost, "/api/trial/openai/chat/completions", strings.NewReader(`{"stream":true,"messages":[]}`))
	req = req.WithContext(withAccount(req.Context(), account))
	rec := &deadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
	api.ChatCompletions(rec, req)

	floor := time.Now().Add(60 * time.Second)
	if rec.write.Before(floor) || rec.read.Before(floor) {
		t.Fatalf("deadlines read=%v write=%v, want both past %v", rec.read, rec.write, floor)
	}
	if data := sseData(t, rec.ResponseRecorder); data[len(data)-1] != "[DONE]" {
		t.Fatalf("data = %q", data)
	}
}

// errAfterReader serves its data, then fails like a cancelled upstream read.
type errAfterReader struct {
	data string
	err  error
}

func (r *errAfterReader) Read(p []byte) (int, error) {
	if r.data == "" {
		return 0, r.err
	}
	n := copy(p, r.data)
	r.data = r.data[n:]
	return n, nil
}

func TestTrialStream_ClientAbortIsNotUpstreamError(t *testing.T) {
	var logs strings.Builder
	captureSlog(t, slog.NewTextHandler(&logs, nil))

	partial := `data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Hel"}}]}` + "\n\n"
	// Cancelled client: no error chunk, logged as client_gone at Info.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	rec := httptest.NewRecorder()
	relayOpenAIStream(ctx, rec, "acc", &errAfterReader{partial, context.Canceled})
	if strings.Contains(rec.Body.String(), "upstream_error") || strings.Contains(rec.Body.String(), "[DONE]") {
		t.Fatalf("gone client got %q", rec.Body.String())
	}
	if l := logs.String(); !strings.Contains(l, "client_gone=true") || strings.Contains(l, "upstream_error") || strings.Contains(l, "level=WARN") {
		t.Fatalf("abort log = %q", l)
	}

	// Live client + broken upstream: still upstream_error=true at Warn.
	logs.Reset()
	rec = httptest.NewRecorder()
	relayOpenAIStream(context.Background(), rec, "acc", &errAfterReader{partial, io.ErrUnexpectedEOF})
	if l := logs.String(); !strings.Contains(l, "client_gone=false") || !strings.Contains(l, "upstream_error=true") || !strings.Contains(l, "level=WARN") {
		t.Fatalf("broken log = %q", l)
	}
	if !strings.HasSuffix(strings.TrimSpace(rec.Body.String()), "[DONE]") {
		t.Fatalf("live client body = %q", rec.Body.String())
	}
}
