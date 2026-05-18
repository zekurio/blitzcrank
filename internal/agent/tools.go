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
	if policy.ReadOnly && a.registry.IsMutatingTool(call.Function.Name) && !a.registry.AllowedInReadOnly(call.Function.Name) {
		err := fmt.Errorf("tool %s is not permitted in read-only source policy", call.Function.Name)
		emitProgress(req, ProgressEvent{Phase: "tool_error", ToolName: call.Function.Name, Error: err.Error(), Message: "Tool is not permitted by the source policy."})
		return nil, err
	}
	if !a.registry.ToolAllowedForPolicy(call.Function.Name, policy) {
		err := fmt.Errorf("tool %s is not available for selected capability set", call.Function.Name)
		emitProgress(req, ProgressEvent{Phase: "tool_error", ToolName: call.Function.Name, Error: err.Error(), Message: "Tool is not available for the selected capability set."})
		return nil, err
	}
	var args map[string]any
	if call.Function.Arguments != "" {
		if err := json.Unmarshal([]byte(call.Function.Arguments), &args); err != nil {
			log.Printf("agent tool call failed: name=%s parse_args=true arguments=%s error=%q", call.Function.Name, compactLogString(call.Function.Arguments, 512), err.Error())
			emitProgress(req, ProgressEvent{Phase: "tool_error", ToolName: call.Function.Name, Error: err.Error(), Message: "Tool arguments could not be parsed."})
			return nil, fmt.Errorf("parse tool arguments for %s: %w", call.Function.Name, err)
		}
	}
	if args == nil {
		args = map[string]any{}
	}
	a.applyRequestScopedToolDefaults(req, call.Function.Name, args)
	if call.Function.Name == "sandbox_run_typescript" {
		if err := a.reviewSandboxTool(ctx, req, args, policy); err != nil {
			emitProgress(req, ProgressEvent{Phase: "tool_error", ToolName: call.Function.Name, Error: err.Error(), Message: "Sandbox review failed."})
			return nil, err
		}
	}
	if a.registry.RequiresApproval(call.Function.Name) {
		if req.ToolApproval == nil {
			err := fmt.Errorf("tool %s requires approval, but no approval callback is available", call.Function.Name)
			emitProgress(req, ProgressEvent{Phase: "tool_error", ToolName: call.Function.Name, Error: err.Error(), Message: "Tool requires approval, but approval is not available."})
			return nil, err
		}
		emitProgress(req, ProgressEvent{Phase: "approval_wait", ToolName: call.Function.Name, Message: "Waiting for tool approval."})
		decision, err := req.ToolApproval(ctx, ToolApprovalRequest{
			Name:             call.Function.Name,
			Mutating:         a.registry.IsMutatingTool(call.Function.Name),
			Destructive:      a.registry.IsDestructiveTool(call.Function.Name),
			ArgumentsSummary: compactLogValue(args, 2000),
		})
		if err != nil {
			emitProgress(req, ProgressEvent{Phase: "approval_error", ToolName: call.Function.Name, Error: err.Error(), Message: "Tool approval failed."})
			emitProgress(req, ProgressEvent{Phase: "tool_error", ToolName: call.Function.Name, Error: err.Error(), Message: "Tool approval failed."})
			return nil, err
		}
		if !decision.Approved {
			emitProgress(req, ProgressEvent{Phase: "approval_denied", ToolName: call.Function.Name, Message: "Tool approval was denied."})
			reason := strings.TrimSpace(decision.Reason)
			if reason == "" {
				reason = "tool call was denied"
			}
			if actor := strings.TrimSpace(decision.Actor); actor != "" {
				err := fmt.Errorf("%s by %s", reason, actor)
				emitProgress(req, ProgressEvent{Phase: "tool_error", ToolName: call.Function.Name, Error: err.Error(), Message: "Tool approval was denied."})
				return nil, err
			}
			err := fmt.Errorf("%s", reason)
			emitProgress(req, ProgressEvent{Phase: "tool_error", ToolName: call.Function.Name, Error: err.Error(), Message: "Tool approval was denied."})
			return nil, err
		}
		emitProgress(req, ProgressEvent{Phase: "approval_approved", ToolName: call.Function.Name, Message: "Tool approval was granted."})
	}
	start := time.Now()
	log.Printf("agent tool call start: name=%s args=%s", call.Function.Name, compactLogValue(args, 512))
	emitProgress(req, ProgressEvent{Phase: "tool_start", ToolName: call.Function.Name, StartedAt: start.UTC(), Message: "Running tool."})
	result, err := a.registry.Call(ctx, call.Function.Name, args)
	completedAt := time.Now()
	if req.ToolAudit != nil {
		record := ToolAuditRecord{
			Name:             call.Function.Name,
			Mutating:         a.registry.IsMutatingTool(call.Function.Name),
			ArgumentsSummary: compactLogValue(args, 2000),
			StartedAt:        start.UTC(),
			CompletedAt:      completedAt.UTC(),
		}
		if err != nil {
			record.Error = compactToolError(call.Function.Name, err.Error())
		} else {
			record.ResultSummary = compactLogValue(result, 4000)
		}
		req.ToolAudit(record)
	}
	elapsed := completedAt.Sub(start).Round(time.Millisecond)
	if err != nil {
		log.Printf("agent tool call failed: name=%s duration=%s error=%q", call.Function.Name, elapsed, compactLogString(err.Error(), 1024))
		emitProgress(req, ProgressEvent{Phase: "tool_error", ToolName: call.Function.Name, StartedAt: start.UTC(), Duration: elapsed, Error: err.Error(), Message: "Tool returned an error."})
		return nil, err
	}
	log.Printf("agent tool call succeeded: name=%s duration=%s result=%s", call.Function.Name, elapsed, compactLogValue(result, 1024))
	emitProgress(req, ProgressEvent{Phase: "tool_done", ToolName: call.Function.Name, StartedAt: start.UTC(), Duration: elapsed, Message: "Tool finished."})
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
