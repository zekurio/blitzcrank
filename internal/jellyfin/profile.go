package jellyfin

import (
	"context"
	"fmt"
	"math"
	"strings"

	"blitzcrank/internal/digest"
	"blitzcrank/internal/recommendation"
)

type ProfileSource struct {
	client     *Client
	repository LinkRepository
	limit      int
}

func NewProfileSource(client *Client, repository LinkRepository, historyLimit int) (*ProfileSource, error) {
	if client == nil {
		return nil, fmt.Errorf("jellyfin client is required")
	}
	if repository == nil {
		return nil, fmt.Errorf("jellyfin link repository is required")
	}
	if historyLimit <= 0 || historyLimit > 500 {
		historyLimit = 200
	}
	return &ProfileSource{client: client, repository: repository, limit: historyLimit}, nil
}

func (s *ProfileSource) Profile(ctx context.Context, subjectID string) (recommendation.Profile, error) {
	subscriber, err := digest.SubscriberFromRecommendationSubject(subjectID)
	if err != nil {
		return recommendation.Profile{}, err
	}
	link, ok, err := s.repository.LoadJellyfinUserLink(ctx, subscriber.GuildID, subscriber.UserID)
	if err != nil {
		return recommendation.Profile{}, fmt.Errorf("load Jellyfin recommendation link: %w", err)
	}
	if !ok {
		return recommendation.Profile{}, nil
	}
	items, err := s.client.WatchedItems(ctx, link.JellyfinUserID, s.limit)
	if err != nil {
		return recommendation.Profile{}, err
	}
	seen := make(map[string]struct{}, len(items))
	genreCounts := make(map[string]float64)
	var maximum float64
	for _, item := range items {
		if key := jellyfinMediaKey(item); key != "" {
			seen[key] = struct{}{}
		}
		for _, genre := range item.Genres {
			genre = strings.ToLower(strings.Join(strings.Fields(genre), " "))
			if genre == "" {
				continue
			}
			genreCounts[genre]++
			if genreCounts[genre] > maximum {
				maximum = genreCounts[genre]
			}
		}
	}
	profile := recommendation.Profile{
		SeenMediaKeys: make([]string, 0, len(seen)),
		GenreWeights:  make(map[string]float64, len(genreCounts)),
	}
	for key := range seen {
		profile.SeenMediaKeys = append(profile.SeenMediaKeys, key)
	}
	for genre, count := range genreCounts {
		// Log scaling keeps a long watch history from overpowering explicit
		// interests while still providing a meaningful personalization signal.
		profile.GenreWeights[genre] = 2 * math.Log1p(count) / math.Log1p(maximum)
	}
	return profile, nil
}

func jellyfinMediaKey(item WatchedItem) string {
	tmdbID := providerID(item.ProviderIDs, "tmdb")
	if tmdbID == "" {
		return ""
	}
	switch strings.ToLower(strings.TrimSpace(item.Type)) {
	case "movie":
		return "tmdb:movie:" + tmdbID
	case "series":
		return "tmdb:tv:" + tmdbID
	default:
		return ""
	}
}

func providerID(values map[string]string, name string) string {
	for key, value := range values {
		if strings.EqualFold(strings.TrimSpace(key), name) {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
