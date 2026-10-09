package cloudserver

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
)

// Native Anthropic Messages adapter for the trial proxy (bd med-p07e),
// selected by TRIAL_AI_PROVIDER=anthropic. The client keeps speaking OpenAI
// chat/completions; this file translates the request to POST /v1/messages and
// the answer back to the chat.completion shape aiclient.js parses. Anthropic's
// OpenAI-compat layer is NOT used on purpose: it silently ignores
// response_format, so strict-schema meal parsing would degrade unnoticed.
//
// Translation covers only what our clients send (aiclient.js, tg-agent.js,
// gamification-narrator.js): system/user/assistant text, image_url data URLs,
// response_format json_schema, function tools + tool_calls + role:tool.
const (
	trialAnthropicDefaultURL   = "https://api.anthropic.com/v1"
	trialAnthropicDefaultModel = "claude-haiku-5-5"
	trialAnthropicVersion      = "2023-06-01"
	// Thinking counts toward max_tokens on the adaptive-thinking models, so
	// leave room above the small JSON answers our callers expect.
	trialAnthropicMaxTokens = 8192
)

// oaMessage is the subset of an OpenAI chat message our clients send.
// AnthropicContent is our own round-trip field: the adapter returns the
// upstream content blocks on tool-calling turns and the tg-agent loop pushes
// the assistant message back verbatim, so thinking blocks reach the next
// request unmodified (the Messages API wants them passed back with tool
// results).
type oaMessage struct {
	Role             string          `json:"role"`
	Content          json.RawMessage `json:"content"`
	ToolCalls        []oaToolCall    `json:"tool_calls"`
	ToolCallID       string          `json:"tool_call_id"`
	AnthropicContent json.RawMessage `json:"anthropic_content"`
}

type oaToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type oaPart struct {
	Type     string `json:"type"`
	Text     string `json:"text"`
	ImageURL struct {
		URL string `json:"url"`
	} `json:"image_url"`
}

type anthropicMessage struct {
	Role    string `json:"role"`
	Content []any  `json:"content"`
}

var errUnsupportedMessage = errors.New("unsupported message")

// oaContentBlocks turns an OpenAI content field (string, part array, or null)
// into Anthropic text/image blocks. Empty text is dropped — the Messages API
// rejects empty text blocks.
func oaContentBlocks(raw json.RawMessage) ([]any, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		if s == "" {
			return nil, nil
		}
		return []any{map[string]any{"type": "text", "text": s}}, nil
	}
	var parts []oaPart
	if err := json.Unmarshal(raw, &parts); err != nil {
		return nil, errUnsupportedMessage
	}
	var out []any
	for _, p := range parts {
		switch p.Type {
		case "text":
			if p.Text != "" {
				out = append(out, map[string]any{"type": "text", "text": p.Text})
			}
		case "image_url":
			out = append(out, map[string]any{"type": "image", "source": imageSource(p.ImageURL.URL)})
		default:
			return nil, errUnsupportedMessage
		}
	}
	return out, nil
}

// imageSource maps a data: URL to a base64 source and anything else to a url
// source. aiclient.js only sends data URLs (FileReader.readAsDataURL).
func imageSource(u string) map[string]any {
	if rest, ok := strings.CutPrefix(u, "data:"); ok {
		if meta, data, ok := strings.Cut(rest, ","); ok {
			if mediaType, isB64 := strings.CutSuffix(meta, ";base64"); isB64 {
				return map[string]any{"type": "base64", "media_type": mediaType, "data": data}
			}
		}
	}
	return map[string]any{"type": "url", "url": u}
}

// toAnthropicRequest translates an OpenAI chat/completions body into a
// Messages API body with the operator's model forced. Unknown OpenAI knobs
// (temperature, top_p, …) are dropped: current Claude models 400 on
// non-default sampling parameters, and our clients do not send them.
func toAnthropicRequest(payload map[string]json.RawMessage, model string) (map[string]any, error) {
	var msgs []oaMessage
	if err := json.Unmarshal(payload["messages"], &msgs); err != nil && len(payload["messages"]) > 0 {
		return nil, err
	}
	var tools []struct {
		Function struct {
			Name        string          `json:"name"`
			Description string          `json:"description"`
			Parameters  json.RawMessage `json:"parameters"`
		} `json:"function"`
	}
	if raw, ok := payload["tools"]; ok {
		if err := json.Unmarshal(raw, &tools); err != nil {
			return nil, err
		}
	}
	hasTools := len(tools) > 0

	var system []string
	var out []anthropicMessage
	push := func(role string, blocks ...any) {
		if len(blocks) == 0 {
			return
		}
		// Merge same-role neighbours: several role:tool replies must land in
		// ONE user message of tool_result blocks.
		if n := len(out); n > 0 && out[n-1].Role == role {
			out[n-1].Content = append(out[n-1].Content, blocks...)
			return
		}
		out = append(out, anthropicMessage{Role: role, Content: blocks})
	}

	for _, m := range msgs {
		switch m.Role {
		case "system", "developer":
			blocks, err := oaContentBlocks(m.Content)
			if err != nil {
				return nil, err
			}
			for _, b := range blocks {
				if t, ok := b.(map[string]any)["text"].(string); ok {
					system = append(system, t)
				}
			}
		case "user":
			blocks, err := oaContentBlocks(m.Content)
			if err != nil {
				return nil, err
			}
			push("user", blocks...)
		case "assistant":
			if hasTools && len(m.AnthropicContent) > 0 {
				var raw []json.RawMessage
				if err := json.Unmarshal(m.AnthropicContent, &raw); err != nil {
					return nil, errUnsupportedMessage
				}
				blocks := make([]any, len(raw))
				for i, b := range raw {
					blocks[i] = b
				}
				push("assistant", blocks...)
				continue
			}
			blocks, err := oaContentBlocks(m.Content)
			if err != nil {
				return nil, err
			}
			for _, tc := range m.ToolCalls {
				if !hasTools {
					// The Messages API refuses tool_use/tool_result history on a
					// request that defines no tools (tg-agent's final "reply in
					// plain text" call), so flatten the round to text. That also
					// drops every thinking block, which the API accepts.
					blocks = append(blocks, map[string]any{"type": "text", "text": "[called tool " + tc.Function.Name + " with " + tc.Function.Arguments + "]"})
					continue
				}
				input := json.RawMessage(tc.Function.Arguments)
				if !json.Valid(input) || !bytes.HasPrefix(bytes.TrimSpace(input), []byte("{")) {
					input = json.RawMessage(`{}`)
				}
				blocks = append(blocks, map[string]any{"type": "tool_use", "id": tc.ID, "name": tc.Function.Name, "input": input})
			}
			push("assistant", blocks...)
		case "tool":
			var text string
			if json.Unmarshal(m.Content, &text) != nil {
				text = string(m.Content)
			}
			if !hasTools {
				push("user", map[string]any{"type": "text", "text": "[tool result] " + text})
				continue
			}
			push("user", map[string]any{"type": "tool_result", "tool_use_id": m.ToolCallID, "content": text})
		default:
			return nil, errUnsupportedMessage
		}
	}

	req := map[string]any{
		"model":      model,
		"max_tokens": trialAnthropicMaxTokens,
		"messages":   out,
	}
	if len(system) > 0 {
		// One breakpoint on the system block caches tools+system (render
		// order is tools → system → messages): the stable prefix of every
		// tg-agent round.
		req["system"] = []any{map[string]any{
			"type": "text", "text": strings.Join(system, "\n\n"),
			"cache_control": map[string]string{"type": "ephemeral"},
		}}
	}
	if hasTools {
		ats := make([]any, len(tools))
		for i, t := range tools {
			schema := t.Function.Parameters
			if len(schema) == 0 || string(schema) == "null" {
				schema = json.RawMessage(`{"type":"object","properties":{}}`)
			}
			at := map[string]any{"name": t.Function.Name, "input_schema": schema}
			if t.Function.Description != "" {
				at["description"] = t.Function.Description
			}
			ats[i] = at
		}
		req["tools"] = ats
		var choice string
		if json.Unmarshal(payload["tool_choice"], &choice) == nil && choice == "none" {
			req["tool_choice"] = map[string]string{"type": "none"}
		}
	}
	if raw, ok := payload["response_format"]; ok {
		var rf struct {
			Type       string `json:"type"`
			JSONSchema struct {
				Schema json.RawMessage `json:"schema"`
			} `json:"json_schema"`
		}
		if json.Unmarshal(raw, &rf) == nil && rf.Type == "json_schema" && len(rf.JSONSchema.Schema) > 0 {
			req["output_config"] = map[string]any{"format": map[string]any{"type": "json_schema", "schema": rf.JSONSchema.Schema}}
		}
	}
	return req, nil
}

// anthropicResponse is the subset of a Messages API 200 we translate.
type anthropicResponse struct {
	ID         string            `json:"id"`
	Content    []json.RawMessage `json:"content"`
	StopReason string            `json:"stop_reason"`
	Usage      struct {
		InputTokens              int `json:"input_tokens"`
		OutputTokens             int `json:"output_tokens"`
		CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
		CacheReadInputTokens     int `json:"cache_read_input_tokens"`
	} `json:"usage"`
}

// fromAnthropicResponse builds the chat.completion body the client parses.
// The upstream "model" is never copied (SECURITY INVARIANT).
func fromAnthropicResponse(r anthropicResponse) map[string]any {
	var text strings.Builder
	var calls []any
	for _, raw := range r.Content {
		var b struct {
			Type  string          `json:"type"`
			Text  string          `json:"text"`
			ID    string          `json:"id"`
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
		}
		if json.Unmarshal(raw, &b) != nil {
			continue
		}
		switch b.Type {
		case "text":
			text.WriteString(b.Text)
		case "tool_use":
			args := string(b.Input)
			if args == "" {
				args = "{}"
			}
			calls = append(calls, map[string]any{
				"id": b.ID, "type": "function",
				"function": map[string]string{"name": b.Name, "arguments": args},
			})
		}
	}
	msg := map[string]any{"role": "assistant", "content": text.String()}
	if len(calls) > 0 {
		msg["tool_calls"] = calls
		msg["anthropic_content"] = r.Content
		if text.Len() == 0 {
			msg["content"] = nil
		}
	}
	finish := "stop"
	switch r.StopReason {
	case "max_tokens":
		finish = "length"
	case "tool_use":
		finish = "tool_calls"
	case "refusal":
		finish = "content_filter"
	}
	prompt := r.Usage.InputTokens + r.Usage.CacheCreationInputTokens + r.Usage.CacheReadInputTokens
	return map[string]any{
		"id":      r.ID,
		"object":  "chat.completion",
		"choices": []any{map[string]any{"index": 0, "message": msg, "finish_reason": finish}},
		"usage": map[string]int{
			"prompt_tokens":     prompt,
			"completion_tokens": r.Usage.OutputTokens,
			"total_tokens":      prompt + r.Usage.OutputTokens,
		},
	}
}

// anthropicRejectsSchema classifies a 400 body like upstreamRejectsSchema, but
// for the Messages API's terms. Credit exhaustion is also a 400 and must stay
// a plain trial failure, never a fenced-prompt retry.
func anthropicRejectsSchema(r io.Reader) bool {
	raw, err := io.ReadAll(io.LimitReader(r, maxTrialErrorSniffBytes))
	if err != nil || len(raw) == 0 {
		return false
	}
	body := strings.ToLower(string(raw))
	if strings.Contains(body, "credit balance") {
		return false
	}
	return strings.Contains(body, "output_config") || strings.Contains(body, "schema")
}

// anthropicChat runs one translated request. Gates (rate limit, budget,
// body cap, stream rejection) already ran in ChatCompletions.
func (a *TrialProxyAPI) anthropicChat(w http.ResponseWriter, r *http.Request, accountID string, payload map[string]json.RawMessage, vision bool) {
	model := a.cfg.AnthropicModel
	if vision {
		model = a.cfg.AnthropicVisionModel
	}
	areq, err := toAnthropicRequest(payload, model)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
		return
	}
	_, sentResponseFormat := areq["output_config"]
	upstreamBody, err := json.Marshal(areq)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), trialUpstreamTimout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.cfg.AnthropicURL+"/messages", bytes.NewReader(upstreamBody))
	if err != nil {
		// SECURITY INVARIANT: err embeds the URL — log a fixed string only.
		slog.Warn("trial chat proxy bad upstream url", "account", accountID, "provider", "anthropic")
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "upstream_error"})
		return
	}
	req.Header.Set("x-api-key", a.cfg.AnthropicAPIKey)
	req.Header.Set("anthropic-version", trialAnthropicVersion)
	req.Header.Set("Content-Type", "application/json")

	resp, err := a.client.Do(req)
	if err != nil {
		slog.Warn("trial chat proxy upstream failed", "account", accountID, "provider", "anthropic")
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "upstream_error"})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		slog.Info("trial chat proxy", "account", accountID, "provider", "anthropic", "status", resp.StatusCode)
		// Same sanitize-and-502 + upstream_status contract as the OpenAI path.
		errCode := "upstream_error"
		if resp.StatusCode == http.StatusBadRequest && sentResponseFormat && anthropicRejectsSchema(resp.Body) {
			errCode = "response_format_unsupported"
		}
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": errCode, "upstream_status": resp.StatusCode})
		return
	}
	var ar anthropicResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxTrialBodyBytes)).Decode(&ar); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "upstream_error"})
		return
	}
	slog.Info("trial chat proxy", "account", accountID, "provider", "anthropic", "status", resp.StatusCode,
		"stop_reason", ar.StopReason, "cache_read_tokens", ar.Usage.CacheReadInputTokens)
	writeJSON(w, http.StatusOK, fromAnthropicResponse(ar))
}
