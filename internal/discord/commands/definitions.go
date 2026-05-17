package commands

import "github.com/bwmarrin/discordgo"

const (
	AutomationCommand       = "automatisierung"
	LegacyAutomationCommand = "automation"
	ReleasesCommand         = "release"
	LegacyReleasesCommand   = "releases"

	AutomationNameOption = "name"
	QuestionOption       = "frage"
	LegacyPromptOption   = "prompt"
	SpanOption           = "zeitraum"
	LegacySpanOption     = "span"
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
				Name:         AutomationNameOption,
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
			Name:        SpanOption,
			Description: "Zeitraum: heute, Woche oder Monat",
			Required:    false,
			Choices: []*discordgo.ApplicationCommandOptionChoice{
				{Name: "Heute", Value: "heute"},
				{Name: "Diese Woche", Value: "woche"},
				{Name: "Dieser Monat", Value: "monat"},
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
			Name:        QuestionOption,
			Description: "Was soll Blitzcrank prüfen oder beantworten?",
			Required:    true,
		}},
	}
}
