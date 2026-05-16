package webhook

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"time"

	"blitzcrank/internal/config"
	"blitzcrank/internal/harness"
)

type Server struct {
	cfg     config.Config
	harness *harness.Manager
	server  *http.Server
}

func NewServer(cfg config.Config, manager *harness.Manager) *Server {
	return &Server{cfg: cfg, harness: manager}
}

func (s *Server) Start(ctx context.Context) error {
	if s.cfg.SeerrWebhookListenAddr == "" {
		return nil
	}

	mux := http.NewServeMux()
	mux.HandleFunc(s.cfg.SeerrWebhookPath, s.handleSeerr)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	s.server = &http.Server{
		Addr:              s.cfg.SeerrWebhookListenAddr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = s.Shutdown(shutdownCtx)
	}()

	go func() {
		log.Printf("listening for Jellyseerr webhooks on http://%s%s", s.cfg.SeerrWebhookListenAddr, s.cfg.SeerrWebhookPath)
		if err := s.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("webhook server failed: %v", err)
		}
	}()

	return nil
}

func (s *Server) Shutdown(ctx context.Context) error {
	if s.server == nil {
		return nil
	}
	return s.server.Shutdown(ctx)
}

func (s *Server) handleSeerr(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	data, err := io.ReadAll(io.LimitReader(r.Body, 2<<20))
	if err != nil {
		http.Error(w, "read request", http.StatusBadRequest)
		return
	}

	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}

	go s.process(context.Background(), payload)
	w.WriteHeader(http.StatusAccepted)
}

func (s *Server) authorized(r *http.Request) bool {
	if s.cfg.SeerrWebhookSecret == "" {
		return true
	}
	if r.Header.Get("X-Blitzcrank-Webhook-Secret") == s.cfg.SeerrWebhookSecret {
		return true
	}
	return r.Header.Get("Authorization") == "Bearer "+s.cfg.SeerrWebhookSecret
}

func (s *Server) process(ctx context.Context, payload map[string]any) {
	result, err := s.harness.HandleWebhook(ctx, payload)
	if err != nil {
		log.Printf("jellyseerr issue workflow failed: issue=%s event=%s error=%v", result.IssueID, result.Event, err)
		return
	}
	if result.Ignored {
		log.Printf("jellyseerr webhook ignored: issue=%s event=%s reason=%s", result.IssueID, result.Event, result.Reason)
	}
}
