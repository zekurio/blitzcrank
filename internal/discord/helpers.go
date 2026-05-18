package discord

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"blitzcrank/internal/store"

	"github.com/bwmarrin/discordgo"
)

func (b *Bot) threadLock(threadID string) *sync.Mutex {
	value, _ := b.locks.LoadOrStore(threadID, &sync.Mutex{})
	return value.(*sync.Mutex)
}

func splitDiscordMessage(content string) []string {
	const limit = 1900
	content = strings.TrimSpace(content)
	if len(content) <= limit {
		return []string{content}
	}

	var chunks []string
	for len(content) > limit {
		cut := discordMessageCutIndex(content, limit)
		if cut <= 0 {
			break
		}
		chunks = append(chunks, strings.TrimSpace(content[:cut]))
		content = strings.TrimSpace(content[cut:])
	}
	if content != "" {
		chunks = append(chunks, content)
	}
	return chunks
}

func discordMessageCutIndex(content string, limit int) int {
	lastBoundary := 0
	lastNewline := -1
	for index, r := range content {
		if index > limit {
			break
		}
		if index > 0 {
			lastBoundary = index
		}
		if r == '\n' && index > 0 {
			lastNewline = index
		}
	}
	if lastNewline > 0 {
		return lastNewline
	}
	if lastBoundary > 0 {
		return lastBoundary
	}
	return len(content)
}

func (b *Bot) mentionsBot(session *discordgo.Session, message *discordgo.Message) bool {
	if session == nil || message == nil {
		return false
	}
	botID := strings.TrimSpace(b.botID)
	if session.State != nil && session.State.User != nil {
		botID = session.State.User.ID
	}
	if botID == "" {
		return false
	}
	for _, user := range message.Mentions {
		if user != nil && user.ID == botID {
			return true
		}
	}
	return false
}

func discordThreadID(externalID string) string {
	return "discord:" + strings.TrimSpace(externalID)
}

func discordAuthor(user *discordgo.User) string {
	if user == nil {
		return "unknown Discord user"
	}
	name := strings.TrimSpace(user.Username)
	if user.GlobalName != "" {
		name = strings.TrimSpace(user.GlobalName)
	}
	if name == "" {
		name = user.ID
	}
	return fmt.Sprintf("%s (%s)", name, user.ID)
}

func discordUserID(user *discordgo.User) string {
	if user == nil {
		return ""
	}
	return strings.TrimSpace(user.ID)
}

func (b *Bot) discordRequestSecurity(event *discordgo.MessageCreate) (string, bool, string) {
	if event == nil {
		return "", false, "non_admin"
	}
	authorID := discordUserID(event.Author)
	isAdmin := b.isAdminUser(event.GuildID, event.ChannelID, authorID, event.Member)
	if isAdmin {
		return authorID, true, "admin"
	}
	return authorID, false, "non_admin"
}

func (b *Bot) interactionRequestSecurity(event *discordgo.InteractionCreate) (string, bool, string) {
	if event == nil {
		return "", false, "non_admin"
	}
	authorID := interactionUserID(event)
	isAdmin := b.isAdminInteraction(event)
	if isAdmin {
		return authorID, true, "admin"
	}
	return authorID, false, "non_admin"
}

func interactionAuthor(event *discordgo.InteractionCreate) string {
	if event == nil {
		return "unknown Discord user"
	}
	if event.Member != nil && event.Member.User != nil {
		return discordAuthor(event.Member.User)
	}
	return discordAuthor(event.User)
}

func interactionUserID(event *discordgo.InteractionCreate) string {
	if event == nil {
		return ""
	}
	if event.Member != nil && event.Member.User != nil {
		return event.Member.User.ID
	}
	if event.User != nil {
		return event.User.ID
	}
	return ""
}

func slashInteractionMessage(event *discordgo.InteractionCreate, root *discordgo.Message) *discordgo.MessageCreate {
	if event == nil || root == nil {
		return nil
	}
	user := &discordgo.User{}
	switch {
	case event.Member != nil && event.Member.User != nil:
		*user = *event.Member.User
	case event.User != nil:
		*user = *event.User
	default:
		user = nil
	}
	return &discordgo.MessageCreate{Message: &discordgo.Message{
		ID:        root.ID,
		ChannelID: root.ChannelID,
		GuildID:   root.GuildID,
		Timestamp: root.Timestamp,
		Author:    user,
	}}
}

func (b *Bot) skillSlashRootMessage(event *discordgo.InteractionCreate, skill, prompt string) string {
	userID := interactionUserID(event)
	if userID == "" {
		return fmt.Sprintf("/%s gestartet: %s", strings.TrimSpace(skill), threadTitle(prompt))
	}
	return fmt.Sprintf("<@%s> hat `/%s` gestartet: %s", userID, strings.TrimSpace(skill), threadTitle(prompt))
}

func discordSkillPrompt(skill, prompt string) string {
	return fmt.Sprintf("Discord slash command: /%s\nSelected skill: %s\n\nUser prompt:\n%s", strings.TrimSpace(skill), strings.TrimSpace(skill), strings.TrimSpace(prompt))
}

func messageReplyTargetID(message *discordgo.Message) string {
	if message == nil || message.MessageReference == nil {
		return ""
	}
	return strings.TrimSpace(message.MessageReference.MessageID)
}

func (b *Bot) messageRepliesToBot(message *discordgo.Message) bool {
	if message == nil || message.MessageReference == nil {
		return false
	}
	if message.ReferencedMessage == nil || message.ReferencedMessage.Author == nil {
		return false
	}
	botID := strings.TrimSpace(b.botID)
	if botID == "" {
		return false
	}
	return message.ReferencedMessage.Author.ID == botID
}

func threadTitle(content string) string {
	title := stripDiscordMentionTokens(content)
	title = strings.TrimSpace(title)
	title = strings.ReplaceAll(title, "\n", " ")
	title = strings.Join(strings.Fields(title), " ")
	title = strings.Trim(title, "`*_~|> ")
	if title == "" {
		return "Support request"
	}
	if len(title) > 90 {
		title = strings.TrimSpace(title[:90])
	}
	return title
}

func titleFromContent(content string) string {
	content = stripDiscordMentionTokens(content)
	content = strings.TrimSpace(content)
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			return line
		}
	}
	return "Support request"
}

func stripDiscordMentionTokens(content string) string {
	var kept []string
	for _, field := range strings.Fields(content) {
		if isDiscordMentionToken(field) {
			continue
		}
		kept = append(kept, field)
	}
	return strings.Join(kept, " ")
}

func isDiscordMentionToken(value string) bool {
	value = strings.Trim(value, ",.;:!?()[]{}")
	switch {
	case strings.HasPrefix(value, "<@") && strings.HasSuffix(value, ">"):
		return true
	case strings.HasPrefix(value, "<#") && strings.HasSuffix(value, ">"):
		return true
	case strings.HasPrefix(value, "<@&") && strings.HasSuffix(value, ">"):
		return true
	default:
		return false
	}
}

func emptySummary(summary string) string {
	summary = strings.TrimSpace(summary)
	if summary == "" {
		return "(none yet)"
	}
	return summary
}

func recentTranscript(events []store.AgentThreadEvent, limit int) string {
	if limit < 1 {
		limit = 12
	}
	start := len(events) - limit
	if start < 0 {
		start = 0
	}
	var lines []string
	for _, event := range events[start:] {
		message := strings.TrimSpace(event.Message)
		if message == "" {
			continue
		}
		actor := strings.TrimSpace(event.Actor)
		if actor == "" {
			actor = "unknown"
		}
		lines = append(lines, fmt.Sprintf("- %s at %s: %s", actor, event.CreatedAt.Format(time.RFC3339), message))
	}
	if len(lines) == 0 {
		return "(no prior messages)"
	}
	return strings.Join(lines, "\n")
}

func recentTranscriptWithinBudget(events []store.AgentThreadEvent, limit, minTailMessages, tokenBudget int) (string, int) {
	if limit < 1 {
		limit = 12
	}
	if minTailMessages > limit {
		limit = minTailMessages
	}
	start := len(events) - limit
	if start < 0 {
		start = 0
	}
	candidates := make([]string, 0, len(events)-start)
	for _, event := range events[start:] {
		line := transcriptLine(event)
		if line == "" {
			continue
		}
		candidates = append(candidates, line)
	}
	if len(candidates) == 0 {
		return "(no prior messages)", 0
	}
	if tokenBudget <= 0 {
		return "(recent transcript compacted into rolling summary)", len(candidates)
	}
	var selected []string
	used := 0
	for i := len(candidates) - 1; i >= 0; i-- {
		line := candidates[i]
		cost := estimatePromptTokens(line)
		if len(selected) > 0 {
			cost += 1
		}
		if used+cost > tokenBudget {
			break
		}
		used += cost
		selected = append(selected, line)
	}
	if len(selected) == 0 {
		return "(recent transcript compacted into rolling summary)", len(candidates)
	}
	for left, right := 0, len(selected)-1; left < right; left, right = left+1, right-1 {
		selected[left], selected[right] = selected[right], selected[left]
	}
	return strings.Join(selected, "\n"), len(candidates) - len(selected)
}

func transcriptLine(event store.AgentThreadEvent) string {
	message := strings.TrimSpace(event.Message)
	if message == "" {
		return ""
	}
	actor := strings.TrimSpace(event.Actor)
	if actor == "" {
		actor = "unknown"
	}
	return fmt.Sprintf("- %s at %s: %s", actor, event.CreatedAt.Format(time.RFC3339), message)
}

func estimatePromptTokens(text string) int {
	text = strings.TrimSpace(text)
	if text == "" {
		return 0
	}
	return (len(text) + 3) / 4
}

func recentRuns(runs []store.AgentRun, limit int) string {
	if limit < 1 {
		limit = 5
	}
	start := len(runs) - limit
	if start < 0 {
		start = 0
	}
	var lines []string
	for _, run := range runs[start:] {
		status := strings.TrimSpace(run.CompletionReason)
		if status == "" {
			status = "completed"
		}
		reply := strings.TrimSpace(run.FinalResponse)
		if len(reply) > 240 {
			reply = strings.TrimSpace(reply[:240]) + "..."
		}
		if reply == "" {
			reply = strings.TrimSpace(run.Error)
		}
		if reply == "" {
			continue
		}
		lines = append(lines, fmt.Sprintf("- %s at %s: %s", status, run.StartedAt.Format(time.RFC3339), reply))
	}
	if len(lines) == 0 {
		return "(no prior agent outcomes)"
	}
	return strings.Join(lines, "\n")
}
