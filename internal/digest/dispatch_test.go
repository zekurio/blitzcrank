package digest_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"blitzcrank/internal/digest"
	"blitzcrank/internal/recommendation"
	"blitzcrank/internal/store"
)

type recommenderFunc func(context.Context, recommendation.Query) (recommendation.Result, error)

func (f recommenderFunc) Recommend(ctx context.Context, query recommendation.Query) (recommendation.Result, error) {
	return f(ctx, query)
}

type recordingDigestSender struct {
	mu       sync.Mutex
	contents []digest.Content
	err      error
}

type cancelOnLoadRepository struct {
	*store.Store
	cancel context.CancelFunc
	once   sync.Once
}

func (r *cancelOnLoadRepository) LoadDigestSubscription(ctx context.Context, subscriber digest.Subscriber, subscriptionID int64) (digest.Subscription, bool, error) {
	subscription, ok, err := r.Store.LoadDigestSubscription(ctx, subscriber, subscriptionID)
	if err == nil {
		r.once.Do(r.cancel)
	}
	return subscription, ok, err
}

func (s *recordingDigestSender) SendDigest(_ context.Context, _ digest.Subscription, content digest.Content) (digest.SendResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return digest.SendResult{}, s.err
	}
	s.contents = append(s.contents, content)
	return digest.SendResult{DiscordChannelID: "dm", DiscordMessageID: "message"}, nil
}

func dueSubscription(t *testing.T, repository *store.Store, subscriber digest.Subscriber, due time.Time) digest.Subscription {
	t.Helper()
	created, err := repository.CreateDigestSubscription(context.Background(), digest.Subscription{
		Subscriber:   subscriber,
		Topics:       []digest.Topic{digest.TopicAnimeSeasons, digest.TopicShowPremieres, digest.TopicMovieReleases},
		ReleaseKinds: []digest.ReleaseKind{digest.ReleaseKindOnline, digest.ReleaseKindPhysical, digest.ReleaseKindCinema},
		Cadence:      digest.CadenceDaily,
		Schedule:     "0 18 * * *",
		Weekday:      time.Friday,
		TimeOfDay:    "18:00",
		Region:       "AT",
		Timezone:     "Europe/Vienna",
		Locale:       "de",
		Interests:    []string{"Science Fiction"},
		Enabled:      true,
		NextRunAt:    &due,
		CreatedAt:    due.Add(-time.Hour),
		UpdatedAt:    due.Add(-time.Hour),
	})
	if err != nil {
		t.Fatalf("CreateDigestSubscription() error = %v", err)
	}
	return created
}

func TestDispatchDueSendsAndDeduplicatesRecommendations(t *testing.T) {
	ctx := context.Background()
	repository, err := store.Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer repository.Close()
	service, err := digest.NewService(repository, "AT", "Europe/Vienna")
	if err != nil {
		t.Fatal(err)
	}
	var queries []recommendation.Query
	recommender := recommenderFunc(func(_ context.Context, query recommendation.Query) (recommendation.Result, error) {
		queries = append(queries, query)
		return recommendation.Result{Items: []recommendation.Candidate{{
			MediaKey:    "tmdb:movie:42",
			EventKey:    "tmdb:movie:42:digital:AT:2026-07-11",
			MediaType:   recommendation.MediaTypeMovie,
			ReleaseKind: recommendation.ReleaseKindDigital,
			Title:       "Example",
			ReleaseAt:   query.Window.Start.Add(time.Hour),
			Source:      "tmdb",
		}}}, nil
	})
	if err := service.ConfigureRecommendations(recommender, 12, 15*time.Minute); err != nil {
		t.Fatal(err)
	}
	subscriber := digest.Subscriber{GuildID: "guild", UserID: "user"}
	due := time.Now().UTC().Add(-time.Minute).Truncate(time.Second)
	subscription := dueSubscription(t, repository, subscriber, due)
	sender := &recordingDigestSender{}

	stats, err := service.DispatchDue(ctx, sender, 100)
	if err != nil {
		t.Fatalf("DispatchDue() error = %v", err)
	}
	if stats.Sent != 1 || stats.Claimed != 1 || len(sender.contents) != 1 {
		t.Fatalf("stats = %#v, sends = %d", stats, len(sender.contents))
	}
	if len(queries) != 1 || queries[0].SubjectID != "guild:user" || queries[0].Region != "AT" || queries[0].Interests["Science Fiction"] != 3 {
		t.Fatalf("query = %#v", queries)
	}
	if queries[0].Window.Start.Hour() != 0 || queries[0].Window.Start.Location() != time.UTC || queries[0].Window.End.Sub(queries[0].Window.Start) < 24*time.Hour {
		t.Fatalf("release-date window = %#v", queries[0].Window)
	}
	if delivery, ok, err := repository.LoadDigestDelivery(ctx, 1); err != nil || !ok || delivery.Status != store.DigestDeliverySent || delivery.DiscordMessageID != "message" {
		t.Fatalf("delivery = %#v, ok %v, error %v", delivery, ok, err)
	}

	secondDue := time.Now().UTC().Add(-time.Second).Truncate(time.Second)
	if err := repository.SetDigestSubscriptionEnabled(ctx, subscriber, subscription.ID, true, &secondDue, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	stats, err = service.DispatchDue(ctx, sender, 100)
	if err != nil {
		t.Fatalf("second DispatchDue() error = %v", err)
	}
	if stats.Empty != 1 || len(sender.contents) != 1 {
		t.Fatalf("second stats = %#v, sends = %d", stats, len(sender.contents))
	}
}

func TestDispatchDueRetriesCatalogFailureWithoutSending(t *testing.T) {
	ctx := context.Background()
	repository, err := store.Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer repository.Close()
	service, err := digest.NewService(repository, "US", "UTC")
	if err != nil {
		t.Fatal(err)
	}
	if err := service.ConfigureRecommendations(recommenderFunc(func(context.Context, recommendation.Query) (recommendation.Result, error) {
		return recommendation.Result{}, errors.New("catalog offline")
	}), 10, 10*time.Minute); err != nil {
		t.Fatal(err)
	}
	subscriber := digest.Subscriber{GuildID: "guild", UserID: "user"}
	due := time.Now().UTC().Add(-time.Minute).Truncate(time.Second)
	subscription := dueSubscription(t, repository, subscriber, due)
	sender := &recordingDigestSender{}
	started := time.Now().UTC()
	stats, err := service.DispatchDue(ctx, sender, 100)
	if err == nil {
		t.Fatal("DispatchDue() error = nil")
	}
	if stats.Failed != 1 || len(sender.contents) != 0 {
		t.Fatalf("stats = %#v, sends = %d", stats, len(sender.contents))
	}
	loaded, ok, err := repository.LoadDigestSubscription(ctx, subscriber, subscription.ID)
	if err != nil || !ok || loaded.NextRunAt == nil {
		t.Fatalf("LoadDigestSubscription() = %#v, ok %v, error %v", loaded, ok, err)
	}
	if loaded.NextRunAt.Before(started.Add(9*time.Minute)) || loaded.NextRunAt.After(started.Add(11*time.Minute)) {
		t.Fatalf("retry NextRunAt = %s", loaded.NextRunAt)
	}
}

func TestDispatchDueCompletesClaimAfterContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	repository, err := store.Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer repository.Close()
	service, err := digest.NewService(repository, "US", "UTC")
	if err != nil {
		t.Fatal(err)
	}
	if err := service.ConfigureRecommendations(recommenderFunc(func(ctx context.Context, _ recommendation.Query) (recommendation.Result, error) {
		cancel()
		return recommendation.Result{}, ctx.Err()
	}), 10, 10*time.Minute); err != nil {
		t.Fatal(err)
	}
	subscriber := digest.Subscriber{GuildID: "guild", UserID: "user"}
	due := time.Now().UTC().Add(-time.Minute).Truncate(time.Second)
	dueSubscription(t, repository, subscriber, due)

	stats, err := service.DispatchDue(ctx, &recordingDigestSender{}, 100)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("DispatchDue() error = %v, want context cancellation", err)
	}
	if stats.Failed != 1 {
		t.Fatalf("stats = %#v", stats)
	}
	delivery, ok, err := repository.LoadDigestDelivery(context.Background(), 1)
	if err != nil || !ok {
		t.Fatalf("LoadDigestDelivery() = %#v, %v, %v", delivery, ok, err)
	}
	if delivery.Status != store.DigestDeliveryFailed || delivery.CompletedAt == nil {
		t.Fatalf("delivery after cancellation = %#v", delivery)
	}
}

func TestDispatchDueBasesRetryOnCompletionTime(t *testing.T) {
	ctx := context.Background()
	repository, err := store.Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer repository.Close()
	service, err := digest.NewService(repository, "US", "UTC")
	if err != nil {
		t.Fatal(err)
	}
	if err := service.ConfigureRecommendations(recommenderFunc(func(context.Context, recommendation.Query) (recommendation.Result, error) {
		return recommendation.Result{}, errors.New("catalog offline")
	}), 10, time.Nanosecond); err != nil {
		t.Fatal(err)
	}
	subscriber := digest.Subscriber{GuildID: "guild", UserID: "user"}
	due := time.Now().UTC().Add(-time.Minute).Truncate(time.Second)
	subscription := dueSubscription(t, repository, subscriber, due)

	stats, err := service.DispatchDue(ctx, &recordingDigestSender{}, 100)
	if err == nil || stats.Failed != 1 {
		t.Fatalf("DispatchDue() = %#v, %v", stats, err)
	}
	delivery, ok, err := repository.LoadDigestDelivery(ctx, 1)
	if err != nil || !ok || delivery.CompletedAt == nil || delivery.Status != store.DigestDeliveryFailed {
		t.Fatalf("delivery = %#v, ok %v, error %v", delivery, ok, err)
	}
	loaded, ok, err := repository.LoadDigestSubscription(ctx, subscriber, subscription.ID)
	if err != nil || !ok || loaded.NextRunAt == nil {
		t.Fatalf("LoadDigestSubscription() = %#v, ok %v, error %v", loaded, ok, err)
	}
	if !loaded.NextRunAt.After(*delivery.CompletedAt) {
		t.Fatalf("retry NextRunAt = %s, completion = %s", loaded.NextRunAt, delivery.CompletedAt)
	}
}

func TestDispatchDueDistinguishesProfileAndReleaseWarnings(t *testing.T) {
	tests := []struct {
		name       string
		source     string
		wantStatus string
		wantError  bool
	}{
		{name: "optional profile", source: "profile", wantStatus: store.DigestDeliveryEmpty},
		{name: "release catalog", source: "tmdb", wantStatus: store.DigestDeliveryFailed, wantError: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			repository, err := store.Open(ctx, ":memory:")
			if err != nil {
				t.Fatal(err)
			}
			defer repository.Close()
			service, err := digest.NewService(repository, "US", "UTC")
			if err != nil {
				t.Fatal(err)
			}
			if err := service.ConfigureRecommendations(recommenderFunc(func(context.Context, recommendation.Query) (recommendation.Result, error) {
				return recommendation.Result{Warnings: []recommendation.Warning{{Source: test.source, Message: "unavailable"}}}, nil
			}), 10, 10*time.Minute); err != nil {
				t.Fatal(err)
			}
			due := time.Now().UTC().Add(-time.Minute).Truncate(time.Second)
			dueSubscription(t, repository, digest.Subscriber{GuildID: "guild", UserID: "user"}, due)

			stats, err := service.DispatchDue(ctx, &recordingDigestSender{}, 100)
			if (err != nil) != test.wantError {
				t.Fatalf("DispatchDue() error = %v, wantError %v", err, test.wantError)
			}
			if stats.Claimed != 1 {
				t.Fatalf("stats = %#v", stats)
			}
			delivery, ok, err := repository.LoadDigestDelivery(ctx, 1)
			if err != nil || !ok || delivery.Status != test.wantStatus {
				t.Fatalf("delivery = %#v, ok %v, error %v", delivery, ok, err)
			}
		})
	}
}

func TestDispatchDueDoesNotSendAfterSubscriptionIsPaused(t *testing.T) {
	ctx := context.Background()
	repository, err := store.Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer repository.Close()
	service, err := digest.NewService(repository, "US", "UTC")
	if err != nil {
		t.Fatal(err)
	}
	subscriber := digest.Subscriber{GuildID: "guild", UserID: "user"}
	due := time.Now().UTC().Add(-time.Minute).Truncate(time.Second)
	subscription := dueSubscription(t, repository, subscriber, due)
	pauseOnRecommend := true
	if err := service.ConfigureRecommendations(recommenderFunc(func(_ context.Context, query recommendation.Query) (recommendation.Result, error) {
		if pauseOnRecommend {
			pauseOnRecommend = false
			if err := repository.SetDigestSubscriptionEnabled(ctx, subscriber, subscription.ID, false, nil, time.Now().UTC()); err != nil {
				t.Fatalf("pause subscription: %v", err)
			}
		}
		return recommendation.Result{Items: []recommendation.Candidate{{
			MediaKey: "tmdb:movie:42", EventKey: "tmdb:movie:42:digital:US:2026-07-11",
			MediaType: recommendation.MediaTypeMovie, ReleaseKind: recommendation.ReleaseKindDigital,
			Title: "Example", ReleaseAt: query.Window.Start, Source: "tmdb",
		}}}, nil
	}), 10, 15*time.Minute); err != nil {
		t.Fatal(err)
	}
	sender := &recordingDigestSender{}
	stats, err := service.DispatchDue(ctx, sender, 100)
	if err != nil {
		t.Fatal(err)
	}
	if stats.Claimed != 1 || stats.Skipped != 1 || len(sender.contents) != 0 {
		t.Fatalf("paused dispatch stats = %#v, sends = %d", stats, len(sender.contents))
	}
	delivery, ok, err := repository.LoadDigestDelivery(ctx, 1)
	if err != nil || !ok || delivery.Status != store.DigestDeliveryInterrupted {
		t.Fatalf("delivery = %#v, ok %v, error %v", delivery, ok, err)
	}

	secondDue := time.Now().UTC().Add(-time.Second).Truncate(time.Second)
	if err := repository.SetDigestSubscriptionEnabled(ctx, subscriber, subscription.ID, true, &secondDue, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	stats, err = service.DispatchDue(ctx, sender, 100)
	if err != nil {
		t.Fatal(err)
	}
	if stats.Sent != 1 || len(sender.contents) != 1 {
		t.Fatalf("resumed dispatch stats = %#v, sends = %d", stats, len(sender.contents))
	}
}

func TestDispatchDueReleasesReservationsWhenCanceledBeforeDiscord(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	repository, err := store.Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer repository.Close()
	wrapped := &cancelOnLoadRepository{Store: repository, cancel: cancel}
	service, err := digest.NewService(wrapped, "US", "UTC")
	if err != nil {
		t.Fatal(err)
	}
	if err := service.ConfigureRecommendations(recommenderFunc(func(_ context.Context, query recommendation.Query) (recommendation.Result, error) {
		return recommendation.Result{Items: []recommendation.Candidate{{
			MediaKey: "tmdb:movie:42", EventKey: "tmdb:movie:42:digital:US:2026-07-11",
			MediaType: recommendation.MediaTypeMovie, ReleaseKind: recommendation.ReleaseKindDigital,
			Title: "Example", ReleaseAt: query.Window.Start, Source: "tmdb",
		}}}, nil
	}), 10, 15*time.Minute); err != nil {
		t.Fatal(err)
	}
	subscriber := digest.Subscriber{GuildID: "guild", UserID: "user"}
	due := time.Now().UTC().Add(-time.Minute).Truncate(time.Second)
	subscription := dueSubscription(t, repository, subscriber, due)
	sender := &recordingDigestSender{}
	stats, err := service.DispatchDue(ctx, sender, 100)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("DispatchDue() error = %v", err)
	}
	if stats.Claimed != 1 || stats.Skipped != 1 || len(sender.contents) != 0 {
		t.Fatalf("canceled dispatch stats = %#v, sends = %d", stats, len(sender.contents))
	}
	delivery, ok, err := repository.LoadDigestDelivery(context.Background(), 1)
	if err != nil || !ok || delivery.Status != store.DigestDeliveryInterrupted {
		t.Fatalf("delivery = %#v, ok %v, error %v", delivery, ok, err)
	}

	secondDue := time.Now().UTC().Add(-time.Second).Truncate(time.Second)
	if err := repository.SetDigestSubscriptionEnabled(context.Background(), subscriber, subscription.ID, true, &secondDue, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	stats, err = service.DispatchDue(context.Background(), sender, 100)
	if err != nil || stats.Sent != 1 || len(sender.contents) != 1 {
		t.Fatalf("retried dispatch stats = %#v, sends = %d, error %v", stats, len(sender.contents), err)
	}
}
