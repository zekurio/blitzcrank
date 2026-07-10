package discord

import (
	"bytes"
	"testing"
	"time"

	"blitzcrank/internal/digest"
)

func TestDigestDraftStoreScopesClonesAndExpiresDrafts(t *testing.T) {
	now := time.Date(2026, time.July, 10, 12, 0, 0, 0, time.UTC)
	store := newDigestDraftStore()
	store.now = func() time.Time { return now }
	store.ttl = time.Minute
	store.random = bytes.NewReader(make([]byte, 16))
	subscriber := digest.Subscriber{GuildID: "guild", UserID: "alice"}
	input := digest.SubscriptionInput{
		Topics:       []digest.Topic{digest.TopicAnimeSeasons},
		ReleaseKinds: []digest.ReleaseKind{digest.ReleaseKindOnline},
		Interests:    []string{"Mystery"},
	}
	nonce, ok := store.create(digestDraft{Kind: digestDraftCreate, Subscriber: subscriber, Locale: "de", Input: input})
	if !ok || len(nonce) != 32 {
		t.Fatalf("create() = %q, %v", nonce, ok)
	}
	input.Topics[0] = digest.TopicMovieReleases
	loaded, ok := store.load(nonce, subscriber)
	if !ok || loaded.Locale != "de" || loaded.Input.Topics[0] != digest.TopicAnimeSeasons {
		t.Fatalf("load() = %#v, %v", loaded, ok)
	}
	loaded.Input.Interests[0] = "changed"
	reloaded, ok := store.load(nonce, subscriber)
	if !ok || reloaded.Input.Interests[0] != "Mystery" {
		t.Fatalf("draft aliases caller memory: %#v", reloaded)
	}
	if _, ok := store.load(nonce, digest.Subscriber{GuildID: "guild", UserID: "mallory"}); ok {
		t.Fatal("foreign user loaded a draft")
	}
	if _, ok := store.load(nonce, digest.Subscriber{GuildID: "other", UserID: "alice"}); ok {
		t.Fatal("foreign guild loaded a draft")
	}
	now = now.Add(time.Minute)
	if _, ok := store.load(nonce, subscriber); ok {
		t.Fatal("expired draft was returned")
	}
}

func TestDigestDraftStoreUpdateRefreshesTTLAndKeepsOwnership(t *testing.T) {
	now := time.Date(2026, time.July, 10, 12, 0, 0, 0, time.UTC)
	store := newDigestDraftStore()
	store.now = func() time.Time { return now }
	store.ttl = time.Minute
	store.random = bytes.NewReader(bytes.Repeat([]byte{1}, 16))
	subscriber := digest.Subscriber{GuildID: "guild", UserID: "alice"}
	nonce, ok := store.create(digestDraft{Kind: digestDraftManage, Subscriber: subscriber, Locale: "en-US"})
	if !ok {
		t.Fatal("create() failed")
	}
	now = now.Add(30 * time.Second)
	draft, ok := store.update(nonce, subscriber, func(draft *digestDraft) bool {
		draft.SubscriptionID = 42
		return true
	})
	if !ok || draft.SubscriptionID != 42 || !draft.ExpiresAt.Equal(now.Add(time.Minute)) {
		t.Fatalf("update() = %#v, %v", draft, ok)
	}
	if _, ok := store.update(nonce, digest.Subscriber{GuildID: "guild", UserID: "mallory"}, func(*digestDraft) bool { return true }); ok {
		t.Fatal("foreign update succeeded")
	}
	now = now.Add(31 * time.Second)
	if _, ok := store.load(nonce, subscriber); !ok {
		t.Fatal("updated draft expired at its original deadline")
	}
}

func TestDigestDraftStoreRejectsUnscopedDraft(t *testing.T) {
	store := newDigestDraftStore()
	if _, ok := store.create(digestDraft{Subscriber: digest.Subscriber{UserID: "alice"}}); ok {
		t.Fatal("draft without guild scope was accepted")
	}
	if _, ok := store.create(digestDraft{Subscriber: digest.Subscriber{GuildID: "guild"}}); ok {
		t.Fatal("draft without user scope was accepted")
	}
}
