package commands

import "github.com/bwmarrin/discordgo"

const (
	AutomationCommand = "automatisierung"

	AutomationNameOption = "name"
)

func RuntimeCommands() []*discordgo.ApplicationCommand {
	admin := int64(discordgo.PermissionAdministrator)
	dm := false
	return []*discordgo.ApplicationCommand{
		{
			Name:                     AutomationCommand,
			Description:              "Eine Blitzcrank-Automatisierung sofort ausführen.",
			DefaultMemberPermissions: &admin,
			DMPermission:             &dm,
			Options: []*discordgo.ApplicationCommandOption{{
				Type:         discordgo.ApplicationCommandOptionString,
				Name:         AutomationNameOption,
				Description:  "Name der Automatisierung",
				Required:     true,
				Autocomplete: true,
			}},
		},
	}
}

func ApplicationCommands() []*discordgo.ApplicationCommand {
	return RuntimeCommands()
}
