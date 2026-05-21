package webhook

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"blitzcrank/internal/automation"
	"blitzcrank/internal/config"
	"blitzcrank/internal/harness"
)

type Server struct {
	cfg          config.Config
	harness      *harness.Manager
	server       *http.Server
	processCtx   context.Context
	cancel       context.CancelFunc
	wg           sync.WaitGroup
	shutdown     sync.Once
	done         chan struct{}
	err          error
	toolErrorsMu sync.Mutex
	toolErrors   map[string][]automation.ToolFailure
}

func NewServer(cfg config.Config, manager *harness.Manager) *Server {
	return &Server{cfg: cfg, harness: manager, done: make(chan struct{}), toolErrors: map[string][]automation.ToolFailure{}}
}

func (s *Server) ResetToolFailures(threadID string) {
	threadID = strings.TrimSpace(threadID)
	if threadID == "" {
		return
	}
	s.toolErrorsMu.Lock()
	defer s.toolErrorsMu.Unlock()
	delete(s.toolErrors, threadID)
}

func (s *Server) DrainToolFailures(threadID string) []automation.ToolFailure {
	threadID = strings.TrimSpace(threadID)
	if threadID == "" {
		return nil
	}
	s.toolErrorsMu.Lock()
	defer s.toolErrorsMu.Unlock()
	failures := append([]automation.ToolFailure(nil), s.toolErrors[threadID]...)
	delete(s.toolErrors, threadID)
	return failures
}

func (s *Server) recordToolFailure(threadID string, failure automation.ToolFailure) {
	threadID = strings.TrimSpace(threadID)
	if threadID == "" {
		return
	}
	s.toolErrorsMu.Lock()
	defer s.toolErrorsMu.Unlock()
	s.toolErrors[threadID] = append(s.toolErrors[threadID], failure)
}

func (s *Server) Start(ctx context.Context) error {
	listenAddr := s.listenAddr()
	if listenAddr == "" {
		return nil
	}
	processCtx, cancel := context.WithCancel(ctx)
	s.processCtx = processCtx
	s.cancel = cancel

	mux := NewRouter()
	mux.Handle("GET", "/healthz", noContent)
	if s.piToolGatewayEnabled() {
		mux.Handle("POST", "/internal/pi/tools/", s.handlePiTool)
	}
	if s.seerrWebhookEnabled() {
		mux.Handle("POST", s.cfg.SeerrWebhookPath, s.handleSeerr)
	}

	s.server = &http.Server{
		Addr:              listenAddr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	listener, err := net.Listen("tcp", listenAddr)
	if err != nil {
		cancel()
		return err
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := s.Shutdown(shutdownCtx); err != nil && !errors.Is(err, context.Canceled) {
			log.Printf("shutdown webhook server after context cancellation: %v", err)
		}
	}()

	go func() {
		log.Printf("listening for HTTP requests on http://%s", listenAddr)
		if err := s.server.Serve(listener); err != nil && err != http.ErrServerClosed {
			log.Printf("webhook server failed: %v", err)
		}
	}()

	return nil
}

func (s *Server) listenAddr() string {
	if strings.TrimSpace(s.cfg.HTTPListenAddr) != "" {
		return strings.TrimSpace(s.cfg.HTTPListenAddr)
	}
	return strings.TrimSpace(s.cfg.SeerrWebhookListenAddr)
}

func (s *Server) seerrWebhookEnabled() bool {
	return s.harness != nil && strings.TrimSpace(s.cfg.SeerrWebhookPath) != "" && strings.TrimSpace(s.cfg.SeerrBaseURL) != "" && strings.TrimSpace(s.cfg.SeerrAPIKey) != ""
}

func (s *Server) piToolGatewayEnabled() bool {
	return s.harness != nil && strings.TrimSpace(s.cfg.PiToolSecret) != ""
}

func (s *Server) Shutdown(ctx context.Context) error {
	s.shutdown.Do(func() {
		defer close(s.done)
		if s.cancel != nil {
			s.cancel()
		}
		if s.server == nil {
			return
		}
		if err := s.server.Shutdown(ctx); err != nil {
			s.err = err
			return
		}
		wait := make(chan struct{})
		go func() {
			defer close(wait)
			s.wg.Wait()
		}()
		select {
		case <-wait:
		case <-ctx.Done():
			s.err = ctx.Err()
		}
	})
	select {
	case <-s.done:
		return s.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Server) handleSeerr(w http.ResponseWriter, r *http.Request) {
	log.Printf("seerr webhook request: method=%s path=%s remote=%s content_length=%d user_agent=%q", r.Method, r.URL.Path, r.RemoteAddr, r.ContentLength, r.UserAgent())
	if r.Method != http.MethodPost {
		log.Printf("seerr webhook rejected: method=%s remote=%s reason=method_not_allowed", r.Method, r.RemoteAddr)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.authorized(r) {
		log.Printf("seerr webhook rejected: remote=%s reason=unauthorized auth_header=%t secret_header=%t", r.RemoteAddr, r.Header.Get("Authorization") != "", r.Header.Get("X-Blitzcrank-Webhook-Secret") != "")
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	data, err := io.ReadAll(io.LimitReader(r.Body, 2<<20))
	if err != nil {
		log.Printf("seerr webhook rejected: remote=%s reason=read_error error=%v", r.RemoteAddr, err)
		http.Error(w, "read request", http.StatusBadRequest)
		return
	}

	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil {
		log.Printf("seerr webhook rejected: remote=%s reason=invalid_json bytes=%d error=%v", r.RemoteAddr, len(data), err)
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}

	log.Printf("seerr webhook accepted: remote=%s bytes=%d notification=%q event=%q subject=%q issue_id=%q actor=%q", r.RemoteAddr, len(data), stringValue(payload, "notification_type"), stringValue(payload, "event"), stringValue(payload, "subject"), issueID(payload), actor(payload))
	processCtx := s.processCtx
	if processCtx == nil {
		processCtx = context.Background()
	}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		s.process(processCtx, payload)
	}()
	w.WriteHeader(http.StatusAccepted)
}

func (s *Server) authorized(r *http.Request) bool {
	if s.cfg.SeerrWebhookSecret == "" {
		return true
	}
	if constantTimeSecretEqual(r.Header.Get("X-Blitzcrank-Webhook-Secret"), s.cfg.SeerrWebhookSecret) {
		return true
	}
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	if !strings.HasPrefix(auth, "Bearer ") {
		return false
	}
	return constantTimeSecretEqual(strings.TrimSpace(strings.TrimPrefix(auth, "Bearer ")), s.cfg.SeerrWebhookSecret)
}

func constantTimeSecretEqual(candidate, secret string) bool {
	candidateHash := sha256.Sum256([]byte(candidate))
	secretHash := sha256.Sum256([]byte(secret))
	return hmac.Equal(candidateHash[:], secretHash[:])
}

func (s *Server) process(ctx context.Context, payload map[string]any) {
	result, err := s.harness.HandleWebhook(ctx, payload)
	if err != nil {
		log.Printf("seerr issue workflow failed: issue=%s event=%s error=%v", result.IssueID, result.Event, err)
		return
	}
	if result.Ignored {
		log.Printf("seerr webhook ignored: issue=%s event=%s reason=%s", result.IssueID, result.Event, result.Reason)
		return
	}
	log.Printf("seerr webhook processed: issue=%s event=%s", result.IssueID, result.Event)
}

func section(payload map[string]any, name string) map[string]any {
	value, _ := payload[name].(map[string]any)
	if value == nil {
		return map[string]any{}
	}
	return value
}

func stringValue(payload map[string]any, key string) string {
	value, _ := payload[key].(string)
	return strings.TrimSpace(value)
}

func issueID(payload map[string]any) string {
	return stringValue(section(payload, "issue"), "issue_id")
}

func actor(payload map[string]any) string {
	for _, candidate := range []struct {
		section string
		key     string
	}{
		{"comment", "commentedBy_username"},
		{"issue", "reportedBy_username"},
		{"request", "requestedBy_username"},
	} {
		if value := stringValue(section(payload, candidate.section), candidate.key); value != "" {
			return value
		}
	}
	return ""
}
