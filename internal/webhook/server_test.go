package webhook

import (
	"net/http"
	"net/http/httptest"
	"testing"
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
