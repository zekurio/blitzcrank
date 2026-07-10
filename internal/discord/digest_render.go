package discord

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"

	"blitzcrank/internal/digest"

	"github.com/bwmarrin/discordgo"
)

const maxDigestItemEmbeds = 6

var _ digest.Sender = (*Bot)(nil)

func (b *Bot) SendDigest(ctx context.Context, subscription digest.Subscription, content digest.Content) (digest.SendResult, error) {
	if b == nil || b.session == nil {
		return digest.SendResult{}, errors.New("discord newsletter sender is unavailable")
	}
	if strings.TrimSpace(subscription.Subscriber.UserID) == "" {
		return digest.SendResult{}, errors.New("discord newsletter recipient is required")
	}
	channel, err := b.session.UserChannelCreate(subscription.Subscriber.UserID, discordgo.WithContext(ctx))
	if err != nil {
		return digest.SendResult{}, fmt.Errorf("open Discord newsletter DM: %w", err)
	}
	if channel == nil || channel.ID == "" {
		return digest.SendResult{}, errors.New("open Discord newsletter DM: response did not include a channel")
	}
	messageContent, embeds := renderDigestContent(subscription, content, false)
	message, err := b.session.ChannelMessageSendComplex(channel.ID, &discordgo.MessageSend{
		Content: messageContent, Embeds: embeds,
		AllowedMentions: &discordgo.MessageAllowedMentions{Parse: []discordgo.AllowedMentionType{}, Roles: []string{}, Users: []string{}},
	}, discordgo.WithContext(ctx))
	if err != nil {
		return digest.SendResult{}, fmt.Errorf("send Discord newsletter DM: %w", err)
	}
	if message == nil || message.ID == "" {
		return digest.SendResult{}, errors.New("send Discord newsletter DM: response did not include a message")
	}
	return digest.SendResult{DiscordChannelID: channel.ID, DiscordMessageID: message.ID}, nil
}

func renderDigestContent(subscription digest.Subscription, content digest.Content, preview bool) (string, []*discordgo.MessageEmbed) {
	copy := digestCopyForLocaleString(subscription.Locale)
	title := copy.DigestTitle
	if preview {
		title = copy.PreviewTitle
	}
	description := digestWindowDescription(content)
	if content.Partial {
		description += "\n\n⚠️ " + copy.PartialSources
	}
	if len(content.Items) > maxDigestItemEmbeds {
		description += "\n\n" + copy.MoreItems
	}
	embeds := []*discordgo.MessageEmbed{{Title: title, Description: truncateDigestText(description, 800), Color: 0x5865f2, Footer: &discordgo.MessageEmbedFooter{Text: copy.DMFooter}}}
	items := content.Items
	if len(items) > maxDigestItemEmbeds {
		items = items[:maxDigestItemEmbeds]
	}
	for _, item := range items {
		embeds = append(embeds, digestEntryEmbed(item, copy))
	}
	if len(content.Items) == 0 {
		return copy.PreviewEmpty, embeds
	}
	return "", embeds
}

func digestEntryEmbed(entry digest.Entry, copy digestCopy) *discordgo.MessageEmbed {
	title := cleanDigestText(entry.Title)
	if entry.Subtitle != "" {
		title += " · " + cleanDigestText(entry.Subtitle)
	}
	status := "Scheduled"
	if entry.HasFile {
		status = "Available"
	}
	return &discordgo.MessageEmbed{
		Title: truncateDigestText(title, 200), Description: truncateDigestText(cleanDigestText(entry.Overview), 360), Color: digestEntryColor(entry),
		Fields: []*discordgo.MessageEmbedField{
			{Name: copy.ReleaseDate, Value: entry.OccursAt.Format(time.DateOnly), Inline: true},
			{Name: copy.ReleasesLabel, Value: digestEntryKindLabel(entry.Kind, copy), Inline: true},
			{Name: copy.SourceLabel, Value: entry.Source + " · " + status, Inline: true},
		},
	}
}

func digestEntryColor(entry digest.Entry) int {
	if entry.Topic == digest.TopicMovies {
		return 0x57f287
	}
	return 0xfee75c
}

func digestEntryKindLabel(kind digest.EntryKind, copy digestCopy) string {
	switch kind {
	case digest.EntryKindCinema:
		return copy.Cinema
	case digest.EntryKindPhysical:
		return copy.Physical
	case digest.EntryKindDigital:
		return copy.Online
	default:
		return copy.ShowPremieres
	}
}

func digestWindowDescription(content digest.Content) string {
	if content.WindowStart.IsZero() || content.WindowEnd.IsZero() {
		return ""
	}
	return content.WindowStart.Format(time.DateOnly) + " – " + content.WindowEnd.Add(-time.Nanosecond).Format(time.DateOnly)
}

func renderDigestSubscription(subscription digest.Subscription, copy digestCopy) *discordgo.MessageEmbed {
	state, color := copy.Paused, 0x99aab5
	if subscription.Enabled {
		state, color = copy.Active, 0x57f287
	}
	return &discordgo.MessageEmbed{
		Title: digestSubscriptionLabel(subscription, copy), Color: color,
		Fields: []*discordgo.MessageEmbedField{
			{Name: copy.TopicsLabel, Value: strings.Join(digestTopicLabels(subscription.Topics, copy), ", ")},
			{Name: copy.CadenceLabel, Value: digestCadenceLabel(subscription.Cadence, copy), Inline: true},
			{Name: copy.ScheduleLabel, Value: subscription.TimeOfDay + " · " + subscription.Timezone, Inline: true},
		}, Footer: &discordgo.MessageEmbedFooter{Text: state},
	}
}

func digestSubscriptionLabel(subscription digest.Subscription, copy digestCopy) string {
	return truncateDigestText(digest.SubscriptionLabel(subscription)+" · "+strings.Join(digestTopicLabels(subscription.Topics, copy), ", "), 100)
}

func digestTopicLabels(topics []digest.Topic, copy digestCopy) []string {
	labels := make([]string, 0, len(topics))
	for _, topic := range topics {
		switch topic {
		case digest.TopicShows:
			labels = append(labels, copy.ShowPremieres)
		case digest.TopicMovies:
			labels = append(labels, copy.MovieReleases)
		}
	}
	return labels
}

func digestCadenceLabel(cadence digest.Cadence, copy digestCopy) string {
	if cadence == digest.CadenceMonthly {
		return copy.Seasonal
	}
	return copy.Weekly
}

func digestCopyForLocaleString(locale string) digestCopy {
	locale = strings.ToLower(strings.ReplaceAll(strings.TrimSpace(locale), "_", "-"))
	if locale == "de" || strings.HasPrefix(locale, "de-") {
		return digestGerman
	}
	return digestEnglish
}

func cleanDigestText(value string) string {
	value = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' || !unicode.IsControl(r) {
			return r
		}
		return -1
	}, value)
	return strings.Join(strings.Fields(value), " ")
}

func truncateDigestText(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len([]rune(value)) <= limit {
		return value
	}
	runes := []rune(value)
	return strings.TrimSpace(string(runes[:limit-1])) + "…"
}
