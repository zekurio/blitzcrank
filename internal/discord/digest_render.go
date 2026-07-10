package discord

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
	"unicode"

	"blitzcrank/internal/digest"
	"blitzcrank/internal/recommendation"

	"github.com/bwmarrin/discordgo"
)

// Discord applies a 6,000-character aggregate limit across all embeds in one
// message. Six bounded item embeds plus the summary stay below that ceiling.
const maxDigestItemEmbeds = 6

var _ digest.Sender = (*Bot)(nil)

func (b *Bot) SendDigest(ctx context.Context, subscription digest.Subscription, content digest.Content) (digest.SendResult, error) {
	if b == nil || b.session == nil {
		return digest.SendResult{}, errors.New("discord digest sender is unavailable")
	}
	if strings.TrimSpace(subscription.Subscriber.UserID) == "" {
		return digest.SendResult{}, errors.New("discord digest recipient is required")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	channel, err := b.session.UserChannelCreate(subscription.Subscriber.UserID, discordgo.WithContext(ctx))
	if err != nil {
		return digest.SendResult{}, fmt.Errorf("open Discord digest DM: %w", err)
	}
	if channel == nil || strings.TrimSpace(channel.ID) == "" {
		return digest.SendResult{}, errors.New("open Discord digest DM: response did not include a channel")
	}
	messageContent, embeds := renderDigestContent(subscription, content, false)
	message, err := b.session.ChannelMessageSendComplex(channel.ID, &discordgo.MessageSend{
		Content: messageContent,
		Embeds:  embeds,
		AllowedMentions: &discordgo.MessageAllowedMentions{
			Parse:       []discordgo.AllowedMentionType{},
			Roles:       []string{},
			Users:       []string{},
			RepliedUser: false,
		},
	}, discordgo.WithContext(ctx))
	if err != nil {
		return digest.SendResult{}, fmt.Errorf("send Discord digest DM: %w", err)
	}
	if message == nil || strings.TrimSpace(message.ID) == "" {
		return digest.SendResult{}, errors.New("send Discord digest DM: response did not include a message")
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
		description = strings.TrimSpace(description + "\n\n⚠️ " + copy.PartialSources)
	}
	if len(content.Items) > maxDigestItemEmbeds {
		description = strings.TrimSpace(description + "\n\n" + copy.MoreItems)
	}
	embeds := []*discordgo.MessageEmbed{{
		Title:       title,
		Description: truncateDigestText(description, 800),
		Color:       0x5865f2,
		Footer:      &discordgo.MessageEmbedFooter{Text: truncateDigestText(copy.DMFooter, 500)},
	}}
	items := content.Items
	if len(items) > maxDigestItemEmbeds {
		items = items[:maxDigestItemEmbeds]
	}
	for _, item := range items {
		embeds = append(embeds, digestCandidateEmbed(item, copy))
	}
	if len(content.Items) == 0 {
		return copy.PreviewEmpty, embeds
	}
	return "", embeds
}

func digestCandidateEmbed(candidate recommendation.Candidate, copy digestCopy) *discordgo.MessageEmbed {
	description := truncateDigestText(cleanDigestText(candidate.Overview), 360)
	source := truncateDigestText(cleanDigestText(candidate.Source), 80)
	if source == "" {
		source = "—"
	}
	embed := &discordgo.MessageEmbed{
		Title:       truncateDigestText(cleanDigestText(candidate.Title), 200),
		Description: description,
		Color:       digestCandidateColor(candidate),
		Fields: []*discordgo.MessageEmbedField{
			{Name: copy.ReleaseDate, Value: candidate.ReleaseAt.Format(time.DateOnly), Inline: true},
			{Name: copy.ReleasesLabel, Value: digestCandidateReleaseLabel(candidate.ReleaseKind, copy), Inline: true},
			{Name: copy.SourceLabel, Value: source, Inline: true},
		},
	}
	if validDigestURL(candidate.URL) {
		embed.URL = candidate.URL
	}
	if validDigestURL(candidate.Poster) {
		embed.Thumbnail = &discordgo.MessageEmbedThumbnail{URL: candidate.Poster}
	}
	return embed
}

func digestCandidateColor(candidate recommendation.Candidate) int {
	switch candidate.MediaType {
	case recommendation.MediaTypeAnime:
		return 0xeb459e
	case recommendation.MediaTypeMovie:
		return 0x57f287
	default:
		return 0xfee75c
	}
}

func digestCandidateReleaseLabel(kind recommendation.ReleaseKind, copy digestCopy) string {
	switch kind {
	case recommendation.ReleaseKindPhysical:
		return copy.Physical
	case recommendation.ReleaseKindTheatrical:
		return copy.Cinema
	default:
		return copy.Online
	}
}

func digestWindowDescription(content digest.Content) string {
	if content.WindowStart.IsZero() || content.WindowEnd.IsZero() {
		return ""
	}
	start := content.WindowStart
	end := content.WindowEnd.Add(-time.Nanosecond)
	return start.Format(time.DateOnly) + " – " + end.Format(time.DateOnly)
}

func renderDigestSubscription(subscription digest.Subscription, copy digestCopy) *discordgo.MessageEmbed {
	state := copy.Paused
	color := 0x99aab5
	if subscription.Enabled {
		state = copy.Active
		color = 0x57f287
	}
	interests := strings.Join(subscription.Interests, ", ")
	if interests == "" {
		interests = "—"
	}
	return &discordgo.MessageEmbed{
		Title: digestSubscriptionLabel(subscription, copy),
		Color: color,
		Fields: []*discordgo.MessageEmbedField{
			{Name: copy.TopicsLabel, Value: strings.Join(digestTopicLabels(subscription.Topics, copy), ", ")},
			{Name: copy.ReleasesLabel, Value: strings.Join(digestReleaseLabels(subscription.ReleaseKinds, copy), ", ")},
			{Name: copy.CadenceLabel, Value: digestCadenceLabel(subscription.Cadence, copy), Inline: true},
			{Name: copy.ScheduleLabel, Value: subscription.TimeOfDay + " · " + subscription.Timezone, Inline: true},
			{Name: copy.RegionLabel, Value: subscription.Region, Inline: true},
			{Name: copy.InterestsLabel, Value: truncateDigestText(interests, 800)},
		},
		Footer: &discordgo.MessageEmbedFooter{Text: state},
	}
}

func digestSubscriptionLabel(subscription digest.Subscription, copy digestCopy) string {
	labels := digestTopicLabels(subscription.Topics, copy)
	label := digest.SubscriptionLabel(subscription)
	if len(labels) > 0 {
		label += " · " + strings.Join(labels, ", ")
	}
	return truncateDigestText(label, 100)
}

func digestTopicLabels(topics []digest.Topic, copy digestCopy) []string {
	labels := make([]string, 0, len(topics))
	for _, topic := range topics {
		switch topic {
		case digest.TopicAnimeSeasons:
			labels = append(labels, copy.AnimeSeasons)
		case digest.TopicShowPremieres:
			labels = append(labels, copy.ShowPremieres)
		case digest.TopicMovieReleases:
			labels = append(labels, copy.MovieReleases)
		}
	}
	return labels
}

func digestReleaseLabels(kinds []digest.ReleaseKind, copy digestCopy) []string {
	labels := make([]string, 0, len(kinds))
	for _, kind := range kinds {
		switch kind {
		case digest.ReleaseKindOnline:
			labels = append(labels, copy.Online)
		case digest.ReleaseKindPhysical:
			labels = append(labels, copy.Physical)
		case digest.ReleaseKindCinema:
			labels = append(labels, copy.Cinema)
		}
	}
	return labels
}

func digestCadenceLabel(cadence digest.Cadence, copy digestCopy) string {
	switch cadence {
	case digest.CadenceDaily:
		return copy.Daily
	case digest.CadenceSeasonal:
		return copy.Seasonal
	default:
		return copy.Weekly
	}
}

func digestCopyForLocaleString(locale string) digestCopy {
	locale = strings.ToLower(strings.ReplaceAll(strings.TrimSpace(locale), "_", "-"))
	if locale == "de" || strings.HasPrefix(locale, "de-") {
		return digestGerman
	}
	return digestEnglish
}

func validDigestURL(value string) bool {
	parsed, err := url.Parse(strings.TrimSpace(value))
	return err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.Host != "" && parsed.User == nil
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
	if limit <= 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	if limit == 1 {
		return "…"
	}
	return strings.TrimSpace(string(runes[:limit-1])) + "…"
}
