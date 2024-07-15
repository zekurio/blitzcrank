package commandhandler

import "github.com/bwmarrin/discordgo"

// Context holds our data from the interaction neatly in one object
type Context interface {
	Channel() (channel *discordgo.Channel, err error)

	Guild() (guild *discordgo.Guild, err error)

	User() (user *discordgo.User, err error)

	Interaction() (interaction *discordgo.Interaction, err error)

	Options() (options []*discordgo.ApplicationCommandInteractionDataOption, err error)

	SlashCommand() (command SlashCommand, err error)

	// TODO work on other command types
}

// Responder handles responding and follow up messages
type Responder interface {
	Context

	Respond(r *discordgo.InteractionResponse) (err error)

	RespondMessage(content string) (err error)

	RespondEmbed(embed *discordgo.MessageEmbed) (err error)

	RespondError(content, title string) (err error)

	// TODO follow up messages
}

type Ctx struct {
	session *discordgo.Session
	event   *discordgo.InteractionCreate

	cmdHandler *CommandHandler
	cmd        Command
}

var _ Context = &Ctx{}

func (c *Ctx) Channel() (channel *discordgo.Channel, err error) {
	return c.cmdHandler.options.State.Channel(c.session, c.event.Interaction.ChannelID)
}

func (c *Ctx) Guild() (guild *discordgo.Guild, err error) {
	return c.cmdHandler.options.State.Guild(c.session, c.event.Interaction.GuildID)
}

func (c *Ctx) User() (user *discordgo.User, err error) {
	return c.cmdHandler.options.State.User(c.session, c.event.Interaction.Member.User.ID)
}

func (c *Ctx) Interaction() (interaction *discordgo.Interaction, err error) {
	return c.event.Interaction, nil
}

func (c *Ctx) Options() (options []*discordgo.ApplicationCommandInteractionDataOption, err error) {
	return c.event.Interaction.ApplicationCommandData().Options, nil
}

func (c *Ctx) SlashCommand() (command SlashCommand, err error) {
	return c.cmd.(SlashCommand), nil
}

type Res struct {
	Ctx

	responded bool
	ephemeral bool
}

var _ Responder = &Res{}

func (c *Res) messageFlags(p discordgo.MessageFlags) (f discordgo.MessageFlags) {
	f = p
	if c.ephemeral {
		f |= discordgo.MessageFlagsEphemeral
	}
	return
}

func (r *Res) Respond(rsp *discordgo.InteractionResponse) (err error) {
	if r.responded {
		return nil
	}

	rsp.Data.Flags = r.messageFlags(rsp.Data.Flags)

	err = r.session.InteractionRespond(r.event.Interaction, rsp)
	if err != nil {
		return err
	}

	r.responded = true

	return nil
}

func (r *Res) RespondMessage(content string) (err error) {
	return r.Respond(&discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseChannelMessageWithSource,
		Data: &discordgo.InteractionResponseData{
			Content: content,
		},
	})
}

func (r *Res) RespondEmbed(embed *discordgo.MessageEmbed) (err error) {
	return r.Respond(&discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseChannelMessageWithSource,
		Data: &discordgo.InteractionResponseData{
			Embeds: []*discordgo.MessageEmbed{embed},
		},
	})
}

func (r *Res) RespondError(content, title string) (err error) {
	return r.RespondEmbed(&discordgo.MessageEmbed{
		Title:       title,
		Description: content,
		Color:       r.Ctx.cmdHandler.options.EmbedColors.Error,
	})
}
