package jellyfin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestAuthenticateUserByNameLogsOutTemporarySession(t *testing.T) {
	var mu sync.Mutex
	var authenticated, loggedOut bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch r.URL.Path {
		case "/Users/AuthenticateByName":
			authenticated = true
			if !strings.Contains(r.Header.Get("Authorization"), `Client="Blitzcrank"`) || strings.Contains(r.Header.Get("Authorization"), "secret-password") {
				t.Errorf("authentication Authorization = %q", r.Header.Get("Authorization"))
			}
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body["Username"] != "alice" || body["Pw"] != "secret-password" {
				t.Errorf("authentication body = %#v", body)
			}
			_, _ = w.Write([]byte(`{"User":{"Id":"user-42"},"AccessToken":"temporary-token"}`))
		case "/Sessions/Logout":
			loggedOut = true
			if !strings.Contains(r.Header.Get("Authorization"), `Token="temporary-token"`) {
				t.Errorf("logout Authorization = %q", r.Header.Get("Authorization"))
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "admin-key", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	user, err := client.AuthenticateUserByName(context.Background(), " alice ", "secret-password")
	if err != nil {
		t.Fatalf("AuthenticateUserByName() error = %v", err)
	}
	if user.ID != "user-42" || !authenticated || !loggedOut {
		t.Fatalf("result = %#v, authenticated=%v loggedOut=%v", user, authenticated, loggedOut)
	}
}

func TestAuthenticateUserByNameHidesCredentialFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`invalid password secret-password`))
	}))
	defer server.Close()
	client, err := NewClient(server.URL, "", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.AuthenticateUserByName(context.Background(), "alice", "secret-password")
	if !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("AuthenticateUserByName() error = %v", err)
	}
	if strings.Contains(err.Error(), "secret-password") || strings.Contains(err.Error(), "alice") {
		t.Fatalf("error leaked credentials: %v", err)
	}
}

func TestNewClientRejectsServiceCredentialOverNetworkHTTP(t *testing.T) {
	if _, err := NewClient("http://192.0.2.1:8096", "admin-key", nil); !errors.Is(err, ErrInsecureTransport) {
		t.Fatalf("NewClient() error = %v", err)
	}
	if _, err := NewClient("http://127.0.0.1:8096", "admin-key", nil); err != nil {
		t.Fatalf("NewClient(loopback) error = %v", err)
	}
}

func TestWatchedItemsUsesAdminCredentialAndUserScope(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/Items" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("X-Emby-Token") != "admin-key" {
			t.Errorf("X-Emby-Token = %q", r.Header.Get("X-Emby-Token"))
		}
		if r.URL.Query().Get("UserId") != "user-42" || r.URL.Query().Get("IsPlayed") != "true" {
			t.Errorf("query = %s", r.URL.RawQuery)
		}
		_, _ = w.Write([]byte(`{"Items":[{"Type":"Movie","Genres":["Science Fiction"],"ProviderIds":{"Tmdb":"123"}}]}`))
	}))
	defer server.Close()
	client, err := NewClient(server.URL, "admin-key", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	items, err := client.WatchedItems(context.Background(), "user-42", 100)
	if err != nil {
		t.Fatalf("WatchedItems() error = %v", err)
	}
	if len(items) != 1 || items[0].ProviderIDs["Tmdb"] != "123" || items[0].Genres[0] != "Science Fiction" {
		t.Fatalf("WatchedItems() = %#v", items)
	}
}
