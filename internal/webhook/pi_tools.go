package webhook

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"
)

type piToolRequest struct {
	Arguments map[string]any `json:"arguments"`
}

func (s *Server) handlePiTool(w http.ResponseWriter, r *http.Request) {
	if !s.authorizedPiTool(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/internal/pi/tools/")
	name = strings.Trim(name, "/")
	if name == "" || strings.Contains(name, "/") {
		http.Error(w, "invalid tool name", http.StatusBadRequest)
		return
	}
	var request piToolRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20)).Decode(&request); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if request.Arguments == nil {
		request.Arguments = map[string]any{}
	}
	result, err := s.harness.CallTool(r.Context(), name, request.Arguments)
	response := map[string]any{"ok": err == nil, "result": result}
	if err != nil {
		response["error"] = err.Error()
		log.Printf("pi tool gateway failed: tool=%s error=%v", name, err)
		if reporter := s.currentToolErrorReporter(); reporter != nil {
			threadID := strings.TrimSpace(r.Header.Get("X-Blitzcrank-Thread-ID"))
			if threadID != "" {
				go func() {
					ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
					defer cancel()
					if reportErr := reporter.PiToolFailed(ctx, threadID, name, err.Error()); reportErr != nil {
						log.Printf("pi tool gateway error report failed: tool=%s thread_id=%s error=%v", name, threadID, reportErr)
					}
				}()
			}
		}
	}
	w.Header().Set("Content-Type", "application/json")
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
	}
	_ = json.NewEncoder(w).Encode(response)
}

func (s *Server) authorizedPiTool(r *http.Request) bool {
	secret := strings.TrimSpace(s.cfg.PiToolSecret)
	if secret == "" {
		return false
	}
	return constantTimeSecretEqual(r.Header.Get("X-Blitzcrank-Tool-Secret"), secret)
}
