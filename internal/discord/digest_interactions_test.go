package discord

import (
	"context"
	"strings"
	"testing"
	"time"

	"blitzcrank/internal/digest"

	"github.com/bwmarrin/discordgo"
)

const testDigestNonce = "00112233445566778899aabbccddeeff"

type typedNilJellyfinLinker struct{}

func (*typedNilJellyfinLinker) Link(context.Context, digest.Subscriber, string, string) error {
	panic("typed-nil linker was called")
}

func (*typedNilJellyfinLinker) Unlink(context.Context, digest.Subscriber) error {
	panic("typed-nil linker was called")
}

func (*typedNilJellyfinLinker) LinkStatus(context.Context, digest.Subscriber) (bool, error) {
	panic("typed-nil linker was called")
}

func TestJellyfinLinkerAvailableRejectsTypedNil(t *testing.T) {
	var concrete *typedNilJellyfinLinker
	var linker JellyfinLinker = concrete
	if linker == nil {
		t.Fatal("test did not construct a typed-nil interface")
	}
	if jellyfinLinkerAvailable(linker) {
		t.Fatal("typed-nil Jellyfin linker was treated as available")
	}
	if jellyfinLinkerAvailable(nil) {
		t.Fatal("nil Jellyfin linker was treated as available")
	}
}

func TestDigestServiceAvailableRejectsTypedNil(t *testing.T) {
	var concrete *digest.Service
	var service DigestService = concrete
	if service == nil {
		t.Fatal("test did not construct a typed-nil interface")
	}
	if digestServiceAvailable(service) {
		t.Fatal("typed-nil digest service was treated as available")
	}
	if digestServiceAvailable(nil) {
		t.Fatal("nil digest service was treated as available")
	}
}

func TestDigestCustomIDsAreOpaqueBoundedAndStrictlyParsed(t *testing.T) {
	customID := digestCustomID("delete-confirm", testDigestNonce)
	if len(customID) > 100 {
		t.Fatalf("custom ID length = %d", len(customID))
	}
	action, nonce, ok := parseDigestCustomID(customID)
	if !ok || action != "delete-confirm" || nonce != testDigestNonce {
		t.Fatalf("parseDigestCustomID() = %q, %q, %v", action, nonce, ok)
	}
	for _, invalid := range []string{
		"digest:edit:42",
		"digest:edit:00112233445566778899AABBCCDDEEFF",
		"digest::" + testDigestNonce,
		"other:edit:" + testDigestNonce,
		"digest:edit:" + testDigestNonce + ":extra",
	} {
		if _, _, ok := parseDigestCustomID(invalid); ok {
			t.Errorf("parseDigestCustomID(%q) accepted invalid value", invalid)
		}
	}
}

func TestDigestWizardUsesStableValuesAndDefaultSelections(t *testing.T) {
	input := digest.SubscriptionInput{
		Topics:       []digest.Topic{digest.TopicAnimeSeasons, digest.TopicMovieReleases},
		ReleaseKinds: []digest.ReleaseKind{digest.ReleaseKindOnline},
		Cadence:      digest.CadenceWeekly,
	}
	_, _, components := digestWizardMessage(digestGerman, testDigestNonce, input, "")
	if len(components) != 4 {
		t.Fatalf("wizard rows = %d", len(components))
	}
	row := components[0].(discordgo.ActionsRow)
	menu := row.Components[0].(discordgo.SelectMenu)
	if menu.CustomID != digestCustomID("topics", testDigestNonce) || menu.Options[0].Value != string(digest.TopicAnimeSeasons) {
		t.Fatalf("topic menu = %#v", menu)
	}
	if !menu.Options[0].Default || menu.Options[1].Default || !menu.Options[2].Default {
		t.Fatalf("topic defaults = %#v", menu.Options)
	}
	if menu.Options[0].Label != digestGerman.AnimeSeasons {
		t.Fatalf("localized option label = %q", menu.Options[0].Label)
	}
	for _, component := range components {
		row := component.(discordgo.ActionsRow)
		for _, child := range row.Components {
			switch child := child.(type) {
			case discordgo.SelectMenu:
				if len(child.CustomID) > 100 {
					t.Errorf("select custom ID length = %d", len(child.CustomID))
				}
			case discordgo.Button:
				if len(child.CustomID) > 100 {
					t.Errorf("button custom ID length = %d", len(child.CustomID))
				}
			}
		}
	}
}

func TestSafeDigestModalValuesRejectsMalformedTrees(t *testing.T) {
	allowed := map[string]bool{"username": true, "password": true}
	valid := []discordgo.MessageComponent{
		&discordgo.ActionsRow{Components: []discordgo.MessageComponent{&discordgo.TextInput{CustomID: "username", Value: "alice"}}},
		&discordgo.ActionsRow{Components: []discordgo.MessageComponent{&discordgo.TextInput{CustomID: "password", Value: "secret"}}},
	}
	values, ok := safeDigestModalValues(valid, allowed)
	if !ok || values["username"] != "alice" || values["password"] != "secret" {
		t.Fatalf("safeDigestModalValues(valid) = %#v, %v", values, ok)
	}
	tests := []struct {
		name       string
		components []discordgo.MessageComponent
	}{
		{name: "missing password", components: valid[:1]},
		{name: "unknown field", components: append(valid, &discordgo.ActionsRow{Components: []discordgo.MessageComponent{&discordgo.TextInput{CustomID: "token"}}})},
		{name: "duplicate", components: append(valid, &discordgo.ActionsRow{Components: []discordgo.MessageComponent{&discordgo.TextInput{CustomID: "username"}}})},
		{name: "multiple inputs in row", components: []discordgo.MessageComponent{&discordgo.ActionsRow{Components: []discordgo.MessageComponent{
			&discordgo.TextInput{CustomID: "username"}, &discordgo.TextInput{CustomID: "password"},
		}}}},
		{name: "button instead of input", components: []discordgo.MessageComponent{&discordgo.ActionsRow{Components: []discordgo.MessageComponent{&discordgo.Button{CustomID: "username"}}}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, ok := safeDigestModalValues(test.components, allowed); ok {
				t.Fatal("malformed modal was accepted")
			}
		})
	}
}

func TestDigestSettingsParsingNormalizesLocalizedInput(t *testing.T) {
	input := digest.SubscriptionInput{
		Topics:       []digest.Topic{digest.TopicMovieReleases},
		ReleaseKinds: []digest.ReleaseKind{digest.ReleaseKindCinema},
		Cadence:      digest.CadenceWeekly,
	}
	parsed, ok := digestInputFromSettings(input, "de", map[string]string{
		"region": "at", "timezone": "Europe/Vienna", "time": "18:30", "weekday": "Freitag", "interests": " Sci-Fi, Thriller;Komödie\nDrama ",
	})
	if !ok {
		t.Fatal("digestInputFromSettings() rejected valid settings")
	}
	if parsed.Region != "AT" || parsed.Weekday != time.Friday || parsed.Locale != "de" || len(parsed.Interests) != 4 {
		t.Fatalf("parsed settings = %#v", parsed)
	}
	if _, ok := digestInputFromSettings(input, "de", map[string]string{
		"region": "Austria", "timezone": "not/a-zone", "time": "evening", "weekday": "Freitag",
	}); ok {
		t.Fatal("invalid settings were accepted")
	}
}

func TestJellyfinCredentialModalDoesNotContainCredentialValues(t *testing.T) {
	response := jellyfinCredentialModal(testDigestNonce, digestEnglish)
	if response.Type != discordgo.InteractionResponseModal || response.Data == nil || len(response.Data.Components) != 2 {
		t.Fatalf("modal response = %#v", response)
	}
	for _, component := range response.Data.Components {
		row := component.(discordgo.ActionsRow)
		input := row.Components[0].(discordgo.TextInput)
		if input.Value != "" {
			t.Fatalf("credential input %q has persisted value", input.CustomID)
		}
		if input.CustomID == "password" && (input.Required || input.MinLength != 0 || input.MaxLength > 256) {
			t.Fatalf("password input = %#v", input)
		}
	}
	if strings.Contains(response.Data.CustomID, "username") || strings.Contains(response.Data.CustomID, "password") {
		t.Fatalf("modal custom ID contains credential metadata: %q", response.Data.CustomID)
	}
}

func TestLinkWarningExplainsUnmaskedPasswordlessFlow(t *testing.T) {
	for language, warning := range map[string]string{"English": digestEnglish.LinkWarning, "German": digestGerman.LinkWarning} {
		lower := strings.ToLower(warning)
		if !strings.Contains(lower, "mask") || (!strings.Contains(lower, "passwordless") && !strings.Contains(lower, "passwortlos")) {
			t.Errorf("%s link warning does not explain the credential field: %q", language, warning)
		}
	}
}
