package digest

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"blitzcrank/internal/recommendation"
)

const (
	DeliveryStatusClaimed     = "claimed"
	DeliveryStatusSent        = "sent"
	DeliveryStatusEmpty       = "empty"
	DeliveryStatusFailed      = "failed"
	DeliveryStatusInterrupted = "interrupted"
	deliveryCleanupTimeout    = 10 * time.Second
)

type Recommender interface {
	Recommend(context.Context, recommendation.Query) (recommendation.Result, error)
}

type DispatchStats struct {
	Due     int
	Claimed int
	Sent    int
	Empty   int
	Failed  int
	Skipped int
}

func (s DispatchStats) String() string {
	return fmt.Sprintf("due=%d claimed=%d sent=%d empty=%d failed=%d skipped=%d", s.Due, s.Claimed, s.Sent, s.Empty, s.Failed, s.Skipped)
}

func (s *Service) ConfigureRecommendations(recommender Recommender, maxItems int, retryDelay time.Duration) error {
	if recommender == nil {
		return errors.New("digest recommender is required")
	}
	if maxItems < 1 || maxItems > 20 {
		return errors.New("digest max items must be between 1 and 20")
	}
	if retryDelay <= 0 {
		return errors.New("digest retry delay must be positive")
	}
	s.recommender = recommender
	s.maxItems = maxItems
	s.retryDelay = retryDelay
	return nil
}

func (s *Service) RecoverDeliveries(ctx context.Context) error {
	if err := s.repository.MarkInterruptedDigestDeliveries(ctx, "process restarted during digest delivery", s.now().UTC()); err != nil {
		return fmt.Errorf("mark interrupted digest deliveries: %w", err)
	}
	return nil
}

func (s *Service) Preview(ctx context.Context, subscriber Subscriber, subscriptionID int64) (Content, error) {
	subscription, ok, err := s.repository.LoadDigestSubscription(ctx, subscriber, subscriptionID)
	if err != nil {
		return Content{}, fmt.Errorf("load digest subscription: %w", err)
	}
	if !ok {
		return Content{}, errors.New("digest subscription was not found")
	}
	windowStart := s.now().UTC()
	var windowEnd time.Time
	switch subscription.Cadence {
	case CadenceDaily:
		windowEnd = windowStart.AddDate(0, 0, 1)
	case CadenceSeasonal:
		windowEnd = windowStart.AddDate(0, 3, 0)
	default:
		windowEnd = windowStart.AddDate(0, 0, 7)
	}
	return s.recommend(ctx, subscription, windowStart, windowEnd)
}

func (s *Service) DispatchDue(ctx context.Context, sender Sender, limit int) (DispatchStats, error) {
	if s.recommender == nil {
		return DispatchStats{}, errors.New("digest recommender is not configured")
	}
	if sender == nil {
		return DispatchStats{}, errors.New("digest sender is required")
	}
	if limit <= 0 {
		limit = 100
	}
	now := s.now().UTC()
	subscriptions, err := s.repository.ListDueDigestSubscriptions(ctx, now, limit)
	if err != nil {
		return DispatchStats{}, fmt.Errorf("list due digest subscriptions: %w", err)
	}
	stats := DispatchStats{Due: len(subscriptions)}
	var dispatchErrors []error
	for index, subscription := range subscriptions {
		if ctxErr := ctx.Err(); ctxErr != nil {
			stats.Skipped += len(subscriptions) - index
			dispatchErrors = append(dispatchErrors, ctxErr)
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
	scheduledFor := subscription.NextRunAt.UTC()
	// A bot that was offline should not replay every missed daily/weekly
	// occurrence. Claim the persisted occurrence for idempotency, but build one
	// current forward-looking window and advance directly to the next future
	// schedule.
	windowStart := startedAt.UTC()
	nextRunAt, err := NextScheduledAt(subscription.Schedule, subscription.Timezone, windowStart)
	if err != nil {
		return "", fmt.Errorf("compute next digest run: %w", err)
	}
	delivery, claimed, err := s.repository.ClaimDigestDelivery(ctx, DeliveryClaim{
		SubscriptionID: subscription.ID,
		ScheduledFor:   scheduledFor,
		NextRunAt:      nextRunAt,
		WindowStart:    windowStart,
		WindowEnd:      nextRunAt,
		StartedAt:      startedAt,
	})
	if err != nil {
		return "", fmt.Errorf("claim digest delivery: %w", err)
	}
	if !claimed {
		return "", nil
	}

	content, recommendErr := s.recommend(ctx, subscription, windowStart, nextRunAt)
	providerUnavailable := recommendErr != nil || (content.ReleaseSourcesPartial && len(content.Items) == 0)
	if providerUnavailable {
		completedAt := s.now().UTC()
		retryAt := completedAt.Add(s.retryDelay)
		completeErr := s.completeDigestDelivery(ctx, delivery.ID, DeliveryStatusFailed, "", "", "release sources unavailable", completedAt, &retryAt)
		if completeErr != nil {
			return DeliveryStatusFailed, errors.Join(recommendErr, fmt.Errorf("complete failed digest delivery: %w", completeErr))
		}
		if recommendErr == nil {
			recommendErr = errors.New("release sources returned only partial failures")
		}
		return DeliveryStatusFailed, recommendErr
	}
	if len(content.Items) == 0 {
		if err := s.completeDigestDelivery(ctx, delivery.ID, DeliveryStatusEmpty, "", "", "", s.now().UTC(), nil); err != nil {
			return DeliveryStatusEmpty, fmt.Errorf("complete empty digest delivery: %w", err)
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
		completeErr := s.completeDigestDelivery(ctx, delivery.ID, DeliveryStatusFailed, "", "", "digest item reservation failed", completedAt, &retryAt)
		return DeliveryStatusFailed, errors.Join(fmt.Errorf("reserve digest items: %w", err), completeErr)
	}
	content.Items = filterReservedRecommendations(content.Items, reserved)
	if len(content.Items) == 0 {
		if err := s.completeDigestDelivery(ctx, delivery.ID, DeliveryStatusEmpty, "", "", "", s.now().UTC(), nil); err != nil {
			return DeliveryStatusEmpty, fmt.Errorf("complete deduplicated digest delivery: %w", err)
		}
		return DeliveryStatusEmpty, nil
	}

	current, stillExists, stateErr := s.repository.LoadDigestSubscription(ctx, subscription.Subscriber, subscription.ID)
	stillCurrent := stateErr == nil && stillExists && current.Enabled && current.NextRunAt != nil &&
		current.NextRunAt.Equal(nextRunAt) && current.UpdatedAt.Equal(startedAt)
	if !stillCurrent {
		abandonErr := s.abandonDigestDelivery(ctx, delivery.ID, "subscription changed during digest delivery", s.now().UTC())
		if stateErr != nil {
			return DeliveryStatusInterrupted, errors.Join(fmt.Errorf("recheck digest subscription: %w", stateErr), abandonErr)
		}
		if abandonErr != nil {
			return DeliveryStatusInterrupted, fmt.Errorf("abandon changed digest delivery: %w", abandonErr)
		}
		return DeliveryStatusInterrupted, nil
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		abandonErr := s.abandonDigestDelivery(ctx, delivery.ID, "digest canceled before Discord request", s.now().UTC())
		return DeliveryStatusInterrupted, errors.Join(ctxErr, abandonErr)
	}

	sent, err := sender.SendDigest(ctx, subscription, content)
	if err != nil {
		// A failed Discord request can be ambiguous after bytes leave the
		// process. Keep item reservations and do not retry automatically: a
		// rare missed digest is preferable to duplicate private notifications.
		completeErr := s.completeDigestDelivery(ctx, delivery.ID, DeliveryStatusFailed, "", "", "Discord DM failed", s.now().UTC(), nil)
		return DeliveryStatusFailed, errors.Join(fmt.Errorf("send digest DM: %w", err), completeErr)
	}
	if err := s.completeDigestDelivery(ctx, delivery.ID, DeliveryStatusSent, sent.DiscordChannelID, sent.DiscordMessageID, "", s.now().UTC(), nil); err != nil {
		return DeliveryStatusSent, fmt.Errorf("complete sent digest delivery: %w", err)
	}
	return DeliveryStatusSent, nil
}

func (s *Service) recommend(ctx context.Context, subscription Subscription, windowStart, windowEnd time.Time) (Content, error) {
	if s.recommender == nil {
		return Content{}, errors.New("digest recommender is not configured")
	}
	releaseWindowStart, releaseWindowEnd, err := releaseDateWindow(subscription.Timezone, windowStart, windowEnd)
	if err != nil {
		return Content{}, err
	}
	result, err := s.recommender.Recommend(ctx, recommendation.Query{
		SubjectID:    subscription.Subscriber.RecommendationSubjectID(),
		MediaTypes:   recommendationMediaTypes(subscription.Topics),
		ReleaseKinds: recommendationReleaseKinds(subscription.ReleaseKinds),
		Region:       subscription.Region,
		Locale:       recommendationLocale(subscription.Locale, subscription.Region),
		Window:       recommendation.Window{Start: releaseWindowStart, End: releaseWindowEnd},
		Interests:    recommendationInterests(subscription.Interests),
		MaxItems:     s.maxItems,
	})
	content := Content{
		Subscription:          subscription,
		WindowStart:           releaseWindowStart,
		WindowEnd:             releaseWindowEnd,
		Items:                 result.Items,
		Partial:               len(result.Warnings) > 0,
		ReleaseSourcesPartial: hasReleaseSourceWarning(result.Warnings),
	}
	if err != nil {
		return content, fmt.Errorf("build digest recommendations: %w", err)
	}
	return content, nil
}

func (s *Service) completeDigestDelivery(ctx context.Context, deliveryID int64, status, discordChannelID, discordMessageID, sanitizedError string, completedAt time.Time, retryAt *time.Time) error {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), deliveryCleanupTimeout)
	defer cancel()
	return s.repository.CompleteDigestDelivery(cleanupCtx, deliveryID, status, discordChannelID, discordMessageID, sanitizedError, completedAt, retryAt)
}

func (s *Service) abandonDigestDelivery(ctx context.Context, deliveryID int64, sanitizedError string, completedAt time.Time) error {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), deliveryCleanupTimeout)
	defer cancel()
	return s.repository.AbandonDigestDelivery(cleanupCtx, deliveryID, sanitizedError, completedAt)
}

func hasReleaseSourceWarning(warnings []recommendation.Warning) bool {
	for _, warning := range warnings {
		if !strings.EqualFold(strings.TrimSpace(warning.Source), "profile") {
			return true
		}
	}
	return false
}

func releaseDateWindow(timezone string, start, end time.Time) (time.Time, time.Time, error) {
	location, err := time.LoadLocation(strings.TrimSpace(timezone))
	if err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("load digest release timezone: %w", err)
	}
	localStart := start.In(location)
	localEnd := end.In(location)
	windowStart := time.Date(localStart.Year(), localStart.Month(), localStart.Day(), 0, 0, 0, 0, time.UTC)
	// Providers expose civil dates without a release time. Include the local
	// end date and rely on durable event-key dedupe at the next boundary.
	windowEnd := time.Date(localEnd.Year(), localEnd.Month(), localEnd.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, 1)
	if !windowEnd.After(windowStart) {
		windowEnd = windowStart.AddDate(0, 0, 1)
	}
	return windowStart, windowEnd, nil
}

func recommendationMediaTypes(topics []Topic) []recommendation.MediaType {
	values := make([]recommendation.MediaType, 0, len(topics))
	for _, topic := range topics {
		switch topic {
		case TopicAnimeSeasons:
			values = append(values, recommendation.MediaTypeAnime)
		case TopicShowPremieres:
			values = append(values, recommendation.MediaTypeShow)
		case TopicMovieReleases:
			values = append(values, recommendation.MediaTypeMovie)
		}
	}
	return values
}

func recommendationReleaseKinds(kinds []ReleaseKind) []recommendation.ReleaseKind {
	seen := make(map[recommendation.ReleaseKind]struct{}, len(kinds)+1)
	for _, kind := range kinds {
		switch kind {
		case ReleaseKindOnline:
			seen[recommendation.ReleaseKindAiring] = struct{}{}
			seen[recommendation.ReleaseKindDigital] = struct{}{}
		case ReleaseKindPhysical:
			seen[recommendation.ReleaseKindPhysical] = struct{}{}
		case ReleaseKindCinema:
			seen[recommendation.ReleaseKindTheatrical] = struct{}{}
		}
	}
	order := []recommendation.ReleaseKind{
		recommendation.ReleaseKindAiring,
		recommendation.ReleaseKindDigital,
		recommendation.ReleaseKindPhysical,
		recommendation.ReleaseKindTheatrical,
	}
	values := make([]recommendation.ReleaseKind, 0, len(seen))
	for _, value := range order {
		if _, ok := seen[value]; ok {
			values = append(values, value)
		}
	}
	return values
}

func recommendationInterests(interests []string) map[string]float64 {
	if len(interests) == 0 {
		return nil
	}
	weights := make(map[string]float64, len(interests))
	for _, interest := range interests {
		if interest = strings.TrimSpace(interest); interest != "" {
			weights[interest] = 3
		}
	}
	return weights
}

func recommendationLocale(locale, region string) string {
	locale = strings.TrimSpace(locale)
	if locale == "" {
		return "en-US"
	}
	if strings.Contains(locale, "-") {
		return locale
	}
	return locale + "-" + strings.ToUpper(strings.TrimSpace(region))
}

func filterReservedRecommendations(items []recommendation.Candidate, keys []string) []recommendation.Candidate {
	if len(keys) == 0 {
		return nil
	}
	reserved := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		reserved[key] = struct{}{}
	}
	filtered := make([]recommendation.Candidate, 0, len(keys))
	for _, item := range items {
		if _, ok := reserved[item.EventKey]; ok {
			filtered = append(filtered, item)
		}
	}
	return filtered
}
