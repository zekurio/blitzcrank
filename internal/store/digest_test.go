package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"blitzcrank/internal/digest"
)

func TestDigestSubscriptionCRUDIsSubscriberScoped(t *testing.T) {
	ctx := context.Background()
	state, err := Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer state.Close()

	now := time.Date(2026, time.July, 10, 8, 0, 0, 0, time.UTC)
	nextRunAt := now.Add(time.Hour)
	subscription := testDigestSubscription(now, &nextRunAt)
	subscription.Subscriber = digest.Subscriber{GuildID: " guild ", UserID: " user "}
	subscription.Topics = []digest.Topic{digest.TopicShowPremieres, digest.TopicAnimeSeasons, digest.TopicShowPremieres}
	subscription.ReleaseKinds = []digest.ReleaseKind{digest.ReleaseKindPhysical, digest.ReleaseKindOnline, digest.ReleaseKindPhysical}
	subscription.Interests = []string{" drama ", "anime", "drama", ""}
	subscription.Region = " at "

	created, err := state.CreateDigestSubscription(ctx, subscription)
	if err != nil {
		t.Fatalf("CreateDigestSubscription() error = %v", err)
	}
	if created.ID == 0 {
		t.Fatal("CreateDigestSubscription() ID = 0")
	}
	if created.Subscriber != (digest.Subscriber{GuildID: "guild", UserID: "user"}) {
		t.Fatalf("created Subscriber = %#v", created.Subscriber)
	}
	if !slices.Equal(created.Topics, []digest.Topic{digest.TopicAnimeSeasons, digest.TopicShowPremieres}) {
		t.Fatalf("created Topics = %#v", created.Topics)
	}
	if !slices.Equal(created.ReleaseKinds, []digest.ReleaseKind{digest.ReleaseKindOnline, digest.ReleaseKindPhysical}) {
		t.Fatalf("created ReleaseKinds = %#v", created.ReleaseKinds)
	}
	if !slices.Equal(created.Interests, []string{"anime", "drama"}) || created.Region != "AT" {
		t.Fatalf("created interests/region = %#v, %q", created.Interests, created.Region)
	}

	loaded, ok, err := state.LoadDigestSubscription(ctx, created.Subscriber, created.ID)
	if err != nil || !ok {
		t.Fatalf("LoadDigestSubscription() = %#v, %v, %v", loaded, ok, err)
	}
	if !loaded.NextRunAt.Equal(nextRunAt) || loaded.TimeOfDay != "09:00" || loaded.Locale != "de" {
		t.Fatalf("loaded = %#v", loaded)
	}
	if _, ok, err := state.LoadDigestSubscription(ctx, digest.Subscriber{GuildID: "guild", UserID: "other"}, created.ID); err != nil || ok {
		t.Fatalf("LoadDigestSubscription(other user) = ok %v, err %v", ok, err)
	}

	updatedAt := now.Add(time.Minute)
	updatedNextRunAt := nextRunAt.Add(24 * time.Hour)
	loaded.Cadence = digest.CadenceDaily
	loaded.Schedule = "0 9 * * *"
	loaded.Weekday = time.Tuesday
	loaded.Locale = "en-US"
	loaded.Enabled = true
	loaded.NextRunAt = &updatedNextRunAt
	loaded.UpdatedAt = updatedAt
	if err := state.UpdateDigestSubscription(ctx, digest.Subscriber{GuildID: "guild", UserID: "other"}, loaded); err == nil {
		t.Fatal("UpdateDigestSubscription(other user) error = nil")
	}
	if err := state.UpdateDigestSubscription(ctx, created.Subscriber, loaded); err != nil {
		t.Fatalf("UpdateDigestSubscription() error = %v", err)
	}
	loaded, ok, err = state.LoadDigestSubscription(ctx, created.Subscriber, created.ID)
	if err != nil || !ok {
		t.Fatalf("LoadDigestSubscription() after update = %#v, %v, %v", loaded, ok, err)
	}
	if loaded.Cadence != digest.CadenceDaily || loaded.Locale != "en-US" || !loaded.NextRunAt.Equal(updatedNextRunAt) {
		t.Fatalf("updated subscription = %#v", loaded)
	}

	if err := state.SetDigestSubscriptionEnabled(ctx, digest.Subscriber{GuildID: "guild", UserID: "other"}, created.ID, false, nil, now.Add(2*time.Minute)); err == nil {
		t.Fatal("SetDigestSubscriptionEnabled(other user) error = nil")
	}
	if err := state.SetDigestSubscriptionEnabled(ctx, created.Subscriber, created.ID, false, nil, now.Add(2*time.Minute)); err != nil {
		t.Fatalf("SetDigestSubscriptionEnabled(false) error = %v", err)
	}
	loaded, ok, err = state.LoadDigestSubscription(ctx, created.Subscriber, created.ID)
	if err != nil || !ok || loaded.Enabled || loaded.NextRunAt != nil {
		t.Fatalf("disabled subscription = %#v, %v, %v", loaded, ok, err)
	}
	if err := state.SetDigestSubscriptionEnabled(ctx, created.Subscriber, created.ID, true, &updatedNextRunAt, now.Add(3*time.Minute)); err != nil {
		t.Fatalf("SetDigestSubscriptionEnabled(true) error = %v", err)
	}

	listed, err := state.ListDigestSubscriptions(ctx, created.Subscriber)
	if err != nil || len(listed) != 1 || listed[0].ID != created.ID {
		t.Fatalf("ListDigestSubscriptions() = %#v, %v", listed, err)
	}
	if err := state.DeleteDigestSubscription(ctx, digest.Subscriber{GuildID: "guild", UserID: "other"}, created.ID, now.Add(4*time.Minute)); err == nil {
		t.Fatal("DeleteDigestSubscription(other user) error = nil")
	}
	if err := state.DeleteDigestSubscription(ctx, created.Subscriber, created.ID, now.Add(4*time.Minute)); err != nil {
		t.Fatalf("DeleteDigestSubscription() error = %v", err)
	}
	if listed, err := state.ListDigestSubscriptions(ctx, created.Subscriber); err != nil || len(listed) != 0 {
		t.Fatalf("ListDigestSubscriptions() after delete = %#v, %v", listed, err)
	}
	if _, ok, err := state.LoadDigestSubscription(ctx, created.Subscriber, created.ID); err != nil || ok {
		t.Fatalf("LoadDigestSubscription() after delete = ok %v, err %v", ok, err)
	}
}

func TestCreateDigestSubscriptionIsConcurrentAndIdempotent(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "state.sqlite")
	state, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer state.Close()
	peer, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("Open(peer) error = %v", err)
	}
	defer peer.Close()
	repositories := []*Store{state, peer}

	const callers = 24
	now := time.Date(2026, time.July, 10, 8, 0, 0, 0, time.UTC)
	nextRunAt := now.Add(time.Hour)
	start := make(chan struct{})
	results := make(chan struct {
		subscription digest.Subscription
		err          error
	}, callers)
	for i := range callers {
		go func() {
			subscription := testDigestSubscription(now, &nextRunAt)
			if i%2 == 1 {
				subscription.Subscriber = digest.Subscriber{GuildID: " guild ", UserID: " user "}
				subscription.Topics = []digest.Topic{digest.TopicMovieReleases, digest.TopicMovieReleases}
				subscription.ReleaseKinds = []digest.ReleaseKind{digest.ReleaseKindOnline, digest.ReleaseKindOnline}
				subscription.Region = " at "
				subscription.Interests = []string{" SCIENCE   FICTION ", "science fiction"}
			}
			<-start
			created, err := repositories[i%len(repositories)].CreateDigestSubscription(ctx, subscription)
			results <- struct {
				subscription digest.Subscription
				err          error
			}{subscription: created, err: err}
		}()
	}
	close(start)

	var subscriptionID int64
	for range callers {
		result := <-results
		if result.err != nil {
			t.Fatalf("CreateDigestSubscription() error = %v", result.err)
		}
		if subscriptionID == 0 {
			subscriptionID = result.subscription.ID
		}
		if result.subscription.ID != subscriptionID {
			t.Fatalf("CreateDigestSubscription() ID = %d, want %d", result.subscription.ID, subscriptionID)
		}
	}
	listed, err := state.ListDigestSubscriptions(ctx, digest.Subscriber{GuildID: "guild", UserID: "user"})
	if err != nil {
		t.Fatalf("ListDigestSubscriptions() error = %v", err)
	}
	if len(listed) != 1 {
		t.Fatalf("ListDigestSubscriptions() length = %d, want 1", len(listed))
	}
}

func TestCreateDigestSubscriptionEnforcesLimitConcurrently(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "state.sqlite")
	state, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer state.Close()
	peer, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("Open(peer) error = %v", err)
	}
	defer peer.Close()
	repositories := []*Store{state, peer}

	const callers = digest.MaxSubscriptionsPerUser + 8
	now := time.Date(2026, time.July, 10, 8, 0, 0, 0, time.UTC)
	nextRunAt := now.Add(time.Hour)
	start := make(chan struct{})
	errorsCh := make(chan error, callers)
	for i := range callers {
		go func() {
			subscription := testDigestSubscription(now, &nextRunAt)
			subscription.Interests = []string{fmt.Sprintf("interest-%02d", i)}
			<-start
			_, err := repositories[i%len(repositories)].CreateDigestSubscription(ctx, subscription)
			errorsCh <- err
		}()
	}
	close(start)

	var created, limited int
	for range callers {
		err := <-errorsCh
		switch {
		case err == nil:
			created++
		case errors.Is(err, digest.ErrSubscriptionLimit):
			limited++
		default:
			t.Fatalf("CreateDigestSubscription() error = %v", err)
		}
	}
	if created != digest.MaxSubscriptionsPerUser || limited != callers-digest.MaxSubscriptionsPerUser {
		t.Fatalf("created/limited = %d/%d, want %d/%d", created, limited, digest.MaxSubscriptionsPerUser, callers-digest.MaxSubscriptionsPerUser)
	}
	listed, err := state.ListDigestSubscriptions(ctx, digest.Subscriber{GuildID: "guild", UserID: "user"})
	if err != nil {
		t.Fatalf("ListDigestSubscriptions() error = %v", err)
	}
	if len(listed) != digest.MaxSubscriptionsPerUser {
		t.Fatalf("ListDigestSubscriptions() length = %d, want %d", len(listed), digest.MaxSubscriptionsPerUser)
	}
}

func TestUpdateDigestSubscriptionRejectsConcurrentDuplicateIdentity(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "state.sqlite")
	state, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer state.Close()
	peer, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("Open(peer) error = %v", err)
	}
	defer peer.Close()

	now := time.Date(2026, time.July, 10, 8, 0, 0, 0, time.UTC)
	nextRunAt := now.Add(time.Hour)
	firstInput := testDigestSubscription(now, &nextRunAt)
	firstInput.Interests = []string{"first"}
	first, err := state.CreateDigestSubscription(ctx, firstInput)
	if err != nil {
		t.Fatalf("CreateDigestSubscription(first) error = %v", err)
	}
	secondInput := testDigestSubscription(now.Add(time.Second), &nextRunAt)
	secondInput.Interests = []string{"second"}
	second, err := state.CreateDigestSubscription(ctx, secondInput)
	if err != nil {
		t.Fatalf("CreateDigestSubscription(second) error = %v", err)
	}
	first.Interests = []string{"target"}
	first.UpdatedAt = now.Add(time.Minute)
	second.Interests = []string{"TARGET"}
	second.UpdatedAt = now.Add(time.Minute)

	start := make(chan struct{})
	errorsCh := make(chan error, 2)
	for i, subscription := range []digest.Subscription{first, second} {
		go func() {
			<-start
			repository := state
			if i == 1 {
				repository = peer
			}
			errorsCh <- repository.UpdateDigestSubscription(ctx, subscription.Subscriber, subscription)
		}()
	}
	close(start)

	var updated, duplicate int
	for range 2 {
		err := <-errorsCh
		switch {
		case err == nil:
			updated++
		case errors.Is(err, digest.ErrSubscriptionAlreadyExists):
			duplicate++
		default:
			t.Fatalf("UpdateDigestSubscription() error = %v", err)
		}
	}
	if updated != 1 || duplicate != 1 {
		t.Fatalf("updated/duplicate = %d/%d, want 1/1", updated, duplicate)
	}
	listed, err := state.ListDigestSubscriptions(ctx, first.Subscriber)
	if err != nil {
		t.Fatalf("ListDigestSubscriptions() error = %v", err)
	}
	var targets int
	for _, subscription := range listed {
		if len(subscription.Interests) == 1 && strings.EqualFold(subscription.Interests[0], "target") {
			targets++
		}
	}
	if targets != 1 {
		t.Fatalf("subscriptions with target identity = %d, want 1", targets)
	}
}

func TestDeletedDigestSubscriptionCanBeRecreated(t *testing.T) {
	ctx := context.Background()
	state, err := Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer state.Close()

	now := time.Date(2026, time.July, 10, 8, 0, 0, 0, time.UTC)
	nextRunAt := now.Add(time.Hour)
	input := testDigestSubscription(now, &nextRunAt)
	created, err := state.CreateDigestSubscription(ctx, input)
	if err != nil {
		t.Fatalf("CreateDigestSubscription() error = %v", err)
	}
	if err := state.DeleteDigestSubscription(ctx, created.Subscriber, created.ID, now.Add(time.Minute)); err != nil {
		t.Fatalf("DeleteDigestSubscription() error = %v", err)
	}
	input.CreatedAt = now.Add(2 * time.Minute)
	input.UpdatedAt = input.CreatedAt
	recreated, err := state.CreateDigestSubscription(ctx, input)
	if err != nil {
		t.Fatalf("CreateDigestSubscription(recreated) error = %v", err)
	}
	if recreated.ID == created.ID {
		t.Fatalf("recreated ID = %d, want a new ID", recreated.ID)
	}
}

func TestListDueDigestSubscriptionsFiltersAndOrders(t *testing.T) {
	ctx := context.Background()
	state, err := Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer state.Close()

	now := time.Date(2026, time.July, 10, 10, 0, 0, 0, time.UTC)
	times := []time.Time{now.Add(-time.Minute), now.Add(-2 * time.Minute), now, now.Add(time.Minute)}
	var ids []int64
	for i, nextRunAt := range times {
		subscription := testDigestSubscription(now.Add(time.Duration(i)*time.Second), &nextRunAt)
		subscription.Subscriber.UserID = "user-" + string(rune('a'+i))
		created, err := state.CreateDigestSubscription(ctx, subscription)
		if err != nil {
			t.Fatalf("CreateDigestSubscription(%d) error = %v", i, err)
		}
		ids = append(ids, created.ID)
	}
	disabledAt := now.Add(-time.Hour)
	disabled := testDigestSubscription(now.Add(10*time.Second), &disabledAt)
	disabled.Subscriber.UserID = "disabled"
	disabled.Enabled = false
	disabled.NextRunAt = nil
	if _, err := state.CreateDigestSubscription(ctx, disabled); err != nil {
		t.Fatalf("CreateDigestSubscription(disabled) error = %v", err)
	}
	deletedAt := now.Add(-time.Hour)
	deleted := testDigestSubscription(now.Add(11*time.Second), &deletedAt)
	deleted.Subscriber.UserID = "deleted"
	createdDeleted, err := state.CreateDigestSubscription(ctx, deleted)
	if err != nil {
		t.Fatalf("CreateDigestSubscription(deleted) error = %v", err)
	}
	if err := state.DeleteDigestSubscription(ctx, createdDeleted.Subscriber, createdDeleted.ID, now); err != nil {
		t.Fatalf("DeleteDigestSubscription() error = %v", err)
	}

	due, err := state.ListDueDigestSubscriptions(ctx, now, 2)
	if err != nil {
		t.Fatalf("ListDueDigestSubscriptions() error = %v", err)
	}
	if len(due) != 2 {
		t.Fatalf("ListDueDigestSubscriptions() length = %d, want 2", len(due))
	}
	gotIDs := []int64{due[0].ID, due[1].ID}
	if want := []int64{ids[1], ids[0]}; !slices.Equal(gotIDs, want) {
		t.Fatalf("due IDs = %#v, want %#v", gotIDs, want)
	}
	due, err = state.ListDueDigestSubscriptions(ctx, now, 10)
	if err != nil {
		t.Fatalf("ListDueDigestSubscriptions(all) error = %v", err)
	}
	gotIDs = gotIDs[:0]
	for _, subscription := range due {
		gotIDs = append(gotIDs, subscription.ID)
	}
	if want := []int64{ids[1], ids[0], ids[2]}; !slices.Equal(gotIDs, want) {
		t.Fatalf("all due IDs = %#v, want %#v", gotIDs, want)
	}
}

func TestClaimDigestDeliveryRejectsEarlyDisabledAndStaleSchedules(t *testing.T) {
	ctx := context.Background()
	state, err := Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer state.Close()

	now := time.Date(2026, time.July, 10, 10, 0, 0, 0, time.UTC)
	scheduledFor := now.Add(time.Hour)
	created, err := state.CreateDigestSubscription(ctx, testDigestSubscription(now, &scheduledFor))
	if err != nil {
		t.Fatalf("CreateDigestSubscription() error = %v", err)
	}
	claim := digest.DeliveryClaim{
		SubscriptionID: created.ID,
		ScheduledFor:   scheduledFor,
		NextRunAt:      scheduledFor.Add(24 * time.Hour),
		WindowStart:    scheduledFor,
		WindowEnd:      scheduledFor.Add(24 * time.Hour),
		StartedAt:      now,
	}
	if _, claimed, err := state.ClaimDigestDelivery(ctx, claim); err != nil || claimed {
		t.Fatalf("ClaimDigestDelivery(early) = claimed %v, err %v", claimed, err)
	}
	if err := state.SetDigestSubscriptionEnabled(ctx, created.Subscriber, created.ID, false, nil, now.Add(time.Minute)); err != nil {
		t.Fatalf("SetDigestSubscriptionEnabled(false) error = %v", err)
	}
	claim.StartedAt = scheduledFor.Add(time.Minute)
	if _, claimed, err := state.ClaimDigestDelivery(ctx, claim); err != nil || claimed {
		t.Fatalf("ClaimDigestDelivery(disabled) = claimed %v, err %v", claimed, err)
	}
	rescheduledFor := scheduledFor.Add(2 * time.Hour)
	if err := state.SetDigestSubscriptionEnabled(ctx, created.Subscriber, created.ID, true, &rescheduledFor, now.Add(2*time.Minute)); err != nil {
		t.Fatalf("SetDigestSubscriptionEnabled(true) error = %v", err)
	}
	if _, claimed, err := state.ClaimDigestDelivery(ctx, claim); err != nil || claimed {
		t.Fatalf("ClaimDigestDelivery(stale schedule) = claimed %v, err %v", claimed, err)
	}
}

func TestClaimDigestDeliveryIsAtomicDurableAndCurrent(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "state.sqlite")
	state, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	now := time.Date(2026, time.July, 10, 10, 0, 0, 0, time.UTC)
	scheduledFor := now.Add(-time.Minute)
	nextRunAt := now.Add(24 * time.Hour)
	created, err := state.CreateDigestSubscription(ctx, testDigestSubscription(now.Add(-time.Hour), &scheduledFor))
	if err != nil {
		t.Fatalf("CreateDigestSubscription() error = %v", err)
	}
	claim := digest.DeliveryClaim{
		SubscriptionID: created.ID,
		ScheduledFor:   scheduledFor,
		NextRunAt:      nextRunAt,
		WindowStart:    now,
		WindowEnd:      now.Add(7 * 24 * time.Hour),
		StartedAt:      now,
	}

	const claimers = 20
	var claims atomic.Int64
	var deliveryID atomic.Int64
	var wg sync.WaitGroup
	errCh := make(chan error, claimers)
	for range claimers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			delivery, claimed, err := state.ClaimDigestDelivery(ctx, claim)
			if err != nil {
				errCh <- err
				return
			}
			if claimed {
				claims.Add(1)
				deliveryID.Store(delivery.ID)
			}
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Errorf("ClaimDigestDelivery() error = %v", err)
	}
	if claims.Load() != 1 {
		t.Fatalf("successful claims = %d, want 1", claims.Load())
	}
	loaded, ok, err := state.LoadDigestSubscription(ctx, created.Subscriber, created.ID)
	if err != nil || !ok {
		t.Fatalf("LoadDigestSubscription() = %#v, %v, %v", loaded, ok, err)
	}
	if !loaded.NextRunAt.Equal(nextRunAt) || loaded.LastRunAt == nil || !loaded.LastRunAt.Equal(now) {
		t.Fatalf("claimed subscription = %#v", loaded)
	}
	if reserved, err := state.ReserveDigestDeliveryItems(ctx, deliveryID.Load(), []string{"tmdb:movie:1:online"}, now); err != nil || len(reserved) != 1 {
		t.Fatalf("ReserveDigestDeliveryItems() = %#v, %v", reserved, err)
	}
	if err := state.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	state, err = Open(ctx, path)
	if err != nil {
		t.Fatalf("Open() after restart error = %v", err)
	}
	defer state.Close()
	if _, claimed, err := state.ClaimDigestDelivery(ctx, claim); err != nil || claimed {
		t.Fatalf("ClaimDigestDelivery() after restart = claimed %v, err %v", claimed, err)
	}
	if err := state.MarkInterruptedDigestDeliveries(ctx, "process restarted", now.Add(time.Minute)); err != nil {
		t.Fatalf("MarkInterruptedDigestDeliveries() error = %v", err)
	}
	delivery, ok, err := state.LoadDigestDelivery(ctx, deliveryID.Load())
	if err != nil || !ok || delivery.Status != DigestDeliveryInterrupted || delivery.CompletedAt == nil {
		t.Fatalf("interrupted delivery = %#v, %v, %v", delivery, ok, err)
	}
	if due, err := state.ListDueDigestSubscriptions(ctx, now.Add(time.Minute), 10); err != nil || len(due) != 0 {
		t.Fatalf("due subscriptions after interruption = %#v, %v", due, err)
	}
	afterRestart := nextRunAt.Add(time.Minute)
	afterRestartDelivery, claimed, err := state.ClaimDigestDelivery(ctx, digest.DeliveryClaim{
		SubscriptionID: created.ID,
		ScheduledFor:   nextRunAt,
		NextRunAt:      nextRunAt.Add(24 * time.Hour),
		WindowStart:    nextRunAt,
		WindowEnd:      nextRunAt.Add(24 * time.Hour),
		StartedAt:      afterRestart,
	})
	if err != nil || !claimed {
		t.Fatalf("ClaimDigestDelivery(after restart) = %#v, %v, %v", afterRestartDelivery, claimed, err)
	}
	if reserved, err := state.ReserveDigestDeliveryItems(ctx, afterRestartDelivery.ID, []string{"tmdb:movie:1:online"}, afterRestart); err != nil || len(reserved) != 0 {
		t.Fatalf("ReserveDigestDeliveryItems(after interrupted send) = %#v, %v", reserved, err)
	}
}

func TestInterruptedDeliveryWithoutReservationsIsRetriedAfterRestart(t *testing.T) {
	ctx := context.Background()
	state, err := Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	now := time.Date(2026, time.July, 10, 10, 0, 0, 0, time.UTC)
	scheduledFor := now.Add(-time.Minute)
	claimedNextRunAt := now.Add(24 * time.Hour)
	created, err := state.CreateDigestSubscription(ctx, testDigestSubscription(now.Add(-time.Hour), &scheduledFor))
	if err != nil {
		t.Fatal(err)
	}
	delivery, claimed, err := state.ClaimDigestDelivery(ctx, digest.DeliveryClaim{
		SubscriptionID: created.ID,
		ScheduledFor:   scheduledFor,
		NextRunAt:      claimedNextRunAt,
		WindowStart:    now,
		WindowEnd:      now.Add(7 * 24 * time.Hour),
		StartedAt:      now,
	})
	if err != nil || !claimed {
		t.Fatalf("ClaimDigestDelivery() = %#v, %v, %v", delivery, claimed, err)
	}
	recoveredAt := now.Add(time.Minute)
	if err := state.MarkInterruptedDigestDeliveries(ctx, "process restarted", recoveredAt); err != nil {
		t.Fatal(err)
	}
	due, err := state.ListDueDigestSubscriptions(ctx, recoveredAt, 10)
	if err != nil || len(due) != 1 || due[0].NextRunAt == nil || !due[0].NextRunAt.Equal(recoveredAt) {
		t.Fatalf("due subscriptions = %#v, error %v", due, err)
	}
	loaded, ok, err := state.LoadDigestDelivery(ctx, delivery.ID)
	if err != nil || !ok || loaded.Status != DigestDeliveryInterrupted {
		t.Fatalf("delivery = %#v, ok %v, error %v", loaded, ok, err)
	}
}

func TestDeliveryRetryDoesNotOverwriteConcurrentScheduleEdit(t *testing.T) {
	ctx := context.Background()
	state, err := Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	now := time.Date(2026, time.July, 10, 10, 0, 0, 0, time.UTC)
	scheduledFor := now.Add(-time.Minute)
	claimedNextRunAt := now.Add(24 * time.Hour)
	created, err := state.CreateDigestSubscription(ctx, testDigestSubscription(now.Add(-time.Hour), &scheduledFor))
	if err != nil {
		t.Fatal(err)
	}
	delivery, claimed, err := state.ClaimDigestDelivery(ctx, digest.DeliveryClaim{
		SubscriptionID: created.ID,
		ScheduledFor:   scheduledFor,
		NextRunAt:      claimedNextRunAt,
		WindowStart:    now,
		WindowEnd:      now.Add(7 * 24 * time.Hour),
		StartedAt:      now,
	})
	if err != nil || !claimed {
		t.Fatalf("ClaimDigestDelivery() = %#v, %v, %v", delivery, claimed, err)
	}
	if _, err := state.ReserveDigestDeliveryItems(ctx, delivery.ID, []string{"tmdb:movie:1:digital"}, now); err != nil {
		t.Fatal(err)
	}
	rescheduledFor := now.Add(48 * time.Hour)
	if err := state.SetDigestSubscriptionEnabled(ctx, created.Subscriber, created.ID, true, &rescheduledFor, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	completedAt := now.Add(2 * time.Minute)
	retryAt := completedAt.Add(15 * time.Minute)
	if err := state.CompleteDigestDelivery(ctx, delivery.ID, DigestDeliveryFailed, "", "", "catalog unavailable", completedAt, &retryAt); err != nil {
		t.Fatal(err)
	}
	loaded, ok, err := state.LoadDigestSubscription(ctx, created.Subscriber, created.ID)
	if err != nil || !ok || loaded.NextRunAt == nil || !loaded.NextRunAt.Equal(rescheduledFor) {
		t.Fatalf("subscription = %#v, ok %v, error %v", loaded, ok, err)
	}
}

func TestDigestDeliveryItemReservationCompletionAndRetry(t *testing.T) {
	ctx := context.Background()
	state, err := Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer state.Close()

	now := time.Date(2026, time.July, 10, 10, 0, 0, 0, time.UTC)
	scheduledFor := now.Add(-time.Minute)
	nextRunAt := now.Add(24 * time.Hour)
	created, err := state.CreateDigestSubscription(ctx, testDigestSubscription(now.Add(-time.Hour), &scheduledFor))
	if err != nil {
		t.Fatalf("CreateDigestSubscription() error = %v", err)
	}
	first, claimed, err := state.ClaimDigestDelivery(ctx, digest.DeliveryClaim{
		SubscriptionID: created.ID,
		ScheduledFor:   scheduledFor,
		NextRunAt:      nextRunAt,
		WindowStart:    now,
		WindowEnd:      nextRunAt,
		StartedAt:      now,
	})
	if err != nil || !claimed {
		t.Fatalf("ClaimDigestDelivery(first) = %#v, %v, %v", first, claimed, err)
	}
	reserved, err := state.ReserveDigestDeliveryItems(ctx, first.ID, []string{" tmdb:movie:1:online ", "tmdb:movie:1:online", "tmdb:movie:2:physical", ""}, now)
	if err != nil {
		t.Fatalf("ReserveDigestDeliveryItems() error = %v", err)
	}
	if want := []string{"tmdb:movie:1:online", "tmdb:movie:2:physical"}; !slices.Equal(reserved, want) {
		t.Fatalf("reserved = %#v, want %#v", reserved, want)
	}
	rows, err := state.db.QueryContext(ctx, `SELECT item_key FROM digest_delivery_items WHERE first_delivery_id = ?`, first.ID)
	if err != nil {
		t.Fatalf("load stored digest item keys: %v", err)
	}
	wantStoredKeys := make(map[string]bool, len(reserved))
	for _, key := range reserved {
		sum := sha256.Sum256([]byte(key))
		wantStoredKeys[hex.EncodeToString(sum[:])] = true
	}
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			_ = rows.Close()
			t.Fatalf("scan stored digest item key: %v", err)
		}
		if !wantStoredKeys[key] || strings.Contains(key, "tmdb:") {
			_ = rows.Close()
			t.Fatalf("stored digest item key = %q, want SHA-256 digest", key)
		}
		delete(wantStoredKeys, key)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		t.Fatalf("iterate stored digest item keys: %v", err)
	}
	if err := rows.Close(); err != nil {
		t.Fatalf("close stored digest item keys: %v", err)
	}
	if len(wantStoredKeys) != 0 {
		t.Fatalf("missing stored digest item hashes = %#v", wantStoredKeys)
	}
	if reserved, err := state.ReserveDigestDeliveryItems(ctx, first.ID, []string{"tmdb:movie:1:online"}, now); err != nil || len(reserved) != 0 {
		t.Fatalf("duplicate reservation = %#v, %v", reserved, err)
	}
	completedAt := now.Add(time.Minute)
	if err := state.CompleteDigestDelivery(ctx, first.ID, DigestDeliverySent, "dm-channel", "message-1", "", completedAt, nil); err != nil {
		t.Fatalf("CompleteDigestDelivery(sent) error = %v", err)
	}
	loadedFirst, ok, err := state.LoadDigestDelivery(ctx, first.ID)
	if err != nil || !ok {
		t.Fatalf("LoadDigestDelivery(first) = %#v, %v, %v", loadedFirst, ok, err)
	}
	if loadedFirst.Status != DigestDeliverySent || loadedFirst.ItemCount != 2 || loadedFirst.DiscordMessageID != "message-1" || loadedFirst.CompletedAt == nil {
		t.Fatalf("completed first delivery = %#v", loadedFirst)
	}
	loadedSubscription, ok, err := state.LoadDigestSubscription(ctx, created.Subscriber, created.ID)
	if err != nil || !ok || loadedSubscription.LastDeliveredAt == nil || !loadedSubscription.LastDeliveredAt.Equal(completedAt) {
		t.Fatalf("subscription after delivery = %#v, %v, %v", loadedSubscription, ok, err)
	}

	secondStartedAt := nextRunAt.Add(time.Minute)
	thirdRunAt := nextRunAt.Add(24 * time.Hour)
	second, claimed, err := state.ClaimDigestDelivery(ctx, digest.DeliveryClaim{
		SubscriptionID: created.ID,
		ScheduledFor:   nextRunAt,
		NextRunAt:      thirdRunAt,
		WindowStart:    nextRunAt,
		WindowEnd:      thirdRunAt,
		StartedAt:      secondStartedAt,
	})
	if err != nil || !claimed {
		t.Fatalf("ClaimDigestDelivery(second) = %#v, %v, %v", second, claimed, err)
	}
	reserved, err = state.ReserveDigestDeliveryItems(ctx, second.ID, []string{"tmdb:movie:1:online", "tmdb:movie:3:cinema"}, secondStartedAt)
	if err != nil {
		t.Fatalf("ReserveDigestDeliveryItems(second) error = %v", err)
	}
	if want := []string{"tmdb:movie:3:cinema"}; !slices.Equal(reserved, want) {
		t.Fatalf("second reserved = %#v, want %#v", reserved, want)
	}
	retryAt := secondStartedAt.Add(15 * time.Minute)
	longError := strings.Repeat("x", 700)
	if err := state.CompleteDigestDelivery(ctx, second.ID, DigestDeliveryFailed, "", "", longError, secondStartedAt.Add(time.Minute), &retryAt); err != nil {
		t.Fatalf("CompleteDigestDelivery(failed) error = %v", err)
	}
	loadedSecond, ok, err := state.LoadDigestDelivery(ctx, second.ID)
	if err != nil || !ok {
		t.Fatalf("LoadDigestDelivery(second) = %#v, %v, %v", loadedSecond, ok, err)
	}
	if loadedSecond.Status != DigestDeliveryFailed || loadedSecond.ItemCount != 1 || len([]rune(loadedSecond.Error)) != 512 {
		t.Fatalf("completed second delivery = %#v", loadedSecond)
	}
	loadedSubscription, ok, err = state.LoadDigestSubscription(ctx, created.Subscriber, created.ID)
	if err != nil || !ok || !loadedSubscription.NextRunAt.Equal(retryAt) {
		t.Fatalf("subscription retry = %#v, %v, %v", loadedSubscription, ok, err)
	}
	if _, err := state.ReserveDigestDeliveryItems(ctx, second.ID, []string{"tmdb:movie:4:online"}, retryAt); err == nil {
		t.Fatal("ReserveDigestDeliveryItems(completed) error = nil")
	}
	retryStartedAt := retryAt.Add(time.Minute)
	fourthRunAt := retryAt.Add(24 * time.Hour)
	retry, claimed, err := state.ClaimDigestDelivery(ctx, digest.DeliveryClaim{
		SubscriptionID: created.ID,
		ScheduledFor:   retryAt,
		NextRunAt:      fourthRunAt,
		WindowStart:    retryAt,
		WindowEnd:      fourthRunAt,
		StartedAt:      retryStartedAt,
	})
	if err != nil || !claimed {
		t.Fatalf("ClaimDigestDelivery(retry) = %#v, %v, %v", retry, claimed, err)
	}
	reserved, err = state.ReserveDigestDeliveryItems(ctx, retry.ID, []string{"tmdb:movie:1:online", "tmdb:movie:3:cinema"}, retryStartedAt)
	if err != nil {
		t.Fatalf("ReserveDigestDeliveryItems(retry) error = %v", err)
	}
	if want := []string{"tmdb:movie:3:cinema"}; !slices.Equal(reserved, want) {
		t.Fatalf("retry reserved = %#v, want %#v", reserved, want)
	}
}

func TestDigestSchemaMigratesFromIssueOnlyDatabase(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "state.sqlite")
	db, err := sql.Open("sqlite", sqliteDSN(path))
	if err != nil {
		t.Fatalf("sql.Open() error = %v", err)
	}
	if _, err := db.ExecContext(ctx, `
CREATE TABLE issue_threads (
  issue_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  completion_reason TEXT,
  last_payload_json TEXT
);`); err != nil {
		_ = db.Close()
		t.Fatalf("create legacy database: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close legacy database: %v", err)
	}

	state, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("Open() legacy database error = %v", err)
	}
	defer state.Close()
	now := time.Date(2026, time.July, 10, 10, 0, 0, 0, time.UTC)
	nextRunAt := now.Add(time.Hour)
	if _, err := state.CreateDigestSubscription(ctx, testDigestSubscription(now, &nextRunAt)); err != nil {
		t.Fatalf("CreateDigestSubscription() after migration error = %v", err)
	}
}

func TestDigestIdentityMigrationSoftDeletesExistingDuplicates(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "state.sqlite")
	state, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	now := time.Date(2026, time.July, 10, 10, 0, 0, 0, time.UTC)
	nextRunAt := now.Add(time.Hour)
	created, err := state.CreateDigestSubscription(ctx, testDigestSubscription(now, &nextRunAt))
	if err != nil {
		_ = state.Close()
		t.Fatalf("CreateDigestSubscription() error = %v", err)
	}
	if _, err := state.db.ExecContext(ctx, `DROP INDEX idx_digest_subscriptions_identity`); err != nil {
		_ = state.Close()
		t.Fatalf("drop identity index: %v", err)
	}
	if _, err := state.db.ExecContext(ctx, `
INSERT INTO digest_subscriptions(
  guild_id,user_id,identity_key,topics_json,release_kinds_json,cadence,schedule,weekday,time_of_day,region,timezone,locale,interests_json,enabled,next_run_at,last_run_at,last_delivered_at,created_at,updated_at,deleted_at
)
SELECT guild_id,user_id,identity_key,topics_json,release_kinds_json,cadence,schedule,weekday,time_of_day,region,timezone,locale,interests_json,enabled,next_run_at,last_run_at,last_delivered_at,created_at,updated_at,deleted_at
FROM digest_subscriptions
WHERE id = ?
`, created.ID); err != nil {
		_ = state.Close()
		t.Fatalf("insert legacy duplicate: %v", err)
	}
	if err := state.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	state, err = Open(ctx, path)
	if err != nil {
		t.Fatalf("Open() after duplicate error = %v", err)
	}
	defer state.Close()
	listed, err := state.ListDigestSubscriptions(ctx, created.Subscriber)
	if err != nil {
		t.Fatalf("ListDigestSubscriptions() error = %v", err)
	}
	if len(listed) != 1 || listed[0].ID != created.ID {
		t.Fatalf("active subscriptions = %#v, want only %d", listed, created.ID)
	}
	var deleted int
	if err := state.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM digest_subscriptions WHERE deleted_at IS NOT NULL`).Scan(&deleted); err != nil {
		t.Fatalf("count deleted subscriptions: %v", err)
	}
	if deleted != 1 {
		t.Fatalf("deleted subscriptions = %d, want 1", deleted)
	}
	if _, err := state.db.ExecContext(ctx, `
INSERT INTO digest_subscriptions(
  guild_id,user_id,identity_key,topics_json,release_kinds_json,cadence,schedule,weekday,time_of_day,region,timezone,locale,interests_json,enabled,next_run_at,last_run_at,last_delivered_at,created_at,updated_at,deleted_at
)
SELECT guild_id,user_id,identity_key,topics_json,release_kinds_json,cadence,schedule,weekday,time_of_day,region,timezone,locale,interests_json,enabled,next_run_at,last_run_at,last_delivered_at,created_at,updated_at,NULL
FROM digest_subscriptions
WHERE id = ?
`, created.ID); err == nil {
		t.Fatal("raw duplicate insert error = nil, want unique identity constraint")
	}
}

func TestDigestDeliverySchemaContainsNoMediaContentColumns(t *testing.T) {
	ctx := context.Background()
	state, err := Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer state.Close()

	for _, table := range []string{"digest_deliveries", "digest_delivery_items"} {
		rows, err := state.db.QueryContext(ctx, `SELECT name FROM pragma_table_info(?)`, table)
		if err != nil {
			t.Fatalf("inspect %s: %v", table, err)
		}
		for rows.Next() {
			var column string
			if err := rows.Scan(&column); err != nil {
				_ = rows.Close()
				t.Fatalf("scan %s column: %v", table, err)
			}
			lower := strings.ToLower(column)
			for _, forbidden := range []string{"title", "synopsis", "overview", "payload", "content", "description"} {
				if strings.Contains(lower, forbidden) {
					_ = rows.Close()
					t.Fatalf("%s unexpectedly has media-content column %q", table, column)
				}
			}
		}
		if err := rows.Close(); err != nil {
			t.Fatalf("close %s schema rows: %v", table, err)
		}
	}
}

func testDigestSubscription(now time.Time, nextRunAt *time.Time) digest.Subscription {
	return digest.Subscription{
		Subscriber:   digest.Subscriber{GuildID: "guild", UserID: "user"},
		Topics:       []digest.Topic{digest.TopicMovieReleases},
		ReleaseKinds: []digest.ReleaseKind{digest.ReleaseKindOnline},
		Cadence:      digest.CadenceWeekly,
		Schedule:     "0 9 * * 1",
		Weekday:      time.Monday,
		TimeOfDay:    "09:00",
		Region:       "AT",
		Timezone:     "Europe/Vienna",
		Locale:       "de",
		Interests:    []string{"science fiction"},
		Enabled:      nextRunAt != nil,
		NextRunAt:    nextRunAt,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
}
