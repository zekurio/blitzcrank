package discord

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"blitzcrank/internal/agent"
	"blitzcrank/internal/store"

	"github.com/bwmarrin/discordgo"
)

const (
	toolApprovalThreadSource     = "discord_tool_approval"
	toolApprovalThreadExternalID = "tool-approvals"
)

type pendingToolApproval struct {
	channelID string
	guildID   string
	decision  chan toolApprovalVote
}

type toolApprovalVote struct {
	approved bool
	actor    string
	actorID  string
}

func (b *Bot) discordToolApproval(ctx context.Context, event *discordgo.MessageCreate) func(context.Context, agent.ToolApprovalRequest) (agent.ToolApprovalDecision, error) {
	if event == nil {
		return nil
	}
	return func(runCtx context.Context, request agent.ToolApprovalRequest) (agent.ToolApprovalDecision, error) {
		return b.awaitDiscordToolApproval(runCtx, event, request)
	}
}

func (b *Bot) awaitDiscordToolApproval(ctx context.Context, event *discordgo.MessageCreate, request agent.ToolApprovalRequest) (agent.ToolApprovalDecision, error) {
	if event == nil {
		return agent.ToolApprovalDecision{}, fmt.Errorf("discord tool approval requires a source message")
	}
	threadID, err := b.toolApprovalThreadID(ctx)
	if err != nil {
		return agent.ToolApprovalDecision{}, fmt.Errorf("prepare approval thread: %w", err)
	}
	message, err := b.sendMessageReferenceAllowedMentions(ctx, threadID, "", b.toolApprovalPrompt(event, request), b.toolApprovalAllowedMentions())
	if err != nil {
		threadID, err = b.createToolApprovalThread(ctx)
		if err != nil {
			return agent.ToolApprovalDecision{}, fmt.Errorf("recreate approval thread: %w", err)
		}
		message, err = b.sendMessageReferenceAllowedMentions(ctx, threadID, "", b.toolApprovalPrompt(event, request), b.toolApprovalAllowedMentions())
		if err != nil {
			return agent.ToolApprovalDecision{}, fmt.Errorf("send approval request: %w", err)
		}
	}
	if message == nil {
		return agent.ToolApprovalDecision{}, fmt.Errorf("send approval request: no approval message returned")
	}
	pending := &pendingToolApproval{
		channelID: threadID,
		guildID:   event.GuildID,
		decision:  make(chan toolApprovalVote, 1),
	}
	b.approvals.Store(message.ID, pending)
	defer b.approvals.Delete(message.ID)

	for _, emoji := range []string{"👍", "👎"} {
		if addErr := b.session.MessageReactionAdd(threadID, message.ID, emoji); addErr != nil {
			// Reaction seeding is best-effort; the approval flow still works without it.
		}
	}

	select {
	case <-ctx.Done():
		return agent.ToolApprovalDecision{}, ctx.Err()
	case vote := <-pending.decision:
		b.finalizeToolApprovalMessage(context.Background(), threadID, message.ID, request, vote)
		if vote.approved {
			return agent.ToolApprovalDecision{Approved: true, Actor: vote.actor, Reason: "genehmigt"}, nil
		}
		return agent.ToolApprovalDecision{Approved: false, Actor: vote.actor, Reason: "tool-aufruf abgelehnt"}, nil
	}
}

func (b *Bot) toolApprovalAllowedMentions() *discordgo.MessageAllowedMentions {
	owner := strings.TrimSpace(b.cfg.InstanceOwnerID)
	role := strings.TrimSpace(b.cfg.DiscordAdminRoleID)
	mentions := &discordgo.MessageAllowedMentions{}
	if owner != "" {
		mentions.Users = []string{owner}
	}
	if role != "" {
		mentions.Roles = []string{role}
	}
	return mentions
}

func (b *Bot) onMessageReactionAdd(session *discordgo.Session, event *discordgo.MessageReactionAdd) {
	if event == nil || event.UserID == "" || event.MessageID == "" {
		return
	}
	if strings.TrimSpace(event.UserID) == strings.TrimSpace(b.botID) {
		return
	}
	value, ok := b.approvals.Load(event.MessageID)
	if !ok {
		if b.isFeedbackReactionTarget(context.Background(), event) {
			b.handleFeedbackReaction(event)
		}
		return
	}
	pending, ok := value.(*pendingToolApproval)
	if !ok || pending == nil {
		return
	}
	approved, handled := approvalReaction(&event.Emoji)
	if !handled {
		return
	}
	guildID := strings.TrimSpace(event.GuildID)
	if guildID == "" {
		guildID = pending.guildID
	}
	channelID := strings.TrimSpace(event.ChannelID)
	if channelID == "" {
		channelID = pending.channelID
	}
	if !b.isAdminUser(guildID, channelID, event.UserID, event.Member) {
		return
	}
	select {
	case pending.decision <- toolApprovalVote{approved: approved, actor: approvalActor(event), actorID: strings.TrimSpace(event.UserID)}:
	default:
	}
}

func (b *Bot) isAdminUser(guildID, channelID, userID string, member *discordgo.Member) bool {
	if owner := strings.TrimSpace(b.cfg.InstanceOwnerID); owner != "" && strings.TrimSpace(userID) == owner {
		return true
	}
	if b.memberHasAdminRole(member) {
		return true
	}
	if member != nil && member.Permissions&discordgo.PermissionAdministrator != 0 {
		return true
	}
	if b.session == nil || strings.TrimSpace(userID) == "" {
		return false
	}
	if strings.TrimSpace(channelID) != "" {
		permissions, err := b.session.UserChannelPermissions(userID, channelID)
		if err == nil {
			return permissions&discordgo.PermissionAdministrator != 0
		}
	}
	if strings.TrimSpace(guildID) == "" {
		return false
	}
	loaded, err := b.session.GuildMember(guildID, userID)
	if err != nil || loaded == nil {
		return false
	}
	if b.memberHasAdminRole(loaded) {
		return true
	}
	return loaded.Permissions&discordgo.PermissionAdministrator != 0
}

func (b *Bot) toolApprovalPrompt(event *discordgo.MessageCreate, request agent.ToolApprovalRequest) string {
	target := b.toolApprovalTargetMention()
	action := "eine geschützte Aktion"
	risk := "Diese Aktion liest oder prüft Daten mit erweiterten Rechten."
	if request.Destructive {
		action = "eine Löschaktion"
		risk = "Diese Aktion kann Daten entfernen oder einen Vorgang abbrechen."
	} else if request.Mutating {
		action = "eine Änderung"
		risk = "Diese Aktion kann Einstellungen, Warteschlangen oder Medienstatus verändern."
	}
	source := "Unbekannter Auslöser"
	if event != nil {
		source = fmt.Sprintf("%s in <#%s>", discordAuthor(event.Author), strings.TrimSpace(event.ChannelID))
	}
	return fmt.Sprintf("%s\nBlitzcrank braucht eine Freigabe für %s.\n\nWas bedeutet das?\n%s\n\nAusgelöst durch: %s\nInterner Tool-Name: `%s`\nDetails für die Prüfung:\n```json\n%s\n```\n\nReagiere mit 👍 zum Freigeben oder mit 👎 zum Ablehnen. Akzeptiert werden Reaktionen vom Owner, von der konfigurierten Admin-Rolle oder von Discord-Administratoren.", target, action, risk, source, strings.TrimSpace(request.Name), approvalArgumentsSummary(request.ArgumentsSummary))
}

func (b *Bot) finalizeToolApprovalMessage(ctx context.Context, channelID, messageID string, request agent.ToolApprovalRequest, vote toolApprovalVote) {
	if b.session == nil || strings.TrimSpace(channelID) == "" || strings.TrimSpace(messageID) == "" {
		return
	}
	select {
	case <-ctx.Done():
		return
	default:
	}
	status := "abgelehnt"
	if vote.approved {
		status = "freigegeben"
	}
	content := fmt.Sprintf("Tool-Freigabe %s durch %s.\nInterner Tool-Name: `%s`", status, approvalActorName(vote), strings.TrimSpace(request.Name))
	if _, err := b.session.ChannelMessageEditComplex(&discordgo.MessageEdit{
		ID:              messageID,
		Channel:         channelID,
		Content:         &content,
		AllowedMentions: &discordgo.MessageAllowedMentions{},
	}); err != nil {
		log.Printf("finalize tool approval message failed: channel=%s message=%s error=%v", channelID, messageID, err)
	}
}

func (b *Bot) toolApprovalThreadID(ctx context.Context) (string, error) {
	b.approvalThreadMu.Lock()
	defer b.approvalThreadMu.Unlock()
	if threadID := strings.TrimSpace(b.approvalThreadID); threadID != "" {
		archived := false
		_, _ = b.session.ChannelEdit(threadID, &discordgo.ChannelEdit{Archived: &archived})
		return threadID, nil
	}
	if b.store != nil {
		thread, ok, err := b.store.LoadAgentThreadByExternalID(ctx, toolApprovalThreadSource, toolApprovalThreadExternalID)
		if err != nil {
			return "", err
		}
		if ok && strings.TrimSpace(thread.RootExternalID) != "" {
			archived := false
			_, _ = b.session.ChannelEdit(thread.RootExternalID, &discordgo.ChannelEdit{Archived: &archived})
			b.approvalThreadID = thread.RootExternalID
			return thread.RootExternalID, nil
		}
	}
	return b.createToolApprovalThread(ctx)
}

func (b *Bot) createToolApprovalThread(ctx context.Context) (string, error) {
	parentID := strings.TrimSpace(b.cfg.AgentDiscordChannelID)
	if parentID == "" {
		return "", fmt.Errorf("discord channel id is not configured")
	}
	thread, err := b.session.ThreadStart(parentID, "tool-freigaben", discordgo.ChannelTypeGuildPublicThread, b.cfg.DiscordThreadArchiveMinutes)
	if err != nil {
		return "", err
	}
	b.approvalThreadID = thread.ID
	if b.store != nil {
		now := time.Now().UTC()
		record := store.AgentThread{
			ThreadID:         toolApprovalThreadSource + ":" + toolApprovalThreadExternalID,
			Source:           toolApprovalThreadSource,
			ExternalID:       toolApprovalThreadExternalID,
			ParentExternalID: parentID,
			RootExternalID:   thread.ID,
			Status:           "active",
			Title:            "tool-freigaben",
			CreatedAt:        now,
			UpdatedAt:        now,
		}
		if err := b.store.UpsertAgentThread(ctx, record); err != nil {
			log.Printf("record tool approval thread failed: thread=%s error=%v", thread.ID, err)
		}
		b.appendDiscordTrace(record.ThreadID, map[string]any{
			"type":              "discord_tool_approval_thread",
			"thread_id":         record.ThreadID,
			"discord_thread_id": thread.ID,
			"parent_channel_id": parentID,
			"title":             record.Title,
			"created_at":        now.Format(time.RFC3339Nano),
		})
	}
	return thread.ID, nil
}

func (b *Bot) toolApprovalTargetMention() string {
	var targets []string
	if role := strings.TrimSpace(b.cfg.DiscordAdminRoleID); role != "" {
		targets = append(targets, "<@&"+role+">")
	}
	if owner := strings.TrimSpace(b.cfg.InstanceOwnerID); owner != "" {
		targets = append(targets, "<@"+owner+">")
	}
	if len(targets) == 0 {
		return "Ein Discord-Administrator"
	}
	return strings.Join(targets, " ")
}

func (b *Bot) memberHasAdminRole(member *discordgo.Member) bool {
	roleID := strings.TrimSpace(b.cfg.DiscordAdminRoleID)
	if roleID == "" || member == nil {
		return false
	}
	for _, role := range member.Roles {
		if strings.TrimSpace(role) == roleID {
			return true
		}
	}
	return false
}

func approvalArgumentsSummary(summary string) string {
	summary = strings.TrimSpace(summary)
	if summary == "" {
		return "{}"
	}
	return summary
}

func approvalActorName(vote toolApprovalVote) string {
	if actor := strings.TrimSpace(vote.actor); actor != "" {
		return actor
	}
	if actorID := strings.TrimSpace(vote.actorID); actorID != "" {
		return actorID
	}
	return "unbekannt"
}

func approvalReaction(emoji *discordgo.Emoji) (approved bool, handled bool) {
	if emoji == nil {
		return false, false
	}
	switch strings.TrimSpace(emoji.APIName()) {
	case "👍":
		return true, true
	case "👎":
		return false, true
	default:
		return false, false
	}
}

func approvalActor(event *discordgo.MessageReactionAdd) string {
	if event == nil {
		return ""
	}
	if event.Member != nil && event.Member.User != nil {
		return discordAuthor(event.Member.User)
	}
	if event.UserID != "" {
		return event.UserID
	}
	return ""
}
