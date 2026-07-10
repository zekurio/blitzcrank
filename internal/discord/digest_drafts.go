package discord

import (
	"crypto/rand"
	"encoding/hex"
	"io"
	"strings"
	"sync"
	"time"

	"blitzcrank/internal/digest"
)

const (
	digestDraftTTL  = 15 * time.Minute
	maxDigestDrafts = 4096
)

type digestDraftKind uint8

const (
	digestDraftCreate digestDraftKind = iota + 1
	digestDraftEdit
	digestDraftManage
	digestDraftPreview
)

type digestDraft struct {
	Kind           digestDraftKind
	Subscriber     digest.Subscriber
	Locale         string
	Input          digest.SubscriptionInput
	SubscriptionID int64
	ExpiresAt      time.Time
}

type digestDraftStore struct {
	mu     sync.Mutex
	drafts map[string]digestDraft
	ttl    time.Duration
	now    func() time.Time
	random io.Reader
}

func newDigestDraftStore() *digestDraftStore {
	return &digestDraftStore{
		drafts: make(map[string]digestDraft),
		ttl:    digestDraftTTL,
		now:    time.Now,
		random: rand.Reader,
	}
}

func (s *digestDraftStore) create(draft digestDraft) (string, bool) {
	if s == nil || strings.TrimSpace(draft.Subscriber.GuildID) == "" || strings.TrimSpace(draft.Subscriber.UserID) == "" {
		return "", false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.initializeLocked()
	s.pruneLocked()
	if len(s.drafts) >= maxDigestDrafts {
		return "", false
	}
	for range 4 {
		var value [16]byte
		if _, err := io.ReadFull(s.random, value[:]); err != nil {
			return "", false
		}
		nonce := hex.EncodeToString(value[:])
		if _, exists := s.drafts[nonce]; exists {
			continue
		}
		draft.Subscriber.GuildID = strings.TrimSpace(draft.Subscriber.GuildID)
		draft.Subscriber.UserID = strings.TrimSpace(draft.Subscriber.UserID)
		draft.Locale = strings.TrimSpace(draft.Locale)
		draft.Input = cloneDigestInput(draft.Input)
		draft.ExpiresAt = s.now().Add(s.ttl)
		s.drafts[nonce] = draft
		return nonce, true
	}
	return "", false
}

func (s *digestDraftStore) load(nonce string, subscriber digest.Subscriber) (digestDraft, bool) {
	if s == nil {
		return digestDraft{}, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.initializeLocked()
	s.pruneLocked()
	draft, ok := s.drafts[strings.TrimSpace(nonce)]
	if !ok || !sameDigestSubscriber(draft.Subscriber, subscriber) {
		return digestDraft{}, false
	}
	draft.Input = cloneDigestInput(draft.Input)
	return draft, true
}

func (s *digestDraftStore) update(nonce string, subscriber digest.Subscriber, update func(*digestDraft) bool) (digestDraft, bool) {
	if s == nil || update == nil {
		return digestDraft{}, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.initializeLocked()
	s.pruneLocked()
	nonce = strings.TrimSpace(nonce)
	draft, ok := s.drafts[nonce]
	if !ok || !sameDigestSubscriber(draft.Subscriber, subscriber) {
		return digestDraft{}, false
	}
	draft.Input = cloneDigestInput(draft.Input)
	if !update(&draft) {
		return digestDraft{}, false
	}
	draft.ExpiresAt = s.now().Add(s.ttl)
	draft.Input = cloneDigestInput(draft.Input)
	s.drafts[nonce] = draft
	draft.Input = cloneDigestInput(draft.Input)
	return draft, true
}

func (s *digestDraftStore) delete(nonce string, subscriber digest.Subscriber) bool {
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.initializeLocked()
	s.pruneLocked()
	nonce = strings.TrimSpace(nonce)
	draft, ok := s.drafts[nonce]
	if !ok || !sameDigestSubscriber(draft.Subscriber, subscriber) {
		return false
	}
	delete(s.drafts, nonce)
	return true
}

func (s *digestDraftStore) initializeLocked() {
	if s.drafts == nil {
		s.drafts = make(map[string]digestDraft)
	}
	if s.ttl <= 0 {
		s.ttl = digestDraftTTL
	}
	if s.now == nil {
		s.now = time.Now
	}
	if s.random == nil {
		s.random = rand.Reader
	}
}

func (s *digestDraftStore) pruneLocked() {
	now := s.now()
	for nonce, draft := range s.drafts {
		if !draft.ExpiresAt.After(now) {
			delete(s.drafts, nonce)
		}
	}
}

func sameDigestSubscriber(left, right digest.Subscriber) bool {
	return strings.TrimSpace(left.GuildID) == strings.TrimSpace(right.GuildID) &&
		strings.TrimSpace(left.UserID) == strings.TrimSpace(right.UserID)
}

func cloneDigestInput(input digest.SubscriptionInput) digest.SubscriptionInput {
	input.Topics = append([]digest.Topic(nil), input.Topics...)
	return input
}
