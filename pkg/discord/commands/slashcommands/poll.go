package slashcommands

import (
	"github.com/bwmarrin/discordgo"
	"github.com/zekurio/kommando"
)

var _ kommando.SlashCommand = (*Poll)(nil)

type Poll struct{}

func (p Poll) Name() string {
	return "poll"
}

func (p Poll) Description() string {
	return "Interact with discords poll features"
}

func (p Poll) Version() string {
	return "1.0.0"
}

func (p Poll) Options() []*discordgo.ApplicationCommandOption {
	return []*discordgo.ApplicationCommandOption{
		{
			Type:        discordgo.ApplicationCommandOptionSubCommand,
			Name:        "get_results",
			Description: "Get results for a given poll",
			Options: []*discordgo.ApplicationCommandOption{
				{
					Type:        discordgo.ApplicationCommandOptionString,
					Name:        "poll_id",
					Description: "The id of the poll",
					Required:    true,
				},
			},
		},
	}
}

func (p Poll) Exec(ctx kommando.Context) (err error) {
	return
}
