package discord

import "github.com/bwmarrin/discordgo"

type CmdHandler struct {
	// cmds is a map of command names to their respective command
	cmds map[string]Command

	// s is our discord session
	s *Discord
}

func NewCmdHandler(s *Discord) *CmdHandler {
	return &CmdHandler{
		cmds: make(map[string]Command),
		s:    s,
	}
}

func (c *CmdHandler) RegisterCommand(cmds ...Command) {
	for _, cmd := range cmds {
		// TODO add checks for duplicate command names
		// TODO add checks for valid command names
		c.cmds[cmd.Name()] = cmd
	}
}

func (c *CmdHandler) HandleInteractionCreate(i *discordgo.InteractionCreate) {
	cmd, ok := c.cmds[i.ApplicationCommandData().Name]
	if !ok {
		return
	}

	cmd.Exec(i.Interaction)
}
