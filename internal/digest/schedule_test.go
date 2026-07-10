package digest

import (
	"strings"
	"testing"
	"time"
)

func testSubscriptionInput() SubscriptionInput {
	return SubscriptionInput{
		Topics:       []Topic{TopicMovieReleases, TopicAnimeSeasons, TopicMovieReleases},
		ReleaseKinds: []ReleaseKind{ReleaseKindCinema, ReleaseKindOnline},
		Cadence:      CadenceWeekly,
		Weekday:      time.Friday,
		TimeOfDay:    "18:30",
		Region:       "at",
		Timezone:     "Europe/Vienna",
		Locale:       "de_AT",
		Interests:    []string{" Sci-Fi ", "sci-fi", "Thriller"},
	}
}

func TestNormalizeSubscriptionInput(t *testing.T) {
	input, err := NormalizeSubscriptionInput(testSubscriptionInput())
	if err != nil {
		t.Fatalf("NormalizeSubscriptionInput() error = %v", err)
	}
	if len(input.Topics) != 2 || input.Topics[0] != TopicAnimeSeasons || input.Topics[1] != TopicMovieReleases {
		t.Fatalf("Topics = %#v", input.Topics)
	}
	if input.Region != "AT" || input.Locale != "de-AT" || input.TimeOfDay != "18:30" {
		t.Fatalf("normalized input = %#v", input)
	}
	if len(input.Interests) != 2 || input.Interests[0] != "Sci-Fi" || input.Interests[1] != "Thriller" {
		t.Fatalf("Interests = %#v", input.Interests)
	}
}

func TestScheduleForAndNextScheduledAt(t *testing.T) {
	schedule, err := ScheduleFor(testSubscriptionInput())
	if err != nil {
		t.Fatalf("ScheduleFor() error = %v", err)
	}
	if schedule != "30 18 * * 5" {
		t.Fatalf("ScheduleFor() = %q", schedule)
	}
	after := time.Date(2026, time.July, 10, 15, 0, 0, 0, time.UTC)
	next, err := NextScheduledAt(schedule, "Europe/Vienna", after)
	if err != nil {
		t.Fatalf("NextScheduledAt() error = %v", err)
	}
	want := time.Date(2026, time.July, 10, 16, 30, 0, 0, time.UTC)
	if !next.Equal(want) {
		t.Fatalf("NextScheduledAt() = %s, want %s", next, want)
	}
}

func TestNextScheduledAtDoesNotRepeatFallBackCivilTime(t *testing.T) {
	beforeFirst, err := time.Parse(time.RFC3339, "2026-10-25T02:15:00+02:00")
	if err != nil {
		t.Fatal(err)
	}
	first, err := NextScheduledAt("30 2 * * *", "Europe/Vienna", beforeFirst)
	if err != nil {
		t.Fatal(err)
	}
	if want := time.Date(2026, time.October, 25, 0, 30, 0, 0, time.UTC); !first.Equal(want) {
		t.Fatalf("first occurrence = %s, want %s", first, want)
	}

	afterFirst, err := time.Parse(time.RFC3339, "2026-10-25T02:31:00+02:00")
	if err != nil {
		t.Fatal(err)
	}
	next, err := NextScheduledAt("30 2 * * *", "Europe/Vienna", afterFirst)
	if err != nil {
		t.Fatal(err)
	}
	if want := time.Date(2026, time.October, 26, 1, 30, 0, 0, time.UTC); !next.Equal(want) {
		t.Fatalf("next occurrence = %s, want %s", next, want)
	}
}

func TestNormalizeSubscriptionInputRejectsImpossibleCombination(t *testing.T) {
	input := testSubscriptionInput()
	input.Topics = []Topic{TopicAnimeSeasons, TopicShowPremieres}
	input.ReleaseKinds = []ReleaseKind{ReleaseKindPhysical, ReleaseKindCinema}
	_, err := NormalizeSubscriptionInput(input)
	if err == nil || !strings.Contains(err.Error(), "cannot produce") {
		t.Fatalf("NormalizeSubscriptionInput() error = %v", err)
	}
}

func TestSeasonalSchedule(t *testing.T) {
	input := testSubscriptionInput()
	input.Cadence = CadenceSeasonal
	input.TimeOfDay = "09:00"
	schedule, err := ScheduleFor(input)
	if err != nil {
		t.Fatal(err)
	}
	if schedule != "0 9 1 1,4,7,10 *" {
		t.Fatalf("ScheduleFor() = %q", schedule)
	}
}
