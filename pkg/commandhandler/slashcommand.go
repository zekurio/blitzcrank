package commandhandler

import "github.com/bwmarrin/discordgo"

type SlashCommand interface {
	Command

	Version() string

	Options() []*discordgo.ApplicationCommandOption
}
