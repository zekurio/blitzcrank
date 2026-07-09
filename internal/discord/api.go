package discord

import (
	"context"

	"github.com/bwmarrin/discordgo"
)

type discordAPI interface {
	BotUserID() string
	CreatePrivateThread(context.Context, privateThreadSpec) (*discordgo.Channel, error)
	AddThreadMember(context.Context, string, string) error
	ArchiveThread(context.Context, string) error
	GetMessage(context.Context, string, string) (*discordgo.Message, error)
	SendMessage(context.Context, string, *discordgo.MessageSend) (*discordgo.Message, error)
	TriggerTyping(context.Context, string) error
}

type privateThreadSpec struct {
	ParentID           string
	Name               string
	AutoArchiveMinutes int
	Invitable          bool
}

type sessionDiscordAPI struct {
	session *discordgo.Session
}

func (a *sessionDiscordAPI) BotUserID() string {
	if a == nil || a.session == nil || a.session.State == nil || a.session.State.User == nil {
		return ""
	}
	return a.session.State.User.ID
}

func (a *sessionDiscordAPI) CreatePrivateThread(ctx context.Context, spec privateThreadSpec) (*discordgo.Channel, error) {
	return a.session.ThreadStartComplex(spec.ParentID, &discordgo.ThreadStart{
		Name:                spec.Name,
		AutoArchiveDuration: spec.AutoArchiveMinutes,
		Type:                discordgo.ChannelTypeGuildPrivateThread,
		Invitable:           spec.Invitable,
	}, discordgo.WithContext(ctx))
}

func (a *sessionDiscordAPI) AddThreadMember(ctx context.Context, threadID, userID string) error {
	return a.session.ThreadMemberAdd(threadID, userID, discordgo.WithContext(ctx))
}

func (a *sessionDiscordAPI) ArchiveThread(ctx context.Context, threadID string) error {
	archived := true
	locked := false
	_, err := a.session.ChannelEditComplex(threadID, &discordgo.ChannelEdit{Archived: &archived, Locked: &locked}, discordgo.WithContext(ctx))
	return err
}

func (a *sessionDiscordAPI) GetMessage(ctx context.Context, channelID, messageID string) (*discordgo.Message, error) {
	return a.session.ChannelMessage(channelID, messageID, discordgo.WithContext(ctx))
}

func (a *sessionDiscordAPI) SendMessage(ctx context.Context, channelID string, message *discordgo.MessageSend) (*discordgo.Message, error) {
	return a.session.ChannelMessageSendComplex(channelID, message, discordgo.WithContext(ctx))
}

func (a *sessionDiscordAPI) TriggerTyping(ctx context.Context, channelID string) error {
	return a.session.ChannelTyping(channelID, discordgo.WithContext(ctx))
}
