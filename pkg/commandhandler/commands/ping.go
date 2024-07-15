package commands

import (
	"github.com/bwmarrin/discordgo"
	"github.com/zekurio/blitzcrank/pkg/commandhandler"
)

var _ commandhandler.SlashCommand = (*Ping)(nil)

type Ping struct {
}

func (p *Ping) Name() string {
	return "ping"
}

func (p *Ping) Description() string {
	return "Pong!"
}

func (p *Ping) Version() string {
	return "1.0.0"
}

func (p *Ping) Options() []*discordgo.ApplicationCommandOption {
	return nil
}

func (p *Ping) Exec(s *discordgo.Session, i *discordgo.Interaction) (err error) {
	user := i.User
	if user == nil {
		user = i.Member.User
	}

	err = s.InteractionRespond(i, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseChannelMessageWithSource,
		Data: &discordgo.InteractionResponseData{
			Content: "Pong!",
		},
	})

	return
}
