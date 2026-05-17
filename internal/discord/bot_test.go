package discord

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"blitzcrank/internal/agent"
	"blitzcrank/internal/config"
	"blitzcrank/internal/discord/commands"
	"blitzcrank/internal/store"

	"github.com/bwmarrin/discordgo"
)

func TestThreadTitleCompactsAndLimitsContent(t *testing.T) {
	title := threadTitle("  **Missing\n\n episode   for a very long series title that should be shortened before Discord sees it because the API has a strict limit**  ")
	if strings.Contains(title, "\n") {
		t.Fatalf("threadTitle() contains newline: %q", title)
	}
	if len(title) > 90 {
		t.Fatalf("threadTitle() length = %d, want <= 90", len(title))
	}
	if title == "" || title == "Support request" {
		t.Fatalf("threadTitle() = %q, want content-derived title", title)
	}
}

func TestThreadTitleStripsDiscordMentions(t *testing.T) {
	title := threadTitle("<@1503832472671223930> Missing S02E05?")
	if title != "Missing S02E05?" {
		t.Fatalf("threadTitle() = %q", title)
	}
}

func TestModelRuntimeQuestionDetection(t *testing.T) {
	tests := []string{
		"<@1503832472671223930> welches model verwendest du gerade?",
		"which model are you using?",
		"what reasoning effort are you running?",
	}
	for _, tt := range tests {
		if !isModelRuntimeQuestion(tt) {
			t.Fatalf("isModelRuntimeQuestion(%q) = false", tt)
		}
	}
	if isModelRuntimeQuestion("Kannst du mir mit Mathe helfen?") {
		t.Fatal("isModelRuntimeQuestion(math question) = true")
	}
}

func TestToolInventoryQuestionDetection(t *testing.T) {
	tests := []string{
		"<@1503832472671223930> Welche tools kannst du nutzen?",
		"bitte zähle alle werkzeuge auf.",
		"please list all tools",
	}
	for _, tt := range tests {
		if !isToolInventoryQuestion(tt) {
			t.Fatalf("isToolInventoryQuestion(%q) = false", tt)
		}
	}
	if isToolInventoryQuestion("Kannst du Project Hail Mary suchen?") {
		t.Fatal("isToolInventoryQuestion(media request) = true")
	}
}

func TestAutomationScheduleQuestionDetection(t *testing.T) {
	tests := []string{
		"<@1503832472671223930> wann läuft der nächste automation job?",
		"which scheduled jobs are configured?",
		"please list automations",
	}
	for _, tt := range tests {
		if !isAutomationScheduleQuestion(tt) {
			t.Fatalf("isAutomationScheduleQuestion(%q) = false", tt)
		}
	}
	if isAutomationScheduleQuestion("Kannst du Project Hail Mary suchen?") {
		t.Fatal("isAutomationScheduleQuestion(media request) = true")
	}
}

func TestRuntimeCommandsRequireAdministratorPermission(t *testing.T) {
	runtimeCommands := commands.RuntimeCommands()
	if len(runtimeCommands) != 1 {
		t.Fatalf("RuntimeCommands() len = %d, want 1", len(runtimeCommands))
	}
	for _, command := range runtimeCommands {
		if command.DefaultMemberPermissions == nil || *command.DefaultMemberPermissions&discordgo.PermissionAdministrator == 0 {
			t.Fatalf("command %s permissions = %#v, want administrator", command.Name, command.DefaultMemberPermissions)
		}
		if command.DMPermission == nil || *command.DMPermission {
			t.Fatalf("command %s DMPermission = %#v, want false", command.Name, command.DMPermission)
		}
	}
	if runtimeCommands[0].Name != commands.AutomationCommand {
		t.Fatalf("runtime command name = %q, want %s", runtimeCommands[0].Name, commands.AutomationCommand)
	}
	if runtimeCommands[0].Description != "Eine Blitzcrank-Automatisierung sofort ausführen." {
		t.Fatalf("automation command description = %q", runtimeCommands[0].Description)
	}
	if len(runtimeCommands[0].Options) != 1 || runtimeCommands[0].Options[0].Name != commands.AutomationNameOption || !runtimeCommands[0].Options[0].Autocomplete {
		t.Fatalf("automation command options = %#v, want autocompleted name", runtimeCommands[0].Options)
	}
	if runtimeCommands[0].Options[0].Description != "Name der Automatisierung" {
		t.Fatalf("automation option description = %q", runtimeCommands[0].Options[0].Description)
	}
}

func TestDiscordCommandDescriptionsAreGerman(t *testing.T) {
	for _, command := range commands.ApplicationCommands() {
		if strings.Contains(command.Description, "Ask Blitzcrank") ||
			strings.Contains(command.Description, "Manage ") ||
			strings.Contains(command.Description, "Run a ") {
			t.Fatalf("command %s description is not localized: %q", command.Name, command.Description)
		}
		for _, option := range command.Options {
			assertGermanCommandOptionDescription(t, command.Name, option)
		}
	}
}

func assertGermanCommandOptionDescription(t *testing.T, commandName string, option *discordgo.ApplicationCommandOption) {
	t.Helper()
	if option == nil {
		return
	}
	for _, english := range []string{"Runtime profile", "Profile field", "Global setting", "New value", "Automation name", "What should"} {
		if strings.Contains(option.Description, english) {
			t.Fatalf("command %s option %s description is not localized: %q", commandName, option.Name, option.Description)
		}
	}
	for _, child := range option.Options {
		assertGermanCommandOptionDescription(t, commandName, child)
	}
}

func TestBotStartReturnsUserLoadError(t *testing.T) {
	wantErr := errors.New("user lookup failed")
	api := &fakeDiscordAPI{userErr: wantErr}
	bot := &Bot{session: &discordgo.Session{}, api: api}

	if err := bot.Start(); !errors.Is(err, wantErr) {
		t.Fatalf("Start() error = %v, want %v", err, wantErr)
	}
	if !api.opened {
		t.Fatal("Start() did not open session")
	}
}

func TestBotStartRegistersRuntimeCommandsFromStateUser(t *testing.T) {
	api := &fakeDiscordAPI{}
	bot := &Bot{
		cfg:     config.Config{DiscordGuildID: "guild-1"},
		session: &discordgo.Session{State: &discordgo.State{Ready: discordgo.Ready{User: &discordgo.User{ID: "bot-1"}}}},
		api:     api,
	}

	if err := bot.Start(); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if bot.botID != "bot-1" {
		t.Fatalf("botID = %q, want bot-1", bot.botID)
	}
	if api.userCalled {
		t.Fatal("Start() called User despite state user")
	}
	if len(api.created) != len(commands.ApplicationCommands()) {
		t.Fatalf("created commands = %d, want %d", len(api.created), len(commands.ApplicationCommands()))
	}
	for _, created := range api.created {
		if created.appID != "bot-1" || created.guildID != "guild-1" {
			t.Fatalf("created command scope = %#v, want bot-1/guild-1", created)
		}
	}
}

func TestRegisterRuntimeCommandsEditsExistingAndCreatesMissing(t *testing.T) {
	api := &fakeDiscordAPI{existing: []*discordgo.ApplicationCommand{
		{ID: "existing-automation", Name: commands.AutomationCommand},
		{ID: "existing-config", Name: "config"},
	}}
	bot := &Bot{
		cfg:   config.Config{DiscordGuildID: "guild-1"},
		api:   api,
		botID: "bot-1",
	}

	if err := bot.registerRuntimeCommands(); err != nil {
		t.Fatalf("registerRuntimeCommands() error = %v", err)
	}
	if len(api.edited) != 1 || api.edited[0].cmdID != "existing-automation" || api.edited[0].name != commands.AutomationCommand {
		t.Fatalf("edited commands = %#v, want existing automation edit", api.edited)
	}
	wantCreates := len(commands.ApplicationCommands()) - 1
	if len(api.created) != wantCreates {
		t.Fatalf("created commands = %d, want %d", len(api.created), wantCreates)
	}
	if !fakeCreatedCommand(api.created, "jellyfin") {
		t.Fatalf("created commands = %#v, want jellyfin", api.created)
	}
	if len(api.deleted) != 1 || api.deleted[0].cmdID != "existing-config" {
		t.Fatalf("deleted commands = %#v, want existing config delete", api.deleted)
	}
}

func TestRegisterRuntimeCommandsSkipsSemanticallyUnchangedCommands(t *testing.T) {
	var existing []*discordgo.ApplicationCommand
	for _, command := range commands.ApplicationCommands() {
		existing = append(existing, discordReturnedApplicationCommand(command, "existing-"+command.Name))
	}
	api := &fakeDiscordAPI{existing: existing}
	bot := &Bot{
		cfg:   config.Config{DiscordGuildID: "guild-1"},
		api:   api,
		botID: "bot-1",
	}

	if err := bot.registerRuntimeCommands(); err != nil {
		t.Fatalf("registerRuntimeCommands() error = %v", err)
	}
	if len(api.edited) != 0 {
		t.Fatalf("edited commands = %#v, want none", api.edited)
	}
	if len(api.created) != 0 {
		t.Fatalf("created commands = %#v, want none", api.created)
	}
}

func TestApplicationCommandMatchesDetectsBehaviorChanges(t *testing.T) {
	desired := commands.ApplicationCommands()[0]
	existing := discordReturnedApplicationCommand(desired, "existing-config")

	if !applicationCommandMatches(existing, desired) {
		t.Fatal("applicationCommandMatches() = false, want true for Discord response defaults")
	}

	existing.Description = "old description"
	if applicationCommandMatches(existing, desired) {
		t.Fatal("applicationCommandMatches() = true after command description changed, want false")
	}

	existing = discordReturnedApplicationCommand(desired, "existing-config")
	existing.Options[0].Description = "old option description"
	if applicationCommandMatches(existing, desired) {
		t.Fatal("applicationCommandMatches() = true after nested option description changed, want false")
	}
}

func TestDiscordApplicationCommandsIncludeSkillCommands(t *testing.T) {
	appCommands := commands.ApplicationCommands()
	var jellyfin *discordgo.ApplicationCommand
	for _, command := range appCommands {
		if command.Name == "jellyfin" {
			jellyfin = command
		}
	}
	if jellyfin == nil {
		t.Fatal("jellyfin slash command missing")
	}
	if jellyfin.DefaultMemberPermissions != nil {
		t.Fatalf("jellyfin command has admin permissions: %#v", jellyfin.DefaultMemberPermissions)
	}
	if jellyfin.DMPermission == nil || *jellyfin.DMPermission {
		t.Fatalf("jellyfin command DMPermission = %#v, want false", jellyfin.DMPermission)
	}
	if len(jellyfin.Options) != 1 || jellyfin.Options[0].Name != commands.QuestionOption || !jellyfin.Options[0].Required {
		t.Fatalf("jellyfin options = %#v, want required question option", jellyfin.Options)
	}
}

func TestDiscordReleaseCommandIsGerman(t *testing.T) {
	appCommands := commands.ApplicationCommands()
	var release *discordgo.ApplicationCommand
	for _, command := range appCommands {
		if command.Name == commands.ReleasesCommand {
			release = command
		}
	}
	if release == nil {
		t.Fatal("release slash command missing")
	}
	if len(release.Options) != 1 || release.Options[0].Name != commands.SpanOption {
		t.Fatalf("release options = %#v, want localized span option", release.Options)
	}
	var values []string
	for _, choice := range release.Options[0].Choices {
		values = append(values, choice.Value.(string))
	}
	for _, want := range []string{"heute", "woche", "monat"} {
		if !slices.Contains(values, want) {
			t.Fatalf("release choices = %#v, missing %q", values, want)
		}
	}
}

func TestSplitDiscordMessagePreservesLongUnicode(t *testing.T) {
	content := strings.Repeat("🍿", 1000)
	chunks := splitDiscordMessage(content)
	if len(chunks) < 2 {
		t.Fatalf("splitDiscordMessage() chunks = %d, want multiple", len(chunks))
	}
	joined := strings.Join(chunks, "")
	if joined != content {
		t.Fatalf("splitDiscordMessage() changed content")
	}
	for _, chunk := range chunks {
		if !utf8.ValidString(chunk) {
			t.Fatalf("chunk is invalid UTF-8: %q", chunk)
		}
		if len(chunk) > 1900 {
			t.Fatalf("chunk byte length = %d, want <= 1900", len(chunk))
		}
	}
}

func TestAdminInteractionAllowsOwnerOrAdministrator(t *testing.T) {
	bot := &Bot{cfg: config.Config{InstanceOwnerID: "owner-1"}}
	owner := &discordgo.InteractionCreate{Interaction: &discordgo.Interaction{
		Member: &discordgo.Member{User: &discordgo.User{ID: "owner-1"}},
	}}
	if !bot.isAdminInteraction(owner) {
		t.Fatal("owner interaction was not allowed")
	}
	admin := &discordgo.InteractionCreate{Interaction: &discordgo.Interaction{
		Member: &discordgo.Member{User: &discordgo.User{ID: "user-1"}, Permissions: discordgo.PermissionAdministrator},
	}}
	if !bot.isAdminInteraction(admin) {
		t.Fatal("administrator interaction was not allowed")
	}
	user := &discordgo.InteractionCreate{Interaction: &discordgo.Interaction{
		Member: &discordgo.Member{User: &discordgo.User{ID: "user-2"}},
	}}
	if bot.isAdminInteraction(user) {
		t.Fatal("normal user interaction was allowed")
	}
}

func TestIsAdminUserAllowsOwnerOrAdministrator(t *testing.T) {
	bot := &Bot{cfg: config.Config{InstanceOwnerID: "owner-1"}}
	if !bot.isAdminUser("guild-1", "channel-1", "owner-1", nil) {
		t.Fatal("owner user was not allowed")
	}
	if !bot.isAdminUser("guild-1", "channel-1", "user-1", &discordgo.Member{Permissions: discordgo.PermissionAdministrator}) {
		t.Fatal("administrator user was not allowed")
	}
	if bot.isAdminUser("guild-1", "channel-1", "user-2", &discordgo.Member{}) {
		t.Fatal("normal user was allowed")
	}
}

func TestIsAdminUserComputesChannelPermissions(t *testing.T) {
	state := discordgo.NewState()
	if err := state.GuildAdd(&discordgo.Guild{
		ID:      "guild-1",
		OwnerID: "owner-1",
		Roles: []*discordgo.Role{
			{ID: "guild-1", Permissions: 0},
			{ID: "role-admin", Permissions: discordgo.PermissionAdministrator},
		},
	}); err != nil {
		t.Fatal(err)
	}
	if err := state.ChannelAdd(&discordgo.Channel{ID: "channel-1", GuildID: "guild-1"}); err != nil {
		t.Fatal(err)
	}
	if err := state.MemberAdd(&discordgo.Member{GuildID: "guild-1", User: &discordgo.User{ID: "user-1"}, Roles: []string{"role-admin"}}); err != nil {
		t.Fatal(err)
	}
	bot := &Bot{session: &discordgo.Session{State: state}}

	if !bot.isAdminUser("guild-1", "channel-1", "user-1", nil) {
		t.Fatal("administrator user was not allowed from computed channel permissions")
	}
}

func TestApprovalReactionRecognizesThumbs(t *testing.T) {
	if approved, handled := approvalReaction(&discordgo.Emoji{Name: "👍"}); !approved || !handled {
		t.Fatalf("approvalReaction(thumbs up) = %t, %t", approved, handled)
	}
	if approved, handled := approvalReaction(&discordgo.Emoji{Name: "👎"}); approved || !handled {
		t.Fatalf("approvalReaction(thumbs down) = %t, %t", approved, handled)
	}
	if _, handled := approvalReaction(&discordgo.Emoji{Name: "✅"}); handled {
		t.Fatal("approvalReaction(check) = handled, want false")
	}
}

func TestFeedbackReactionRecognizesThumbs(t *testing.T) {
	if rating, handled := feedbackReaction(&discordgo.Emoji{Name: "👍"}); rating != "positive" || !handled {
		t.Fatalf("feedbackReaction(thumbs up) = %q, %t", rating, handled)
	}
	if rating, handled := feedbackReaction(&discordgo.Emoji{Name: "👎"}); rating != "negative" || !handled {
		t.Fatalf("feedbackReaction(thumbs down) = %q, %t", rating, handled)
	}
	if _, handled := feedbackReaction(&discordgo.Emoji{Name: "✅"}); handled {
		t.Fatal("feedbackReaction(check) = handled, want false")
	}
}

func TestFeedbackReactionIgnoresUnknownDiscordMessage(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	state, err := store.Open(ctx, filepath.Join(dir, "blitzcrank.sqlite"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer state.Close()

	now := time.Date(2026, 5, 16, 10, 0, 0, 0, time.UTC)
	thread := store.AgentThread{
		ThreadID:   "discord:channel-1",
		Source:     "discord",
		ExternalID: "channel-1",
		Status:     "active",
		Title:      "Support thread",
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	if err := state.UpsertAgentThread(ctx, thread); err != nil {
		t.Fatalf("UpsertAgentThread() error = %v", err)
	}
	bot := &Bot{store: state, botID: "bot-1"}
	bot.onMessageReactionAdd(nil, &discordgo.MessageReactionAdd{
		MessageReaction: &discordgo.MessageReaction{
			UserID:    "user-1",
			ChannelID: "channel-1",
			MessageID: "unrelated-message-1",
			Emoji:     discordgo.Emoji{Name: "👍"},
		},
	})

	events, err := state.LoadAgentThreadEvents(ctx, thread.ThreadID)
	if err != nil {
		t.Fatalf("LoadAgentThreadEvents() error = %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("feedback events = %#v, want none for unrelated reaction", events)
	}
}

func TestFeedbackReactionRecordsKnownBotMessageInThread(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	state, err := store.Open(ctx, filepath.Join(dir, "blitzcrank.sqlite"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer state.Close()

	now := time.Date(2026, 5, 16, 10, 0, 0, 0, time.UTC)
	thread := store.AgentThread{
		ThreadID:        "discord:channel-1",
		Source:          "discord",
		ExternalID:      "channel-1",
		Status:          "active",
		Title:           "Support thread",
		LastPayloadJSON: `{"bot_message_ids":["bot-message-1"]}`,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	if err := state.UpsertAgentThread(ctx, thread); err != nil {
		t.Fatalf("UpsertAgentThread() error = %v", err)
	}
	bot := &Bot{store: state, botID: "bot-1"}
	bot.onMessageReactionAdd(nil, &discordgo.MessageReactionAdd{
		MessageReaction: &discordgo.MessageReaction{
			UserID:    "user-1",
			ChannelID: "channel-1",
			MessageID: "bot-message-1",
			Emoji:     discordgo.Emoji{Name: "👎"},
		},
	})

	events, err := state.LoadAgentThreadEvents(ctx, thread.ThreadID)
	if err != nil {
		t.Fatalf("LoadAgentThreadEvents() error = %v", err)
	}
	if len(events) != 1 || events[0].EventType != "feedback" || events[0].ExternalMessageID != "bot-message-1" || !strings.Contains(events[0].Message, "negative") {
		t.Fatalf("feedback events = %#v", events)
	}
}

func TestFeedbackCustomIDRoundTrip(t *testing.T) {
	channelID, messageID, ok := parseFeedbackCustomID(feedbackButtonCustomID("channel-1", "message-1"), feedbackButtonCustomIDPrefix)
	if !ok || channelID != "channel-1" || messageID != "message-1" {
		t.Fatalf("parseFeedbackCustomID(button) = %q, %q, %t", channelID, messageID, ok)
	}
	channelID, messageID, ok = parseFeedbackCustomID(feedbackModalCustomID("channel-2", "message-2"), feedbackModalCustomIDPrefix)
	if !ok || channelID != "channel-2" || messageID != "message-2" {
		t.Fatalf("parseFeedbackCustomID(modal) = %q, %q, %t", channelID, messageID, ok)
	}
	if _, _, ok := parseFeedbackCustomID("other", feedbackButtonCustomIDPrefix); ok {
		t.Fatal("parseFeedbackCustomID(other) ok = true")
	}
}

func TestModalTextInputValue(t *testing.T) {
	components := []discordgo.MessageComponent{
		discordgo.ActionsRow{Components: []discordgo.MessageComponent{
			discordgo.TextInput{CustomID: feedbackTextInputCustomID, Value: "needs better evidence"},
		}},
	}
	if got := modalTextInputValue(components, feedbackTextInputCustomID); got != "needs better evidence" {
		t.Fatalf("modalTextInputValue() = %q", got)
	}
}

func TestToolApprovalPromptMentionsOwner(t *testing.T) {
	bot := &Bot{cfg: config.Config{InstanceOwnerID: "owner-1"}}
	event := &discordgo.MessageCreate{Message: &discordgo.Message{GuildID: "guild-1"}}
	prompt := bot.toolApprovalPrompt(event, agent.ToolApprovalRequest{
		Name:             "sonarr_delete_blocklist_item",
		ArgumentsSummary: `{"blocklist_id":"42"}`,
	})
	for _, want := range []string{"<@owner-1>", "👍", "👎", "sonarr_delete_blocklist_item"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("toolApprovalPrompt() missing %q: %s", want, prompt)
		}
	}
}

func TestToolApprovalAllowedMentionsOnlyOwner(t *testing.T) {
	bot := &Bot{cfg: config.Config{InstanceOwnerID: "owner-1"}}
	mentions := bot.toolApprovalAllowedMentions()
	if mentions == nil || len(mentions.Users) != 1 || mentions.Users[0] != "owner-1" || mentions.RepliedUser {
		t.Fatalf("toolApprovalAllowedMentions() = %#v, want only owner", mentions)
	}
}

func TestDiscordToolGroupsForContentScopesDirectMentions(t *testing.T) {
	groups := discordToolGroupsForContent("download queue stuck after import")
	if !stringSliceContains(groups, "sabnzbd") || !stringSliceContains(groups, "filesystem") {
		t.Fatalf("groups = %#v, want sabnzbd and filesystem", groups)
	}
	if stringSliceContains(groups, "sonarr") || stringSliceContains(groups, "radarr") {
		t.Fatalf("groups = %#v, want no unrelated arr groups", groups)
	}
}

func TestSeerrRequestContextUsesRequesterAndMentionMappings(t *testing.T) {
	bot := &Bot{cfg: config.Config{DiscordSeerrUserMap: map[string]string{
		"1001": "42",
		"1002": "84",
	}}}
	seerrUserID, contextText := bot.seerrRequestContext("bitte für <@1002> anfragen", "1001")
	if seerrUserID != "42" {
		t.Fatalf("seerrUserID = %q", seerrUserID)
	}
	for _, want := range []string{"`42`", "`84`", "prefer Seerr request tools"} {
		if !strings.Contains(contextText, want) {
			t.Fatalf("context missing %q: %s", want, contextText)
		}
	}
}

func TestFallbackIntakeReply(t *testing.T) {
	reply := fallbackIntakeReply("Kannst du mir mit Mathe helfen?", "unsupported")
	if !strings.Contains(reply, "Medienserver") {
		t.Fatalf("fallbackIntakeReply() = %q", reply)
	}
	reply = fallbackIntakeReply("Can you help?", "clarify")
	if !strings.Contains(reply, "What") {
		t.Fatalf("fallbackIntakeReply(clarify) = %q", reply)
	}
}

func TestValidateDiscordReplyRejectsInternalOutput(t *testing.T) {
	if _, err := validateDiscordReply("Alles gut."); err != nil {
		t.Fatalf("validateDiscordReply() error = %v", err)
	}
	if _, err := validateDiscordReply("tool result: {\"secret\":true}"); err == nil {
		t.Fatal("validateDiscordReply() error = nil, want internal-output error")
	}
}

func TestOneOffDiscordQuestionRouting(t *testing.T) {
	triage := agent.DiscordTriageResult{Action: "support_request", Actionable: true, NeedsAgentRun: true}
	tests := []struct {
		name    string
		message string
		want    bool
	}{
		{name: "jellyfin availability", message: "ist auf jellyfin der neue project hail mary film verfügbar?", want: true},
		{name: "release date", message: "weiß jemand wann der neue ghost in the shell anime rauskommt?", want: true},
		{name: "service status", message: "sind sonarr und radarr erreichbar?", want: true},
		{name: "playback issue", message: "Project Hail Mary geht in Jellyfin nicht"},
		{name: "missing track", message: "bei S02E05 fehlen die Untertitel"},
		{name: "download issue", message: "download stuck for Ghost in the Shell"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isOneOffDiscordQuestion(tt.message, triage); got != tt.want {
				t.Fatalf("isOneOffDiscordQuestion() = %t, want %t", got, tt.want)
			}
		})
	}
}

func TestMessageReplyHelpers(t *testing.T) {
	bot := &Bot{botID: "bot-1"}
	message := &discordgo.Message{
		MessageReference: &discordgo.MessageReference{MessageID: "reply-target"},
		ReferencedMessage: &discordgo.Message{
			Author: &discordgo.User{ID: "bot-1"},
		},
	}
	if got := messageReplyTargetID(message); got != "reply-target" {
		t.Fatalf("messageReplyTargetID() = %q", got)
	}
	if !bot.messageRepliesToBot(message) {
		t.Fatal("messageRepliesToBot() = false")
	}
	message.ReferencedMessage.Author.ID = "user-1"
	if bot.messageRepliesToBot(message) {
		t.Fatal("messageRepliesToBot(non-bot) = true")
	}
}

func TestReplyContinuationRequiresOriginalAuthor(t *testing.T) {
	thread := store.AgentThread{
		Events: []store.AgentThreadEvent{
			{EventType: "feedback", ActorID: "user-2"},
			{EventType: "direct_agent", ActorID: "user-1"},
			{EventType: "reply", ActorID: "user-1"},
		},
	}
	if got := originalThreadAuthorID(thread); got != "user-1" {
		t.Fatalf("originalThreadAuthorID() = %q, want user-1", got)
	}
	originalReply := &discordgo.MessageCreate{Message: &discordgo.Message{
		Author: &discordgo.User{ID: "user-1"},
	}}
	if !replyContinuationAuthorAllowed(thread, originalReply) {
		t.Fatal("replyContinuationAuthorAllowed(original author) = false")
	}
	otherReply := &discordgo.MessageCreate{Message: &discordgo.Message{
		Author: &discordgo.User{ID: "user-2"},
	}}
	if replyContinuationAuthorAllowed(thread, otherReply) {
		t.Fatal("replyContinuationAuthorAllowed(other author) = true")
	}
}

func TestRecentTranscriptUsesLatestMessages(t *testing.T) {
	now := time.Date(2026, 5, 16, 10, 0, 0, 0, time.UTC)
	events := []store.AgentThreadEvent{
		{Actor: "alice", Message: "old", CreatedAt: now},
		{Actor: "bob", Message: "new", CreatedAt: now.Add(time.Minute)},
	}
	transcript := recentTranscript(events, 1)
	if strings.Contains(transcript, "old") || !strings.Contains(transcript, "new") {
		t.Fatalf("recentTranscript() = %q", transcript)
	}
}

func TestRecentRunsIncludesOutcomeWithoutRawEmptyRows(t *testing.T) {
	now := time.Date(2026, 5, 16, 10, 0, 0, 0, time.UTC)
	runs := []store.AgentRun{
		{StartedAt: now, CompletionReason: "discord response posted", FinalResponse: "fixed"},
	}
	out := recentRuns(runs, 5)
	if !strings.Contains(out, "fixed") || !strings.Contains(out, "discord response posted") {
		t.Fatalf("recentRuns() = %q", out)
	}
}

func TestDiscordThreadWritesJSONLTrace(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	state, err := store.Open(ctx, filepath.Join(dir, "blitzcrank.sqlite"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer state.Close()

	bot := &Bot{
		cfg:   config.Config{ThreadsDirectory: filepath.Join(dir, "threads")},
		store: state,
	}
	event := &discordgo.MessageCreate{Message: &discordgo.Message{
		ID:        "message-1",
		ChannelID: "channel-1",
		GuildID:   "guild-1",
		Timestamp: time.Date(2026, 5, 16, 10, 0, 0, 0, time.UTC),
		Author:    &discordgo.User{ID: "user-1", Username: "alice"},
	}}
	if err := bot.recordDiscordThread(ctx, recordDiscordThreadRequest{
		ThreadID:      "thread-1",
		ParentID:      "channel-1",
		RootMessageID: "message-1",
		Title:         "Missing episode",
		Event:         event,
		EventType:     "root_message",
		Content:       "S02E05 fehlt",
	}); err != nil {
		t.Fatalf("recordDiscordThread() error = %v", err)
	}

	completedAt := time.Date(2026, 5, 16, 10, 1, 0, 0, time.UTC)
	bot.persistDiscordRun("discord:thread-1", store.AgentRun{
		ThreadID:         "discord:thread-1",
		SourceEventType:  "root_message",
		StartedAt:        completedAt.Add(-time.Minute),
		CompletedAt:      &completedAt,
		FinalResponse:    "Ist erledigt.",
		Posted:           true,
		Attribution:      "discord:gpt-5.5",
		CompletionReason: "discord response posted",
		Summary:          "Episode fixed.",
	})

	data, err := os.ReadFile(filepath.Join(dir, "threads", "discord", "thread-1.jsonl"))
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 3 {
		t.Fatalf("trace line count = %d, want 3\n%s", len(lines), string(data))
	}
	var records []map[string]any
	for _, line := range lines {
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatalf("Unmarshal(%q) error = %v", line, err)
		}
		records = append(records, record)
	}
	if records[0]["type"] != "discord_thread" || records[1]["type"] != "discord_event" || records[2]["type"] != "discord_run" {
		t.Fatalf("trace record types = %#v", records)
	}
	if records[2]["final_response"] != "Ist erledigt." || records[2]["posted"] != true {
		t.Fatalf("run trace = %#v", records[2])
	}
	loaded, ok, err := state.LoadAgentThreadByExternalID(ctx, "discord", "thread-1")
	if err != nil {
		t.Fatalf("LoadAgentThreadByExternalID() error = %v", err)
	}
	if !ok {
		t.Fatal("LoadAgentThreadByExternalID() ok = false")
	}
	if loaded.ThreadID != records[0]["thread_id"] || loaded.ExternalID != records[0]["discord_thread_id"] {
		t.Fatalf("thread DB/JSONL mismatch: loaded=%#v trace=%#v", loaded, records[0])
	}
	if len(loaded.Events) != 1 || loaded.Events[0].ExternalMessageID != records[1]["external_message_id"] {
		t.Fatalf("event DB/JSONL mismatch: loaded=%#v trace=%#v", loaded.Events, records[1])
	}
	if loaded.Summary != "Episode fixed." {
		t.Fatalf("thread summary = %q", loaded.Summary)
	}
	if len(loaded.Runs) != 1 || loaded.Runs[0].FinalResponse != records[2]["final_response"] {
		t.Fatalf("run DB/JSONL mismatch: loaded=%#v trace=%#v", loaded.Runs, records[2])
	}
}

func TestDiscordDirectInteractionWritesJSONLTrace(t *testing.T) {
	dir := t.TempDir()
	bot := &Bot{cfg: config.Config{ThreadsDirectory: filepath.Join(dir, "threads")}}
	event := &discordgo.MessageCreate{Message: &discordgo.Message{
		ID:        "message-1",
		ChannelID: "channel-1",
		GuildID:   "guild-1",
		Timestamp: time.Date(2026, 5, 16, 10, 0, 0, 0, time.UTC),
		Author:    &discordgo.User{ID: "user-1", Username: "alice"},
	}}
	startedAt := time.Date(2026, 5, 16, 10, 1, 0, 0, time.UTC)
	bot.appendDiscordInteractionTrace(discordInteractionTraceRequest{
		Event:           event,
		InteractionType: "direct_agent_reply",
		Content:         "ping",
		Reply:           "pong",
		StartedAt:       startedAt,
		CompletedAt:     startedAt.Add(time.Second),
		Extra: map[string]any{
			"attribution": "discord:gpt-5.5",
		},
	})

	data, err := os.ReadFile(filepath.Join(dir, "threads", "discord", "interactions", "message-1.jsonl"))
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	var record map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(data))), &record); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if record["type"] != "discord_interaction" || record["interaction_type"] != "direct_agent_reply" {
		t.Fatalf("interaction trace = %#v", record)
	}
	if record["message_id"] != "message-1" || record["reply"] != "pong" || record["attribution"] != "discord:gpt-5.5" {
		t.Fatalf("interaction trace = %#v", record)
	}
}

func TestRecordDiscordInteractionThreadCanContinueFromBotReply(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	state, err := store.Open(ctx, filepath.Join(dir, "blitzcrank.sqlite"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer state.Close()

	bot := &Bot{
		cfg:   config.Config{ThreadsDirectory: filepath.Join(dir, "threads")},
		store: state,
	}
	bot.recordDiscordInteractionThread(ctx, interactionThreadRecord{
		ThreadID:       discordThreadID("bot-message-1"),
		ExternalID:     "bot-message-1",
		ParentID:       "channel-1",
		RootID:         "user-message-1",
		Title:          "wie gehts dir?",
		Actor:          "alice (user-1)",
		ActorID:        "user-1",
		MessageID:      "user-message-1",
		EventType:      "triage_direct_reply",
		Content:        "wie gehts dir?",
		ToolGroups:     []string{"jellyseerr", "jellyfin"},
		BotMessageID:   "bot-message-1",
		BotMessageText: "Mir geht's gut.",
		Attribution:    "discord:triage",
	})

	loaded, ok, err := state.LoadAgentThreadByBotMessageID(ctx, "discord", "bot-message-1")
	if err != nil {
		t.Fatalf("LoadAgentThreadByBotMessageID() error = %v", err)
	}
	if !ok {
		t.Fatal("LoadAgentThreadByBotMessageID() ok = false")
	}
	if loaded.ThreadID != discordThreadID("bot-message-1") {
		t.Fatalf("ThreadID = %q", loaded.ThreadID)
	}
	if len(loaded.Events) != 1 || loaded.Events[0].EventType != "triage_direct_reply" || loaded.Events[0].ActorID != "user-1" {
		t.Fatalf("events = %#v", loaded.Events)
	}
	if got := threadToolGroups(loaded); !stringSliceContains(got, "jellyseerr") || !stringSliceContains(got, "jellyfin") {
		t.Fatalf("threadToolGroups() = %#v", got)
	}
}

func TestDiscordFeedbackPersistsToAgentThreadAndTrace(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	state, err := store.Open(ctx, filepath.Join(dir, "blitzcrank.sqlite"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer state.Close()

	now := time.Date(2026, 5, 16, 10, 0, 0, 0, time.UTC)
	thread := store.AgentThread{
		ThreadID:         "discord:thread-1",
		Source:           "discord",
		ExternalID:       "thread-1",
		ParentExternalID: "channel-1",
		Status:           "active",
		Title:            "Missing episode",
		CreatedAt:        now,
		UpdatedAt:        now,
	}
	if err := state.UpsertAgentThread(ctx, thread); err != nil {
		t.Fatalf("UpsertAgentThread() error = %v", err)
	}
	bot := &Bot{
		cfg:   config.Config{ThreadsDirectory: filepath.Join(dir, "threads")},
		store: state,
	}

	bot.recordDiscordFeedback(ctx, discordFeedbackRecord{
		ChannelID: "thread-1",
		MessageID: "bot-message-1",
		Rating:    "negative",
		Source:    "reaction",
		Actor:     "alice (user-1)",
		ActorID:   "user-1",
		CreatedAt: now.Add(time.Minute),
	})
	bot.recordDiscordFeedback(ctx, discordFeedbackRecord{
		ChannelID: "thread-1",
		MessageID: "bot-message-1",
		Text:      "claimed the wrong season",
		Source:    "modal",
		Actor:     "alice (user-1)",
		ActorID:   "user-1",
		CreatedAt: now.Add(2 * time.Minute),
	})

	loaded, ok, err := state.LoadAgentThread(ctx, thread.ThreadID)
	if err != nil {
		t.Fatalf("LoadAgentThread() error = %v", err)
	}
	if !ok {
		t.Fatal("LoadAgentThread() ok = false")
	}
	if len(loaded.Events) != 1 {
		t.Fatalf("feedback events len = %d, want 1", len(loaded.Events))
	}
	event := loaded.Events[0]
	if event.EventType != "feedback" || event.ActorID != "user-1" || event.ExternalMessageID != "bot-message-1" {
		t.Fatalf("feedback event = %#v", event)
	}
	if !strings.Contains(event.Message, "negative") || !strings.Contains(event.Message, "claimed the wrong season") {
		t.Fatalf("feedback event message = %q", event.Message)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(event.PayloadJSON), &payload); err != nil {
		t.Fatalf("Unmarshal(payload) error = %v", err)
	}
	if payload["type"] != "discord_feedback" || payload["source"] != "reaction" || payload["rating"] != "negative" || payload["text"] != "claimed the wrong season" {
		t.Fatalf("feedback payload = %#v", payload)
	}

	data, err := os.ReadFile(filepath.Join(dir, "threads", "discord", "thread-1.jsonl"))
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 1 {
		t.Fatalf("feedback trace line count = %d, want 1\n%s", len(lines), string(data))
	}
	if !strings.Contains(string(data), `"type":"discord_feedback"`) ||
		!strings.Contains(string(data), `"message_id":"bot-message-1"`) ||
		!strings.Contains(string(data), `"rating":"negative"`) ||
		!strings.Contains(string(data), `"text":"claimed the wrong season"`) {
		t.Fatalf("feedback trace = %s", string(data))
	}
}

func TestDiscordFeedbackCanResolveDirectReplyMessage(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	state, err := store.Open(ctx, filepath.Join(dir, "blitzcrank.sqlite"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer state.Close()

	now := time.Date(2026, 5, 16, 10, 0, 0, 0, time.UTC)
	thread := store.AgentThread{
		ThreadID:         "discord:bot-message-1",
		Source:           "discord",
		ExternalID:       "bot-message-1",
		ParentExternalID: "channel-1",
		RootExternalID:   "user-message-1",
		Status:           "active",
		Title:            "Direct question",
		CreatedAt:        now,
		UpdatedAt:        now,
	}
	if err := state.UpsertAgentThread(ctx, thread); err != nil {
		t.Fatalf("UpsertAgentThread() error = %v", err)
	}
	bot := &Bot{store: state}

	bot.recordDiscordFeedback(ctx, discordFeedbackRecord{
		ChannelID: "channel-1",
		MessageID: "bot-message-1",
		Rating:    "positive",
		Source:    "reaction",
		ActorID:   "user-1",
		CreatedAt: now.Add(time.Minute),
	})

	events, err := state.LoadAgentThreadEvents(ctx, thread.ThreadID)
	if err != nil {
		t.Fatalf("LoadAgentThreadEvents() error = %v", err)
	}
	if len(events) != 1 || events[0].EventType != "feedback" || !strings.Contains(events[0].Message, "positive") {
		t.Fatalf("feedback events = %#v", events)
	}
}

func TestDiscordAutomationReportWritesJSONLOnly(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	state, err := store.Open(ctx, filepath.Join(dir, "blitzcrank.sqlite"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer state.Close()

	bot := &Bot{
		cfg:   config.Config{ThreadsDirectory: filepath.Join(dir, "threads"), BotPublicName: "Blitzcrank"},
		store: state,
	}
	bot.recordAutomationReport(ctx, "hourly-stale-import-handler", "done")

	data, err := os.ReadFile(filepath.Join(dir, "threads", "automations", "hourly-stale-import-handler.jsonl"))
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	var record map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(data))), &record); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if record["type"] != "discord_automation_report" || record["message"] != "done" {
		t.Fatalf("automation report trace = %#v", record)
	}
	events, err := state.LoadAgentThreadEvents(ctx, "discord_automation:hourly-stale-import-handler")
	if err != nil {
		t.Fatalf("LoadAgentThreadEvents() error = %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("automation report events = %#v, want none", events)
	}
}

type fakeDiscordAPI struct {
	opened     bool
	userCalled bool
	user       *discordgo.User
	userErr    error
	existing   []*discordgo.ApplicationCommand
	created    []fakeCommandCall
	edited     []fakeCommandCall
	deleted    []fakeCommandCall
}

type fakeCommandCall struct {
	appID   string
	guildID string
	cmdID   string
	name    string
}

func (f *fakeDiscordAPI) Open() error {
	f.opened = true
	return nil
}

func (f *fakeDiscordAPI) User(userID string, _ ...discordgo.RequestOption) (*discordgo.User, error) {
	f.userCalled = true
	if f.userErr != nil {
		return nil, f.userErr
	}
	if f.user != nil {
		return f.user, nil
	}
	return &discordgo.User{ID: strings.TrimSpace(userID)}, nil
}

func (f *fakeDiscordAPI) ApplicationCommands(_ string, _ string, _ ...discordgo.RequestOption) ([]*discordgo.ApplicationCommand, error) {
	return f.existing, nil
}

func (f *fakeDiscordAPI) ApplicationCommandEdit(appID, guildID, cmdID string, cmd *discordgo.ApplicationCommand, _ ...discordgo.RequestOption) (*discordgo.ApplicationCommand, error) {
	f.edited = append(f.edited, fakeCommandCall{appID: appID, guildID: guildID, cmdID: cmdID, name: cmd.Name})
	return cmd, nil
}

func (f *fakeDiscordAPI) ApplicationCommandCreate(appID, guildID string, cmd *discordgo.ApplicationCommand, _ ...discordgo.RequestOption) (*discordgo.ApplicationCommand, error) {
	f.created = append(f.created, fakeCommandCall{appID: appID, guildID: guildID, name: cmd.Name})
	return cmd, nil
}

func (f *fakeDiscordAPI) ApplicationCommandDelete(appID, guildID, cmdID string, _ ...discordgo.RequestOption) error {
	f.deleted = append(f.deleted, fakeCommandCall{appID: appID, guildID: guildID, cmdID: cmdID})
	return nil
}

func fakeCreatedCommand(calls []fakeCommandCall, name string) bool {
	for _, call := range calls {
		if call.name == name {
			return true
		}
	}
	return false
}

func discordReturnedApplicationCommand(command *discordgo.ApplicationCommand, id string) *discordgo.ApplicationCommand {
	if command == nil {
		return nil
	}
	nsfw := false
	nameLocalizations := map[discordgo.Locale]string{}
	descriptionLocalizations := map[discordgo.Locale]string{}
	contexts := []discordgo.InteractionContextType{discordgo.InteractionContextGuild}
	integrationTypes := []discordgo.ApplicationIntegrationType{discordgo.ApplicationIntegrationGuildInstall}
	return &discordgo.ApplicationCommand{
		ID:                       id,
		ApplicationID:            "bot-1",
		GuildID:                  "guild-1",
		Version:                  "1",
		Type:                     applicationCommandType(command.Type),
		Name:                     command.Name,
		NameLocalizations:        &nameLocalizations,
		DefaultMemberPermissions: command.DefaultMemberPermissions,
		NSFW:                     &nsfw,
		Contexts:                 &contexts,
		IntegrationTypes:         &integrationTypes,
		Description:              command.Description,
		DescriptionLocalizations: &descriptionLocalizations,
		Options:                  discordReturnedApplicationCommandOptions(command.Options),
	}
}

func discordReturnedApplicationCommandOptions(options []*discordgo.ApplicationCommandOption) []*discordgo.ApplicationCommandOption {
	if len(options) == 0 {
		return []*discordgo.ApplicationCommandOption{}
	}
	returned := make([]*discordgo.ApplicationCommandOption, 0, len(options))
	for _, option := range options {
		if option == nil {
			returned = append(returned, nil)
			continue
		}
		returned = append(returned, &discordgo.ApplicationCommandOption{
			Type:                     option.Type,
			Name:                     option.Name,
			NameLocalizations:        map[discordgo.Locale]string{},
			Description:              option.Description,
			DescriptionLocalizations: map[discordgo.Locale]string{},
			ChannelTypes:             append([]discordgo.ChannelType{}, option.ChannelTypes...),
			Required:                 option.Required,
			Options:                  discordReturnedApplicationCommandOptions(option.Options),
			Autocomplete:             option.Autocomplete,
			Choices:                  discordReturnedApplicationCommandChoices(option.Choices),
			MinValue:                 option.MinValue,
			MaxValue:                 option.MaxValue,
			MinLength:                option.MinLength,
			MaxLength:                option.MaxLength,
		})
	}
	return returned
}

func discordReturnedApplicationCommandChoices(choices []*discordgo.ApplicationCommandOptionChoice) []*discordgo.ApplicationCommandOptionChoice {
	if len(choices) == 0 {
		return []*discordgo.ApplicationCommandOptionChoice{}
	}
	returned := make([]*discordgo.ApplicationCommandOptionChoice, 0, len(choices))
	for _, choice := range choices {
		if choice == nil {
			returned = append(returned, nil)
			continue
		}
		returned = append(returned, &discordgo.ApplicationCommandOptionChoice{
			Name:              choice.Name,
			NameLocalizations: map[discordgo.Locale]string{},
			Value:             choice.Value,
		})
	}
	return returned
}

func stringSliceContains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
