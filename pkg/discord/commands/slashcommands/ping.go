package slashcommands

import (
	"github.com/bwmarrin/discordgo"
	"github.com/zekurio/kommando"
)

var _ kommando.SlashCommand = (*Ping)(nil)

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

func (p *Ping) Exec(ctx kommando.Context) (err error) {
	err = ctx.RespondMessage("Pong!")
	return
}
