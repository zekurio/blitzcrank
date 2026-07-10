package discord

import "github.com/bwmarrin/discordgo"

func digestApplicationCommand() *discordgo.ApplicationCommand {
	contexts := []discordgo.InteractionContextType{discordgo.InteractionContextGuild}
	minimumID := float64(1)
	return &discordgo.ApplicationCommand{
		Name:        "digest",
		Description: "Private media release digests and recommendations.",
		DescriptionLocalizations: &map[discordgo.Locale]string{
			discordgo.German: "Private Medien-Digests und Empfehlungen.",
		},
		Contexts: &contexts,
		Options: []*discordgo.ApplicationCommandOption{
			{
				Type:        discordgo.ApplicationCommandOptionSubCommand,
				Name:        "subscribe",
				Description: "Create a personalized DM digest.",
				NameLocalizations: map[discordgo.Locale]string{
					discordgo.German: "abonnieren",
				},
				DescriptionLocalizations: map[discordgo.Locale]string{
					discordgo.German: "Einen persönlichen DM-Digest erstellen.",
				},
			},
			{
				Type:        discordgo.ApplicationCommandOptionSubCommand,
				Name:        "manage",
				Description: "Edit, pause, or delete your digests.",
				NameLocalizations: map[discordgo.Locale]string{
					discordgo.German: "verwalten",
				},
				DescriptionLocalizations: map[discordgo.Locale]string{
					discordgo.German: "Deine Digests bearbeiten, pausieren oder löschen.",
				},
			},
			{
				Type:        discordgo.ApplicationCommandOptionSubCommand,
				Name:        "preview",
				Description: "Preview one of your recommendation digests.",
				NameLocalizations: map[discordgo.Locale]string{
					discordgo.German: "vorschau",
				},
				DescriptionLocalizations: map[discordgo.Locale]string{
					discordgo.German: "Vorschau eines Empfehlungs-Digests anzeigen.",
				},
				Options: []*discordgo.ApplicationCommandOption{{
					Type:        discordgo.ApplicationCommandOptionInteger,
					Name:        "subscription",
					Description: "Subscription number (optional).",
					NameLocalizations: map[discordgo.Locale]string{
						discordgo.German: "abo",
					},
					DescriptionLocalizations: map[discordgo.Locale]string{
						discordgo.German: "Abo-Nummer (optional).",
					},
					MinValue: &minimumID,
				}},
			},
			{
				Type:        discordgo.ApplicationCommandOptionSubCommand,
				Name:        "link",
				Description: "Link Jellyfin to personalize recommendations.",
				NameLocalizations: map[discordgo.Locale]string{
					discordgo.German: "verknüpfen",
				},
				DescriptionLocalizations: map[discordgo.Locale]string{
					discordgo.German: "Jellyfin für persönliche Empfehlungen verknüpfen.",
				},
			},
			{
				Type:        discordgo.ApplicationCommandOptionSubCommand,
				Name:        "unlink",
				Description: "Remove your Jellyfin account link.",
				NameLocalizations: map[discordgo.Locale]string{
					discordgo.German: "trennen",
				},
				DescriptionLocalizations: map[discordgo.Locale]string{
					discordgo.German: "Die Jellyfin-Verknüpfung entfernen.",
				},
			},
		},
	}
}
