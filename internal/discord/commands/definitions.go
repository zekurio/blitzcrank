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
			Description:              "Manage Blitzcrank runtime configuration and operations.",
			DefaultMemberPermissions: &admin,
			DMPermission:             &dm,
			Options:                  configCommandOptions(),
		},
		{
			Name:                     AutomationCommand,
			Description:              "Run a Blitzcrank automation now.",
			DefaultMemberPermissions: &admin,
			DMPermission:             &dm,
			Options: []*discordgo.ApplicationCommandOption{{
				Type:         discordgo.ApplicationCommandOptionString,
				Name:         "name",
				Description:  "Automation name",
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
		{Type: discordgo.ApplicationCommandOptionString, Name: "profile", Description: "Runtime profile", Required: true, Choices: stringChoices("default", "seerr", "discord", "automation", "discord_triage")},
		{Type: discordgo.ApplicationCommandOptionString, Name: "field", Description: "Profile field", Required: true, Choices: stringChoices("provider", "model", "reasoning_effort")},
	}
	return []*discordgo.ApplicationCommandOption{
		{Type: discordgo.ApplicationCommandOptionSubCommand, Name: "restart", Description: "Restart Blitzcrank through its supervisor."},
		{Type: discordgo.ApplicationCommandOptionSubCommand, Name: "reload-skills", Description: "Reload runtime skills from SKILLS_DIR."},
		{Type: discordgo.ApplicationCommandOptionSubCommand, Name: "reload-automations", Description: "Reload runtime automations from AUTOMATIONS_DIR."},
		{
			Type:        discordgo.ApplicationCommandOptionSubCommandGroup,
			Name:        "global",
			Description: "Get or set global runtime config.",
			Options: []*discordgo.ApplicationCommandOption{
				{
					Type:        discordgo.ApplicationCommandOptionSubCommand,
					Name:        "get",
					Description: "Read a global runtime setting.",
					Options: []*discordgo.ApplicationCommandOption{{
						Type:        discordgo.ApplicationCommandOptionString,
						Name:        "key",
						Description: "Global setting",
						Required:    true,
						Choices:     stringChoices("skills_dir", "automations_dir", "automations_enabled", "timezone"),
					}},
				},
				{
					Type:        discordgo.ApplicationCommandOptionSubCommand,
					Name:        "set",
					Description: "Write a global runtime setting.",
					Options: []*discordgo.ApplicationCommandOption{
						{Type: discordgo.ApplicationCommandOptionString, Name: "key", Description: "Global setting", Required: true, Choices: stringChoices("skills_dir", "automations_dir", "automations_enabled", "timezone")},
						{Type: discordgo.ApplicationCommandOptionString, Name: "value", Description: "New value", Required: true},
					},
				},
			},
		},
		{
			Type:        discordgo.ApplicationCommandOptionSubCommandGroup,
			Name:        "profile",
			Description: "Get or set runtime profile config.",
			Options: []*discordgo.ApplicationCommandOption{
				{
					Type:        discordgo.ApplicationCommandOptionSubCommand,
					Name:        "get",
					Description: "Read a runtime profile setting.",
					Options:     profileOptions,
				},
				{
					Type:        discordgo.ApplicationCommandOptionSubCommand,
					Name:        "set",
					Description: "Write a runtime profile setting.",
					Options: append([]*discordgo.ApplicationCommandOption{}, append(profileOptions,
						&discordgo.ApplicationCommandOption{Type: discordgo.ApplicationCommandOptionString, Name: "value", Description: "New value", Required: true})...),
				},
			},
		},
		{
			Type:        discordgo.ApplicationCommandOptionSubCommandGroup,
			Name:        "automation",
			Description: "Manage automations.",
			Options: []*discordgo.ApplicationCommandOption{
				{Type: discordgo.ApplicationCommandOptionSubCommand, Name: "list", Description: "List loaded automations and next runs."},
				{Type: discordgo.ApplicationCommandOptionSubCommand, Name: "reload", Description: "Reload automations from AUTOMATIONS_DIR."},
				{
					Type:        discordgo.ApplicationCommandOptionSubCommand,
					Name:        "run",
					Description: "Run an automation by name now.",
					Options: []*discordgo.ApplicationCommandOption{{
						Type:        discordgo.ApplicationCommandOptionString,
						Name:        "name",
						Description: "Automation name",
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
		Description:  "Ask Blitzcrank with the " + name + " skill selected.",
		DMPermission: &dm,
		Options: []*discordgo.ApplicationCommandOption{{
			Type:        discordgo.ApplicationCommandOptionString,
			Name:        "prompt",
			Description: "What should Blitzcrank investigate or answer?",
			Required:    true,
		}},
	}
}
