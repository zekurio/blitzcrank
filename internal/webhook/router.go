package webhook

import (
	"net/http"
	"strings"
)

type Router struct {
	mux *http.ServeMux
}

func NewRouter() *Router {
	return &Router{mux: http.NewServeMux()}
}

func (r *Router) Handle(method, pattern string, handler http.HandlerFunc) {
	method = strings.ToUpper(strings.TrimSpace(method))
	r.mux.HandleFunc(pattern, func(w http.ResponseWriter, req *http.Request) {
		if method != "" && req.Method != method {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		handler(w, req)
	})
}

func (r *Router) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	r.mux.ServeHTTP(w, req)
}

func noContent(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusNoContent)
}
