package webhook

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"blitzcrank/internal/automation"
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
		s.recordToolFailure(r.Header.Get("X-Blitzcrank-Thread-ID"), automation.ToolFailure{Tool: name, Error: err.Error()})
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
