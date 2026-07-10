package digest

import "time"

type Topic string

const (
	TopicAnimeSeasons  Topic = "anime_seasons"
	TopicShowPremieres Topic = "show_premieres"
	TopicMovieReleases Topic = "movie_releases"
)

type ReleaseKind string

const (
	ReleaseKindOnline   ReleaseKind = "online"
	ReleaseKindPhysical ReleaseKind = "physical"
	ReleaseKindCinema   ReleaseKind = "cinema"
)

type Cadence string

const (
	CadenceDaily    Cadence = "daily"
	CadenceWeekly   Cadence = "weekly"
	CadenceSeasonal Cadence = "seasonal"
)

type Subscriber struct {
	GuildID string
	UserID  string
}

type Subscription struct {
	ID              int64
	Subscriber      Subscriber
	Topics          []Topic
	ReleaseKinds    []ReleaseKind
	Cadence         Cadence
	Schedule        string
	Weekday         time.Weekday
	TimeOfDay       string
	Region          string
	Timezone        string
	Locale          string
	Interests       []string
	Enabled         bool
	NextRunAt       *time.Time
	LastRunAt       *time.Time
	LastDeliveredAt *time.Time
	CreatedAt       time.Time
	UpdatedAt       time.Time
	DeletedAt       *time.Time
}

type Delivery struct {
	ID               int64
	SubscriptionID   int64
	ScheduledFor     time.Time
	WindowStart      time.Time
	WindowEnd        time.Time
	Status           string
	StartedAt        time.Time
	CompletedAt      *time.Time
	DiscordChannelID string
	DiscordMessageID string
	ItemCount        int
	Error            string
}

// DeliveryClaim contains the scheduler-owned state needed to claim one due
// subscription. NextRunAt is persisted in the same transaction as the claim so
// a restart cannot replay the same scheduled occurrence.
type DeliveryClaim struct {
	SubscriptionID int64
	ScheduledFor   time.Time
	NextRunAt      time.Time
	WindowStart    time.Time
	WindowEnd      time.Time
	StartedAt      time.Time
}
