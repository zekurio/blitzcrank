package llm

import "blitzcrank/internal/llm/api"

type Client = api.Client
type ChatRequest = api.ChatRequest
type Message = api.Message
type ToolCall = api.ToolCall
type ChatResponse = api.ChatResponse

type ErrorKind = api.ErrorKind
type ProviderError = api.ProviderError

const (
	ErrorKindUnknown             = api.ErrorKindUnknown
	ErrorKindInvalidRequest      = api.ErrorKindInvalidRequest
	ErrorKindUnauthorized        = api.ErrorKindUnauthorized
	ErrorKindInsufficientCredits = api.ErrorKindInsufficientCredits
	ErrorKindForbidden           = api.ErrorKindForbidden
	ErrorKindTimeout             = api.ErrorKindTimeout
	ErrorKindRateLimited         = api.ErrorKindRateLimited
	ErrorKindProviderUnavailable = api.ErrorKindProviderUnavailable
)
