package discord

import "github.com/bwmarrin/discordgo"

// Command is an interface that all commands must implement
type Command interface {
	// Name returns the name of the command
	Name() string

	// Description returns the description of the command
	Description() string

	// Exec executes the command, pass the discordgo.Interaction
	Exec(i *discordgo.Interaction) error
}
