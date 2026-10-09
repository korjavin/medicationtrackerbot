package cloudserver

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeMessagesAPI is an httptest stand-in for POST /v1/messages: it records
// each request and answers with the next canned (status, body) pair.
type fakeMessagesAPI struct {
	srv      *httptest.Server
	bodies   []map[string]any
	headers  []http.Header
	replies  []string
	statuses []int
}

func newFakeMessagesAPI(t *testing.T) *fakeMessagesAPI {
	f := &fakeMessagesAPI{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages" {
			t.Errorf("upstream path = %q, want /v1/messages", r.URL.Path)
		}
		var body map[string]any
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Errorf("upstream body not JSON: %v", err)
		}
		f.bodies = append(f.bodies, body)
		f.headers = append(f.headers, r.Header.Clone())
		i := len(f.bodies) - 1
		status := http.StatusOK
		if i < len(f.statuses) && f.statuses[i] != 0 {
			status = f.statuses[i]
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		w.Write([]byte(f.replies[i]))
	}))
	t.Cleanup(f.srv.Close)
	return f
}

const (
	anthKey   = "sk-ant-trial-secret"
	anthModel = "claude-trial-text"
	anthVis   = "claude-trial-vision"
)

func anthropicTrialCfg(url string) TrialConfig {
	return TrialConfig{
		Provider: TrialProviderAnthropic, AnthropicAPIKey: anthKey, AnthropicURL: url + "/v1",
		AnthropicModel: anthModel, AnthropicVisionModel: anthVis, RatePerMinute: 100,
		// The OpenAI triple sits in env alongside — it must not be used.
		OpenAIAPIKey: "sk-openai-unused", OpenAIURL: "http://unused.invalid", OpenAIModel: "gpt-unused",
	}
}

func assertNoTrialLeak(t *testing.T, rec *httptest.ResponseRecorder, secrets ...string) {
	t.Helper()
	for _, s := range secrets {
		if strings.Contains(rec.Body.String(), s) {
			t.Fatalf("trial config %q leaked in response body %q", s, rec.Body.String())
		}
		for name, vals := range rec.Header() {
			if strings.Contains(strings.Join(vals, " "), s) {
				t.Fatalf("trial config %q leaked in header %s", s, name)
			}
		}
	}
}

func chatMessage(t *testing.T, rec *httptest.ResponseRecorder) (map[string]any, string) {
	t.Helper()
	var out struct {
		Choices []struct {
			Message      map[string]any `json:"message"`
			FinishReason string         `json:"finish_reason"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || len(out.Choices) != 1 {
		t.Fatalf("not a chat.completion: %q (%v)", rec.Body.String(), err)
	}
	return out.Choices[0].Message, out.Choices[0].FinishReason
}

func TestTrialAnthropic_SchemaTextAndVision(t *testing.T) {
	f := newFakeMessagesAPI(t)
	f.replies = []string{
		`{"id":"msg_1","model":"` + anthModel + `","content":[{"type":"thinking","thinking":"","signature":"sig"},{"type":"text","text":"{\"items\":[]}"}],"stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":90}}`,
		`{"id":"msg_2","model":"` + anthVis + `","content":[{"type":"text","text":"{\"items\":[]}"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}`,
	}
	h, _, host, claim := newTrialTestHandlerAPI(t, anthropicTrialCfg(f.srv.URL))
	session := registerAndGetSession(t, h, host, claim)

	// Meal text parse: what aiclient.js parseMealFromDescription sends.
	rec := postTrialChat(h, host, "/api/trial/openai/chat/completions", `{
		"messages":[{"role":"system","content":"You parse meals."},{"role":"user","content":"2 eggs"}],
		"response_format":{"type":"json_schema","json_schema":{"name":"parsed_meal","strict":true,"schema":{"type":"object","properties":{"items":{"type":"array"}},"required":["items"],"additionalProperties":false}}},
		"temperature":0.2}`, session)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %q", rec.Code, rec.Body.String())
	}
	msg, finish := chatMessage(t, rec)
	if msg["content"] != `{"items":[]}` || finish != "stop" {
		t.Fatalf("message = %v finish = %q", msg, finish)
	}
	if _, has := msg["anthropic_content"]; has {
		t.Fatalf("anthropic_content must only ride along on tool turns: %v", msg)
	}
	hdr, body := f.headers[0], f.bodies[0]
	if hdr.Get("x-api-key") != anthKey || hdr.Get("anthropic-version") != trialAnthropicVersion {
		t.Fatalf("upstream auth headers = %v", hdr)
	}
	if hdr.Get("Authorization") != "" {
		t.Fatalf("OpenAI bearer must not be sent to Anthropic")
	}
	if body["model"] != anthModel || body["max_tokens"] == nil {
		t.Fatalf("model/max_tokens = %v/%v", body["model"], body["max_tokens"])
	}
	if _, has := body["temperature"]; has {
		t.Fatalf("sampling params must be dropped: %v", body)
	}
	sys := body["system"].([]any)[0].(map[string]any)
	if sys["text"] != "You parse meals." || sys["cache_control"] == nil {
		t.Fatalf("system = %v", sys)
	}
	format := body["output_config"].(map[string]any)["format"].(map[string]any)
	if format["type"] != "json_schema" || format["schema"].(map[string]any)["additionalProperties"] != false {
		t.Fatalf("output_config.format = %v", format)
	}
	msgs := body["messages"].([]any)
	if len(msgs) != 1 || msgs[0].(map[string]any)["role"] != "user" {
		t.Fatalf("messages = %v (system must move to top level)", msgs)
	}
	assertNoTrialLeak(t, rec, anthKey, anthModel, f.srv.URL, "sk-openai-unused")

	// Meal photo parse: image_url data URL → base64 image block, vision model.
	rec = postTrialChat(h, host, "/api/trial/openai/chat/completions?vision=1", `{
		"messages":[{"role":"user","content":[{"type":"text","text":"Identify"},{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,QUJD"}}]}]}`, session)
	if rec.Code != http.StatusOK {
		t.Fatalf("vision status = %d, body %q", rec.Code, rec.Body.String())
	}
	body = f.bodies[1]
	if body["model"] != anthVis {
		t.Fatalf("vision model = %v", body["model"])
	}
	parts := body["messages"].([]any)[0].(map[string]any)["content"].([]any)
	img := parts[1].(map[string]any)
	src := img["source"].(map[string]any)
	if img["type"] != "image" || src["type"] != "base64" || src["media_type"] != "image/jpeg" || src["data"] != "QUJD" {
		t.Fatalf("image block = %v", img)
	}
	assertNoTrialLeak(t, rec, anthKey, anthVis, f.srv.URL)
}

// TestTrialAnthropic_ToolLoop drives the tg-agent shape: tools round, the
// assistant message pushed back verbatim, tool replies, then the tool-less
// "reply in plain text" call.
func TestTrialAnthropic_ToolLoop(t *testing.T) {
	f := newFakeMessagesAPI(t)
	f.replies = []string{
		`{"id":"msg_1","content":[{"type":"thinking","thinking":"","signature":"sig-1"},{"type":"tool_use","id":"toolu_1","name":"mcp_help","input":{"query":"weight"}},{"type":"tool_use","id":"toolu_2","name":"mcp_help","input":{}}],"stop_reason":"tool_use","usage":{"input_tokens":5,"output_tokens":5}}`,
		`{"id":"msg_2","content":[{"type":"text","text":"Logged."}],"stop_reason":"end_turn","usage":{"input_tokens":5,"output_tokens":5}}`,
		`{"id":"msg_3","content":[{"type":"text","text":"Done."}],"stop_reason":"end_turn","usage":{"input_tokens":5,"output_tokens":5}}`,
	}
	h, _, host, claim := newTrialTestHandlerAPI(t, anthropicTrialCfg(f.srv.URL))
	session := registerAndGetSession(t, h, host, claim)

	tools := `[{"type":"function","function":{"name":"mcp_help","description":"Search ops","parameters":{"type":"object","properties":{"query":{"type":"string"}}}}}]`
	sys := `{"role":"system","content":"You are the agent."}`
	user := `{"role":"user","content":"log 80kg"}`

	rec := postTrialChat(h, host, "/api/trial/openai/chat/completions",
		`{"messages":[`+sys+`,`+user+`],"tools":`+tools+`,"tool_choice":"auto"}`, session)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %q", rec.Code, rec.Body.String())
	}
	msg, finish := chatMessage(t, rec)
	calls, _ := msg["tool_calls"].([]any)
	if finish != "tool_calls" || len(calls) != 2 || msg["content"] != nil {
		t.Fatalf("message = %v finish = %q", msg, finish)
	}
	fn := calls[0].(map[string]any)["function"].(map[string]any)
	if fn["name"] != "mcp_help" || fn["arguments"] != `{"query":"weight"}` {
		t.Fatalf("tool call = %v", calls[0])
	}
	tool0 := f.bodies[0]["tools"].([]any)[0].(map[string]any)
	if tool0["name"] != "mcp_help" || tool0["input_schema"] == nil || tool0["description"] != "Search ops" {
		t.Fatalf("tool def = %v", tool0)
	}

	// Round 2: the client pushes msg back verbatim plus two role:tool replies.
	assistant, _ := json.Marshal(msg)
	rec = postTrialChat(h, host, "/api/trial/openai/chat/completions",
		`{"messages":[`+sys+`,`+user+`,`+string(assistant)+`,
		{"role":"tool","tool_call_id":"toolu_1","content":"{\"ops\":[]}"},
		{"role":"tool","tool_call_id":"toolu_2","content":"{}"}],"tools":`+tools+`,"tool_choice":"auto"}`, session)
	if rec.Code != http.StatusOK {
		t.Fatalf("round 2 status = %d, body %q", rec.Code, rec.Body.String())
	}
	if m, _ := chatMessage(t, rec); m["content"] != "Logged." {
		t.Fatalf("round 2 message = %v", m)
	}
	msgs := f.bodies[1]["messages"].([]any)
	if len(msgs) != 3 {
		t.Fatalf("round 2 messages = %v, want user/assistant/user", msgs)
	}
	asst := msgs[1].(map[string]any)["content"].([]any)
	if first := asst[0].(map[string]any); first["type"] != "thinking" || first["signature"] != "sig-1" {
		t.Fatalf("thinking block not round-tripped first: %v", asst)
	}
	results := msgs[2].(map[string]any)["content"].([]any)
	if len(results) != 2 || results[0].(map[string]any)["tool_use_id"] != "toolu_1" || results[1].(map[string]any)["type"] != "tool_result" {
		t.Fatalf("tool results must share one user message: %v", results)
	}

	// Final tool-less call: tool history flattens to text (the Messages API
	// refuses tool_use blocks on a request without tools).
	rec = postTrialChat(h, host, "/api/trial/openai/chat/completions",
		`{"messages":[`+sys+`,`+user+`,`+string(assistant)+`,
		{"role":"tool","tool_call_id":"toolu_1","content":"{}"},
		{"role":"user","content":"Now reply in plain text."}]}`, session)
	if rec.Code != http.StatusOK {
		t.Fatalf("final status = %d, body %q", rec.Code, rec.Body.String())
	}
	raw, _ := json.Marshal(f.bodies[2])
	for _, banned := range []string{`"tool_use"`, `"tool_result"`, `"thinking"`, `"tools"`} {
		if strings.Contains(string(raw), banned) {
			t.Fatalf("tool-less request carries %s: %s", banned, raw)
		}
	}
	assertNoTrialLeak(t, rec, anthKey, anthModel, f.srv.URL)
}

func TestTrialAnthropic_ErrorsSanitized(t *testing.T) {
	cases := []struct {
		name, reply, wantCode string
		status                int
	}{
		{"schema rejection retries fenced", `{"type":"error","error":{"type":"invalid_request_error","message":"output_config.format.schema: unsupported keyword"}}`, "response_format_unsupported", 400},
		{"credit exhaustion is a plain failure", `{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}`, "upstream_error", 400},
		{"bad key", `{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key ` + anthKey + `"}}`, "upstream_error", 401},
		{"overloaded", `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`, "upstream_error", 529},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeMessagesAPI(t)
			f.replies, f.statuses = []string{tc.reply}, []int{tc.status}
			h, _, host, claim := newTrialTestHandlerAPI(t, anthropicTrialCfg(f.srv.URL))
			session := registerAndGetSession(t, h, host, claim)
			rec := postTrialChat(h, host, "/api/trial/openai/chat/completions",
				`{"messages":[{"role":"user","content":"x"}],"response_format":{"type":"json_schema","json_schema":{"schema":{"type":"object"}}}}`, session)
			if rec.Code != http.StatusBadGateway {
				t.Fatalf("status = %d, want 502", rec.Code)
			}
			var got struct {
				Error          string `json:"error"`
				UpstreamStatus int    `json:"upstream_status"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil || got.Error != tc.wantCode || got.UpstreamStatus != tc.status {
				t.Fatalf("body = %q, want %s/%d", rec.Body.String(), tc.wantCode, tc.status)
			}
			if strings.Contains(rec.Body.String(), "credit") || strings.Contains(rec.Body.String(), "Overloaded") {
				t.Fatalf("upstream body relayed: %q", rec.Body.String())
			}
			assertNoTrialLeak(t, rec, anthKey, f.srv.URL)
		})
	}
}

func TestTrialAnthropic_GatesBeforeUpstream(t *testing.T) {
	f := newFakeMessagesAPI(t)
	f.replies = []string{`{"id":"m","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn"}`}

	// Active provider without its key → not configured, even with an OpenAI key.
	cfg := anthropicTrialCfg(f.srv.URL)
	cfg.AnthropicAPIKey = ""
	h, _, host, claim := newTrialTestHandlerAPI(t, cfg)
	session := registerAndGetSession(t, h, host, claim)
	rec := postTrialChat(h, host, "/api/trial/openai/chat/completions", `{"messages":[{"role":"user","content":"x"}]}`, session)
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "trial_not_configured") {
		t.Fatalf("status = %d body %q, want 503 trial_not_configured", rec.Code, rec.Body.String())
	}

	// Rate limit and stream rejection run before any upstream call.
	cfg = anthropicTrialCfg(f.srv.URL)
	cfg.RatePerMinute = 1
	h, _, host, claim = newTrialTestHandlerAPI(t, cfg)
	session = registerAndGetSession(t, h, host, claim)
	rec = postTrialChat(h, host, "/api/trial/openai/chat/completions", `{"stream":true,"messages":[]}`, session)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("stream status = %d, want 400", rec.Code)
	}
	rec = postTrialChat(h, host, "/api/trial/openai/chat/completions", `{"messages":[{"role":"user","content":"x"}]}`, session)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("second call status = %d, want 429", rec.Code)
	}
	if len(f.bodies) != 0 {
		t.Fatalf("upstream called %d times, want 0", len(f.bodies))
	}
}

func TestTrialConfigFromEnv_Provider(t *testing.T) {
	t.Setenv("TRIAL_AI_PROVIDER", "")
	t.Setenv("TRIAL_ANTHROPIC_MODEL", "")
	t.Setenv("TRIAL_ANTHROPIC_VISION_MODEL", "")
	cfg, err := TrialConfigFromEnv()
	if err != nil || cfg.Provider != TrialProviderOpenAI {
		t.Fatalf("unset provider = %q (%v), want openai", cfg.Provider, err)
	}

	t.Setenv("TRIAL_AI_PROVIDER", "Anthropic")
	t.Setenv("TRIAL_ANTHROPIC_API_KEY", "sk-ant")
	cfg, err = TrialConfigFromEnv()
	if err != nil {
		t.Fatalf("anthropic: %v", err)
	}
	if cfg.Provider != TrialProviderAnthropic || cfg.AnthropicModel != "claude-haiku-5-5" ||
		cfg.AnthropicVisionModel != "claude-haiku-5-5" || cfg.AnthropicURL != "https://api.anthropic.com/v1" || !cfg.TrialAIConfigured() {
		t.Fatalf("anthropic cfg = %+v", cfg)
	}

	t.Setenv("TRIAL_AI_PROVIDER", "gemini")
	if _, err := TrialConfigFromEnv(); err == nil || strings.Contains(err.Error(), "gemini") {
		t.Fatalf("unknown provider err = %v, want refusal naming only the env var", err)
	}
}

func TestToAnthropicRequest_Table(t *testing.T) {
	cases := []struct {
		name, body string
		check      func(t *testing.T, req map[string]any)
		wantErr    bool
	}{
		{"unknown role rejected", `{"messages":[{"role":"function","content":"x"}]}`, nil, true},
		{"url image passes through", `{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"https://x/y.png"}}]}]}`,
			func(t *testing.T, req map[string]any) {
				src := req["messages"].([]anthropicMessage)[0].Content[0].(map[string]any)["source"].(map[string]any)
				if src["type"] != "url" {
					t.Fatalf("source = %v", src)
				}
			}, false},
		{"empty assistant skipped", `{"messages":[{"role":"user","content":"a"},{"role":"assistant","content":""},{"role":"user","content":"b"}]}`,
			func(t *testing.T, req map[string]any) {
				msgs := req["messages"].([]anthropicMessage)
				if len(msgs) != 1 || len(msgs[0].Content) != 2 {
					t.Fatalf("messages = %+v, want one merged user turn", msgs)
				}
			}, false},
		{"bad tool arguments become empty input", `{"tools":[{"type":"function","function":{"name":"t"}}],"messages":[{"role":"assistant","tool_calls":[{"id":"c","type":"function","function":{"name":"t","arguments":"not json"}}]}]}`,
			func(t *testing.T, req map[string]any) {
				b := req["messages"].([]anthropicMessage)[0].Content[0].(map[string]any)
				if string(b["input"].(json.RawMessage)) != "{}" {
					t.Fatalf("input = %s", b["input"])
				}
				if req["tools"].([]any)[0].(map[string]any)["input_schema"] == nil {
					t.Fatalf("missing parameters must still yield an input_schema")
				}
			}, false},
		{"tool_choice none kept", `{"tools":[{"type":"function","function":{"name":"t"}}],"tool_choice":"none","messages":[]}`,
			func(t *testing.T, req map[string]any) {
				if req["tool_choice"].(map[string]string)["type"] != "none" {
					t.Fatalf("tool_choice = %v", req["tool_choice"])
				}
			}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var payload map[string]json.RawMessage
			if err := json.Unmarshal([]byte(tc.body), &payload); err != nil {
				t.Fatal(err)
			}
			req, err := toAnthropicRequest(payload, "m")
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tc.wantErr)
			}
			if tc.check != nil {
				tc.check(t, req)
			}
		})
	}
}

func TestFromAnthropicResponse_FinishReasons(t *testing.T) {
	for stop, want := range map[string]string{"end_turn": "stop", "stop_sequence": "stop", "max_tokens": "length", "tool_use": "tool_calls", "refusal": "content_filter"} {
		out := fromAnthropicResponse(anthropicResponse{StopReason: stop})
		got := out["choices"].([]any)[0].(map[string]any)["finish_reason"]
		if got != want {
			t.Errorf("stop_reason %q → %v, want %q", stop, got, want)
		}
	}
	var r anthropicResponse
	r.Usage.InputTokens, r.Usage.CacheReadInputTokens, r.Usage.CacheCreationInputTokens, r.Usage.OutputTokens = 1, 2, 3, 4
	u := fromAnthropicResponse(r)["usage"].(map[string]int)
	if u["prompt_tokens"] != 6 || u["completion_tokens"] != 4 || u["total_tokens"] != 10 {
		t.Fatalf("usage = %v", u)
	}
}
