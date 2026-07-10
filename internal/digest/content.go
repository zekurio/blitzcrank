package digest

import (
	"context"
	"time"

	"blitzcrank/internal/recommendation"
)

// Content is the provider-neutral result used by both Discord previews and
// scheduled DM delivery. Partial is true when at least one release/profile
// source failed. ReleaseSourcesPartial excludes optional profile failures so an
// otherwise successful empty catalog result is not retried.
type Content struct {
	Subscription          Subscription
	WindowStart           time.Time
	WindowEnd             time.Time
	Items                 []recommendation.Candidate
	Partial               bool
	ReleaseSourcesPartial bool
}

type SendResult struct {
	DiscordChannelID string
	DiscordMessageID string
}

type Sender interface {
	SendDigest(context.Context, Subscription, Content) (SendResult, error)
}
