package digest

import (
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/robfig/cron/v3"
)

type SubscriptionInput struct {
	Topics       []Topic
	ReleaseKinds []ReleaseKind
	Cadence      Cadence
	Weekday      time.Weekday
	TimeOfDay    string
	Region       string
	Timezone     string
	Locale       string
	Interests    []string
}

func NormalizeSubscriptionInput(input SubscriptionInput) (SubscriptionInput, error) {
	input.Topics = normalizeTopics(input.Topics)
	if len(input.Topics) == 0 {
		return SubscriptionInput{}, errors.New("at least one digest topic is required")
	}
	input.ReleaseKinds = normalizeReleaseKinds(input.ReleaseKinds)
	if len(input.ReleaseKinds) == 0 {
		return SubscriptionInput{}, errors.New("at least one release kind is required")
	}
	if !hasCompatibleRelease(input.Topics, input.ReleaseKinds) {
		return SubscriptionInput{}, errors.New("the selected topics and release kinds cannot produce a digest")
	}
	switch input.Cadence {
	case CadenceDaily, CadenceWeekly, CadenceSeasonal:
	default:
		return SubscriptionInput{}, fmt.Errorf("unsupported digest cadence %q", input.Cadence)
	}
	if input.Weekday < time.Sunday || input.Weekday > time.Saturday {
		return SubscriptionInput{}, errors.New("digest weekday is invalid")
	}
	parsedTime, err := time.Parse("15:04", strings.TrimSpace(input.TimeOfDay))
	if err != nil {
		return SubscriptionInput{}, errors.New("digest delivery time must use HH:MM")
	}
	input.TimeOfDay = parsedTime.Format("15:04")
	input.Region = strings.ToUpper(strings.TrimSpace(input.Region))
	if len(input.Region) != 2 || input.Region[0] < 'A' || input.Region[0] > 'Z' || input.Region[1] < 'A' || input.Region[1] > 'Z' {
		return SubscriptionInput{}, errors.New("digest region must be an ISO 3166-1 alpha-2 code")
	}
	input.Timezone = strings.TrimSpace(input.Timezone)
	if input.Timezone == "" {
		return SubscriptionInput{}, errors.New("digest timezone is required")
	}
	if _, err := time.LoadLocation(input.Timezone); err != nil {
		return SubscriptionInput{}, fmt.Errorf("load digest timezone: %w", err)
	}
	input.Locale = strings.ReplaceAll(strings.TrimSpace(input.Locale), "_", "-")
	if input.Locale == "" {
		input.Locale = "en-US"
	}
	if len(input.Locale) > 16 {
		return SubscriptionInput{}, errors.New("digest locale is too long")
	}
	input.Interests, err = normalizeInterests(input.Interests)
	if err != nil {
		return SubscriptionInput{}, err
	}
	return input, nil
}

func ScheduleFor(input SubscriptionInput) (string, error) {
	input, err := NormalizeSubscriptionInput(input)
	if err != nil {
		return "", err
	}
	clock, _ := time.Parse("15:04", input.TimeOfDay)
	minute, hour := clock.Minute(), clock.Hour()
	var schedule string
	switch input.Cadence {
	case CadenceDaily:
		schedule = fmt.Sprintf("%d %d * * *", minute, hour)
	case CadenceWeekly:
		schedule = fmt.Sprintf("%d %d * * %d", minute, hour, input.Weekday)
	case CadenceSeasonal:
		schedule = fmt.Sprintf("%d %d 1 1,4,7,10 *", minute, hour)
	}
	if _, err := cron.ParseStandard(schedule); err != nil {
		return "", fmt.Errorf("parse generated digest schedule: %w", err)
	}
	return schedule, nil
}

func NextScheduledAt(schedule, timezone string, after time.Time) (time.Time, error) {
	parsed, err := cron.ParseStandard(strings.TrimSpace(schedule))
	if err != nil {
		return time.Time{}, fmt.Errorf("parse digest schedule: %w", err)
	}
	location, err := time.LoadLocation(strings.TrimSpace(timezone))
	if err != nil {
		return time.Time{}, fmt.Errorf("load digest timezone: %w", err)
	}
	afterLocal := after.In(location)
	next := parsed.Next(afterLocal)
	nextLocal := next.In(location)
	// During a fall-back transition the same local clock time occurs twice.
	// Digest schedules represent one civil-time slot per eligible day, so skip
	// a second candidate whose wall clock moved backwards on that same date.
	if sameCivilDate(afterLocal, nextLocal) && civilClockMinute(nextLocal) <= civilClockMinute(afterLocal) {
		next = parsed.Next(next)
	}
	return next.UTC(), nil
}

func sameCivilDate(left, right time.Time) bool {
	leftYear, leftMonth, leftDay := left.Date()
	rightYear, rightMonth, rightDay := right.Date()
	return leftYear == rightYear && leftMonth == rightMonth && leftDay == rightDay
}

func civilClockMinute(value time.Time) int {
	return value.Hour()*60 + value.Minute()
}

func normalizeTopics(values []Topic) []Topic {
	seen := make(map[Topic]struct{}, len(values))
	for _, value := range values {
		switch value {
		case TopicAnimeSeasons, TopicShowPremieres, TopicMovieReleases:
			seen[value] = struct{}{}
		}
	}
	order := []Topic{TopicAnimeSeasons, TopicShowPremieres, TopicMovieReleases}
	out := make([]Topic, 0, len(seen))
	for _, value := range order {
		if _, ok := seen[value]; ok {
			out = append(out, value)
		}
	}
	return out
}

func normalizeReleaseKinds(values []ReleaseKind) []ReleaseKind {
	seen := make(map[ReleaseKind]struct{}, len(values))
	for _, value := range values {
		switch value {
		case ReleaseKindOnline, ReleaseKindPhysical, ReleaseKindCinema:
			seen[value] = struct{}{}
		}
	}
	order := []ReleaseKind{ReleaseKindOnline, ReleaseKindPhysical, ReleaseKindCinema}
	out := make([]ReleaseKind, 0, len(seen))
	for _, value := range order {
		if _, ok := seen[value]; ok {
			out = append(out, value)
		}
	}
	return out
}

func normalizeInterests(values []string) ([]string, error) {
	seen := make(map[string]string, len(values))
	for _, value := range values {
		value = strings.Join(strings.Fields(strings.TrimSpace(value)), " ")
		if value == "" {
			continue
		}
		if len([]rune(value)) > 40 {
			return nil, errors.New("digest interests must be at most 40 characters each")
		}
		key := strings.ToLower(value)
		if _, ok := seen[key]; !ok {
			seen[key] = value
		}
	}
	if len(seen) > 10 {
		return nil, errors.New("at most 10 digest interests are allowed")
	}
	keys := make([]string, 0, len(seen))
	for key := range seen {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		out = append(out, seen[key])
	}
	return out, nil
}

func hasCompatibleRelease(topics []Topic, kinds []ReleaseKind) bool {
	for _, kind := range kinds {
		if kind == ReleaseKindOnline {
			return true
		}
		for _, topic := range topics {
			if topic == TopicMovieReleases {
				return true
			}
		}
	}
	return false
}

func SubscriptionLabel(subscription Subscription) string {
	return "#" + strconv.FormatInt(subscription.ID, 10)
}
