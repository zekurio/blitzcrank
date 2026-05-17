package commands

import "github.com/bwmarrin/discordgo"

const (
	ConfigCommand     = "config"
	AutomationCommand = "automation"
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
			Name:                     ConfigCommand,
			Description:              "Blitzcrank-Laufzeitkonfiguration und Betrieb verwalten.",
			DefaultMemberPermissions: &admin,
			DMPermission:             &dm,
			Options:                  configCommandOptions(),
		},
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
	for _, name := range []string{"jellyfin", "jellyseerr", "sonarr", "radarr", "sabnzbd", "filesystem"} {
		commands = append(commands, skillCommand(name))
	}
	return commands
}

func configCommandOptions() []*discordgo.ApplicationCommandOption {
	profileOptions := []*discordgo.ApplicationCommandOption{
		{Type: discordgo.ApplicationCommandOptionString, Name: "profile", Description: "Laufzeitprofil", Required: true, Choices: stringChoices("default", "seerr", "discord", "automation", "discord_triage")},
		{Type: discordgo.ApplicationCommandOptionString, Name: "field", Description: "Profilfeld", Required: true, Choices: stringChoices("provider", "model", "reasoning_effort")},
	}
	return []*discordgo.ApplicationCommandOption{
		{Type: discordgo.ApplicationCommandOptionSubCommand, Name: "restart", Description: "Blitzcrank über den Supervisor neu starten."},
		{Type: discordgo.ApplicationCommandOptionSubCommand, Name: "reload-skills", Description: "Laufzeit-Skills aus SKILLS_DIR neu laden."},
		{Type: discordgo.ApplicationCommandOptionSubCommand, Name: "reload-automations", Description: "Laufzeit-Automatisierungen aus AUTOMATIONS_DIR neu laden."},
		{
			Type:        discordgo.ApplicationCommandOptionSubCommandGroup,
			Name:        "global",
			Description: "Globale Laufzeitkonfiguration lesen oder ändern.",
			Options: []*discordgo.ApplicationCommandOption{
				{
					Type:        discordgo.ApplicationCommandOptionSubCommand,
					Name:        "get",
					Description: "Eine globale Laufzeiteinstellung lesen.",
					Options: []*discordgo.ApplicationCommandOption{{
						Type:        discordgo.ApplicationCommandOptionString,
						Name:        "key",
						Description: "Globale Einstellung",
						Required:    true,
						Choices:     stringChoices("skills_dir", "automations_dir", "automations_enabled", "timezone"),
					}},
				},
				{
					Type:        discordgo.ApplicationCommandOptionSubCommand,
					Name:        "set",
					Description: "Eine globale Laufzeiteinstellung ändern.",
					Options: []*discordgo.ApplicationCommandOption{
						{Type: discordgo.ApplicationCommandOptionString, Name: "key", Description: "Globale Einstellung", Required: true, Choices: stringChoices("skills_dir", "automations_dir", "automations_enabled", "timezone")},
						{Type: discordgo.ApplicationCommandOptionString, Name: "value", Description: "Neuer Wert", Required: true},
					},
				},
			},
		},
		{
			Type:        discordgo.ApplicationCommandOptionSubCommandGroup,
			Name:        "profile",
			Description: "Laufzeitprofil-Konfiguration lesen oder ändern.",
			Options: []*discordgo.ApplicationCommandOption{
				{
					Type:        discordgo.ApplicationCommandOptionSubCommand,
					Name:        "get",
					Description: "Eine Laufzeitprofil-Einstellung lesen.",
					Options:     profileOptions,
				},
				{
					Type:        discordgo.ApplicationCommandOptionSubCommand,
					Name:        "set",
					Description: "Eine Laufzeitprofil-Einstellung ändern.",
					Options: append([]*discordgo.ApplicationCommandOption{}, append(profileOptions,
						&discordgo.ApplicationCommandOption{Type: discordgo.ApplicationCommandOptionString, Name: "value", Description: "Neuer Wert", Required: true})...),
				},
			},
		},
		{
			Type:        discordgo.ApplicationCommandOptionSubCommandGroup,
			Name:        "automation",
			Description: "Automatisierungen verwalten.",
			Options: []*discordgo.ApplicationCommandOption{
				{Type: discordgo.ApplicationCommandOptionSubCommand, Name: "list", Description: "Geladene Automatisierungen und nächste Läufe anzeigen."},
				{Type: discordgo.ApplicationCommandOptionSubCommand, Name: "reload", Description: "Automatisierungen aus AUTOMATIONS_DIR neu laden."},
				{
					Type:        discordgo.ApplicationCommandOptionSubCommand,
					Name:        "run",
					Description: "Eine Automatisierung nach Namen sofort ausführen.",
					Options: []*discordgo.ApplicationCommandOption{{
						Type:        discordgo.ApplicationCommandOptionString,
						Name:        "name",
						Description: "Name der Automatisierung",
						Required:    true,
					}},
				},
			},
		},
	}
}

func stringChoices(values ...string) []*discordgo.ApplicationCommandOptionChoice {
	choices := make([]*discordgo.ApplicationCommandOptionChoice, 0, len(values))
	for _, value := range values {
		choices = append(choices, &discordgo.ApplicationCommandOptionChoice{Name: value, Value: value})
	}
	return choices
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
