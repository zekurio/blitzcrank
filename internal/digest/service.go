package digest

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

const MaxSubscriptionsPerUser = 10

var (
	ErrSubscriptionAlreadyExists = errors.New("an identical digest subscription already exists")
	ErrSubscriptionLimit         = errors.New("digest subscription limit reached")
)

type Repository interface {
	CreateDigestSubscription(context.Context, Subscription) (Subscription, error)
	UpdateDigestSubscription(context.Context, Subscriber, Subscription) error
	LoadDigestSubscription(context.Context, Subscriber, int64) (Subscription, bool, error)
	ListDigestSubscriptions(context.Context, Subscriber) ([]Subscription, error)
	SetDigestSubscriptionEnabled(context.Context, Subscriber, int64, bool, *time.Time, time.Time) error
	DeleteDigestSubscription(context.Context, Subscriber, int64, time.Time) error
	ListDueDigestSubscriptions(context.Context, time.Time, int) ([]Subscription, error)
	ClaimDigestDelivery(context.Context, DeliveryClaim) (Delivery, bool, error)
	ReserveDigestDeliveryItems(context.Context, int64, []string, time.Time) ([]string, error)
	CompleteDigestDelivery(context.Context, int64, string, string, string, string, time.Time, *time.Time) error
	AbandonDigestDelivery(context.Context, int64, string, time.Time) error
	MarkInterruptedDigestDeliveries(context.Context, string, time.Time) error
}

type Service struct {
	repository    Repository
	now           func() time.Time
	defaultRegion string
	defaultZone   string
	recommender   Recommender
	maxItems      int
	retryDelay    time.Duration
}

func NewService(repository Repository, defaultRegion, defaultTimezone string) (*Service, error) {
	if repository == nil {
		return nil, errors.New("digest repository is required")
	}
	defaultRegion = strings.ToUpper(strings.TrimSpace(defaultRegion))
	if len(defaultRegion) != 2 {
		return nil, errors.New("digest default region is invalid")
	}
	defaultTimezone = strings.TrimSpace(defaultTimezone)
	if _, err := time.LoadLocation(defaultTimezone); err != nil {
		return nil, fmt.Errorf("load digest default timezone: %w", err)
	}
	return &Service{
		repository:    repository,
		now:           time.Now,
		defaultRegion: defaultRegion,
		defaultZone:   defaultTimezone,
		maxItems:      12,
		retryDelay:    15 * time.Minute,
	}, nil
}

func (s *Service) DefaultInput(locale string) SubscriptionInput {
	return SubscriptionInput{
		Topics:       []Topic{TopicAnimeSeasons, TopicShowPremieres, TopicMovieReleases},
		ReleaseKinds: []ReleaseKind{ReleaseKindOnline, ReleaseKindPhysical, ReleaseKindCinema},
		Cadence:      CadenceWeekly,
		Weekday:      time.Friday,
		TimeOfDay:    "18:00",
		Region:       s.defaultRegion,
		Timezone:     s.defaultZone,
		Locale:       strings.TrimSpace(locale),
	}
}

func (s *Service) CreateSubscription(ctx context.Context, subscriber Subscriber, input SubscriptionInput) (Subscription, error) {
	if err := validateSubscriber(subscriber); err != nil {
		return Subscription{}, err
	}
	normalized, schedule, nextRunAt, err := s.prepareInput(input, s.now())
	if err != nil {
		return Subscription{}, err
	}
	now := s.now().UTC()
	subscription := subscriptionFromInput(subscriber, normalized, schedule)
	subscription.Enabled = true
	subscription.NextRunAt = &nextRunAt
	subscription.CreatedAt = now
	subscription.UpdatedAt = now
	created, err := s.repository.CreateDigestSubscription(ctx, subscription)
	if err != nil {
		return Subscription{}, fmt.Errorf("create digest subscription: %w", err)
	}
	return created, nil
}

func (s *Service) UpdateSubscription(ctx context.Context, subscriber Subscriber, subscriptionID int64, input SubscriptionInput) (Subscription, error) {
	current, ok, err := s.repository.LoadDigestSubscription(ctx, subscriber, subscriptionID)
	if err != nil {
		return Subscription{}, fmt.Errorf("load digest subscription: %w", err)
	}
	if !ok {
		return Subscription{}, errors.New("digest subscription was not found")
	}
	normalized, schedule, nextRunAt, err := s.prepareInput(input, s.now())
	if err != nil {
		return Subscription{}, err
	}
	updated := subscriptionFromInput(subscriber, normalized, schedule)
	updated.ID = current.ID
	updated.Enabled = current.Enabled
	updated.CreatedAt = current.CreatedAt
	updated.UpdatedAt = s.now().UTC()
	updated.LastRunAt = current.LastRunAt
	updated.LastDeliveredAt = current.LastDeliveredAt
	if updated.Enabled {
		updated.NextRunAt = &nextRunAt
	}
	if err := s.repository.UpdateDigestSubscription(ctx, subscriber, updated); err != nil {
		return Subscription{}, fmt.Errorf("update digest subscription: %w", err)
	}
	return updated, nil
}

func (s *Service) GetSubscription(ctx context.Context, subscriber Subscriber, subscriptionID int64) (Subscription, bool, error) {
	return s.repository.LoadDigestSubscription(ctx, subscriber, subscriptionID)
}

func (s *Service) ListSubscriptions(ctx context.Context, subscriber Subscriber) ([]Subscription, error) {
	if err := validateSubscriber(subscriber); err != nil {
		return nil, err
	}
	return s.repository.ListDigestSubscriptions(ctx, subscriber)
}

func (s *Service) SetSubscriptionEnabled(ctx context.Context, subscriber Subscriber, subscriptionID int64, enabled bool) error {
	current, ok, err := s.repository.LoadDigestSubscription(ctx, subscriber, subscriptionID)
	if err != nil {
		return fmt.Errorf("load digest subscription: %w", err)
	}
	if !ok {
		return errors.New("digest subscription was not found")
	}
	now := s.now().UTC()
	var nextRunAt *time.Time
	if enabled {
		next, err := NextScheduledAt(current.Schedule, current.Timezone, now)
		if err != nil {
			return err
		}
		nextRunAt = &next
	}
	if err := s.repository.SetDigestSubscriptionEnabled(ctx, subscriber, subscriptionID, enabled, nextRunAt, now); err != nil {
		return fmt.Errorf("set digest subscription state: %w", err)
	}
	return nil
}

func (s *Service) DeleteSubscription(ctx context.Context, subscriber Subscriber, subscriptionID int64) error {
	if err := s.repository.DeleteDigestSubscription(ctx, subscriber, subscriptionID, s.now().UTC()); err != nil {
		return fmt.Errorf("delete digest subscription: %w", err)
	}
	return nil
}

func (s *Service) prepareInput(input SubscriptionInput, after time.Time) (SubscriptionInput, string, time.Time, error) {
	if strings.TrimSpace(input.Region) == "" {
		input.Region = s.defaultRegion
	}
	if strings.TrimSpace(input.Timezone) == "" {
		input.Timezone = s.defaultZone
	}
	normalized, err := NormalizeSubscriptionInput(input)
	if err != nil {
		return SubscriptionInput{}, "", time.Time{}, err
	}
	schedule, err := ScheduleFor(normalized)
	if err != nil {
		return SubscriptionInput{}, "", time.Time{}, err
	}
	nextRunAt, err := NextScheduledAt(schedule, normalized.Timezone, after)
	if err != nil {
		return SubscriptionInput{}, "", time.Time{}, err
	}
	return normalized, schedule, nextRunAt, nil
}

func subscriptionFromInput(subscriber Subscriber, input SubscriptionInput, schedule string) Subscription {
	return Subscription{
		Subscriber:   subscriber,
		Topics:       append([]Topic(nil), input.Topics...),
		ReleaseKinds: append([]ReleaseKind(nil), input.ReleaseKinds...),
		Cadence:      input.Cadence,
		Schedule:     schedule,
		Weekday:      input.Weekday,
		TimeOfDay:    input.TimeOfDay,
		Region:       input.Region,
		Timezone:     input.Timezone,
		Locale:       input.Locale,
		Interests:    append([]string(nil), input.Interests...),
	}
}

func validateSubscriber(subscriber Subscriber) error {
	if strings.TrimSpace(subscriber.GuildID) == "" || strings.TrimSpace(subscriber.UserID) == "" {
		return errors.New("digest subscriber guild and user IDs are required")
	}
	return nil
}
