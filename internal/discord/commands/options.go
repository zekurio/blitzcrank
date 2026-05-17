package commands

import (
	"strings"

	"github.com/bwmarrin/discordgo"
)

func SlashPrompt(data discordgo.ApplicationCommandInteractionData) string {
	if value := StringOption(data, QuestionOption); value != "" {
		return value
	}
	if value := StringOption(data, LegacyPromptOption); value != "" {
		return value
	}
	return ""
}

func ReleaseSpan(data discordgo.ApplicationCommandInteractionData) string {
	if value := StringOption(data, SpanOption); value != "" {
		return value
	}
	if value := StringOption(data, LegacySpanOption); value != "" {
		return value
	}
	return ""
}

func AutomationName(data discordgo.ApplicationCommandInteractionData) string {
	return StringOption(data, AutomationNameOption)
}

func FirstSubcommandPath(data discordgo.ApplicationCommandInteractionData) (string, *discordgo.ApplicationCommandInteractionDataOption) {
	for _, option := range data.Options {
		if option == nil {
			continue
		}
		if option.Type == discordgo.ApplicationCommandOptionSubCommand {
			return "", option
		}
		if option.Type == discordgo.ApplicationCommandOptionSubCommandGroup {
			for _, sub := range option.Options {
				if sub != nil && sub.Type == discordgo.ApplicationCommandOptionSubCommand {
					return option.Name, sub
				}
			}
			return option.Name, nil
		}
	}
	return "", nil
}

func OptionString(sub *discordgo.ApplicationCommandInteractionDataOption, name string) string {
	if sub == nil {
		return ""
	}
	for _, option := range sub.Options {
		if option != nil && option.Name == name && option.Type == discordgo.ApplicationCommandOptionString {
			return strings.TrimSpace(option.StringValue())
		}
	}
	return ""
}

func StringOption(data discordgo.ApplicationCommandInteractionData, name string) string {
	for _, option := range data.Options {
		if option != nil && option.Name == name && option.Type == discordgo.ApplicationCommandOptionString {
			return strings.TrimSpace(option.StringValue())
		}
	}
	return ""
}
