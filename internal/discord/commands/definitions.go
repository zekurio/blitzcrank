package commands

import "github.com/bwmarrin/discordgo"

const (
	AutomationCommand = "automation"
	ReleasesCommand   = "releases"
)

var SkillCommandGroups = map[string][]string{
	"jellyfin":   {"jellyfin"},
	"jellyseerr": {"jellyseerr"},
	"sonarr":     {"jellyseerr", "sonarr"},
	"radarr":     {"jellyseerr", "radarr"},
	"sabnzbd":    {"sabnzbd"},
	"filesystem": {"filesystem"},
}

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
				Name:         "name",
				Description:  "Name der Automatisierung",
				Required:     true,
				Autocomplete: true,
			}},
		},
	}
}

func ApplicationCommands() []*discordgo.ApplicationCommand {
	commands := RuntimeCommands()
	commands = append(commands, releasesCommand())
	for _, name := range []string{"jellyfin", "jellyseerr", "sonarr", "radarr", "sabnzbd", "filesystem"} {
		commands = append(commands, skillCommand(name))
	}
	return commands
}

func releasesCommand() *discordgo.ApplicationCommand {
	dm := false
	return &discordgo.ApplicationCommand{
		Name:         ReleasesCommand,
		Description:  "Release-Kalender für Sonarr und Radarr als PNG anzeigen.",
		DMPermission: &dm,
		Options: []*discordgo.ApplicationCommandOption{{
			Type:        discordgo.ApplicationCommandOptionString,
			Name:        "span",
			Description: "Zeitraum: heute, Woche oder Monat",
			Required:    false,
			Choices: []*discordgo.ApplicationCommandOptionChoice{
				{Name: "Heute", Value: "today"},
				{Name: "Woche", Value: "week"},
				{Name: "Monat", Value: "month"},
			},
		}},
	}
}

func skillCommand(name string) *discordgo.ApplicationCommand {
	dm := false
	return &discordgo.ApplicationCommand{
		Name:         name,
		Description:  "Blitzcrank mit ausgewähltem Skill " + name + " fragen.",
		DMPermission: &dm,
		Options: []*discordgo.ApplicationCommandOption{{
			Type:        discordgo.ApplicationCommandOptionString,
			Name:        "prompt",
			Description: "Was soll Blitzcrank prüfen oder beantworten?",
			Required:    true,
		}},
	}
}
