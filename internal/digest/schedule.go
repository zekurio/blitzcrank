package digest

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/robfig/cron/v3"
)

type SubscriptionInput struct {
	Topics    []Topic
	Cadence   Cadence
	Weekday   time.Weekday
	TimeOfDay string
	Timezone  string
	Locale    string
}

func NormalizeSubscriptionInput(input SubscriptionInput) (SubscriptionInput, error) {
	input.Topics = normalizeTopics(input.Topics)
	if len(input.Topics) == 0 {
		return SubscriptionInput{}, errors.New("at least one newsletter topic is required")
	}
	switch input.Cadence {
	case CadenceWeekly, CadenceMonthly:
	default:
		return SubscriptionInput{}, fmt.Errorf("unsupported newsletter cadence %q", input.Cadence)
	}
	if input.Weekday < time.Sunday || input.Weekday > time.Saturday {
		return SubscriptionInput{}, errors.New("newsletter weekday is invalid")
	}
	parsedTime, err := time.Parse("15:04", strings.TrimSpace(input.TimeOfDay))
	if err != nil {
		return SubscriptionInput{}, errors.New("newsletter delivery time must use HH:MM")
	}
	input.TimeOfDay = parsedTime.Format("15:04")
	input.Timezone = strings.TrimSpace(input.Timezone)
	if input.Timezone == "" {
		return SubscriptionInput{}, errors.New("newsletter timezone is required")
	}
	if _, err := time.LoadLocation(input.Timezone); err != nil {
		return SubscriptionInput{}, fmt.Errorf("load newsletter timezone: %w", err)
	}
	input.Locale = strings.ReplaceAll(strings.TrimSpace(input.Locale), "_", "-")
	if input.Locale == "" {
		input.Locale = "en-US"
	}
	if len(input.Locale) > 16 {
		return SubscriptionInput{}, errors.New("newsletter locale is too long")
	}
	return input, nil
}

func ScheduleFor(input SubscriptionInput) (string, error) {
	input, err := NormalizeSubscriptionInput(input)
	if err != nil {
		return "", err
	}
	clock, _ := time.Parse("15:04", input.TimeOfDay)
	var schedule string
	switch input.Cadence {
	case CadenceWeekly:
		schedule = fmt.Sprintf("%d %d * * %d", clock.Minute(), clock.Hour(), input.Weekday)
	case CadenceMonthly:
		schedule = fmt.Sprintf("%d %d 1 * *", clock.Minute(), clock.Hour())
	}
	if _, err := cron.ParseStandard(schedule); err != nil {
		return "", fmt.Errorf("parse generated newsletter schedule: %w", err)
	}
	return schedule, nil
}

func NextScheduledAt(schedule, timezone string, after time.Time) (time.Time, error) {
	parsed, err := cron.ParseStandard(strings.TrimSpace(schedule))
	if err != nil {
		return time.Time{}, fmt.Errorf("parse newsletter schedule: %w", err)
	}
	location, err := time.LoadLocation(strings.TrimSpace(timezone))
	if err != nil {
		return time.Time{}, fmt.Errorf("load newsletter timezone: %w", err)
	}
	afterLocal := after.In(location)
	next := parsed.Next(afterLocal)
	nextLocal := next.In(location)
	if sameCivilDate(afterLocal, nextLocal) && civilClockMinute(nextLocal) <= civilClockMinute(afterLocal) {
		next = parsed.Next(next)
	}
	return next.UTC(), nil
}

func normalizeTopics(values []Topic) []Topic {
	seen := make(map[Topic]struct{}, len(values))
	for _, value := range values {
		switch value {
		case TopicShows, TopicMovies:
			seen[value] = struct{}{}
		}
	}
	order := []Topic{TopicShows, TopicMovies}
	out := make([]Topic, 0, len(seen))
	for _, value := range order {
		if _, ok := seen[value]; ok {
			out = append(out, value)
		}
	}
	return out
}

func sameCivilDate(left, right time.Time) bool {
	leftYear, leftMonth, leftDay := left.Date()
	rightYear, rightMonth, rightDay := right.Date()
	return leftYear == rightYear && leftMonth == rightMonth && leftDay == rightDay
}

func civilClockMinute(value time.Time) int {
	return value.Hour()*60 + value.Minute()
}

func SubscriptionLabel(subscription Subscription) string {
	return "#" + strconv.FormatInt(subscription.ID, 10)
}
