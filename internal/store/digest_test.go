package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"blitzcrank/internal/digest"
)

func TestDigestSubscriptionRoundTrip(t *testing.T) {
	ctx := context.Background()
	state, err := Open(ctx, filepath.Join(t.TempDir(), "state.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	now := time.Now().UTC().Truncate(time.Second)
	next := now.Add(time.Hour)
	created, err := state.CreateDigestSubscription(ctx, digest.Subscription{
		Subscriber: digest.Subscriber{GuildID: "guild", UserID: "user"}, Topics: []digest.Topic{digest.TopicMovies, digest.TopicShows},
		Cadence: digest.CadenceWeekly, Schedule: "0 18 * * 5", Weekday: time.Friday, TimeOfDay: "18:00", Timezone: "Europe/Vienna", Locale: "de-AT",
		Enabled: true, NextRunAt: &next, CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	loaded, ok, err := state.LoadDigestSubscription(ctx, created.Subscriber, created.ID)
	if err != nil || !ok {
		t.Fatalf("loaded = %#v, ok = %v, error = %v", loaded, ok, err)
	}
	if len(loaded.Topics) != 2 || loaded.Topics[0] != digest.TopicMovies && loaded.Topics[0] != digest.TopicShows || loaded.Cadence != digest.CadenceWeekly {
		t.Fatalf("loaded = %#v", loaded)
	}
}
