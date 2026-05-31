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
	httpClient *http.Client
}

// NewClient builds a chat client. baseURL defaults to OpenAI; model defaults to
// a small tool-calling model. Both are normally supplied from env.
func NewClient(apiKey, baseURL, model string) *Client {
	if baseURL == "" {
		baseURL = "https://api.openai.com/v1"
	}
	if model == "" {
		model = "gpt-4o-mini"
	}
	return &Client{
		apiKey:     apiKey,
		baseURL:    strings.TrimRight(baseURL, "/"),
		model:      model,
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
}

type chatToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
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

// chat issues one Chat Completions request.
func (c *Client) chat(ctx context.Context, req chatRequest) (*chatResponse, error) {
	reqBytes, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}
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
	defer resp.Body.Close()

	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		excerpt := strings.TrimSpace(string(raw))
		if len(excerpt) > 400 {
			excerpt = excerpt[:400] + "..."
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
	})
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(resp.Choices[0].Message.Content), nil
}
