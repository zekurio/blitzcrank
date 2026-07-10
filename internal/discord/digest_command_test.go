package discord

import (
	"testing"

	"github.com/bwmarrin/discordgo"
)

func TestDigestApplicationCommandIsLocalizedAndGuildOnly(t *testing.T) {
	command := digestApplicationCommand()
	if command.Name != "digest" || command.Description == "" {
		t.Fatalf("command = %#v", command)
	}
	if command.Contexts == nil || len(*command.Contexts) != 1 || (*command.Contexts)[0] != discordgo.InteractionContextGuild {
		t.Fatalf("contexts = %#v", command.Contexts)
	}
	if command.DescriptionLocalizations == nil || (*command.DescriptionLocalizations)[discordgo.German] == "" {
		t.Fatal("German root localization is missing")
	}
	wantNames := map[string]string{
		"subscribe": "abonnieren",
		"manage":    "verwalten",
		"preview":   "vorschau",
		"link":      "verknüpfen",
		"unlink":    "trennen",
	}
	for _, option := range command.Options {
		if got := option.NameLocalizations[discordgo.German]; got != wantNames[option.Name] {
			t.Errorf("German localization for %q = %q", option.Name, got)
		}
		if option.DescriptionLocalizations[discordgo.German] == "" {
			t.Errorf("German description for %q is missing", option.Name)
		}
		delete(wantNames, option.Name)
	}
	if len(wantNames) != 0 {
		t.Fatalf("missing subcommands = %#v", wantNames)
	}
}

func TestDigestCopyFallsBackToEnglish(t *testing.T) {
	if got := digestCopyFor(discordgo.German).Continue; got != "Weiter" {
		t.Fatalf("German Continue = %q", got)
	}
	if got := digestCopyFor(discordgo.French).Continue; got != "Continue" {
		t.Fatalf("fallback Continue = %q", got)
	}
	if got := canonicalDigestLocale(discordgo.EnglishGB); got != "en-GB" {
		t.Fatalf("canonicalDigestLocale(en-GB) = %q", got)
	}
}
