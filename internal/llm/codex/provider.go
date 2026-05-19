package codex

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"blitzcrank/internal/config"
	"blitzcrank/internal/llm/api"
	"blitzcrank/internal/llm/chatcompletions"
)

type CodexOAuth struct {
	cfg     config.Config
	baseURL string
	http    *http.Client
}

func New(cfg config.Config) (*CodexOAuth, error) {
	if _, err := loadCodexCredential(cfg); err != nil {
		return nil, err
	}
	return &CodexOAuth{
		cfg:     cfg,
		baseURL: strings.TrimRight(cfg.CodexBaseURL, "/"),
		http: &http.Client{
			Timeout: 90 * time.Second,
		},
	}, nil
}

func (c *CodexOAuth) Chat(ctx context.Context, request api.ChatRequest) (api.ChatResponse, error) {
	cred, err := loadCodexCredential(c.cfg)
	if err != nil {
		return api.ChatResponse{}, err
	}
	if time.Until(cred.ExpiresAt) < codexRefreshSkew {
		cred, err = refreshCodexCredential(ctx, c.cfg, cred)
		if err != nil {
			return api.ChatResponse{}, err
		}
	}

	body, err := json.Marshal(toResponsesRequest(request, c.cfg.CodexFast))
	if err != nil {
		return api.ChatResponse{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/responses", bytes.NewReader(body))
	if err != nil {
		return api.ChatResponse{}, err
	}
	req.Header.Set("Authorization", "Bearer "+cred.AccessToken)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "blitzcrank")
	req.Header.Set("originator", "blitzcrank")
	if cred.AccountID != "" {
		req.Header.Set("ChatGPT-Account-Id", cred.AccountID)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return api.ChatResponse{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		if err != nil {
			return api.ChatResponse{}, err
		}
		return api.ChatResponse{}, api.ProviderErrorFromHTTP("codex-oauth", resp.StatusCode, resp.Header, data)
	}
	return fromResponsesStream(io.LimitReader(resp.Body, 32<<20))
}

func toResponsesRequest(request api.ChatRequest, fast bool) map[string]any {
	input := make([]any, 0, len(request.Messages))
	var instructions []string
	for _, message := range request.Messages {
		if message.Role == "system" {
			if strings.TrimSpace(message.Content) != "" {
				instructions = append(instructions, strings.TrimSpace(message.Content))
			}
			continue
		}
		if message.Role == "tool" {
			input = append(input, map[string]any{
				"type":    "function_call_output",
				"call_id": message.ToolCallID,
				"output":  message.Content,
			})
			continue
		}
		if message.Role == "assistant" && len(message.ToolCalls) > 0 {
			if strings.TrimSpace(message.Content) != "" {
				input = append(input, map[string]any{
					"role":    message.Role,
					"content": message.Content,
				})
			}
			for _, call := range message.ToolCalls {
				input = append(input, map[string]any{
					"type":      "function_call",
					"call_id":   call.ID,
					"name":      call.Function.Name,
					"arguments": call.Function.Arguments,
				})
			}
			continue
		}
		input = append(input, map[string]any{
			"role":    message.Role,
			"content": message.Content,
		})
	}

	tools := make([]any, 0, len(request.Tools))
	for _, raw := range request.Tools {
		tool, ok := raw.(map[string]any)
		if !ok {
			tools = append(tools, raw)
			continue
		}
		fn, _ := tool["function"].(map[string]any)
		if tool["type"] == "function" && fn != nil {
			tools = append(tools, map[string]any{
				"type":        "function",
				"name":        fn["name"],
				"description": fn["description"],
				"parameters":  fn["parameters"],
			})
			continue
		}
		tools = append(tools, raw)
	}

	payload := map[string]any{
		"model":  request.Model,
		"input":  input,
		"tools":  tools,
		"store":  false,
		"stream": true,
	}
	if request.ParallelToolCalls {
		payload["parallel_tool_calls"] = true
	}
	if fast {
		payload["service_tier"] = "priority"
	}
	if len(instructions) > 0 {
		payload["instructions"] = strings.Join(instructions, "\n\n")
	}
	if effort := chatcompletions.ReasoningEffortForWire(request.ReasoningEffort); effort != "" {
		payload["reasoning"] = map[string]any{"effort": effort}
	}
	return payload
}

func fromResponsesStream(r io.Reader) (api.ChatResponse, error) {
	var completed []byte
	var streamedOutput []json.RawMessage
	var streamedText []string
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 8<<20)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" || data == "[DONE]" {
			continue
		}
		var event struct {
			Type     string          `json:"type"`
			Response json.RawMessage `json:"response"`
			Item     json.RawMessage `json:"item"`
			Delta    string          `json:"delta"`
		}
		if err := json.Unmarshal([]byte(data), &event); err != nil {
			continue
		}
		switch event.Type {
		case "response.output_item.done":
			if len(event.Item) > 0 {
				streamedOutput = append(streamedOutput, event.Item)
			}
		case "response.output_text.delta":
			if event.Delta != "" {
				streamedText = append(streamedText, event.Delta)
			}
		case "response.completed":
			if len(event.Response) > 0 {
				completed = event.Response
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return api.ChatResponse{}, err
	}
	if len(completed) > 0 {
		response, err := fromResponsesResponse(completed)
		if err != nil {
			return api.ChatResponse{}, err
		}
		choice := response.FirstChoice()
		if strings.TrimSpace(choice.Message.Content) != "" || len(choice.Message.ToolCalls) > 0 {
			return response, nil
		}
	}
	if len(streamedOutput) > 0 {
		data, err := json.Marshal(struct {
			Output []json.RawMessage `json:"output"`
		}{Output: streamedOutput})
		if err != nil {
			return api.ChatResponse{}, err
		}
		response, err := fromResponsesResponse(data)
		if err != nil {
			return api.ChatResponse{}, err
		}
		choice := response.FirstChoice()
		if strings.TrimSpace(choice.Message.Content) != "" || len(choice.Message.ToolCalls) > 0 {
			return response, nil
		}
	}
	if len(streamedText) > 0 {
		message := api.Message{
			Role:    "assistant",
			Content: strings.TrimSpace(strings.Join(streamedText, "")),
		}
		return api.ChatResponse{Choices: []struct {
			Message api.Message `json:"message"`
		}{{Message: message}}}, nil
	}
	if len(completed) == 0 {
		return api.ChatResponse{}, fmt.Errorf("codex responses stream ended without response.completed")
	}
	return api.ChatResponse{}, fmt.Errorf("codex responses completed without assistant output")
}

func fromResponsesResponse(data []byte) (api.ChatResponse, error) {
	var raw struct {
		Output []struct {
			Type      string `json:"type"`
			ID        string `json:"id"`
			CallID    string `json:"call_id"`
			Name      string `json:"name"`
			Arguments string `json:"arguments"`
			Content   []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"output"`
		OutputText string `json:"output_text"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return api.ChatResponse{}, err
	}

	message := api.Message{Role: "assistant"}
	var text []string
	for _, item := range raw.Output {
		switch item.Type {
		case "message":
			for _, content := range item.Content {
				if content.Text != "" {
					text = append(text, content.Text)
				}
			}
		case "function_call":
			var call api.ToolCall
			call.ID = item.CallID
			if call.ID == "" {
				call.ID = item.ID
			}
			call.Type = "function"
			call.Function.Name = item.Name
			call.Function.Arguments = item.Arguments
			message.ToolCalls = append(message.ToolCalls, call)
		}
	}
	if len(text) == 0 && raw.OutputText != "" {
		text = append(text, raw.OutputText)
	}
	message.Content = strings.TrimSpace(strings.Join(text, "\n\n"))

	var response api.ChatResponse
	response.Choices = append(response.Choices, struct {
		Message api.Message `json:"message"`
	}{Message: message})
	return response, nil
}
