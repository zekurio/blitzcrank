package discord

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"time"

	"blitzcrank/internal/digest"

	"github.com/bwmarrin/discordgo"
)

const (
	digestCustomIDPrefix  = "digest:"
	digestExternalTimeout = 45 * time.Second
)

type DigestService interface {
	DefaultInput(string) digest.SubscriptionInput
	CreateSubscription(context.Context, digest.Subscriber, digest.SubscriptionInput) (digest.Subscription, error)
	UpdateSubscription(context.Context, digest.Subscriber, int64, digest.SubscriptionInput) (digest.Subscription, error)
	GetSubscription(context.Context, digest.Subscriber, int64) (digest.Subscription, bool, error)
	ListSubscriptions(context.Context, digest.Subscriber) ([]digest.Subscription, error)
	SetSubscriptionEnabled(context.Context, digest.Subscriber, int64, bool) error
	DeleteSubscription(context.Context, digest.Subscriber, int64) error
	Preview(context.Context, digest.Subscriber, int64) (digest.Content, error)
}

// handleDigestInteraction returns true when the interaction belongs to the
// digest command surface. The caller can use this as one branch in the shared
// Discord interaction router.
func (b *Bot) handleDigestInteraction(s *discordgo.Session, event *discordgo.InteractionCreate) bool {
	if b == nil || s == nil || event == nil || event.Interaction == nil {
		return false
	}
	switch event.Type {
	case discordgo.InteractionApplicationCommand:
		if event.ApplicationCommandData().Name != "digest" {
			return false
		}
		b.handleDigestCommand(s, event)
		return true
	case discordgo.InteractionMessageComponent:
		if !strings.HasPrefix(event.MessageComponentData().CustomID, digestCustomIDPrefix) {
			return false
		}
		b.handleDigestComponent(s, event)
		return true
	case discordgo.InteractionModalSubmit:
		if !strings.HasPrefix(event.ModalSubmitData().CustomID, digestCustomIDPrefix) {
			return false
		}
		b.handleDigestModal(s, event)
		return true
	default:
		return false
	}
}

func (b *Bot) handleDigestCommand(s *discordgo.Session, event *discordgo.InteractionCreate) {
	subscriber, locale, ok := digestInteractionIdentity(event)
	copy := digestCopyFor(event.Locale)
	if !ok || !digestServiceAvailable(b.digests) || b.digestDrafts == nil {
		_ = respondDigestEphemeral(s, event, copy.InternalError, nil, nil)
		return
	}
	options := event.ApplicationCommandData().Options
	if len(options) != 1 || options[0] == nil {
		_ = respondDigestEphemeral(s, event, copy.InvalidAction, nil, nil)
		return
	}
	switch options[0].Name {
	case "subscribe":
		input := b.digests.DefaultInput(locale)
		input.Locale = locale
		draft := digestDraft{Kind: digestDraftCreate, Subscriber: subscriber, Locale: locale, Input: input}
		nonce, created := b.digestDrafts.create(draft)
		if !created {
			_ = respondDigestEphemeral(s, event, copy.InternalError, nil, nil)
			return
		}
		content, embeds, components := digestWizardMessage(copy, nonce, input, "")
		_ = respondDigestEphemeral(s, event, content, embeds, components)
	case "manage":
		b.openDigestManager(s, event, subscriber, locale)
	case "preview":
		subscriptionID, valid := digestPreviewOption(options[0])
		if !valid {
			_ = respondDigestEphemeral(s, event, copy.InvalidAction, nil, nil)
			return
		}
		b.openDigestPreview(s, event, subscriber, locale, subscriptionID)
	default:
		_ = respondDigestEphemeral(s, event, copy.InvalidAction, nil, nil)
	}
}

func (b *Bot) handleDigestComponent(s *discordgo.Session, event *discordgo.InteractionCreate) {
	subscriber, locale, ok := digestInteractionIdentity(event)
	copy := digestCopyFor(event.Locale)
	if !ok || b.digestDrafts == nil {
		_ = respondDigestEphemeral(s, event, copy.InvalidAction, nil, nil)
		return
	}
	data := event.MessageComponentData()
	action, nonce, ok := parseDigestCustomID(data.CustomID)
	if !ok {
		_ = respondDigestEphemeral(s, event, copy.InvalidAction, nil, nil)
		return
	}
	if draft, found := b.digestDrafts.load(nonce, subscriber); found {
		locale = draft.Locale
		copy = digestCopyForLocaleString(locale)
	}
	switch action {
	case "topics", "cadence":
		b.updateDigestWizardSelection(s, event, subscriber, nonce, action, data.Values, copy)
	case "continue", "settings":
		b.openDigestSettingsModal(s, event, subscriber, nonce, copy)
	case "cancel":
		if !b.digestDrafts.delete(nonce, subscriber) {
			_ = respondDigestEphemeral(s, event, copy.InvalidAction, nil, nil)
			return
		}
		_ = respondDigestMessageUpdate(s, event, copy.Canceled, nil, nil)
	case "manage-select":
		b.selectManagedDigest(s, event, subscriber, nonce, data.Values, copy)
	case "preview-select":
		b.selectDigestPreview(s, event, subscriber, nonce, data.Values, copy)
	case "edit":
		b.editManagedDigest(s, event, subscriber, nonce, copy)
	case "toggle":
		b.toggleManagedDigest(s, event, subscriber, nonce, copy)
	case "preview":
		b.previewManagedDigest(s, event, subscriber, nonce, copy)
	case "delete":
		b.confirmDigestDelete(s, event, subscriber, nonce, copy)
	case "delete-confirm":
		b.deleteManagedDigest(s, event, subscriber, nonce, copy)
	case "back":
		b.backToDigestManager(s, event, subscriber, nonce, copy)
	default:
		_ = respondDigestEphemeral(s, event, copy.InvalidAction, nil, nil)
	}
}

func (b *Bot) handleDigestModal(s *discordgo.Session, event *discordgo.InteractionCreate) {
	subscriber, locale, ok := digestInteractionIdentity(event)
	copy := digestCopyFor(event.Locale)
	if !ok || b.digestDrafts == nil {
		_ = respondDigestEphemeral(s, event, copy.InvalidAction, nil, nil)
		return
	}
	data := event.ModalSubmitData()
	action, nonce, ok := parseDigestCustomID(data.CustomID)
	if !ok {
		_ = respondDigestEphemeral(s, event, copy.InvalidAction, nil, nil)
		return
	}
	draft, found := b.digestDrafts.load(nonce, subscriber)
	if !found {
		_ = respondDigestEphemeral(s, event, copy.InvalidAction, nil, nil)
		return
	}
	locale = draft.Locale
	copy = digestCopyForLocaleString(locale)
	switch action {
	case "settings-modal":
		b.saveDigestSettings(s, event, subscriber, nonce, draft, data, copy)
	default:
		_ = respondDigestEphemeral(s, event, copy.InvalidAction, nil, nil)
	}
}

func (b *Bot) openDigestManager(s *discordgo.Session, event *discordgo.InteractionCreate, subscriber digest.Subscriber, locale string) {
	copy := digestCopyForLocaleString(locale)
	subscriptions, err := b.listDigestSubscriptions(subscriber)
	if err != nil {
		_ = respondDigestEphemeral(s, event, copy.InternalError, nil, nil)
		return
	}
	if len(subscriptions) == 0 {
		_ = respondDigestEphemeral(s, event, copy.NoSubscriptions, nil, nil)
		return
	}
	nonce, created := b.digestDrafts.create(digestDraft{Kind: digestDraftManage, Subscriber: subscriber, Locale: locale})
	if !created {
		_ = respondDigestEphemeral(s, event, copy.InternalError, nil, nil)
		return
	}
	content, components := digestSubscriptionPicker(copy, nonce, subscriptions, "manage-select")
	_ = respondDigestEphemeral(s, event, content, nil, components)
}

func (b *Bot) openDigestPreview(s *discordgo.Session, event *discordgo.InteractionCreate, subscriber digest.Subscriber, locale string, subscriptionID int64) {
	copy := digestCopyForLocaleString(locale)
	if subscriptionID > 0 {
		subscription, ok, err := b.getDigestSubscription(subscriber, subscriptionID)
		if err != nil || !ok {
			_ = respondDigestEphemeral(s, event, copy.InvalidAction, nil, nil)
			return
		}
		b.startDigestPreview(s, event, subscriber, subscription, copy)
		return
	}
	subscriptions, err := b.listDigestSubscriptions(subscriber)
	if err != nil {
		_ = respondDigestEphemeral(s, event, copy.InternalError, nil, nil)
		return
	}
	if len(subscriptions) == 0 {
		_ = respondDigestEphemeral(s, event, copy.NoSubscriptions, nil, nil)
		return
	}
	if len(subscriptions) == 1 {
		b.startDigestPreview(s, event, subscriber, subscriptions[0], copy)
		return
	}
	nonce, created := b.digestDrafts.create(digestDraft{Kind: digestDraftPreview, Subscriber: subscriber, Locale: locale})
	if !created {
		_ = respondDigestEphemeral(s, event, copy.InternalError, nil, nil)
		return
	}
	content, components := digestSubscriptionPicker(copy, nonce, subscriptions, "preview-select")
	_ = respondDigestEphemeral(s, event, content, nil, components)
}

func (b *Bot) updateDigestWizardSelection(s *discordgo.Session, event *discordgo.InteractionCreate, subscriber digest.Subscriber, nonce, action string, values []string, copy digestCopy) {
	draft, ok := b.digestDrafts.update(nonce, subscriber, func(draft *digestDraft) bool {
		if draft.Kind != digestDraftCreate && draft.Kind != digestDraftEdit {
			return false
		}
		switch action {
		case "topics":
			selected := parseDigestTopics(values)
			if len(selected) == 0 {
				return false
			}
			draft.Input.Topics = selected
		case "cadence":
			cadence, valid := parseDigestCadence(values)
			if !valid {
				return false
			}
			draft.Input.Cadence = cadence
		}
		return true
	})
	if !ok {
		_ = respondDigestEphemeral(s, event, copy.InvalidAction, nil, nil)
		return
	}
	content, embeds, components := digestWizardMessage(copy, nonce, draft.Input, "")
	_ = respondDigestMessageUpdate(s, event, content, embeds, components)
}

func (b *Bot) openDigestSettingsModal(s *discordgo.Session, event *discordgo.InteractionCreate, subscriber digest.Subscriber, nonce string, copy digestCopy) {
	draft, ok := b.digestDrafts.update(nonce, subscriber, func(draft *digestDraft) bool {
		return draft.Kind == digestDraftCreate || draft.Kind == digestDraftEdit
	})
	if !ok || (draft.Kind != digestDraftCreate && draft.Kind != digestDraftEdit) {
		_ = respondDigestEphemeral(s, event, copy.InvalidAction, nil, nil)
		return
	}
	if len(draft.Input.Topics) == 0 || draft.Input.Cadence == "" {
		content, embeds, components := digestWizardMessage(copy, nonce, draft.Input, copy.ChooseAll)
		_ = respondDigestMessageUpdate(s, event, content, embeds, components)
		return
	}
	if _, err := digest.NormalizeSubscriptionInput(draft.Input); err != nil {
		content, embeds, components := digestWizardMessage(copy, nonce, draft.Input, copy.InvalidCombination)
		_ = respondDigestMessageUpdate(s, event, content, embeds, components)
		return
	}
	_ = s.InteractionRespond(event.Interaction, digestSettingsModal(nonce, draft.Input, copy))
}

func (b *Bot) saveDigestSettings(s *discordgo.Session, event *discordgo.InteractionCreate, subscriber digest.Subscriber, nonce string, draft digestDraft, data discordgo.ModalSubmitInteractionData, copy digestCopy) {
	if !digestServiceAvailable(b.digests) || (draft.Kind != digestDraftCreate && draft.Kind != digestDraftEdit) {
		_ = respondDigestEphemeral(s, event, copy.InvalidAction, nil, nil)
		return
	}
	values, ok := safeDigestModalValues(data.Components, map[string]bool{"timezone": true, "time": true, "weekday": true})
	if !ok {
		_ = respondDigestEphemeral(s, event, copy.InvalidSettings, nil, digestSettingsRetryComponents(nonce, copy))
		return
	}
	input, ok := digestInputFromSettings(draft.Input, draft.Locale, values)
	if !ok {
		_ = respondDigestEphemeral(s, event, copy.InvalidSettings, nil, digestSettingsRetryComponents(nonce, copy))
		return
	}
	if _, ok := b.digestDrafts.update(nonce, subscriber, func(current *digestDraft) bool {
		if current.Kind != draft.Kind || current.SubscriptionID != draft.SubscriptionID {
			return false
		}
		current.Input = input
		return true
	}); !ok {
		_ = respondDigestEphemeral(s, event, copy.InvalidAction, nil, nil)
		return
	}
	ctx, cancel := context.WithTimeout(b.digestBaseContext(), 2*time.Second)
	defer cancel()
	var err error
	message := copy.SubscriptionCreated
	if draft.Kind == digestDraftEdit {
		_, err = b.digests.UpdateSubscription(ctx, subscriber, draft.SubscriptionID, input)
		message = copy.SubscriptionUpdated
	} else {
		_, err = b.digests.CreateSubscription(ctx, subscriber, input)
	}
	if err != nil {
		message := copy.InternalError
		switch {
		case errors.Is(err, digest.ErrSubscriptionAlreadyExists):
			message = copy.SubscriptionExists
		case errors.Is(err, digest.ErrSubscriptionLimit):
			message = copy.SubscriptionLimit
		}
		_ = respondDigestEphemeral(s, event, message, nil, digestSettingsRetryComponents(nonce, copy))
		return
	}
	b.digestDrafts.delete(nonce, subscriber)
	_ = respondDigestEphemeral(s, event, message, nil, nil)
}

func (b *Bot) selectManagedDigest(s *discordgo.Session, event *discordgo.InteractionCreate, subscriber digest.Subscriber, nonce string, values []string, copy digestCopy) {
	subscriptionID, ok := digestSubscriptionID(values)
	if !ok {
		_ = respondDigestEphemeral(s, event, copy.InvalidAction, nil, nil)
		return
	}
	draft, ok := b.digestDrafts.update(nonce, subscriber, func(draft *digestDraft) bool {
		if draft.Kind != digestDraftManage {
			return false
		}
		draft.SubscriptionID = subscriptionID
		return true
	})
	if !ok {
		_ = respondDigestEphemeral(s, event, copy.InvalidAction, nil, nil)
		return
	}
	subscription, found, err := b.getDigestSubscription(subscriber, draft.SubscriptionID)
	if err != nil || !found {
		_ = respondDigestEphemeral(s, event, copy.InvalidAction, nil, nil)
		return
	}
	_ = respondDigestMessageUpdate(s, event, "", []*discordgo.MessageEmbed{renderDigestSubscription(subscription, copy)}, digestManageButtons(nonce, subscription, copy))
}

func (b *Bot) selectDigestPreview(s *discordgo.Session, event *discordgo.InteractionCreate, subscriber digest.Subscriber, nonce string, values []string, copy digestCopy) {
	draft, ok := b.digestDrafts.load(nonce, subscriber)
	if !ok || draft.Kind != digestDraftPreview {
		_ = respondDigestEphemeral(s, event, copy.InvalidAction, nil, nil)
		return
	}
	subscriptionID, ok := digestSubscriptionID(values)
	if !ok {
		_ = respondDigestEphemeral(s, event, copy.InvalidAction, nil, nil)
		return
	}
	subscription, found, err := b.getDigestSubscription(subscriber, subscriptionID)
	if err != nil || !found {
		_ = respondDigestEphemeral(s, event, copy.InvalidAction, nil, nil)
		return
	}
	b.digestDrafts.delete(nonce, subscriber)
	b.startDigestPreview(s, event, subscriber, subscription, copy)
}

func (b *Bot) editManagedDigest(s *discordgo.Session, event *discordgo.InteractionCreate, subscriber digest.Subscriber, nonce string, copy digestCopy) {
	draft, ok := b.digestDrafts.load(nonce, subscriber)
	if !ok || draft.Kind != digestDraftManage || draft.SubscriptionID <= 0 {
		_ = respondDigestEphemeral(s, event, copy.InvalidAction, nil, nil)
		return
	}
	subscription, found, err := b.getDigestSubscription(subscriber, draft.SubscriptionID)
	if err != nil || !found {
		_ = respondDigestEphemeral(s, event, copy.InvalidAction, nil, nil)
		return
	}
	draft, ok = b.digestDrafts.update(nonce, subscriber, func(draft *digestDraft) bool {
		draft.Kind = digestDraftEdit
		draft.Input = digestInputFromSubscription(subscription)
		draft.Input.Locale = draft.Locale
		return true
	})
	if !ok {
		_ = respondDigestEphemeral(s, event, copy.InvalidAction, nil, nil)
		return
	}
	content, embeds, components := digestWizardMessage(copy, nonce, draft.Input, "")
	_ = respondDigestMessageUpdate(s, event, content, embeds, components)
}

func (b *Bot) toggleManagedDigest(s *discordgo.Session, event *discordgo.InteractionCreate, subscriber digest.Subscriber, nonce string, copy digestCopy) {
	_, subscription, ok := b.managedDigest(subscriber, nonce)
	if !ok || !digestServiceAvailable(b.digests) {
		_ = respondDigestEphemeral(s, event, copy.InvalidAction, nil, nil)
		return
	}
	ctx, cancel := context.WithTimeout(b.digestBaseContext(), 2*time.Second)
	err := b.digests.SetSubscriptionEnabled(ctx, subscriber, subscription.ID, !subscription.Enabled)
	cancel()
	if err != nil {
		_ = respondDigestEphemeral(s, event, copy.InternalError, nil, nil)
		return
	}
	subscription, found, err := b.getDigestSubscription(subscriber, subscription.ID)
	if err != nil || !found {
		_ = respondDigestEphemeral(s, event, copy.InternalError, nil, nil)
		return
	}
	message := copy.SubscriptionPaused
	if subscription.Enabled {
		message = copy.SubscriptionResumed
	}
	_ = respondDigestMessageUpdate(s, event, message, []*discordgo.MessageEmbed{renderDigestSubscription(subscription, copy)}, digestManageButtons(nonce, subscription, copy))
}

func (b *Bot) previewManagedDigest(s *discordgo.Session, event *discordgo.InteractionCreate, subscriber digest.Subscriber, nonce string, copy digestCopy) {
	_, subscription, ok := b.managedDigest(subscriber, nonce)
	if !ok {
		_ = respondDigestEphemeral(s, event, copy.InvalidAction, nil, nil)
		return
	}
	b.startDigestPreview(s, event, subscriber, subscription, copy)
}

func (b *Bot) confirmDigestDelete(s *discordgo.Session, event *discordgo.InteractionCreate, subscriber digest.Subscriber, nonce string, copy digestCopy) {
	_, subscription, ok := b.managedDigest(subscriber, nonce)
	if !ok {
		_ = respondDigestEphemeral(s, event, copy.InvalidAction, nil, nil)
		return
	}
	_ = respondDigestMessageUpdate(s, event, copy.ConfirmDelete, []*discordgo.MessageEmbed{renderDigestSubscription(subscription, copy)}, digestDeleteButtons(nonce, copy))
}

func (b *Bot) deleteManagedDigest(s *discordgo.Session, event *discordgo.InteractionCreate, subscriber digest.Subscriber, nonce string, copy digestCopy) {
	_, subscription, ok := b.managedDigest(subscriber, nonce)
	if !ok || !digestServiceAvailable(b.digests) {
		_ = respondDigestEphemeral(s, event, copy.InvalidAction, nil, nil)
		return
	}
	ctx, cancel := context.WithTimeout(b.digestBaseContext(), 2*time.Second)
	err := b.digests.DeleteSubscription(ctx, subscriber, subscription.ID)
	cancel()
	if err != nil {
		_ = respondDigestEphemeral(s, event, copy.InternalError, nil, nil)
		return
	}
	b.digestDrafts.delete(nonce, subscriber)
	_ = respondDigestMessageUpdate(s, event, copy.SubscriptionDeleted, nil, nil)
}

func (b *Bot) backToDigestManager(s *discordgo.Session, event *discordgo.InteractionCreate, subscriber digest.Subscriber, nonce string, copy digestCopy) {
	_, ok := b.digestDrafts.update(nonce, subscriber, func(draft *digestDraft) bool {
		if draft.Kind != digestDraftManage {
			return false
		}
		draft.SubscriptionID = 0
		return true
	})
	if !ok {
		_ = respondDigestEphemeral(s, event, copy.InvalidAction, nil, nil)
		return
	}
	subscriptions, err := b.listDigestSubscriptions(subscriber)
	if err != nil {
		_ = respondDigestEphemeral(s, event, copy.InternalError, nil, nil)
		return
	}
	if len(subscriptions) == 0 {
		b.digestDrafts.delete(nonce, subscriber)
		_ = respondDigestMessageUpdate(s, event, copy.NoSubscriptions, nil, nil)
		return
	}
	content, components := digestSubscriptionPicker(copy, nonce, subscriptions, "manage-select")
	_ = respondDigestMessageUpdate(s, event, content, nil, components)
}

func (b *Bot) managedDigest(subscriber digest.Subscriber, nonce string) (digestDraft, digest.Subscription, bool) {
	draft, ok := b.digestDrafts.update(nonce, subscriber, func(draft *digestDraft) bool {
		return draft.Kind == digestDraftManage && draft.SubscriptionID > 0
	})
	if !ok || draft.Kind != digestDraftManage || draft.SubscriptionID <= 0 {
		return digestDraft{}, digest.Subscription{}, false
	}
	subscription, found, err := b.getDigestSubscription(subscriber, draft.SubscriptionID)
	return draft, subscription, err == nil && found
}

func (b *Bot) startDigestPreview(s *discordgo.Session, event *discordgo.InteractionCreate, subscriber digest.Subscriber, subscription digest.Subscription, copy digestCopy) {
	if !digestServiceAvailable(b.digests) {
		_ = respondDigestEphemeral(s, event, copy.InternalError, nil, nil)
		return
	}
	if err := respondDigestDeferred(s, event); err != nil {
		return
	}
	started := b.tasks.goRun(func() {
		ctx, cancel := context.WithTimeout(b.digestBaseContext(), digestExternalTimeout)
		defer cancel()
		content, err := b.digests.Preview(ctx, subscriber, subscription.ID)
		if err != nil {
			_ = editDigestResponse(s, event, copy.InternalError, nil)
			return
		}
		message, embeds := renderDigestContent(subscription, content, true)
		_ = editDigestResponse(s, event, message, embeds)
	})
	if !started {
		_ = editDigestResponse(s, event, copy.InternalError, nil)
	}
}

func (b *Bot) listDigestSubscriptions(subscriber digest.Subscriber) ([]digest.Subscription, error) {
	if !digestServiceAvailable(b.digests) {
		return nil, fmt.Errorf("digest service is unavailable")
	}
	ctx, cancel := context.WithTimeout(b.digestBaseContext(), 2*time.Second)
	defer cancel()
	return b.digests.ListSubscriptions(ctx, subscriber)
}

func (b *Bot) getDigestSubscription(subscriber digest.Subscriber, subscriptionID int64) (digest.Subscription, bool, error) {
	if !digestServiceAvailable(b.digests) || subscriptionID <= 0 {
		return digest.Subscription{}, false, nil
	}
	ctx, cancel := context.WithTimeout(b.digestBaseContext(), 2*time.Second)
	defer cancel()
	return b.digests.GetSubscription(ctx, subscriber, subscriptionID)
}

func (b *Bot) digestBaseContext() context.Context {
	if b != nil && b.ctx != nil {
		return b.ctx
	}
	return context.Background()
}

func digestServiceAvailable(service DigestService) bool {
	return nonNilInterface(service)
}

func nonNilInterface(value any) bool {
	if value == nil {
		return false
	}
	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return !reflected.IsNil()
	default:
		return true
	}
}

func digestInteractionIdentity(event *discordgo.InteractionCreate) (digest.Subscriber, string, bool) {
	if event == nil || event.Interaction == nil || strings.TrimSpace(event.GuildID) == "" {
		return digest.Subscriber{}, "", false
	}
	var userID string
	if event.Member != nil && event.Member.User != nil {
		userID = event.Member.User.ID
	} else if event.User != nil {
		userID = event.User.ID
	}
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return digest.Subscriber{}, "", false
	}
	return digest.Subscriber{GuildID: strings.TrimSpace(event.GuildID), UserID: userID}, canonicalDigestLocale(event.Locale), true
}

func digestPreviewOption(subcommand *discordgo.ApplicationCommandInteractionDataOption) (int64, bool) {
	if subcommand == nil {
		return 0, false
	}
	for _, option := range subcommand.Options {
		if option == nil || option.Name != "subscription" {
			continue
		}
		if option.Type != discordgo.ApplicationCommandOptionInteger {
			return 0, false
		}
		switch value := option.Value.(type) {
		case float64:
			return int64(value), value >= 1 && value == float64(int64(value))
		case int64:
			return value, value > 0
		case int:
			return int64(value), value > 0
		default:
			return 0, false
		}
	}
	return 0, true
}

func parseDigestCustomID(customID string) (string, string, bool) {
	parts := strings.Split(customID, ":")
	if len(parts) != 3 || parts[0] != "digest" || strings.TrimSpace(parts[1]) == "" || len(parts[2]) != 32 {
		return "", "", false
	}
	if strings.ToLower(parts[2]) != parts[2] {
		return "", "", false
	}
	decoded, err := hex.DecodeString(parts[2])
	if err != nil || len(decoded) != 16 {
		return "", "", false
	}
	return parts[1], parts[2], true
}

func digestCustomID(action, nonce string) string {
	return "digest:" + action + ":" + nonce
}

func parseDigestTopics(values []string) []digest.Topic {
	seen := make(map[digest.Topic]struct{}, len(values))
	for _, value := range values {
		switch digest.Topic(value) {
		case digest.TopicShows, digest.TopicMovies:
			seen[digest.Topic(value)] = struct{}{}
		}
	}
	order := []digest.Topic{digest.TopicShows, digest.TopicMovies}
	return selectedDigestTopics(order, seen)
}

func selectedDigestTopics(order []digest.Topic, seen map[digest.Topic]struct{}) []digest.Topic {
	result := make([]digest.Topic, 0, len(seen))
	for _, value := range order {
		if _, ok := seen[value]; ok {
			result = append(result, value)
		}
	}
	return result
}

func parseDigestCadence(values []string) (digest.Cadence, bool) {
	if len(values) != 1 {
		return "", false
	}
	value := digest.Cadence(values[0])
	return value, value == digest.CadenceWeekly || value == digest.CadenceMonthly
}

func digestSubscriptionID(values []string) (int64, bool) {
	if len(values) != 1 {
		return 0, false
	}
	value, err := strconv.ParseInt(values[0], 10, 64)
	return value, err == nil && value > 0
}

func digestInputFromSubscription(subscription digest.Subscription) digest.SubscriptionInput {
	return digest.SubscriptionInput{
		Topics: append([]digest.Topic(nil), subscription.Topics...), Cadence: subscription.Cadence,
		Weekday: subscription.Weekday, TimeOfDay: subscription.TimeOfDay, Timezone: subscription.Timezone, Locale: subscription.Locale,
	}
}

func digestInputFromSettings(input digest.SubscriptionInput, locale string, values map[string]string) (digest.SubscriptionInput, bool) {
	weekday, ok := parseDigestWeekday(values["weekday"])
	if !ok {
		return digest.SubscriptionInput{}, false
	}
	input.Timezone = values["timezone"]
	input.TimeOfDay = values["time"]
	input.Weekday = weekday
	input.Locale = locale
	normalized, err := digest.NormalizeSubscriptionInput(input)
	return normalized, err == nil
}

func parseDigestWeekday(value string) (time.Weekday, bool) {
	value = strings.ToLower(strings.TrimSpace(value))
	weekdays := map[string]time.Weekday{
		"0": time.Sunday, "sunday": time.Sunday, "sun": time.Sunday, "sonntag": time.Sunday, "so": time.Sunday,
		"1": time.Monday, "monday": time.Monday, "mon": time.Monday, "montag": time.Monday, "mo": time.Monday,
		"2": time.Tuesday, "tuesday": time.Tuesday, "tue": time.Tuesday, "dienstag": time.Tuesday, "di": time.Tuesday,
		"3": time.Wednesday, "wednesday": time.Wednesday, "wed": time.Wednesday, "mittwoch": time.Wednesday, "mi": time.Wednesday,
		"4": time.Thursday, "thursday": time.Thursday, "thu": time.Thursday, "donnerstag": time.Thursday, "do": time.Thursday,
		"5": time.Friday, "friday": time.Friday, "fri": time.Friday, "freitag": time.Friday, "fr": time.Friday,
		"6": time.Saturday, "saturday": time.Saturday, "sat": time.Saturday, "samstag": time.Saturday, "sa": time.Saturday,
	}
	weekday, ok := weekdays[value]
	return weekday, ok
}

func formatDigestWeekday(weekday time.Weekday, locale string) string {
	if weekday < time.Sunday || weekday > time.Saturday {
		weekday = time.Friday
	}
	if strings.HasPrefix(strings.ToLower(locale), "de") {
		return []string{"Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"}[weekday]
	}
	return weekday.String()
}

func safeDigestModalValues(components []discordgo.MessageComponent, allowed map[string]bool) (map[string]string, bool) {
	values := make(map[string]string, len(allowed))
	for _, component := range components {
		row, ok := digestActionRow(component)
		if !ok || len(row) != 1 {
			return nil, false
		}
		input, ok := digestTextInput(row[0])
		if !ok || !allowed[input.CustomID] {
			return nil, false
		}
		if _, duplicate := values[input.CustomID]; duplicate {
			return nil, false
		}
		values[input.CustomID] = input.Value
	}
	for customID := range allowed {
		if _, ok := values[customID]; !ok {
			return nil, false
		}
	}
	return values, true
}

func digestActionRow(component discordgo.MessageComponent) ([]discordgo.MessageComponent, bool) {
	switch row := component.(type) {
	case *discordgo.ActionsRow:
		if row == nil {
			return nil, false
		}
		return row.Components, true
	case discordgo.ActionsRow:
		return row.Components, true
	default:
		return nil, false
	}
}

func digestTextInput(component discordgo.MessageComponent) (discordgo.TextInput, bool) {
	switch input := component.(type) {
	case *discordgo.TextInput:
		if input == nil {
			return discordgo.TextInput{}, false
		}
		return *input, true
	case discordgo.TextInput:
		return input, true
	default:
		return discordgo.TextInput{}, false
	}
}

func digestWizardMessage(copy digestCopy, nonce string, input digest.SubscriptionInput, warning string) (string, []*discordgo.MessageEmbed, []discordgo.MessageComponent) {
	content := "**" + copy.SubscribeTitle + "**\n" + copy.SubscribeIntro
	if warning != "" {
		content += "\n\n⚠️ " + warning
	}
	minimum := 1
	components := []discordgo.MessageComponent{
		discordgo.ActionsRow{Components: []discordgo.MessageComponent{discordgo.SelectMenu{
			CustomID: digestCustomID("topics", nonce), Placeholder: copy.TopicsPlaceholder, MinValues: &minimum, MaxValues: 2,
			Options: []discordgo.SelectMenuOption{
				{Label: copy.ShowPremieres, Description: copy.ShowDescription, Value: string(digest.TopicShows), Default: containsDigestTopic(input.Topics, digest.TopicShows)},
				{Label: copy.MovieReleases, Description: copy.MovieDescription, Value: string(digest.TopicMovies), Default: containsDigestTopic(input.Topics, digest.TopicMovies)},
			},
		}}},
		discordgo.ActionsRow{Components: []discordgo.MessageComponent{discordgo.SelectMenu{
			CustomID: digestCustomID("cadence", nonce), Placeholder: copy.CadencePlaceholder, MinValues: &minimum, MaxValues: 1,
			Options: []discordgo.SelectMenuOption{
				{Label: copy.Weekly, Value: string(digest.CadenceWeekly), Default: input.Cadence == digest.CadenceWeekly},
				{Label: copy.Seasonal, Value: string(digest.CadenceMonthly), Default: input.Cadence == digest.CadenceMonthly},
			},
		}}},
		discordgo.ActionsRow{Components: []discordgo.MessageComponent{
			discordgo.Button{CustomID: digestCustomID("continue", nonce), Label: copy.Continue, Style: discordgo.PrimaryButton},
			discordgo.Button{CustomID: digestCustomID("cancel", nonce), Label: copy.Cancel, Style: discordgo.SecondaryButton},
		}},
	}
	return content, nil, components
}

func containsDigestTopic(values []digest.Topic, wanted digest.Topic) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func digestSettingsModal(nonce string, input digest.SubscriptionInput, copy digestCopy) *discordgo.InteractionResponse {
	return &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseModal,
		Data: &discordgo.InteractionResponseData{
			CustomID: digestCustomID("settings-modal", nonce),
			Title:    truncateDigestText(copy.SettingsTitle, 45),
			Components: []discordgo.MessageComponent{
				digestTextInputRow("timezone", copy.TimezoneLabel, copy.TimezonePlaceholder, input.Timezone, true, 1, 64),
				digestTextInputRow("time", copy.TimeLabel, copy.TimePlaceholder, input.TimeOfDay, true, 5, 5),
				digestTextInputRow("weekday", copy.WeekdayLabel, copy.WeekdayPlaceholder, formatDigestWeekday(input.Weekday, input.Locale), true, 1, 12),
			},
		},
	}
}

func digestTextInputRow(customID, label, placeholder, value string, required bool, minimum, maximum int) discordgo.ActionsRow {
	return discordgo.ActionsRow{Components: []discordgo.MessageComponent{discordgo.TextInput{
		CustomID: customID, Label: truncateDigestText(label, 45), Style: discordgo.TextInputShort,
		Placeholder: truncateDigestText(placeholder, 100), Value: truncateDigestText(value, maximum), Required: required,
		MinLength: minimum, MaxLength: maximum,
	}}}
}

func digestSettingsRetryComponents(nonce string, copy digestCopy) []discordgo.MessageComponent {
	return []discordgo.MessageComponent{discordgo.ActionsRow{Components: []discordgo.MessageComponent{
		discordgo.Button{CustomID: digestCustomID("settings", nonce), Label: copy.Edit, Style: discordgo.PrimaryButton},
		discordgo.Button{CustomID: digestCustomID("cancel", nonce), Label: copy.Cancel, Style: discordgo.SecondaryButton},
	}}}
}

func digestSubscriptionPicker(copy digestCopy, nonce string, subscriptions []digest.Subscription, action string) (string, []discordgo.MessageComponent) {
	options := make([]discordgo.SelectMenuOption, 0, len(subscriptions))
	for _, subscription := range subscriptions {
		state := copy.Paused
		if subscription.Enabled {
			state = copy.Active
		}
		options = append(options, discordgo.SelectMenuOption{
			Label:       digestSubscriptionLabel(subscription, copy),
			Value:       strconv.FormatInt(subscription.ID, 10),
			Description: truncateDigestText(state+" · "+digestCadenceLabel(subscription.Cadence, copy)+" · "+subscription.Timezone, 100),
		})
	}
	return "**" + copy.ManageTitle + "**", []discordgo.MessageComponent{discordgo.ActionsRow{Components: []discordgo.MessageComponent{
		discordgo.SelectMenu{CustomID: digestCustomID(action, nonce), Placeholder: copy.ManagePlaceholder, Options: options, MaxValues: 1},
	}}}
}

func digestManageButtons(nonce string, subscription digest.Subscription, copy digestCopy) []discordgo.MessageComponent {
	toggleLabel := copy.Resume
	if subscription.Enabled {
		toggleLabel = copy.Pause
	}
	return []discordgo.MessageComponent{discordgo.ActionsRow{Components: []discordgo.MessageComponent{
		discordgo.Button{CustomID: digestCustomID("edit", nonce), Label: copy.Edit, Style: discordgo.SecondaryButton},
		discordgo.Button{CustomID: digestCustomID("toggle", nonce), Label: toggleLabel, Style: discordgo.SecondaryButton},
		discordgo.Button{CustomID: digestCustomID("preview", nonce), Label: copy.Preview, Style: discordgo.PrimaryButton},
		discordgo.Button{CustomID: digestCustomID("delete", nonce), Label: copy.Delete, Style: discordgo.DangerButton},
		discordgo.Button{CustomID: digestCustomID("back", nonce), Label: copy.Back, Style: discordgo.SecondaryButton},
	}}}
}

func digestDeleteButtons(nonce string, copy digestCopy) []discordgo.MessageComponent {
	return []discordgo.MessageComponent{discordgo.ActionsRow{Components: []discordgo.MessageComponent{
		discordgo.Button{CustomID: digestCustomID("delete-confirm", nonce), Label: copy.DeleteNow, Style: discordgo.DangerButton},
		discordgo.Button{CustomID: digestCustomID("back", nonce), Label: copy.Back, Style: discordgo.SecondaryButton},
	}}}
}

func respondDigestEphemeral(s *discordgo.Session, event *discordgo.InteractionCreate, content string, embeds []*discordgo.MessageEmbed, components []discordgo.MessageComponent) error {
	return s.InteractionRespond(event.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseChannelMessageWithSource,
		Data: digestResponseData(content, embeds, components, discordgo.MessageFlagsEphemeral),
	})
}

func respondDigestMessageUpdate(s *discordgo.Session, event *discordgo.InteractionCreate, content string, embeds []*discordgo.MessageEmbed, components []discordgo.MessageComponent) error {
	return s.InteractionRespond(event.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseUpdateMessage,
		Data: digestResponseData(content, embeds, components, 0),
	})
}

func respondDigestDeferred(s *discordgo.Session, event *discordgo.InteractionCreate) error {
	return s.InteractionRespond(event.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseDeferredChannelMessageWithSource,
		Data: &discordgo.InteractionResponseData{Flags: discordgo.MessageFlagsEphemeral},
	})
}

func digestResponseData(content string, embeds []*discordgo.MessageEmbed, components []discordgo.MessageComponent, flags discordgo.MessageFlags) *discordgo.InteractionResponseData {
	return &discordgo.InteractionResponseData{
		Content:    content,
		Embeds:     embeds,
		Components: components,
		Flags:      flags,
		AllowedMentions: &discordgo.MessageAllowedMentions{
			Parse:       []discordgo.AllowedMentionType{},
			Roles:       []string{},
			Users:       []string{},
			RepliedUser: false,
		},
	}
}

func editDigestResponse(s *discordgo.Session, event *discordgo.InteractionCreate, content string, embeds []*discordgo.MessageEmbed) error {
	components := []discordgo.MessageComponent{}
	_, err := s.InteractionResponseEdit(event.Interaction, &discordgo.WebhookEdit{
		Content:    &content,
		Embeds:     &embeds,
		Components: &components,
		AllowedMentions: &discordgo.MessageAllowedMentions{
			Parse:       []discordgo.AllowedMentionType{},
			Roles:       []string{},
			Users:       []string{},
			RepliedUser: false,
		},
	})
	return err
}
