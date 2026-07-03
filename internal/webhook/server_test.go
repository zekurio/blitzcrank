package webhook

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"blitzcrank/internal/config"
)

func TestRouterRejectsWrongMethod(t *testing.T) {
	router := NewRouter()
	router.Handle("GET", "/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodPost, "/healthz", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}
}

func TestIsLoopbackAddr(t *testing.T) {
	cases := []struct {
		addr string
		want bool
	}{
		{"127.0.0.1:8080", true},
		{"localhost:8080", true},
		{"[::1]:8080", true},
		{":8080", false},
		{"0.0.0.0:8080", false},
		{"192.168.1.5:8080", false},
	}
	for _, tc := range cases {
		if got := isLoopbackAddr(tc.addr); got != tc.want {
			t.Errorf("isLoopbackAddr(%q) = %v, want %v", tc.addr, got, tc.want)
		}
	}
}

func TestAcquireRunSlot(t *testing.T) {
	s := NewServer(config.Config{MaxConcurrentRuns: 1}, nil)

	release1, ok := s.acquireRunSlot(context.Background())
	if !ok {
		t.Fatalf("first acquire: ok = false, want true")
	}

	cancelledCtx, cancel := context.WithCancel(context.Background())
	cancel()
	_, ok = s.acquireRunSlot(cancelledCtx)
	if ok {
		t.Fatalf("second acquire with cancelled context: ok = true, want false")
	}

	release1()

	release3, ok := s.acquireRunSlot(context.Background())
	if !ok {
		t.Fatalf("third acquire after release: ok = false, want true")
	}
	release3()
}
