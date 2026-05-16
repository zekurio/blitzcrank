package llm

import "context"

type Client interface {
	Chat(ctx context.Context, request ChatRequest) (ChatResponse, error)
}

type ChatRequest struct {
	Model           string    `json:"model"`
	ReasoningEffort string    `json:"reasoning_effort,omitempty"`
	Messages        []Message `json:"messages"`
	Tools           []any     `json:"tools,omitempty"`
}

type Message struct {
	Role       string     `json:"role"`
	Content    string     `json:"content,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
}

type ToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type ChatResponse struct {
	Choices []struct {
		Message Message `json:"message"`
	} `json:"choices"`
}

func (r ChatResponse) FirstChoice() struct {
	Message Message `json:"message"`
} {
	return r.Choices[0]
}
