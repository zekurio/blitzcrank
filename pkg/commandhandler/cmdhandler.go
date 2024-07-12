package commandhandler

import (
	"github.com/bwmarrin/discordgo"
)

type CommandHandler struct {
	// cmds is a map of command names to their respective command
	cmds map[string]Command

	// s is our discord session
	s *discordgo.Session
}

func New(s *discordgo.Session) *CommandHandler {
	h := &CommandHandler{
		cmds: make(map[string]Command),
		s:    s,
	}

	s.AddHandler(h.onInteractionCreate)

	return h
}

func (c *CommandHandler) RegisterCommand(cmds ...Command) {
	for _, cmd := range cmds {
		// TODO add checks for duplicate command names
		// TODO add checks for valid command names
		c.cmds[cmd.Name()] = cmd
	}
}

func (c *CommandHandler) HandleInteractionCreate(i *discordgo.InteractionCreate) {
	cmd, ok := c.cmds[i.ApplicationCommandData().Name]
	if !ok {
		return
	}

	cmd.Exec(i.Interaction)
}

func (c *CommandHandler) onInteractionCreate(s *discordgo.Session, e *discordgo.InteractionCreate) {
	switch e.Type {
	case discordgo.InteractionApplicationCommand:
		c.onInteractionApplicationCommand(s, e)
	default:
		return
	}
}

func (c *CommandHandler) onInteractionApplicationCommand(s *discordgo.Session, e *discordgo.InteractionCreate) {
	cmd := c.cmds[e.ApplicationCommandData().Name]
	if cmd == nil {
		return
	}

	err := cmd.Exec(e.Interaction)
	if err != nil {
		// TODO handle error
	}
}
