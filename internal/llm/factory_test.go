package llm

import (
	"strings"
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
	toolCall := ToolCall{ID: "call_1", Type: "function"}
	toolCall.Function.Name = "seerr_get_issue"
	toolCall.Function.Arguments = `{"issue_id":"42"}`
	request := toResponsesRequest(ChatRequest{
		Model: "gpt-test",
		Messages: []Message{
			{Role: "system", Content: "system prompt"},
			{Role: "user", Content: "hi"},
			{Role: "assistant", ToolCalls: []ToolCall{toolCall}},
			{Role: "tool", ToolCallID: "call_1", Content: `{"ok":true}`},
		},
	}, "standard")
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
