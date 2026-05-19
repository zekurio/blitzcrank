package codex

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"blitzcrank/internal/config"
	"blitzcrank/internal/llm/api"
)

func TestFromResponsesResponseToolCall(t *testing.T) {
	data := []byte(`{
		"output": [
			{"type":"function_call","call_id":"call_1","name":"seerr_get_issue","arguments":"{\"issue_id\":\"42\"}"}
		]
	}`)
	response, err := fromResponsesResponse(data)
	if err != nil {
		t.Fatalf("fromResponsesResponse() error = %v", err)
	}
	choice := response.FirstChoice()
	if len(choice.Message.ToolCalls) != 1 {
		t.Fatalf("tool calls = %d, want 1", len(choice.Message.ToolCalls))
	}
	if choice.Message.ToolCalls[0].Function.Name != "seerr_get_issue" {
		t.Fatalf("tool name = %q", choice.Message.ToolCalls[0].Function.Name)
	}
}

func TestToResponsesRequestConvertsToolOutput(t *testing.T) {
	toolCall := api.ToolCall{ID: "call_1", Type: "function"}
	toolCall.Function.Name = "seerr_get_issue"
	toolCall.Function.Arguments = `{"issue_id":"42"}`
	request := toResponsesRequest(api.ChatRequest{
		Model: "gpt-test",
		Messages: []api.Message{
			{Role: "system", Content: "system prompt"},
			{Role: "user", Content: "hi"},
			{Role: "assistant", ToolCalls: []api.ToolCall{toolCall}},
			{Role: "tool", ToolCallID: "call_1", Content: `{"ok":true}`},
		},
	}, false)
	if request["instructions"] != "system prompt" {
		t.Fatalf("instructions = %v, want system prompt", request["instructions"])
	}
	if request["store"] != false {
		t.Fatalf("store = %v, want false", request["store"])
	}
	if request["stream"] != true {
		t.Fatalf("stream = %v, want true", request["stream"])
	}
	input := request["input"].([]any)
	if len(input) != 3 {
		t.Fatalf("input len = %d, want 3", len(input))
	}
	functionCall := input[1].(map[string]any)
	if functionCall["type"] != "function_call" {
		t.Fatalf("type = %v, want function_call", functionCall["type"])
	}
	if functionCall["call_id"] != "call_1" {
		t.Fatalf("call_id = %v", functionCall["call_id"])
	}
	if functionCall["name"] != "seerr_get_issue" {
		t.Fatalf("name = %v", functionCall["name"])
	}
	toolOutput := input[2].(map[string]any)
	if toolOutput["type"] != "function_call_output" {
		t.Fatalf("type = %v, want function_call_output", toolOutput["type"])
	}
	if toolOutput["call_id"] != "call_1" {
		t.Fatalf("call_id = %v", toolOutput["call_id"])
	}
}

func TestFromResponsesStreamUsesCompletedResponse(t *testing.T) {
	stream := strings.NewReader("event: response.completed\n" +
		"data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"done\"}]}]}}\n\n" +
		"data: [DONE]\n\n")
	response, err := fromResponsesStream(stream)
	if err != nil {
		t.Fatalf("fromResponsesStream() error = %v", err)
	}
	if got := response.FirstChoice().Message.Content; got != "done" {
		t.Fatalf("content = %q, want done", got)
	}
}

func TestFromResponsesStreamFallsBackToStreamedOutputItem(t *testing.T) {
	stream := strings.NewReader("event: response.output_item.done\n" +
		"data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"seerr_get_issue\",\"arguments\":\"{\\\"issue_id\\\":\\\"42\\\"}\"}}\n\n" +
		"event: response.completed\n" +
		"data: {\"type\":\"response.completed\",\"response\":{\"output\":[]}}\n\n" +
		"data: [DONE]\n\n")
	response, err := fromResponsesStream(stream)
	if err != nil {
		t.Fatalf("fromResponsesStream() error = %v", err)
	}
	choice := response.FirstChoice()
	if len(choice.Message.ToolCalls) != 1 {
		t.Fatalf("tool calls = %d, want 1", len(choice.Message.ToolCalls))
	}
	if choice.Message.ToolCalls[0].Function.Name != "seerr_get_issue" {
		t.Fatalf("tool name = %q", choice.Message.ToolCalls[0].Function.Name)
	}
}

func TestFromResponsesStreamFallsBackToTextDeltas(t *testing.T) {
	stream := strings.NewReader("event: response.output_text.delta\n" +
		"data: {\"type\":\"response.output_text.delta\",\"delta\":\"Test \"}\n\n" +
		"event: response.output_text.delta\n" +
		"data: {\"type\":\"response.output_text.delta\",\"delta\":\"erfolgreich\"}\n\n" +
		"event: response.completed\n" +
		"data: {\"type\":\"response.completed\",\"response\":{\"output\":[]}}\n\n" +
		"data: [DONE]\n\n")
	response, err := fromResponsesStream(stream)
	if err != nil {
		t.Fatalf("fromResponsesStream() error = %v", err)
	}
	if got := response.FirstChoice().Message.Content; got != "Test erfolgreich" {
		t.Fatalf("content = %q, want Test erfolgreich", got)
	}
}

func TestToResponsesRequestAddsFastServiceTier(t *testing.T) {
	request := toResponsesRequest(api.ChatRequest{
		Model:    "gpt-test",
		Messages: []api.Message{{Role: "user", Content: "hi"}},
	}, true)
	if request["service_tier"] != "priority" {
		t.Fatalf("service_tier = %v, want priority", request["service_tier"])
	}
}

func TestToResponsesRequestAddsParallelToolCalls(t *testing.T) {
	request := toResponsesRequest(api.ChatRequest{
		Model:             "gpt-test",
		Messages:          []api.Message{{Role: "user", Content: "hi"}},
		ParallelToolCalls: true,
	}, false)
	if request["parallel_tool_calls"] != true {
		t.Fatalf("parallel_tool_calls = %v, want true", request["parallel_tool_calls"])
	}
}

func TestToResponsesRequestAddsReasoningEffort(t *testing.T) {
	request := toResponsesRequest(api.ChatRequest{
		Model:           "gpt-test",
		ReasoningEffort: "high",
		Messages:        []api.Message{{Role: "user", Content: "hi"}},
	}, false)
	reasoning := request["reasoning"].(map[string]any)
	if reasoning["effort"] != "high" {
		t.Fatalf("reasoning effort = %v, want high", reasoning["effort"])
	}
}

func TestToResponsesRequestOmitsEmptyReasoningEffort(t *testing.T) {
	request := toResponsesRequest(api.ChatRequest{
		Model:    "gpt-test",
		Messages: []api.Message{{Role: "user", Content: "hi"}},
	}, false)
	if _, ok := request["reasoning"]; ok {
		t.Fatalf("request unexpectedly included reasoning: %#v", request)
	}
}

func TestToResponsesRequestPassesNoneReasoningEffort(t *testing.T) {
	request := toResponsesRequest(api.ChatRequest{
		Model:           "gpt-test",
		ReasoningEffort: "none",
		Messages:        []api.Message{{Role: "user", Content: "hi"}},
	}, false)
	reasoning := request["reasoning"].(map[string]any)
	if reasoning["effort"] != "none" {
		t.Fatalf("reasoning effort = %v, want none", reasoning["effort"])
	}
}

func TestCodexChatNon2xxReturnsProviderError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "60")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":{"code":429,"message":"rate limited"}}`))
	}))
	defer server.Close()

	cfg := config.Config{
		CodexAuthProfile: "default",
		CodexAuthStore:   t.TempDir() + "/auth.json",
		CodexBaseURL:     server.URL,
	}
	if err := saveCodexCredential(cfg, CodexCredential{
		AccessToken:  "access",
		RefreshToken: "refresh",
		ExpiresAt:    time.Now().Add(time.Hour),
		UpdatedAt:    time.Now(),
	}); err != nil {
		t.Fatalf("saveCodexCredential() error = %v", err)
	}
	client, err := New(cfg)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	_, err = client.Chat(context.Background(), api.ChatRequest{
		Model:    "gpt-test",
		Messages: []api.Message{{Role: "user", Content: "hi"}},
	})
	var providerErr *api.ProviderError
	if !errors.As(err, &providerErr) {
		t.Fatalf("error = %T %v, want *api.ProviderError", err, err)
	}
	if providerErr.Provider != "codex-oauth" || providerErr.Kind != api.ErrorKindRateLimited || providerErr.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("provider error = %#v", providerErr)
	}
	if providerErr.RetryAfter != time.Minute {
		t.Fatalf("RetryAfter = %v, want 1m", providerErr.RetryAfter)
	}
}
