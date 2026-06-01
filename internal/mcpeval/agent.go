// Package mcpeval is an evaluation harness that measures whether an LLM agent
// can drive the MCP server's discover-then-run surface (mcp_help / mcp_call /
// mcp_execute) to accomplish real tasks.
//
// The harness wires the *production* MCP stack end-to-end — the real registry,
// proxy, Python executor, HMAC-signed bridge, and HTTP handlers — against an
// in-memory SQLite store seeded deterministically by internal/seeddemo. A real
// LLM (any OpenAI-compatible, tool-calling endpoint, configured via env) is
// handed the live tool surface and a task; judges then score the outcome
// against persisted DB state and the agent's tool trajectory.
//
// It is intentionally opt-in: nothing here runs without MCPEVAL_API_KEY, so
// `go test ./...` and CI are unaffected. See docs/mcp-evals.md.
package mcpeval

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// systemPromptUnderTest is the lean, generic instruction handed to the agent.
//
// It is deliberately minimal: the eval measures how self-describing the MCP
// surface itself is (the tool descriptions + the usage_protocol embedded in
// mcp_help), NOT a hand-tuned prompt. This constant plus the server-side tool
// descriptions are the knobs you "hill-climb"; the scenario dataset catches
// regressions when either changes.
const systemPromptUnderTest = `You are a helpful assistant for a personal health-tracking app. ` +
	`You can read and modify the user's health data ONLY through the provided MCP tools. ` +
	`Discover what is available with mcp_help, then act: use mcp_call for a single read or write, ` +
	`and mcp_execute (a sandboxed Python script) only for multi-step work such as loops, joins, or computed values. ` +
	`When the user asks you to change data, you must actually perform the change with a tool (writes need mode="write" and a one-sentence intent). ` +
	`If a request cannot be done with the available tools, say so plainly instead of pretending. ` +
	`When you have the answer, reply to the user in one or two short sentences.`

// ToolSpec is a tool exposed to the agent, sourced from the MCP server's
// ListTools response. Parameters is the tool's JSON Schema verbatim.
type ToolSpec struct {
	Name        string
	Description string
	Parameters  json.RawMessage
}

// ToolRunner executes a tool call on the agent's behalf and returns the textual
// result fed back to the model. isError mirrors the MCP CallToolResult.IsError
// flag so the model can see failures and self-correct. The harness implements
// this against the in-memory MCP client session.
type ToolRunner interface {
	RunTool(ctx context.Context, name string, args json.RawMessage) (result string, isError bool, err error)
}

// ToolInvocation is one recorded tool call in the agent's trajectory.
type ToolInvocation struct {
	Name       string          `json:"name"`
	Args       json.RawMessage `json:"args"`
	Result     string          `json:"result"`
	IsError    bool            `json:"is_error"`
	DurationMS int64           `json:"duration_ms"`
}

// Usage accumulates token counts across the agent's turns (best-effort; not all
// providers populate it).
type Usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

// RunResult is the full record of one agent run over a single task.
type RunResult struct {
	Task       string           `json:"task"`
	FinalText  string           `json:"final_text"`
	Trajectory []ToolInvocation `json:"trajectory"`
	Rounds     int              `json:"rounds"`
	Usage      Usage            `json:"usage"`
	Truncated  bool             `json:"truncated"` // hit the round cap without finishing
}

// Client is a minimal OpenAI-compatible Chat Completions client with tool
// calling. It is kept local to the eval package on purpose — the production
// internal/ai client has no need for a generic tool-calling loop. Modeled on
// internal/ai/openai.go's request/transport/error-decode style.
type Client struct {
	apiKey     string
	baseURL    string
	model      string
	maxTokens  int
	httpClient *http.Client
}

// defaultMaxTokens is the completion cap when none is configured. Sized to leave
// room for a reasoning model's chain-of-thought PLUS the final visible answer
// (qwen3.5-9b alone spends ~550 reasoning tokens on a one-line reply).
const defaultMaxTokens = 4096

// NewClient builds a chat client. baseURL defaults to OpenAI; model defaults to
// a small tool-calling model; maxTokens<=0 falls back to defaultMaxTokens. All
// are normally supplied from env.
func NewClient(apiKey, baseURL, model string, maxTokens int) *Client {
	if baseURL == "" {
		baseURL = "https://api.openai.com/v1"
	}
	if model == "" {
		model = "gpt-4o-mini"
	}
	if maxTokens <= 0 {
		maxTokens = defaultMaxTokens
	}
	return &Client{
		apiKey:     apiKey,
		baseURL:    strings.TrimRight(baseURL, "/"),
		model:      model,
		maxTokens:  maxTokens,
		httpClient: &http.Client{Timeout: 120 * time.Second},
	}
}

// Agent runs a bounded tool-calling loop against a ToolRunner.
type Agent struct {
	client    *Client
	maxRounds int
}

// NewAgent builds an agent. maxRounds caps how many assistant turns may issue
// tool calls before the loop gives up (guards runaway loops / cost).
func NewAgent(client *Client, maxRounds int) *Agent {
	if maxRounds <= 0 {
		maxRounds = 8
	}
	return &Agent{client: client, maxRounds: maxRounds}
}

// --- OpenAI Chat Completions wire types ---

type chatRequest struct {
	Model       string        `json:"model"`
	Messages    []chatMessage `json:"messages"`
	Tools       []chatTool    `json:"tools,omitempty"`
	ToolChoice  string        `json:"tool_choice,omitempty"`
	Temperature float64       `json:"temperature"`
	// MaxTokens caps the completion length. It MUST be generous for reasoning
	// models: they spend most of the budget in reasoning_content, and a small cap
	// truncates the visible answer mid-word (finish_reason="length", empty/partial
	// content) — observed with qwen3.5-9b, which burned ~550 reasoning tokens and
	// got cut off before finishing "...was 115/68". Omitted (0) → provider default.
	MaxTokens int `json:"max_tokens,omitempty"`
}

type chatTool struct {
	Type     string           `json:"type"`
	Function chatToolFunction `json:"function"`
}

type chatToolFunction struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters,omitempty"`
}

type chatMessage struct {
	Role       string         `json:"role"`
	Content    string         `json:"content,omitempty"`
	ToolCalls  []chatToolCall `json:"tool_calls,omitempty"`
	ToolCallID string         `json:"tool_call_id,omitempty"`
	Name       string         `json:"name,omitempty"`
	// ReasoningContent is the model's chain-of-thought, surfaced by reasoning
	// models (qwen3.5, DeepSeek-R1, …) alongside an often-empty Content. It MUST
	// be echoed back verbatim on subsequent turns: with it stripped, qwen3.5-9b
	// returns empty content and stops without answering (it relies on its own
	// prior reasoning being in context). omitempty makes it a no-op for models
	// that don't emit it. Mirrors the Gemini extra_content round-trip on
	// chatToolCall — same class of "preserve provider state across turns" fix.
	ReasoningContent string `json:"reasoning_content,omitempty"`
}

type chatToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
	// ExtraContent is provider-specific tool-call metadata captured verbatim and
	// echoed back unchanged on the next turn. Gemini 3 (via its OpenAI-compat
	// layer) returns a reasoning token here as
	// extra_content.google.thought_signature and REJECTS the follow-up request
	// (HTTP 400) if the assistant turn's tool calls don't carry it back. Other
	// providers omit the field, so the omitempty round-trips as a no-op.
	ExtraContent json.RawMessage `json:"extra_content,omitempty"`
}

type chatResponse struct {
	Choices []struct {
		Message      chatMessage `json:"message"`
		FinishReason string      `json:"finish_reason"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
		TotalTokens      int `json:"total_tokens"`
	} `json:"usage"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// maxRateLimitRetries bounds how many times chat retries a 429. Free-tier
// endpoints (e.g. Gemini's generate_content_free_tier_requests, ~5 req/min) hand
// out 429s readily; without a retry the whole suite fails on quota rather than on
// agent behavior. Each retry waits the server-advised RetryInfo delay when
// present, else a capped exponential backoff.
const maxRateLimitRetries = 5

// chat issues one Chat Completions request, retrying transient 429s.
func (c *Client) chat(ctx context.Context, req chatRequest) (*chatResponse, error) {
	reqBytes, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	var lastBody string
	for attempt := 0; ; attempt++ {
		httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(reqBytes))
		if err != nil {
			return nil, fmt.Errorf("build request: %w", err)
		}
		httpReq.Header.Set("Content-Type", "application/json")
		if c.apiKey != "" {
			httpReq.Header.Set("Authorization", "Bearer "+c.apiKey)
		}
		resp, err := c.httpClient.Do(httpReq)
		if err != nil {
			return nil, fmt.Errorf("request failed: %w", err)
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		if resp.StatusCode == http.StatusTooManyRequests && attempt < maxRateLimitRetries && isRetryableQuota(raw) {
			lastBody = strings.TrimSpace(string(raw))
			wait := retryAfter(resp.Header, raw, attempt)
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(wait):
			}
			continue
		}

		if resp.StatusCode != http.StatusOK {
			excerpt := strings.TrimSpace(string(raw))
			if len(excerpt) > 400 {
				excerpt = excerpt[:400] + "..."
			}
			if excerpt == "" {
				excerpt = lastBody
			}
			return nil, fmt.Errorf("chat API status %d: %s", resp.StatusCode, excerpt)
		}
		var out chatResponse
		if err := json.Unmarshal(raw, &out); err != nil {
			return nil, fmt.Errorf("decode response: %w", err)
		}
		if out.Error != nil && out.Error.Message != "" {
			return nil, fmt.Errorf("chat API error: %s", out.Error.Message)
		}
		if len(out.Choices) == 0 {
			return nil, fmt.Errorf("chat API returned no choices")
		}
		return &out, nil
	}
}

// isRetryableQuota reports whether a 429 body is worth retrying. A per-minute /
// per-request-rate throttle clears on its own, so we wait and retry. A per-DAY
// project quota (Google quotaId like
// "GenerateRequestsPerDayPerProjectPerModel-FreeTier", e.g. Gemini free tier =
// 20 req/day) will NOT clear within a run, so retrying just hangs each remaining
// scenario through pointless backoff — fail fast instead. Unparseable or
// non-Google 429s default to retryable (the conservative choice).
func isRetryableQuota(body []byte) bool {
	var parsed struct {
		Error struct {
			Details []struct {
				Type       string `json:"@type"`
				Violations []struct {
					QuotaID string `json:"quotaId"`
				} `json:"violations"`
			} `json:"details"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		var arr []json.RawMessage
		if json.Unmarshal(body, &arr) == nil && len(arr) > 0 {
			_ = json.Unmarshal(arr[0], &parsed)
		}
	}
	for _, d := range parsed.Error.Details {
		if !strings.Contains(d.Type, "QuotaFailure") {
			continue
		}
		for _, v := range d.Violations {
			if strings.Contains(strings.ToLower(v.QuotaID), "perday") {
				return false // daily cap — won't clear within this run
			}
		}
	}
	return true
}

// retryAfter computes how long to wait before retrying a 429. It prefers the
// Retry-After header, then the Google RetryInfo.retryDelay embedded in the error
// body (e.g. "30s"), and falls back to a capped exponential backoff keyed on the
// attempt number. The result is clamped to [1s, 60s].
func retryAfter(h http.Header, body []byte, attempt int) time.Duration {
	if v := strings.TrimSpace(h.Get("Retry-After")); v != "" {
		if secs, err := strconv.Atoi(v); err == nil && secs > 0 {
			return clampBackoff(time.Duration(secs) * time.Second)
		}
	}
	// Google embeds {"@type":".../RetryInfo","retryDelay":"30s"} in error.details.
	var parsed struct {
		Error struct {
			Details []struct {
				Type       string `json:"@type"`
				RetryDelay string `json:"retryDelay"`
			} `json:"details"`
		} `json:"error"`
	}
	// The body may be a top-level array of error objects; try both shapes.
	if err := json.Unmarshal(body, &parsed); err != nil {
		var arr []json.RawMessage
		if json.Unmarshal(body, &arr) == nil && len(arr) > 0 {
			_ = json.Unmarshal(arr[0], &parsed)
		}
	}
	for _, d := range parsed.Error.Details {
		if strings.Contains(d.Type, "RetryInfo") && d.RetryDelay != "" {
			if dur, err := time.ParseDuration(d.RetryDelay); err == nil && dur > 0 {
				return clampBackoff(dur)
			}
		}
	}
	// Exponential backoff: 2s, 4s, 8s, ...
	return clampBackoff(time.Duration(2<<attempt) * time.Second)
}

// clampBackoff bounds a retry wait to a sane [1s, 60s] window.
func clampBackoff(d time.Duration) time.Duration {
	const minWait, maxWait = time.Second, 60 * time.Second
	if d < minWait {
		return minWait
	}
	if d > maxWait {
		return maxWait
	}
	return d
}

// Run executes the bounded tool-calling loop for one task and returns the full
// trajectory. The agent sees exactly the supplied tools (sourced from the live
// MCP server) and dispatches each call through the runner.
func (a *Agent) Run(ctx context.Context, task string, tools []ToolSpec, runner ToolRunner) (*RunResult, error) {
	chatTools := make([]chatTool, 0, len(tools))
	for _, t := range tools {
		// ToolSpec and chatToolFunction carry the same fields; convert directly.
		chatTools = append(chatTools, chatTool{Type: "function", Function: chatToolFunction(t)})
	}

	messages := []chatMessage{
		{Role: "system", Content: systemPromptUnderTest},
		{Role: "user", Content: task},
	}

	res := &RunResult{Task: task}

	for round := 0; round < a.maxRounds; round++ {
		res.Rounds = round + 1
		resp, err := a.client.chat(ctx, chatRequest{
			Model:       a.client.model,
			Messages:    messages,
			Tools:       chatTools,
			ToolChoice:  "auto",
			Temperature: 0,
			MaxTokens:   a.client.maxTokens,
		})
		if err != nil {
			return res, err
		}
		res.Usage.PromptTokens += resp.Usage.PromptTokens
		res.Usage.CompletionTokens += resp.Usage.CompletionTokens
		res.Usage.TotalTokens += resp.Usage.TotalTokens

		msg := resp.Choices[0].Message

		// No tool calls → the assistant is answering. Record and finish.
		if len(msg.ToolCalls) == 0 {
			res.FinalText = strings.TrimSpace(msg.Content)
			return res, nil
		}

		// Append the assistant turn verbatim (the API requires it before the
		// matching tool result messages), then execute each tool call.
		messages = append(messages, msg)
		for _, tc := range msg.ToolCalls {
			args := json.RawMessage(tc.Function.Arguments)
			if len(args) == 0 {
				args = json.RawMessage("{}")
			}
			start := time.Now()
			result, isErr, runErr := runner.RunTool(ctx, tc.Function.Name, args)
			if runErr != nil {
				// Surface the dispatch error to the model rather than aborting,
				// so it can recover; also record it in the trajectory.
				result = "tool dispatch error: " + runErr.Error()
				isErr = true
			}
			res.Trajectory = append(res.Trajectory, ToolInvocation{
				Name:       tc.Function.Name,
				Args:       args,
				Result:     result,
				IsError:    isErr,
				DurationMS: time.Since(start).Milliseconds(),
			})
			content := result
			if isErr {
				content = "ERROR: " + result
			}
			messages = append(messages, chatMessage{
				Role:       "tool",
				ToolCallID: tc.ID,
				Name:       tc.Function.Name,
				Content:    content,
			})
		}
	}

	res.Truncated = true
	return res, nil
}

// completeJSON issues a single non-tool completion and returns the assistant
// text. Used by the LLM judge.
func (c *Client) completeJSON(ctx context.Context, system, user string) (string, error) {
	resp, err := c.chat(ctx, chatRequest{
		Model: c.model,
		Messages: []chatMessage{
			{Role: "system", Content: system},
			{Role: "user", Content: user},
		},
		Temperature: 0,
		MaxTokens:   c.maxTokens,
	})
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(resp.Choices[0].Message.Content), nil
}
