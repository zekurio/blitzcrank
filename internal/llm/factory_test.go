package llm

import (
	"testing"

	"blitzcrank/internal/config"
)

func TestFactoryOpenAICompatibleAliases(t *testing.T) {
	for _, provider := range []string{"", ProviderOpenAICompatible, "api-key", "openrouter"} {
		client, err := New(config.Config{
			LLMProvider:   provider,
			OpenAIBaseURL: "https://example.test/v1",
			OpenAIAPIKey:  "key",
		})
		if err != nil {
			t.Fatalf("New(%q) error = %v", provider, err)
		}
		if _, ok := client.(*OpenAICompatible); !ok {
			t.Fatalf("New(%q) type = %T, want *OpenAICompatible", provider, client)
		}
	}
}

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
	request := toResponsesRequest(ChatRequest{
		Model: "gpt-test",
		Messages: []Message{
			{Role: "system", Content: "system prompt"},
			{Role: "user", Content: "hi"},
			{Role: "tool", ToolCallID: "call_1", Content: `{"ok":true}`},
		},
	}, "standard")
	if request["instructions"] != "system prompt" {
		t.Fatalf("instructions = %v, want system prompt", request["instructions"])
	}
	if request["store"] != false {
		t.Fatalf("store = %v, want false", request["store"])
	}
	input := request["input"].([]any)
	if len(input) != 2 {
		t.Fatalf("input len = %d, want 2", len(input))
	}
	toolOutput := input[1].(map[string]any)
	if toolOutput["type"] != "function_call_output" {
		t.Fatalf("type = %v, want function_call_output", toolOutput["type"])
	}
	if toolOutput["call_id"] != "call_1" {
		t.Fatalf("call_id = %v", toolOutput["call_id"])
	}
}

func TestToResponsesRequestAddsFastServiceTier(t *testing.T) {
	request := toResponsesRequest(ChatRequest{
		Model:    "gpt-test",
		Messages: []Message{{Role: "user", Content: "hi"}},
	}, "fast")
	if request["service_tier"] != "fast" {
		t.Fatalf("service_tier = %v, want fast", request["service_tier"])
	}
}

func TestToResponsesRequestAddsReasoningEffort(t *testing.T) {
	request := toResponsesRequest(ChatRequest{
		Model:           "gpt-test",
		ReasoningEffort: "high",
		Messages:        []Message{{Role: "user", Content: "hi"}},
	}, "standard")
	reasoning := request["reasoning"].(map[string]any)
	if reasoning["effort"] != "high" {
		t.Fatalf("reasoning effort = %v, want high", reasoning["effort"])
	}
}
