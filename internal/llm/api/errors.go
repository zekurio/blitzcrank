package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type ErrorKind string

const (
	ErrorKindUnknown             ErrorKind = "unknown"
	ErrorKindInvalidRequest      ErrorKind = "invalid_request"
	ErrorKindUnauthorized        ErrorKind = "unauthorized"
	ErrorKindInsufficientCredits ErrorKind = "insufficient_credits"
	ErrorKindForbidden           ErrorKind = "forbidden"
	ErrorKindTimeout             ErrorKind = "timeout"
	ErrorKindRateLimited         ErrorKind = "rate_limited"
	ErrorKindProviderUnavailable ErrorKind = "provider_unavailable"
)

type ProviderError struct {
	Provider   string
	Kind       ErrorKind
	StatusCode int
	Code       string
	Message    string
	RetryAfter time.Duration
	Body       string
}

func (e *ProviderError) Error() string {
	provider := strings.TrimSpace(e.Provider)
	if provider == "" {
		provider = "llm"
	}
	message := strings.TrimSpace(e.Message)
	if message == "" {
		message = strings.TrimSpace(e.Body)
	}
	if message == "" {
		message = "request failed"
	}
	if e.StatusCode > 0 {
		return fmt.Sprintf("%s failed: status=%d kind=%s code=%s: %s", provider, e.StatusCode, e.Kind, nonEmptyString(e.Code, "unknown"), message)
	}
	return fmt.Sprintf("%s failed: kind=%s code=%s: %s", provider, e.Kind, nonEmptyString(e.Code, "unknown"), message)
}

func (e *ProviderError) Temporary() bool {
	switch e.Kind {
	case ErrorKindTimeout, ErrorKindRateLimited, ErrorKindProviderUnavailable:
		return true
	default:
		return false
	}
}

type ErrorEnvelope struct {
	Error *struct {
		Code    any    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func ProviderErrorFromHTTP(provider string, statusCode int, headers http.Header, body []byte) *ProviderError {
	return ProviderErrorFromEnvelope(provider, statusCode, headers, body)
}

func ProviderErrorFromEnvelope(provider string, statusCode int, headers http.Header, body []byte) *ProviderError {
	code := ""
	message := strings.TrimSpace(string(body))
	var envelope ErrorEnvelope
	if err := json.Unmarshal(body, &envelope); err == nil && envelope.Error != nil {
		code = anyToString(envelope.Error.Code)
		if strings.TrimSpace(envelope.Error.Message) != "" {
			message = strings.TrimSpace(envelope.Error.Message)
		}
	}
	if code == "" && statusCode > 0 {
		code = strconv.Itoa(statusCode)
	}
	return &ProviderError{
		Provider:   provider,
		Kind:       classifyProviderError(statusCode, code, message),
		StatusCode: statusCode,
		Code:       code,
		Message:    message,
		RetryAfter: parseRetryAfter(headers.Get("Retry-After")),
		Body:       compactErrorBody(body),
	}
}

func classifyProviderError(statusCode int, code, message string) ErrorKind {
	lower := strings.ToLower(strings.TrimSpace(code + " " + message))
	switch {
	case statusCode == http.StatusBadRequest:
		return ErrorKindInvalidRequest
	case statusCode == http.StatusUnauthorized:
		return ErrorKindUnauthorized
	case statusCode == http.StatusPaymentRequired:
		return ErrorKindInsufficientCredits
	case statusCode == http.StatusForbidden:
		return ErrorKindForbidden
	case statusCode == http.StatusRequestTimeout || strings.Contains(lower, "timeout"):
		return ErrorKindTimeout
	case statusCode == http.StatusTooManyRequests || strings.Contains(lower, "rate"):
		return ErrorKindRateLimited
	case statusCode == http.StatusBadGateway || statusCode == http.StatusServiceUnavailable || strings.Contains(lower, "provider") || strings.Contains(lower, "unavailable"):
		return ErrorKindProviderUnavailable
	default:
		return ErrorKindUnknown
	}
}

func parseRetryAfter(value string) time.Duration {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	if seconds, err := strconv.Atoi(value); err == nil && seconds > 0 {
		return time.Duration(seconds) * time.Second
	}
	if when, err := http.ParseTime(value); err == nil {
		if delay := time.Until(when); delay > 0 {
			return delay
		}
	}
	return 0
}

func compactErrorBody(body []byte) string {
	const limit = 4096
	text := strings.TrimSpace(string(body))
	if len(text) > limit {
		return text[:limit] + "..."
	}
	return text
}

func anyToString(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return v
	case float64:
		if v == float64(int64(v)) {
			return strconv.FormatInt(int64(v), 10)
		}
		return strconv.FormatFloat(v, 'f', -1, 64)
	default:
		return fmt.Sprint(v)
	}
}

func nonEmptyString(value, fallback string) string {
	if strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	return fallback
}
