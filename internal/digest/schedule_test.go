package digest

import (
	"testing"
	"time"
)

func TestNormalizeAndScheduleNewsletter(t *testing.T) {
	input, err := NormalizeSubscriptionInput(SubscriptionInput{Topics: []Topic{TopicMovies, TopicShows, TopicMovies}, Cadence: CadenceWeekly, Weekday: time.Friday, TimeOfDay: "18:00", Timezone: "Europe/Vienna", Locale: "de_AT"})
	if err != nil {
		t.Fatal(err)
	}
	if len(input.Topics) != 2 || input.Topics[0] != TopicShows || input.Locale != "de-AT" {
		t.Fatalf("input = %#v", input)
	}
	schedule, err := ScheduleFor(input)
	if err != nil || schedule != "0 18 * * 5" {
		t.Fatalf("schedule = %q, error = %v", schedule, err)
	}
	input.Cadence = CadenceMonthly
	schedule, err = ScheduleFor(input)
	if err != nil || schedule != "0 18 1 * *" {
		t.Fatalf("monthly schedule = %q, error = %v", schedule, err)
	}
}

func TestNewsletterWindow(t *testing.T) {
	subscription := Subscription{Cadence: CadenceMonthly, Timezone: "Europe/Vienna"}
	start, end, err := newsletterWindow(subscription, time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC), true)
	if err != nil {
		t.Fatal(err)
	}
	if start.In(time.FixedZone("CEST", 2*60*60)).Month() != time.August || end.In(time.FixedZone("CEST", 2*60*60)).Month() != time.September {
		t.Fatalf("window = %s - %s", start, end)
	}
}
