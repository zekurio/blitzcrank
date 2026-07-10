package jellyfin

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"blitzcrank/internal/digest"
	"blitzcrank/internal/store"
)

const (
	linkAttemptWindow = 15 * time.Minute
	maxLinkAttempts   = 5
	maxAttemptBuckets = 2048
)

var (
	ErrNotLinked       = errors.New("jellyfin account is not linked")
	ErrLinkRateLimited = errors.New("too many Jellyfin linking attempts; try again later")
)

type LinkRepository interface {
	UpsertJellyfinUserLink(context.Context, store.JellyfinUserLink) error
	LoadJellyfinUserLink(context.Context, string, string) (store.JellyfinUserLink, bool, error)
	DeleteJellyfinUserLink(context.Context, string, string) error
}

type LinkService struct {
	client     *Client
	repository LinkRepository
	now        func() time.Time
	attemptMu  sync.Mutex
	attempts   map[string][]time.Time
	profileMu  sync.RWMutex
	invalidate func(string)
}

func NewLinkService(client *Client, repository LinkRepository) (*LinkService, error) {
	if client == nil {
		return nil, errors.New("jellyfin client is required")
	}
	if repository == nil {
		return nil, errors.New("jellyfin link repository is required")
	}
	if !client.allowsPasswordAuthentication() {
		return nil, ErrInsecureTransport
	}
	return &LinkService{client: client, repository: repository, now: time.Now, attempts: make(map[string][]time.Time)}, nil
}

func (s *LinkService) SetProfileInvalidator(invalidate func(string)) {
	s.profileMu.Lock()
	s.invalidate = invalidate
	s.profileMu.Unlock()
}

func (s *LinkService) Link(ctx context.Context, subscriber digest.Subscriber, username, password string) error {
	if err := validateLinkSubscriber(subscriber); err != nil {
		return err
	}
	username = strings.TrimSpace(username)
	if username == "" {
		return errors.New("jellyfin username is required")
	}
	attemptedAt := s.now().UTC()
	keys := linkAttemptKeys(subscriber, username)
	if !s.allowLinkAttempt(keys, attemptedAt) {
		return ErrLinkRateLimited
	}
	user, err := s.client.AuthenticateUserByName(ctx, username, password)
	if err != nil {
		return err
	}
	s.clearLinkAttempts(keys)
	now := s.now().UTC()
	existing, ok, err := s.repository.LoadJellyfinUserLink(ctx, subscriber.GuildID, subscriber.UserID)
	if err != nil {
		return fmt.Errorf("load Jellyfin account link: %w", err)
	}
	linkedAt := now
	if ok {
		linkedAt = existing.LinkedAt
	}
	if err := s.repository.UpsertJellyfinUserLink(ctx, store.JellyfinUserLink{
		GuildID:        subscriber.GuildID,
		DiscordUserID:  subscriber.UserID,
		JellyfinUserID: user.ID,
		LinkedAt:       linkedAt,
		UpdatedAt:      now,
	}); err != nil {
		return fmt.Errorf("save Jellyfin account link: %w", err)
	}
	s.invalidateProfile(subscriber)
	return nil
}

func (s *LinkService) allowLinkAttempt(keys [2]string, now time.Time) bool {
	s.attemptMu.Lock()
	defer s.attemptMu.Unlock()
	cutoff := now.Add(-linkAttemptWindow)
	for key, attempts := range s.attempts {
		kept := attempts[:0]
		for _, attemptedAt := range attempts {
			if attemptedAt.After(cutoff) {
				kept = append(kept, attemptedAt)
			}
		}
		if len(kept) == 0 {
			delete(s.attempts, key)
		} else {
			s.attempts[key] = kept
		}
	}
	newBuckets := 0
	for _, key := range keys {
		if len(s.attempts[key]) >= maxLinkAttempts {
			return false
		}
		if _, exists := s.attempts[key]; !exists {
			newBuckets++
		}
	}
	if len(s.attempts)+newBuckets > maxAttemptBuckets {
		return false
	}
	for _, key := range keys {
		s.attempts[key] = append(s.attempts[key], now)
	}
	return true
}

func (s *LinkService) clearLinkAttempts(keys [2]string) {
	s.attemptMu.Lock()
	defer s.attemptMu.Unlock()
	for _, key := range keys {
		delete(s.attempts, key)
	}
}

func linkAttemptKeys(subscriber digest.Subscriber, username string) [2]string {
	usernameHash := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(username))))
	return [2]string{
		"discord:" + subscriber.GuildID + ":" + subscriber.UserID,
		"jellyfin:" + hex.EncodeToString(usernameHash[:]),
	}
}

func (s *LinkService) Unlink(ctx context.Context, subscriber digest.Subscriber) error {
	if err := validateLinkSubscriber(subscriber); err != nil {
		return err
	}
	_, ok, err := s.repository.LoadJellyfinUserLink(ctx, subscriber.GuildID, subscriber.UserID)
	if err != nil {
		return fmt.Errorf("load Jellyfin account link: %w", err)
	}
	if !ok {
		return ErrNotLinked
	}
	if err := s.repository.DeleteJellyfinUserLink(ctx, subscriber.GuildID, subscriber.UserID); err != nil {
		return fmt.Errorf("delete Jellyfin account link: %w", err)
	}
	s.invalidateProfile(subscriber)
	return nil
}

func (s *LinkService) invalidateProfile(subscriber digest.Subscriber) {
	s.profileMu.RLock()
	invalidate := s.invalidate
	s.profileMu.RUnlock()
	if invalidate != nil {
		invalidate(subscriber.RecommendationSubjectID())
	}
}

func (s *LinkService) LinkStatus(ctx context.Context, subscriber digest.Subscriber) (bool, error) {
	if err := validateLinkSubscriber(subscriber); err != nil {
		return false, err
	}
	_, ok, err := s.repository.LoadJellyfinUserLink(ctx, subscriber.GuildID, subscriber.UserID)
	return ok, err
}

func validateLinkSubscriber(subscriber digest.Subscriber) error {
	if strings.TrimSpace(subscriber.GuildID) == "" || strings.TrimSpace(subscriber.UserID) == "" {
		return errors.New("jellyfin link guild and Discord user IDs are required")
	}
	return nil
}
