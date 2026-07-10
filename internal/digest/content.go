package digest

import (
	"context"
	"time"
)

type EntryKind string

const (
	EntryKindEpisode  EntryKind = "episode"
	EntryKindCinema   EntryKind = "cinema"
	EntryKindDigital  EntryKind = "digital"
	EntryKindPhysical EntryKind = "physical"
)

// Entry is one calendar event from Sonarr or Radarr. EventKey is stable across
// runs and is hashed before persistence.
type Entry struct {
	EventKey string
	Topic    Topic
	Kind     EntryKind
	Title    string
	Subtitle string
	Overview string
	OccursAt time.Time
	HasFile  bool
	Source   string
}

type CalendarQuery struct {
	Topics []Topic
	Start  time.Time
	End    time.Time
	Limit  int
}

type CalendarResult struct {
	Items    []Entry
	Warnings []string
}

type CalendarSource interface {
	Fetch(context.Context, CalendarQuery) (CalendarResult, error)
}

// Content is the calendar-neutral result used by both Discord previews and
// scheduled DM delivery.
type Content struct {
	Subscription Subscription
	WindowStart  time.Time
	WindowEnd    time.Time
	Items        []Entry
	Partial      bool
}

type SendResult struct {
	DiscordChannelID string
	DiscordMessageID string
}

type Sender interface {
	SendDigest(context.Context, Subscription, Content) (SendResult, error)
}
