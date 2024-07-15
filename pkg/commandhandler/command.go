package commandhandler

import (
	"fmt"

	"github.com/bwmarrin/discordgo"
)

// Command is an interface that all commands must implement
type Command interface {
	// Name returns the name of the command
	Name() string

	// Description returns the description of the command
	Description() string

	// Exec executes the command, pass the discordgo.Interaction
	Exec(s *discordgo.Session, i *discordgo.Interaction) (err error)
}

func toApplicationCommand(c Command) *discordgo.ApplicationCommand {
	switch cm := c.(type) {
	case SlashCommand:
		return &discordgo.ApplicationCommand{
			Name:        cm.Name(),
			Type:        discordgo.ChatApplicationCommand,
			Description: cm.Description(),
			Version:     cm.Version(),
			Options:     cm.Options(),
		}
	default:
		panic(fmt.Sprintf("Command type not implemented for command: %s", cm.Name()))
	}
}
