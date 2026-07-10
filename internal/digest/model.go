package digest

import "time"

type Topic string

const (
	TopicShows  Topic = "shows"
	TopicMovies Topic = "movies"
)

type Cadence string

const (
	CadenceWeekly  Cadence = "weekly"
	CadenceMonthly Cadence = "monthly"
)

type Subscriber struct {
	GuildID string
	UserID  string
}

type Subscription struct {
	ID              int64
	Subscriber      Subscriber
	Topics          []Topic
	Cadence         Cadence
	Schedule        string
	Weekday         time.Weekday
	TimeOfDay       string
	Timezone        string
	Locale          string
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
