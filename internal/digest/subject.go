package digest

import (
	"errors"
	"strings"
)

func (s Subscriber) RecommendationSubjectID() string {
	return strings.TrimSpace(s.GuildID) + ":" + strings.TrimSpace(s.UserID)
}

func SubscriberFromRecommendationSubject(value string) (Subscriber, error) {
	guildID, userID, ok := strings.Cut(strings.TrimSpace(value), ":")
	if !ok || strings.TrimSpace(guildID) == "" || strings.TrimSpace(userID) == "" {
		return Subscriber{}, errors.New("recommendation subject is invalid")
	}
	return Subscriber{GuildID: strings.TrimSpace(guildID), UserID: strings.TrimSpace(userID)}, nil
}
