package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"blitzcrank/internal/llm"
	"blitzcrank/internal/tools"
)

func (a *Agent) executeTool(ctx context.Context, req Request, call llm.ToolCall, policy tools.ToolPolicy) (any, error) {
	name := call.Function.Name
	if err := a.validateToolPolicy(req, name, policy); err != nil {
		return nil, err
	}
	args, err := parseToolArguments(req, call)
	if err != nil {
		return nil, err
	}
	a.applyRequestScopedToolDefaults(req, name, args)
	if err := validateMemoryToolAccess(req, name, args); err != nil {
		emitProgress(req, ProgressEvent{Phase: "tool_error", ToolName: name, Error: err.Error(), Message: "Memory access is not permitted for this requester."})
		return nil, err
	}
	if name == "sandbox_run_typescript" {
		if err := a.reviewSandboxTool(ctx, req, args, policy); err != nil {
			emitProgress(req, ProgressEvent{Phase: "tool_error", ToolName: name, Error: err.Error(), Message: "Sandbox review failed."})
			return nil, err
		}
	}
	if err := a.ensureToolApproved(ctx, req, name, args); err != nil {
		return nil, err
	}
	return a.callToolWithAudit(ctx, req, name, args)
}

func (a *Agent) validateToolPolicy(req Request, name string, policy tools.ToolPolicy) error {
	if policy.ReadOnly && a.registry.IsMutatingTool(name) && !a.registry.AllowedInReadOnly(name) {
		err := fmt.Errorf("tool %s is not permitted in read-only source policy", name)
		emitProgress(req, ProgressEvent{Phase: "tool_error", ToolName: name, Error: err.Error(), Message: "Tool is not permitted by the source policy."})
		return err
	}
	if !a.registry.ToolAllowedForPolicy(name, policy) {
		err := fmt.Errorf("tool %s is not available for selected capability set", name)
		emitProgress(req, ProgressEvent{Phase: "tool_error", ToolName: name, Error: err.Error(), Message: "Tool is not available for the selected capability set."})
		return err
	}
	return nil
}

func parseToolArguments(req Request, call llm.ToolCall) (map[string]any, error) {
	args := map[string]any{}
	if call.Function.Arguments == "" {
		return args, nil
	}
	if err := json.Unmarshal([]byte(call.Function.Arguments), &args); err != nil {
		log.Printf("agent tool call failed: name=%s parse_args=true arguments=%s error=%q", call.Function.Name, compactLogString(call.Function.Arguments, 512), err.Error())
		emitProgress(req, ProgressEvent{Phase: "tool_error", ToolName: call.Function.Name, Error: err.Error(), Message: "Tool arguments could not be parsed."})
		return nil, fmt.Errorf("parse tool arguments for %s: %w", call.Function.Name, err)
	}
	if args == nil {
		args = map[string]any{}
	}
	return args, nil
}

func (a *Agent) ensureToolApproved(ctx context.Context, req Request, name string, args map[string]any) error {
	if a.registry.RequiresApproval(name) {
		if req.ToolApproval == nil {
			err := fmt.Errorf("tool %s requires approval, but no approval callback is available", name)
			emitProgress(req, ProgressEvent{Phase: "tool_error", ToolName: name, Error: err.Error(), Message: "Tool requires approval, but approval is not available."})
			return err
		}
		emitProgress(req, ProgressEvent{Phase: "approval_wait", ToolName: name, Message: "Waiting for tool approval."})
		decision, err := req.ToolApproval(ctx, ToolApprovalRequest{
			Name:             name,
			Mutating:         a.registry.IsMutatingTool(name),
			Destructive:      a.registry.IsDestructiveTool(name),
			ArgumentsSummary: compactLogValue(args, 2000),
		})
		if err != nil {
			emitProgress(req, ProgressEvent{Phase: "approval_error", ToolName: name, Error: err.Error(), Message: "Tool approval failed."})
			emitProgress(req, ProgressEvent{Phase: "tool_error", ToolName: name, Error: err.Error(), Message: "Tool approval failed."})
			return err
		}
		if !decision.Approved {
			emitProgress(req, ProgressEvent{Phase: "approval_denied", ToolName: name, Message: "Tool approval was denied."})
			reason := strings.TrimSpace(decision.Reason)
			if reason == "" {
				reason = "tool call was denied"
			}
			if actor := strings.TrimSpace(decision.Actor); actor != "" {
				err := fmt.Errorf("%s by %s", reason, actor)
				emitProgress(req, ProgressEvent{Phase: "tool_error", ToolName: name, Error: err.Error(), Message: "Tool approval was denied."})
				return err
			}
			err := fmt.Errorf("%s", reason)
			emitProgress(req, ProgressEvent{Phase: "tool_error", ToolName: name, Error: err.Error(), Message: "Tool approval was denied."})
			return err
		}
		emitProgress(req, ProgressEvent{Phase: "approval_approved", ToolName: name, Message: "Tool approval was granted."})
	}
	return nil
}

func (a *Agent) callToolWithAudit(ctx context.Context, req Request, name string, args map[string]any) (any, error) {
	start := time.Now()
	log.Printf("agent tool call start: name=%s args=%s", name, compactLogValue(args, 512))
	emitProgress(req, ProgressEvent{Phase: "tool_start", ToolName: name, StartedAt: start.UTC(), Message: "Running tool."})
	result, err := a.registry.Call(ctx, name, args)
	completedAt := time.Now()
	if req.ToolAudit != nil {
		record := ToolAuditRecord{
			Name:             name,
			Mutating:         a.registry.IsMutatingTool(name),
			ArgumentsSummary: compactLogValue(args, 2000),
			StartedAt:        start.UTC(),
			CompletedAt:      completedAt.UTC(),
		}
		if err != nil {
			record.Error = compactToolError(name, err.Error())
		} else {
			record.ResultSummary = compactLogValue(result, 4000)
		}
		req.ToolAudit(record)
	}
	elapsed := completedAt.Sub(start).Round(time.Millisecond)
	if err != nil {
		log.Printf("agent tool call failed: name=%s duration=%s error=%q", name, elapsed, compactLogString(err.Error(), 1024))
		emitProgress(req, ProgressEvent{Phase: "tool_error", ToolName: name, StartedAt: start.UTC(), Duration: elapsed, Error: err.Error(), Message: "Tool returned an error."})
		return nil, err
	}
	log.Printf("agent tool call succeeded: name=%s duration=%s result=%s", name, elapsed, compactLogValue(result, 1024))
	emitProgress(req, ProgressEvent{Phase: "tool_done", ToolName: name, StartedAt: start.UTC(), Duration: elapsed, Message: "Tool finished."})
	return result, nil
}

func requestMessage(req Request) string {
	body := fmt.Sprintf("Source: %s\nAuthor: %s", req.Source, req.Author)
	if contextText := strings.TrimSpace(req.Context); contextText != "" {
		body += "\nContext:\n" + contextText
	}
	body += "\n\n" + req.Content
	return body
}

func (a *Agent) applyRequestScopedToolDefaults(req Request, toolName string, args map[string]any) {
	if strings.TrimSpace(req.SeerrUserID) == "" {
		return
	}
	switch toolName {
	case "seerr_get_user", "seerr_get_user_quota", "seerr_request_media":
		if strings.TrimSpace(toolArgString(args, "user_id")) == "" {
			args["user_id"] = req.SeerrUserID
		}
	}
}

func validateMemoryToolAccess(req Request, toolName string, args map[string]any) error {
	if !strings.HasPrefix(toolName, "memory_") || !requestAudienceIsRestricted(req) {
		return nil
	}
	if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(req.Source)), "discord") {
		return fmt.Errorf("memory tools are restricted for this non-admin audience")
	}
	authorID := strings.Trim(strings.TrimSpace(req.AuthorID), "/")
	if authorID == "" {
		return fmt.Errorf("memory tools require a Discord requester id for non-admin access")
	}
	scope := strings.TrimSpace(toolArgString(args, "scope"))
	if scope == "" {
		args["scope"] = "discord_user"
		scope = "discord_user"
	}
	if scope != "discord_user" {
		return fmt.Errorf("non-admin memory access is limited to the requester's own Discord user memory")
	}
	keyPrefix := strings.Trim(strings.TrimSpace(toolArgString(args, "key_prefix")), "/")
	key := strings.Trim(strings.TrimSpace(toolArgString(args, "key")), "/")
	switch toolName {
	case "memory_list":
		if keyPrefix == "" {
			args["key_prefix"] = authorID
			return nil
		}
		if keyPrefix == authorID || strings.HasPrefix(keyPrefix, authorID+"/") {
			return nil
		}
	case "memory_search":
		if keyPrefix == "" {
			args["key_prefix"] = authorID
			return nil
		}
		if keyPrefix == authorID || strings.HasPrefix(keyPrefix, authorID+"/") {
			return nil
		}
	case "memory_get", "memory_upsert", "memory_delete":
		if key == authorID || strings.HasPrefix(key, authorID+"/") {
			return nil
		}
	default:
		return nil
	}
	return fmt.Errorf("non-admin memory access is limited to key prefix %q", authorID)
}

func toolArgString(args map[string]any, key string) string {
	if args == nil {
		return ""
	}
	value, ok := args[key]
	if !ok || value == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(value))
}
