package discord

import (
	"context"
	"fmt"
	"strings"

	"blitzcrank/internal/agent"

	"github.com/bwmarrin/discordgo"
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
	message, err := b.sendMessageReferenceAllowedMentions(ctx, event.ChannelID, event.ID, b.toolApprovalPrompt(event, request), b.toolApprovalAllowedMentions())
	if err != nil {
		return agent.ToolApprovalDecision{}, fmt.Errorf("send approval request: %w", err)
	}
	if message == nil {
		return agent.ToolApprovalDecision{}, fmt.Errorf("send approval request: no approval message returned")
	}
	pending := &pendingToolApproval{
		channelID: event.ChannelID,
		guildID:   event.GuildID,
		decision:  make(chan toolApprovalVote, 1),
	}
	b.approvals.Store(message.ID, pending)
	defer b.approvals.Delete(message.ID)

	for _, emoji := range []string{"👍", "👎"} {
		if addErr := b.session.MessageReactionAdd(event.ChannelID, message.ID, emoji); addErr != nil {
			// Reaction seeding is best-effort; the approval flow still works without it.
		}
	}

	select {
	case <-ctx.Done():
		return agent.ToolApprovalDecision{}, ctx.Err()
	case vote := <-pending.decision:
		b.finalizeToolApprovalMessage(context.Background(), event.ChannelID, message.ID, request, vote)
		if vote.approved {
			return agent.ToolApprovalDecision{Approved: true, Actor: vote.actor, Reason: "genehmigt"}, nil
		}
		return agent.ToolApprovalDecision{Approved: false, Actor: vote.actor, Reason: "tool-aufruf abgelehnt"}, nil
	}
}

func (b *Bot) toolApprovalAllowedMentions() *discordgo.MessageAllowedMentions {
	owner := strings.TrimSpace(b.cfg.InstanceOwnerID)
	if owner == "" {
		return &discordgo.MessageAllowedMentions{}
	}
	return &discordgo.MessageAllowedMentions{Users: []string{owner}}
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
	return loaded.Permissions&discordgo.PermissionAdministrator != 0
}

func (b *Bot) toolApprovalPrompt(event *discordgo.MessageCreate, request agent.ToolApprovalRequest) string {
	target := "Ein Discord-Administrator"
	if owner := strings.TrimSpace(b.cfg.InstanceOwnerID); owner != "" {
		target = "<@" + owner + ">"
	}
	return fmt.Sprintf("%s bitte diesen Löschaufruf genehmigen. Reagiere mit 👍 zum Genehmigen oder 👎 zum Ablehnen. Jeder Discord-Administrator kann ebenfalls reagieren.\nTool: `%s`\nArgumente: `%s`", target, strings.TrimSpace(request.Name), strings.TrimSpace(request.ArgumentsSummary))
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
		status = "genehmigt"
	}
	actor := strings.TrimSpace(vote.actor)
	if actorID := strings.TrimSpace(vote.actorID); actorID != "" {
		actor = "<@" + actorID + ">"
	}
	content := fmt.Sprintf("%s hat den Tool-Aufruf %s.\nTool: `%s`\nArgumente: `%s`", actor, status, strings.TrimSpace(request.Name), strings.TrimSpace(request.ArgumentsSummary))
	_, _ = b.session.ChannelMessageEdit(channelID, messageID, content)
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
