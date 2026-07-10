package digest_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"blitzcrank/internal/digest"
	"blitzcrank/internal/store"
)

func TestServiceCreatesIdempotentOwnedSubscription(t *testing.T) {
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
	subscriber := digest.Subscriber{GuildID: "guild", UserID: "alice"}
	input := service.DefaultInput("de")
	created, err := service.CreateSubscription(ctx, subscriber, input)
	if err != nil {
		t.Fatalf("CreateSubscription() error = %v", err)
	}
	if created.ID == 0 || !created.Enabled || created.NextRunAt == nil {
		t.Fatalf("created subscription = %#v", created)
	}
	duplicate, err := service.CreateSubscription(ctx, subscriber, input)
	if err != nil {
		t.Fatalf("duplicate CreateSubscription() error = %v", err)
	}
	if duplicate.ID != created.ID {
		t.Fatalf("duplicate ID = %d, want %d", duplicate.ID, created.ID)
	}
	if _, ok, err := service.GetSubscription(ctx, digest.Subscriber{GuildID: "guild", UserID: "mallory"}, created.ID); err != nil || ok {
		t.Fatalf("foreign GetSubscription() = ok %v, error %v", ok, err)
	}
}

func TestServiceUpdatesAndPausesSubscription(t *testing.T) {
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
	subscriber := digest.Subscriber{GuildID: "guild", UserID: "alice"}
	input := service.DefaultInput("en-US")
	created, err := service.CreateSubscription(ctx, subscriber, input)
	if err != nil {
		t.Fatal(err)
	}
	input.Cadence = digest.CadenceDaily
	input.TimeOfDay = "07:15"
	input.Interests = []string{"Mystery"}
	updated, err := service.UpdateSubscription(ctx, subscriber, created.ID, input)
	if err != nil {
		t.Fatalf("UpdateSubscription() error = %v", err)
	}
	if updated.Schedule != "15 7 * * *" || len(updated.Interests) != 1 {
		t.Fatalf("updated subscription = %#v", updated)
	}
	if err := service.SetSubscriptionEnabled(ctx, subscriber, created.ID, false); err != nil {
		t.Fatalf("SetSubscriptionEnabled(false) error = %v", err)
	}
	loaded, ok, err := service.GetSubscription(ctx, subscriber, created.ID)
	if err != nil || !ok {
		t.Fatalf("GetSubscription() = ok %v, error %v", ok, err)
	}
	if loaded.Enabled || loaded.NextRunAt != nil {
		t.Fatalf("paused subscription = %#v", loaded)
	}
	if err := service.SetSubscriptionEnabled(ctx, subscriber, created.ID, true); err != nil {
		t.Fatalf("SetSubscriptionEnabled(true) error = %v", err)
	}
	loaded, _, err = service.GetSubscription(ctx, subscriber, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !loaded.Enabled || loaded.NextRunAt == nil || !loaded.NextRunAt.After(time.Now().UTC().Add(-time.Minute)) {
		t.Fatalf("resumed subscription = %#v", loaded)
	}
}

func TestServiceReportsDuplicateUpdateAndSubscriptionLimit(t *testing.T) {
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
	subscriber := digest.Subscriber{GuildID: "guild", UserID: "alice"}
	firstInput := service.DefaultInput("en-US")
	first, err := service.CreateSubscription(ctx, subscriber, firstInput)
	if err != nil {
		t.Fatalf("CreateSubscription(first) error = %v", err)
	}
	secondInput := firstInput
	secondInput.Interests = []string{"second"}
	second, err := service.CreateSubscription(ctx, subscriber, secondInput)
	if err != nil {
		t.Fatalf("CreateSubscription(second) error = %v", err)
	}
	if _, err := service.UpdateSubscription(ctx, subscriber, second.ID, firstInput); !errors.Is(err, digest.ErrSubscriptionAlreadyExists) {
		t.Fatalf("UpdateSubscription() error = %v, want ErrSubscriptionAlreadyExists", err)
	}

	for i := 2; i < digest.MaxSubscriptionsPerUser; i++ {
		input := firstInput
		input.Interests = []string{string(rune('a' + i))}
		if _, err := service.CreateSubscription(ctx, subscriber, input); err != nil {
			t.Fatalf("CreateSubscription(%d) error = %v", i, err)
		}
	}
	limitInput := firstInput
	limitInput.Interests = []string{"over-limit"}
	if _, err := service.CreateSubscription(ctx, subscriber, limitInput); !errors.Is(err, digest.ErrSubscriptionLimit) {
		t.Fatalf("CreateSubscription(over limit) error = %v, want ErrSubscriptionLimit", err)
	}
	loaded, ok, err := service.GetSubscription(ctx, subscriber, first.ID)
	if err != nil || !ok || loaded.ID != first.ID {
		t.Fatalf("GetSubscription(first) = %#v, %v, %v", loaded, ok, err)
	}
}
