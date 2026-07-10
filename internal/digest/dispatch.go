package digest

import (
	"context"
	"errors"
	"fmt"
	"time"
)

const (
	DeliveryStatusClaimed     = "claimed"
	DeliveryStatusSent        = "sent"
	DeliveryStatusEmpty       = "empty"
	DeliveryStatusFailed      = "failed"
	DeliveryStatusInterrupted = "interrupted"
	deliveryCleanupTimeout    = 10 * time.Second
)

type DispatchStats struct {
	Due, Claimed, Sent, Empty, Failed, Skipped int
}

func (s DispatchStats) String() string {
	return fmt.Sprintf("due=%d claimed=%d sent=%d empty=%d failed=%d skipped=%d", s.Due, s.Claimed, s.Sent, s.Empty, s.Failed, s.Skipped)
}

func (s *Service) RecoverDeliveries(ctx context.Context) error {
	if err := s.repository.MarkInterruptedDigestDeliveries(ctx, "process restarted during newsletter delivery", s.now().UTC()); err != nil {
		return fmt.Errorf("mark interrupted newsletter deliveries: %w", err)
	}
	return nil
}

func (s *Service) Preview(ctx context.Context, subscriber Subscriber, subscriptionID int64) (Content, error) {
	subscription, ok, err := s.repository.LoadDigestSubscription(ctx, subscriber, subscriptionID)
	if err != nil {
		return Content{}, fmt.Errorf("load newsletter subscription: %w", err)
	}
	if !ok {
		return Content{}, errors.New("newsletter subscription was not found")
	}
	start, end, err := newsletterWindow(subscription, s.now(), true)
	if err != nil {
		return Content{}, err
	}
	return s.fetch(ctx, subscription, start, end)
}

func (s *Service) DispatchDue(ctx context.Context, sender Sender, limit int) (DispatchStats, error) {
	if s.calendar == nil {
		return DispatchStats{}, errors.New("newsletter calendar source is not configured")
	}
	if sender == nil {
		return DispatchStats{}, errors.New("newsletter sender is required")
	}
	if limit <= 0 {
		limit = 100
	}
	subscriptions, err := s.repository.ListDueDigestSubscriptions(ctx, s.now().UTC(), limit)
	if err != nil {
		return DispatchStats{}, fmt.Errorf("list due newsletter subscriptions: %w", err)
	}
	stats := DispatchStats{Due: len(subscriptions)}
	var dispatchErrors []error
	for index, subscription := range subscriptions {
		if err := ctx.Err(); err != nil {
			stats.Skipped += len(subscriptions) - index
			dispatchErrors = append(dispatchErrors, err)
			break
		}
		outcome, err := s.dispatchSubscription(ctx, sender, subscription, s.now().UTC())
		switch outcome {
		case DeliveryStatusSent:
			stats.Claimed++
			stats.Sent++
		case DeliveryStatusEmpty:
			stats.Claimed++
			stats.Empty++
		case DeliveryStatusFailed:
			stats.Claimed++
			stats.Failed++
		case DeliveryStatusInterrupted:
			stats.Claimed++
			stats.Skipped++
		default:
			stats.Skipped++
		}
		if err != nil {
			dispatchErrors = append(dispatchErrors, err)
		}
	}
	return stats, errors.Join(dispatchErrors...)
}

func (s *Service) dispatchSubscription(ctx context.Context, sender Sender, subscription Subscription, startedAt time.Time) (string, error) {
	if subscription.NextRunAt == nil {
		return "", nil
	}
	nextRunAt, err := NextScheduledAt(subscription.Schedule, subscription.Timezone, startedAt)
	if err != nil {
		return "", fmt.Errorf("compute next newsletter run: %w", err)
	}
	windowStart, windowEnd, err := newsletterWindow(subscription, startedAt, false)
	if err != nil {
		return "", err
	}
	delivery, claimed, err := s.repository.ClaimDigestDelivery(ctx, DeliveryClaim{
		SubscriptionID: subscription.ID,
		ScheduledFor:   subscription.NextRunAt.UTC(),
		NextRunAt:      nextRunAt,
		WindowStart:    windowStart,
		WindowEnd:      windowEnd,
		StartedAt:      startedAt,
	})
	if err != nil {
		return "", fmt.Errorf("claim newsletter delivery: %w", err)
	}
	if !claimed {
		return "", nil
	}

	content, fetchErr := s.fetch(ctx, subscription, windowStart, windowEnd)
	if fetchErr != nil || (content.Partial && len(content.Items) == 0) {
		completedAt := s.now().UTC()
		retryAt := completedAt.Add(s.retryDelay)
		completeErr := s.completeDigestDelivery(ctx, delivery.ID, DeliveryStatusFailed, "", "", "calendar sources unavailable", completedAt, &retryAt)
		if fetchErr == nil {
			fetchErr = errors.New("calendar sources returned only failures")
		}
		return DeliveryStatusFailed, errors.Join(fetchErr, completeErr)
	}
	if len(content.Items) == 0 {
		if err := s.completeDigestDelivery(ctx, delivery.ID, DeliveryStatusEmpty, "", "", "", s.now().UTC(), nil); err != nil {
			return DeliveryStatusEmpty, fmt.Errorf("complete empty newsletter delivery: %w", err)
		}
		return DeliveryStatusEmpty, nil
	}

	keys := make([]string, 0, len(content.Items))
	for _, item := range content.Items {
		keys = append(keys, item.EventKey)
	}
	reserved, err := s.repository.ReserveDigestDeliveryItems(ctx, delivery.ID, keys, s.now().UTC())
	if err != nil {
		completedAt := s.now().UTC()
		retryAt := completedAt.Add(s.retryDelay)
		completeErr := s.completeDigestDelivery(ctx, delivery.ID, DeliveryStatusFailed, "", "", "newsletter item reservation failed", completedAt, &retryAt)
		return DeliveryStatusFailed, errors.Join(fmt.Errorf("reserve newsletter items: %w", err), completeErr)
	}
	content.Items = filterReservedEntries(content.Items, reserved)
	if len(content.Items) == 0 {
		if err := s.completeDigestDelivery(ctx, delivery.ID, DeliveryStatusEmpty, "", "", "", s.now().UTC(), nil); err != nil {
			return DeliveryStatusEmpty, fmt.Errorf("complete deduplicated newsletter delivery: %w", err)
		}
		return DeliveryStatusEmpty, nil
	}

	current, exists, stateErr := s.repository.LoadDigestSubscription(ctx, subscription.Subscriber, subscription.ID)
	stillCurrent := stateErr == nil && exists && current.Enabled && current.NextRunAt != nil &&
		current.NextRunAt.Equal(nextRunAt) && current.UpdatedAt.Equal(startedAt)
	if !stillCurrent {
		abandonErr := s.abandonDigestDelivery(ctx, delivery.ID, "subscription changed during newsletter delivery", s.now().UTC())
		if stateErr != nil {
			return DeliveryStatusInterrupted, errors.Join(fmt.Errorf("recheck newsletter subscription: %w", stateErr), abandonErr)
		}
		return DeliveryStatusInterrupted, abandonErr
	}
	if err := ctx.Err(); err != nil {
		return DeliveryStatusInterrupted, errors.Join(err, s.abandonDigestDelivery(ctx, delivery.ID, "newsletter canceled before Discord request", s.now().UTC()))
	}

	sent, err := sender.SendDigest(ctx, subscription, content)
	if err != nil {
		completeErr := s.completeDigestDelivery(ctx, delivery.ID, DeliveryStatusFailed, "", "", "Discord DM failed", s.now().UTC(), nil)
		return DeliveryStatusFailed, errors.Join(fmt.Errorf("send newsletter DM: %w", err), completeErr)
	}
	if err := s.completeDigestDelivery(ctx, delivery.ID, DeliveryStatusSent, sent.DiscordChannelID, sent.DiscordMessageID, "", s.now().UTC(), nil); err != nil {
		return DeliveryStatusSent, fmt.Errorf("complete sent newsletter delivery: %w", err)
	}
	return DeliveryStatusSent, nil
}

func newsletterWindow(subscription Subscription, at time.Time, preview bool) (time.Time, time.Time, error) {
	location, err := time.LoadLocation(subscription.Timezone)
	if err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("load newsletter timezone: %w", err)
	}
	local := at.In(location)
	start := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, location)
	if subscription.Cadence == CadenceMonthly {
		start = time.Date(local.Year(), local.Month(), 1, 0, 0, 0, 0, location)
		if preview && local.Day() != 1 {
			start = start.AddDate(0, 1, 0)
		}
		return start.UTC(), start.AddDate(0, 1, 0).UTC(), nil
	}
	return start.UTC(), start.AddDate(0, 0, 7).UTC(), nil
}

func (s *Service) fetch(ctx context.Context, subscription Subscription, start, end time.Time) (Content, error) {
	if s.calendar == nil {
		return Content{}, errors.New("newsletter calendar source is not configured")
	}
	result, err := s.calendar.Fetch(ctx, CalendarQuery{Topics: subscription.Topics, Start: start, End: end, Limit: s.maxItems})
	content := Content{Subscription: subscription, WindowStart: start, WindowEnd: end, Items: result.Items, Partial: len(result.Warnings) > 0}
	if err != nil {
		return content, fmt.Errorf("fetch newsletter calendars: %w", err)
	}
	return content, nil
}

func (s *Service) completeDigestDelivery(ctx context.Context, deliveryID int64, status, channelID, messageID, sanitizedError string, completedAt time.Time, retryAt *time.Time) error {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), deliveryCleanupTimeout)
	defer cancel()
	return s.repository.CompleteDigestDelivery(cleanupCtx, deliveryID, status, channelID, messageID, sanitizedError, completedAt, retryAt)
}

func (s *Service) abandonDigestDelivery(ctx context.Context, deliveryID int64, sanitizedError string, completedAt time.Time) error {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), deliveryCleanupTimeout)
	defer cancel()
	return s.repository.AbandonDigestDelivery(cleanupCtx, deliveryID, sanitizedError, completedAt)
}

func filterReservedEntries(items []Entry, keys []string) []Entry {
	reserved := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		reserved[key] = struct{}{}
	}
	result := make([]Entry, 0, len(keys))
	for _, item := range items {
		if _, ok := reserved[item.EventKey]; ok {
			result = append(result, item)
		}
	}
	return result
}
