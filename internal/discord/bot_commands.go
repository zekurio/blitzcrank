package discord

import "github.com/bwmarrin/discordgo"

func retiredApplicationCommands() []string {
	return []string{"automation", "config", "releases", "jellyseerr", "jellyfin", "seerr", "sonarr", "radarr", "sabnzbd", "filesystem"}
}

func applicationCommandMatches(existing, desired *discordgo.ApplicationCommand) bool {
	if existing == nil || desired == nil {
		return false
	}
	return existing.Name == desired.Name &&
		existing.Description == desired.Description &&
		applicationCommandType(existing.Type) == applicationCommandType(desired.Type) &&
		int64PtrEqual(existing.DefaultMemberPermissions, desired.DefaultMemberPermissions) &&
		omittedBoolPtrEqual(existing.DMPermission, desired.DMPermission) &&
		commandBoolPtrEqual(existing.NSFW, desired.NSFW, false) &&
		commandLocalizationPtrEqual(existing.NameLocalizations, desired.NameLocalizations) &&
		commandLocalizationPtrEqual(existing.DescriptionLocalizations, desired.DescriptionLocalizations) &&
		interactionContextsEqual(existing.Contexts, desired.Contexts) &&
		applicationIntegrationTypesEqual(existing.IntegrationTypes, desired.IntegrationTypes) &&
		applicationCommandOptionsEqual(existing.Options, desired.Options)
}

func applicationCommandType(commandType discordgo.ApplicationCommandType) discordgo.ApplicationCommandType {
	if commandType == 0 {
		return discordgo.ChatApplicationCommand
	}
	return commandType
}

func int64PtrEqual(a, b *int64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func commandBoolPtrEqual(existing, desired *bool, defaultValue bool) bool {
	return boolValue(existing, defaultValue) == boolValue(desired, defaultValue)
}

func omittedBoolPtrEqual(existing, desired *bool) bool {
	if existing == nil || desired == nil {
		return true
	}
	return *existing == *desired
}

func boolValue(value *bool, defaultValue bool) bool {
	if value == nil {
		return defaultValue
	}
	return *value
}

func commandLocalizationPtrEqual(existing, desired *map[discordgo.Locale]string) bool {
	return localizationMapEqual(localizationPtrValue(existing), localizationPtrValue(desired))
}

func localizationPtrValue(value *map[discordgo.Locale]string) map[discordgo.Locale]string {
	if value == nil {
		return nil
	}
	return *value
}

func localizationMapEqual(existing, desired map[discordgo.Locale]string) bool {
	if len(existing) != len(desired) {
		return false
	}
	for key, value := range existing {
		if desired[key] != value {
			return false
		}
	}
	return true
}

func interactionContextsEqual(existing, desired *[]discordgo.InteractionContextType) bool {
	if desired == nil || len(*desired) == 0 {
		return true
	}
	if existing == nil || len(*existing) != len(*desired) {
		return false
	}
	for i := range *desired {
		if (*existing)[i] != (*desired)[i] {
			return false
		}
	}
	return true
}

func applicationIntegrationTypesEqual(existing, desired *[]discordgo.ApplicationIntegrationType) bool {
	if desired == nil || len(*desired) == 0 {
		return true
	}
	if existing == nil || len(*existing) != len(*desired) {
		return false
	}
	for i := range *desired {
		if (*existing)[i] != (*desired)[i] {
			return false
		}
	}
	return true
}

func applicationCommandOptionsEqual(existing, desired []*discordgo.ApplicationCommandOption) bool {
	if len(existing) != len(desired) {
		return false
	}
	for i := range desired {
		if !applicationCommandOptionEqual(existing[i], desired[i]) {
			return false
		}
	}
	return true
}

func applicationCommandOptionEqual(existing, desired *discordgo.ApplicationCommandOption) bool {
	if existing == nil || desired == nil {
		return existing == desired
	}
	return existing.Type == desired.Type &&
		existing.Name == desired.Name &&
		existing.Description == desired.Description &&
		localizationMapEqual(existing.NameLocalizations, desired.NameLocalizations) &&
		localizationMapEqual(existing.DescriptionLocalizations, desired.DescriptionLocalizations) &&
		channelTypesEqual(existing.ChannelTypes, desired.ChannelTypes) &&
		existing.Required == desired.Required &&
		existing.Autocomplete == desired.Autocomplete &&
		float64PtrEqual(existing.MinValue, desired.MinValue) &&
		existing.MaxValue == desired.MaxValue &&
		intPtrEqual(existing.MinLength, desired.MinLength) &&
		existing.MaxLength == desired.MaxLength &&
		applicationCommandOptionsEqual(existing.Options, desired.Options) &&
		applicationCommandChoicesEqual(existing.Choices, desired.Choices)
}

func channelTypesEqual(existing, desired []discordgo.ChannelType) bool {
	if len(existing) != len(desired) {
		return false
	}
	for i := range desired {
		if existing[i] != desired[i] {
			return false
		}
	}
	return true
}

func applicationCommandChoicesEqual(existing, desired []*discordgo.ApplicationCommandOptionChoice) bool {
	if len(existing) != len(desired) {
		return false
	}
	for i := range desired {
		if !applicationCommandChoiceEqual(existing[i], desired[i]) {
			return false
		}
	}
	return true
}

func applicationCommandChoiceEqual(existing, desired *discordgo.ApplicationCommandOptionChoice) bool {
	if existing == nil || desired == nil {
		return existing == desired
	}
	return existing.Name == desired.Name &&
		existing.Value == desired.Value &&
		localizationMapEqual(existing.NameLocalizations, desired.NameLocalizations)
}

func float64PtrEqual(a, b *float64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func intPtrEqual(a, b *int) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
