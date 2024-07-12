package commands

import (
	"github.com/bwmarrin/discordgo"
	"github.com/zekurio/blitzcrank/pkg/commandhandler"
)

var _ commandhandler.Command = (*Ping)(nil)

// Ping is a command that responds with "Pong!"
type Ping struct {
}

func (p *Ping) Name() string {
	return "ping"
}

func (p *Ping) Description() string {
	return "Pong!"
}

func (p *Ping) Exec(i *discordgo.Interaction) error {
	return nil
}
