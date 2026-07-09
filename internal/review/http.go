package review

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
)

const maxBrokerRequestBytes = 256 * 1024

func (b *Broker) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/reviews", b.handleReview)
	mux.HandleFunc("POST /v1/approvals/consume", b.handleConsume)
	mux.HandleFunc("POST /v1/mutations/execution", b.handleExecution)
	mux.HandleFunc("POST /v1/observations", b.handleObservation)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if !requestFromLoopback(r) {
			writeError(w, http.StatusForbidden, "loopback access required")
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (b *Broker) handleReview(w http.ResponseWriter, r *http.Request) {
	token, ok := b.bearerRunToken(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "invalid review authorization")
		return
	}
	var proposal Proposal
	if err := decodeBrokerJSON(w, r, &proposal); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	decision, err := b.review(r.Context(), token, proposal)
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, ErrUnauthorized) {
			status = http.StatusUnauthorized
		}
		writeError(w, status, safeHTTPError(err))
		return
	}
	writeJSON(w, http.StatusOK, decision)
}

func (b *Broker) handleConsume(w http.ResponseWriter, r *http.Request) {
	token, ok := b.bearerRunToken(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "invalid review authorization")
		return
	}
	var request struct {
		ApprovalToken string   `json:"approval_token"`
		Proposal      Proposal `json:"proposal"`
	}
	if err := decodeBrokerJSON(w, r, &request); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(request.ApprovalToken) == "" {
		writeError(w, http.StatusBadRequest, "approval_token is required")
		return
	}
	if err := b.consume(token, request.ApprovalToken, request.Proposal); err != nil {
		status := http.StatusForbidden
		if errors.Is(err, ErrApprovalBinding) {
			status = http.StatusConflict
		}
		writeError(w, status, safeHTTPError(err))
		return
	}
	hash, err := b.hashForRun(token, request.Proposal)
	if err != nil {
		writeError(w, http.StatusForbidden, "review authorization expired")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"authorized": true, "proposal_hash": hash})
}

func (b *Broker) handleObservation(w http.ResponseWriter, r *http.Request) {
	token, ok := b.bearerRunToken(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "invalid review authorization")
		return
	}
	var request struct {
		ProposalHash string `json:"proposal_hash"`
		Service      string `json:"service"`
		Path         string `json:"path"`
		Outcome      string `json:"outcome"`
	}
	if err := decodeBrokerJSON(w, r, &request); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := b.RecordValidation(token, request.ProposalHash, request.Service, request.Path, request.Outcome); err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, ErrUnauthorized) {
			status = http.StatusUnauthorized
		}
		writeError(w, status, safeHTTPError(err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"recorded": true})
}

func (b *Broker) handleExecution(w http.ResponseWriter, r *http.Request) {
	token, ok := b.bearerRunToken(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "invalid review authorization")
		return
	}
	var request struct {
		ProposalHash      string   `json:"proposal_hash"`
		Status            string   `json:"status"`
		ValidationTargets []string `json:"validation_targets"`
	}
	if err := decodeBrokerJSON(w, r, &request); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := b.RecordExecution(token, request.ProposalHash, request.Status, request.ValidationTargets); err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, ErrUnauthorized) {
			status = http.StatusUnauthorized
		}
		writeError(w, status, safeHTTPError(err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"recorded": true})
}

func (b *Broker) bearerRunToken(r *http.Request) (string, bool) {
	header := strings.TrimSpace(r.Header.Get("Authorization"))
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return "", false
	}
	token := strings.TrimSpace(strings.TrimPrefix(header, prefix))
	if token == "" {
		return "", false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.pruneLocked(b.now())
	_, ok := b.runs[token]
	return token, ok
}

func (b *Broker) hashForRun(token string, proposal Proposal) (string, error) {
	normalized, err := normalizeProposal(proposal)
	if err != nil {
		return "", err
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.pruneLocked(b.now())
	run, ok := b.runs[token]
	if !ok {
		return "", ErrUnauthorized
	}
	return bindingHash(run.context, normalized), nil
}

func decodeBrokerJSON(w http.ResponseWriter, r *http.Request, target any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxBrokerRequestBytes)
	defer r.Body.Close()
	decoder := json.NewDecoder(r.Body)
	decoder.UseNumber()
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("decode request JSON: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return fmt.Errorf("request contains multiple JSON values")
		}
		return fmt.Errorf("decode request JSON trailer: %w", err)
	}
	return nil
}

func requestFromLoopback(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func safeHTTPError(err error) string {
	switch {
	case errors.Is(err, ErrUnauthorized):
		return "invalid review authorization"
	case errors.Is(err, ErrApprovalBinding):
		return "approved proposal binding does not match"
	case errors.Is(err, ErrBudgetExceeded):
		return "mutation budget exhausted"
	case errors.Is(err, ErrForbidden):
		return "mutation forbidden by deterministic policy"
	default:
		return "mutation review request failed"
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
