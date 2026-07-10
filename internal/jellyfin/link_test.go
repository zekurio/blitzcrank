package jellyfin

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"blitzcrank/internal/digest"
	"blitzcrank/internal/store"
)

func TestLinkServicePersistsOnlyUserIdentity(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/Users/AuthenticateByName":
			_, _ = w.Write([]byte(`{"User":{"Id":"jellyfin-user"},"AccessToken":"temporary"}`))
		case "/Sessions/Logout":
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	client, err := NewClient(server.URL, "admin", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	repository, err := store.Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer repository.Close()
	links, err := NewLinkService(client, repository)
	if err != nil {
		t.Fatal(err)
	}
	subscriber := digest.Subscriber{GuildID: "guild", UserID: "discord-user"}
	invalidations := 0
	links.SetProfileInvalidator(func(subjectID string) {
		invalidations++
		if subjectID != subscriber.RecommendationSubjectID() {
			t.Errorf("invalidated subject = %q", subjectID)
		}
	})
	if err := links.Link(context.Background(), subscriber, "alice", "secret-password"); err != nil {
		t.Fatalf("Link() error = %v", err)
	}
	link, ok, err := repository.LoadJellyfinUserLink(context.Background(), "guild", "discord-user")
	if err != nil || !ok {
		t.Fatalf("LoadJellyfinUserLink() = ok %v, error %v", ok, err)
	}
	if link.JellyfinUserID != "jellyfin-user" {
		t.Fatalf("link = %#v", link)
	}
	if err := links.Unlink(context.Background(), subscriber); err != nil {
		t.Fatalf("Unlink() error = %v", err)
	}
	if linked, err := links.LinkStatus(context.Background(), subscriber); err != nil || linked {
		t.Fatalf("LinkStatus() = %v, %v", linked, err)
	}
	if invalidations != 2 {
		t.Fatalf("profile invalidations = %d, want 2", invalidations)
	}
}

func TestNewLinkServiceRejectsPasswordAuthenticationOverNetworkHTTP(t *testing.T) {
	client, err := NewClient("http://192.0.2.1:8096", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	repository, err := store.Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer repository.Close()
	if _, err := NewLinkService(client, repository); !errors.Is(err, ErrInsecureTransport) {
		t.Fatalf("NewLinkService() error = %v", err)
	}
}

func TestLinkServiceRateLimitsFailedAuthentication(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/Users/AuthenticateByName" {
			http.NotFound(w, r)
			return
		}
		requests++
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()
	client, err := NewClient(server.URL, "admin", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	repository, err := store.Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer repository.Close()
	links, err := NewLinkService(client, repository)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, time.July, 10, 12, 0, 0, 0, time.UTC)
	links.now = func() time.Time { return now }
	subscriber := digest.Subscriber{GuildID: "guild", UserID: "discord-user"}
	for range maxLinkAttempts {
		if err := links.Link(context.Background(), subscriber, "alice", "wrong"); !errors.Is(err, ErrInvalidCredentials) {
			t.Fatalf("Link() error = %v, want invalid credentials", err)
		}
	}
	if err := links.Link(context.Background(), subscriber, "alice", "wrong"); !errors.Is(err, ErrLinkRateLimited) {
		t.Fatalf("rate-limited Link() error = %v", err)
	}
	if requests != maxLinkAttempts {
		t.Fatalf("authentication requests = %d, want %d", requests, maxLinkAttempts)
	}
	now = now.Add(linkAttemptWindow + time.Second)
	if err := links.Link(context.Background(), subscriber, "alice", "wrong"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("Link() after window error = %v", err)
	}
	if requests != maxLinkAttempts+1 {
		t.Fatalf("authentication requests after window = %d", requests)
	}
}

func TestProfileSourceBuildsSeenKeysAndGenreWeights(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"Items":[
			{"Type":"Movie","Genres":["Science Fiction","Drama"],"ProviderIds":{"Tmdb":"123"}},
			{"Type":"Series","Genres":["Science Fiction"],"ProviderIds":{"TMDB":"456"}}
		]}`))
	}))
	defer server.Close()
	client, err := NewClient(server.URL, "admin", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	repository, err := store.Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer repository.Close()
	if err := repository.UpsertJellyfinUserLink(context.Background(), store.JellyfinUserLink{
		GuildID: "guild", DiscordUserID: "discord-user", JellyfinUserID: "jellyfin-user",
		LinkedAt: time.Date(2026, time.July, 10, 12, 0, 0, 0, time.UTC), UpdatedAt: time.Date(2026, time.July, 10, 12, 0, 0, 0, time.UTC),
	}); err != nil {
		t.Fatal(err)
	}
	source, err := NewProfileSource(client, repository, 100)
	if err != nil {
		t.Fatal(err)
	}
	profile, err := source.Profile(context.Background(), digest.Subscriber{GuildID: "guild", UserID: "discord-user"}.RecommendationSubjectID())
	if err != nil {
		t.Fatalf("Profile() error = %v", err)
	}
	seen := map[string]bool{}
	for _, key := range profile.SeenMediaKeys {
		seen[key] = true
	}
	if !seen["tmdb:movie:123"] || !seen["tmdb:tv:456"] {
		t.Fatalf("seen keys = %#v", profile.SeenMediaKeys)
	}
	if profile.GenreWeights["science fiction"] <= profile.GenreWeights["drama"] {
		t.Fatalf("genre weights = %#v", profile.GenreWeights)
	}
}
